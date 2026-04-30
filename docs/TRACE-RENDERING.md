# Trace Rendering Pipeline: From KiCad to 3D Tubes

How a flat `.kicad_pcb` file becomes thousands of 3D tubes floating in AR.

## Stage 1: Extraction

The converter (`kicad-to-json.mjs`) parses KiCad's S-expression format and pulls out every `segment` and `arc` on copper layers. Each segment is just two endpoints and a width in millimeters. A typical Arduino Nano has ~800 segments.

## Stage 2: Segment Merging

Raw segments are disconnected pairs of points. `mergeSegments()` stitches them into continuous polylines by net. It builds spatial lookup tables keyed on endpoint position (quantized to 0.0001mm grid, K=10000), then walks forward and backward from each unvisited seed segment, following endpoint matches. The result: polylines with parallel `points[]` and `widths[]` arrays, where each point carries the width of the segment that produced it.

This is where variable width enters the system. A single polyline can have width changes mid-path because KiCad designers use different trace widths for power vs signal traces, and a merged polyline might span both.

## Stage 3: Corner Smoothing

`smoothPolylineWithWidths()` replaces sharp corners with quadratic Bezier arcs. For each interior point, it checks the dot product of incoming and outgoing edge directions. If the angle is sharp enough (dot < 0.95), it:

1. Pulls back from the corner by 35% of the shorter adjacent edge length
2. Creates Bezier control points: the corner vertex itself, plus the two pullback points
3. Evaluates the quadratic Bezier at 4-6 intermediate steps (more for sharper corners)
4. Interpolates width along the Bezier using the same quadratic formula: `u^2 * w0 + 2ut * w1 + t^2 * w2`

This produces smooth curves at corners instead of hard angles, with width tapering naturally through the curve.

## Stage 4: Width Smoothing

`smoothWidths()` handles the remaining hard width transitions. It scans the width array for discontinuities (where adjacent widths differ by more than 0.001mm), then for each change point, applies a cubic ease-in-out blend over a +/-2mm window using the Hermite basis: `3t^2 - 2t^3`. This turns a step function into an S-curve.

## Stage 5: The Tube Mesh

This is where it gets interesting. Each polyline becomes a 3D tube with a rounded-rectangle cross-section.

### The Profile

A 2D shape with 8 vertices (2 per corner of the rounded rect). The half-width is normalized to 1.0, the half-height is 0.25 (the `TRACE_HEIGHT_RATIO`), giving traces a flat, tape-like aspect ratio. Corner radius is 80% of the half-height (0.2 units), with 1 interpolation step per 90-degree arc. The profile is defined as arrays of (x, y) positions and (nx, ny) normals.

```
        pIW=0.8     pCR=0.2
    +-------------------------+  <- pHH = 0.25
    |    ,---------------.    |
    |    |               |    |  <- pIH = 0.05
    |    `---------------'    |
    +-------------------------+
    <- pHW = 1.0 ->
```

### Parallel Transport Frame

For each point along the polyline, we need a local coordinate frame (R, B) to orient the profile perpendicular to the curve. The code uses parallel transport rather than independent per-vertex frame computation, which prevents frame twisting at bends.

**Tangent computation:** At endpoints, forward/backward finite difference. At interior points, the average of the normalized incoming and outgoing edge directions.

**Frame propagation:** At vertex 0, the frame is seeded from the tangent crossed with a world up vector (0, 0, 1), with fallback to (1, 0, 0) if the tangent is nearly vertical. For each subsequent vertex, the previous frame's R and B vectors are rotated by the minimum angle that maps the old tangent to the new tangent, using Rodrigues' rotation formula:

```
axis = cross(T_prev, T_cur)          // rotation axis
cos(a) = dot(T_prev, T_cur)          // rotation angle
sin(a) = |cross(T_prev, T_cur)|
R' = R*cos + (axis x R)*sin + axis*(axis.R)*(1-cos)
B' = B*cos + (axis x B)*sin + axis*(axis.B)*(1-cos)
```

This is equivalent to parallel transporting the frame along the curve. The rotation is the smallest rotation that maps one tangent to the next, preserving frame orientation and avoiding the sudden flips or twists that happen when computing frames independently from a fixed up vector at each point.

### Per-Vertex Scaling

Each ring of profile vertices gets scaled by `tubeR = width[i] * 0.5 * scaleFactor`. The profile coordinates are multiplied by tubeR, then transformed into world space using the Frenet frame:

```
worldPos = center + (profileX * tubeR) * R + (profileY * tubeR) * B
normal   = profileNX * R + profileNY * B
```

### Indexing

Adjacent rings are connected with triangle strips. For PROF=8 vertices per ring and N points along the polyline, that's `(N-1) * 8 * 2 = 16(N-1)` triangles for the body.

### Caps

Flat disc caps at both ends, using a fan topology from a center vertex. The start cap normal faces backward (-T), the end cap normal faces forward (+T). The cap is scaled by the endpoint's radius.

### Vertex Attributes

Each vertex carries:
- Position (3 floats)
- Normal (3 floats)
- UV0: `(t, traceIdx)` where t is parametric position [0,1] along arc length, traceIdx identifies the trace for data texture lookup
- UV1: `(0, 0)` reserved for morph displacement

## Stage 6: Batching

Lens Studio's MeshBuilder uses UInt16 indices (max 65535 vertices). The code enforces a 63000 vertex limit per batch. When a trace would push the batch over the limit, the current batch is finalized (mesh uploaded, RenderMeshVisual created, material assigned) and a new batch starts. A complex board like the RPi CM4 IO can produce 10+ batches per copper layer.

## Stage 7: The Data Texture

Per-trace state is encoded in a 2-column RGBA8 texture (2 pixels wide, N pixels tall where N = number of traces):

- **Column 0 (x=0.25):** R,G = growth [0,1] as 16-bit fixed-point. B,A = hue [0,1] as 16-bit fixed-point.
- **Column 1 (x=0.75):** R,G = arc length (x200 cm scale). B,A = cumulative offset (x200 cm scale).

The 16-bit encoding packs a [0,1] value into two bytes: `hi = (v >> 8) & 0xFF`, `lo = v & 0xFF`. The shader decodes with: `(hi * 255 * 256 + lo * 255) / 65535`.

Growth is updated per-frame during animation, and the texture is re-uploaded. The shader clips vertices where `t > growth + 0.001`, creating the wavefront effect.

## Stage 8: The Shader

`KiCadTraceShader.js` runs in Lens Studio's shader graph Code Node. It:

1. Applies morph displacement from UV1 (for schematic-to-PCB animation)
2. Looks up growth and hue from the data texture using the trace index
3. Clips invisible vertices (beyond growth front)
4. Colors by net: vivid mode uses HSV rainbow per-net hue, realistic mode uses copper tones
5. Adds a tip glow at the growth wavefront (warm white highlight, only during active growth)
6. Adds an arrival pulse (exponential falloff behind the wavefront)
7. Renders signal flow as marching dashes when flowTime > 0 and trace is fully grown

The tip glow is gated by `isGrowing = 1.0 - step(0.99, growth)`, which turns off all growth effects once the trace reaches 99% grown. This prevents persistent bright spots on fully-grown boards.

## Width Transitions

PCB traces have variable widths: a single merged polyline can span from 0.1mm signal traces to 3.0mm power pours (30x ratio on the RPi CM4 IO board). Each vertex ring is scaled by its local `tubeR = width * 0.5 * scaleFactor`, so width changes directly affect tube geometry.

### Adaptive Width Smoothing

`smoothWidths()` applies cubic ease-in-out blending at width transition points, but with an adaptive window that scales with the magnitude of the change:

```
halfWindow = max(baseTransitionMM, maxWidth * 3.0)
```

A 0.2mm trace keeps the default 2mm window. A 3.0mm power pour gets a 9mm window. This ensures the ramp is proportionally gradual regardless of the width delta.

### Vertex Resampling at Transitions

Width ramps need sufficient vertex density to resolve smoothly as geometry. If a transition zone has only 1-2 original vertices, the cubic ramp is undersampled and appears as a hard step. `smoothWidths()` inserts intermediate vertices at 0.3mm spacing within transition zones by linearly interpolating position along the polyline and evaluating the smoothed width function at each new point.

### Parallel Transport Prevents Bulging at Bends

The parallel transport frame eliminates the frame twisting that compounds with width changes. When the old per-vertex frame computation flipped orientation at a bend (because the fixed up vector produced a discontinuous right vector), the width scaling amplified that flip into a visible bulge. Parallel transport ensures the frame rotates smoothly through bends, so width changes only produce gradual, predictable expansion.

The web viewer avoids all of this by rendering traces as 2D canvas strokes with `lineCap: 'round'` and `lineJoin: 'round'`, where the browser handles join geometry implicitly. In 3D, we solve it with adaptive smoothing, resampling, and parallel transport.
