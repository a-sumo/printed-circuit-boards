# Connectors: Electronics Visualization for Spectacles

Three rendering systems for electronics on Spectacles additive display, plus a real-time circuit solver. All share the same shader pipeline and color conventions.

## Files

| File | Role |
|------|------|
| `KiCadBoard.ts` | PCB renderer: board substrate, 3D tube traces, pads, vias, labels, DigiCube materialization |
| `KiCadBoardShader.js` | Flat unlit shader for board/pad/via geometry (vertex colors baked in UVs) |
| `KiCadTraceShader.js` | 3D tube shader with growth animation, tip glow, HSV net coloring |
| `ElectronicsLab.ts` | JSON-driven electronics workbench: resistors, LEDs, capacitors, headers, breadboard |
| `ElectronicsLabShader.js` | Flat unlit shader with sim data texture support (brightness, heat, growth per component) |
| `CircuitSim.ts` | Interactive drag-and-snap circuit simulation with SIK grab, breadboard connectivity |
| `CircuitSolver.ts` | Modified Nodal Analysis DC solver (pure math, no LS deps) |

## Architecture

```
KiCad .kicad_pcb
    │  scripts/kicad-to-json.mjs
    ▼
board.json ──► KiCadBoard.ts ──► MeshBuilder geometry
                  │                    │
                  │  boardMaterial ─────► KiCadBoardShader.js (flat unlit, vertex colors)
                  │  traceMaterial ─────► KiCadTraceShader.js (growth + tip glow)
                  │  digiMaterial ──────► DigiCubeShader.js (voxel materialization)
                  │
                  ▼
              ProceduralTexture (1xN RGBA8: growth + hue per trace)


scene.json ──► ElectronicsLab.ts ──► MeshBuilder geometry
                  │                       │
                  │  boardMaterial ────────► ElectronicsLabShader.js (colors + sim data)
                  │  wireMaterial ─────────► KiCadTraceShader.js (reused for wire growth)
                  │
                  ▼
              Sequential wire growth animation, LED blink


CircuitSim.ts ──► ElectronicsLab (static geometry helpers)
    │             CircuitSolver.ts (MNA DC solve)
    │
    ▼
SIK Interactable + InteractableManipulation
    │  pinch-grab palette ──► clone component
    │  drag to breadboard ──► snap to grid
    │  release ──► rebuild netlist ──► solve ──► update sim texture
    ▼
ProceduralTexture (1x64 RGBA8: brightness, heat, growth per component)
    │
    ▼
ElectronicsLabShader.js reads sim data per-vertex via componentTag
```

## Vertex Encoding Convention

All three renderers pack color and metadata into UV texture channels because LS Code Nodes can only read position, normal, and texture coordinates.

### KiCadBoard / ElectronicsLab (board geometry)

| Channel | Components | Content |
|---------|-----------|---------|
| texture0 | (u, v) | Red, Green color channels |
| texture1 | (u, v) | Blue channel, componentTag or revealDist |

### KiCadTraceShader (tube traces)

| Channel | Components | Content |
|---------|-----------|---------|
| texture0 | (u, v) | parametric t along polyline [0,1], traceIndex |
| texture1 | (u, v) | unused, unused |

### ElectronicsLabShader componentTag values

| Range | Meaning |
|-------|---------|
| 0.0 - 0.49 | Inert geometry (breadboard, leads, housing) |
| 0.5 - 0.99 | Legacy LED (uses EmissivePulse uniform) |
| >= 1.0 | Sim-driven component. `floor(tag)` = row in sim data texture (1-based) |

## Data Textures

### Trace texture (KiCadTraceShader)

1-pixel wide, N rows tall (one row per polyline). RGBA8 encoding:

| Byte | Content | Decode |
|------|---------|--------|
| R, G | Growth [0, 1] | `(R * 255 * 256 + G * 255) / 65535` |
| B, A | Net hue [0, 1] | Same 16-bit decode, passed to `hsv2rgb(hue, 0.9, 0.9)` |

### Sim texture (ElectronicsLabShader)

1-pixel wide, 64 rows (MAX_SIM_ROWS). One row per placed component.

| Byte | Content | Range |
|------|---------|-------|
| R | Brightness / emissive | 0-255 mapped to 0-1. LED at 20mA = full. |
| G | Heat glow | 0-255. Resistor at 0.5W = full. Warm orange overlay. |
| B | Growth | 0-255. Component materialization (0 = invisible, 255 = full size). |
| A | Reserved | 0 |

## KiCadBoard

Renders a KiCad PCB from JSON produced by `scripts/kicad-to-json.mjs`.

### Inspector Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| boardData | string | "" | Board JSON (paste from converter output) |
| traceMaterial | Material | - | Material with KiCadTraceShader.js |
| boardMaterial | Material | - | Material with KiCadBoardShader.js |
| autoPlay | string | "" | "all" to auto-grow all nets on awake |
| scaleFactor | number | 1.0 | KiCad mm to LS cm conversion |
| labelFont | Font | - | Font for component ref labels |
| labelSize | number | 100 | Text size in LS font units |
| showBoard | bool | true | Toggle board substrate visibility |
| showTraces | bool | true | Toggle copper traces |
| showVias | bool | true | Toggle vias |
| showPads | bool | true | Toggle pads |
| showLabels | bool | true | Toggle component ref labels |
| digiMaterial | Material | - | DigiCube material for voxel materialization (optional) |

### Z-Layer Stacking

Offsets from board surface (in mm, scaled by scaleFactor):

| Layer | Z Offset | Content |
|-------|----------|---------|
| Board substrate | 0 | Blue slab with FR4 tan edges |
| Fabrication | +0.08 | Component body outlines (dim silkscreen) |
| Traces | +0.10 | 3D copper tubes with hemisphere caps |
| Courtyard | +0.14 | Component boundary lines (bright silkscreen) |
| Pads | +0.18 | Gold/net-colored pads (rect or circular with drill hole) |
| Via hole | +0.20 | Dark via drill holes |
| Via ring | +0.22 | Net-colored annular rings |

### Trace Pipeline

1. `kicad-to-json.mjs` parses KiCad S-expressions into `{traces, footprints, vias, board}` JSON
2. Segment merging: spatial hash at 0.001mm grid chains same-net/width segments into polylines
3. Bezier corner smoothing: quadratic arcs at corners (0.35 * min segment length)
4. 3D tube geometry: N rings of 6 vertices along polyline, hemisphere caps (2 latitude rings + pole)
5. Mesh batching: split at 63K vertex limit, shared material clone per layer
6. Growth order: BFS from power nets (GND, VCC, +3V3, +5V, VBUS) through component adjacency

### Per-Net Coloring

Vias and pads are colored by net using golden-ratio hue distribution:

```
hue = (netId * 0.618033988749895) % 1.0
rgb = hsv2rgb(hue, 0.85, 0.9)
```

Unconnected pads use default gold. This matches the trace shader's HSV coloring so traces, pads, and vias on the same net share the same hue.

### DigiCube Board Materialization

When `digiMaterial` is assigned, the board appears as voxel cubes that expand from center before swapping to real geometry:

1. Board outline is voxelized onto a ~20-cell grid (point-in-polygon test)
2. Each cube has 8 shared vertices with center/offset encoded in UV channels
3. DigiCubeShader scales cubes from zero to full size based on effector radius
4. Effector expands from board center over `digiDuration` (2.5s default)
5. When complete: cubes destroyed, real board geometry enabled, trace growth starts
6. Labels reveal as the wavefront passes their position

Without `digiMaterial`, the board appears instantly with a 0.5s delay before trace growth.

### Public API

```typescript
selectFootprint(ref: string): void      // Highlight a footprint
deselectFootprint(): void               // Clear highlight
hitTestFootprint(x: number, y: number): string | null  // Ray test
growFromFootprint(ref: string): void    // Start growth from a specific footprint
startGrowAll(): void                    // BFS growth from power nets
```

## ElectronicsLab

JSON-driven workbench for educational electronics visualization. Components are schematic-style 3D (simplified, not photorealistic).

### Inspector Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| sceneData | string | (example scene) | JSON with components[] and wires[] |
| boardMaterial | Material | - | Material with ElectronicsLabShader.js |
| wireMaterial | Material | - | Material with KiCadTraceShader.js |
| labelFont | Font | - | Font for component labels |
| scale | number | 2.0 | Global scale (1 = 1mm per cm) |
| autoAnimate | bool | true | Auto-animate signal flow on start |

### Scene JSON Format

```json
{
  "components": [
    {
      "id": "R1",
      "type": "resistor",
      "pos": [5, -20, 0],
      "rot": 90,
      "config": { "label": "R1", "value": 220 }
    },
    {
      "id": "LED1",
      "type": "led",
      "pos": [5, -30, 0],
      "config": { "label": "LED1", "color": "red", "blinkRate": 2 }
    }
  ],
  "wires": [
    {
      "from": { "component": "R1", "pin": "2" },
      "to": { "component": "LED1", "pin": "anode" },
      "color": "yellow"
    }
  ]
}
```

### Component Types

| Type | Config | Pins | Geometry |
|------|--------|------|----------|
| resistor | `value` (ohms) | "1", "2" | Cylinder body + color bands + leads |
| led | `color`, `blinkRate` | "anode", "cathode" | Cylinder base + hemisphere dome + leads |
| capacitor | `value` (string) | "1", "2" | Cylinder body + marking band + leads |
| header | `pins`, `rows`, `pinLabels` | "ROW-COL" or label name | Plastic housing + gold pins |
| breadboard | `cols`, `rows` | Grid positions | Flat board with rail stripes |

### Z Convention

z=0 is the breadboard top surface. Components sit above (z > 0), leads descend through holes (z < 0). Wire routing happens at z=0 for clean connections.

### Static Geometry Helpers

ElectronicsLab exposes static methods for reuse by CircuitSim:

```typescript
static newMB(): MeshBuilder
static appendCylinder(mb, cx, cy, cz, startX, endX, radius, r, g, b, a, ao, segs, isVertical, tag?)
static appendBox(mb, cx, cy, cz, w, h, d, r, g, b, a, ao, tag?)
static appendHemisphere(mb, cx, cy, cz, radius, r, g, b, segs, tag?)
static resistorBands(ohms): number[][]
static ledColor(color): [number, number, number]
static formatResistance(ohms): string
```

### Public API

```typescript
setLED(id: string, on: boolean): void
setResistorValue(id: string, ohms: number): void
getPin(componentId: string, pinName: string): vec3 | null
select(componentId: string): void
animateSignal(wireIndex: number): void
hitTest(x: number, y: number): string | null
```

## CircuitSim

Interactive drag-and-snap circuit building. Combines ElectronicsLab geometry with a real-time MNA solver for live simulation feedback on Spectacles.

### Inspector Inputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| boardMaterial | Material | - | ElectronicsLabShader.js (with simTex, SimTexHeight, GlobalGrowth params) |
| wireMaterial | Material | - | KiCadTraceShader.js |
| labelFont | Font | - | Component labels |
| scale | number | 2.0 | Global scale |
| bbCols | number | 30 | Breadboard column count |
| bbRows | number | 10 | Breadboard row count |
| includeVSource | bool | true | Include 3.3V source in palette |

### Interaction Flow

1. **Palette** floats left of breadboard with template components (220R, 1K, red LED, amber LED, 100nF, 3.3V source)
2. **Pinch-grab** on a template clones it as a PlacedComponent with a unique sim index
3. **SIK InteractableManipulation** handles drag transform tracking natively
4. **Release** snaps to nearest valid breadboard grid cell (2.54mm pitch)
5. **Topology change** triggers: netlist rebuild from grid connectivity, MNA solve, wire mesh rebuild, sim texture update
6. Picking up a placed component unregisters it from the grid and re-enables dragging

### Breadboard Connectivity

The breadboard follows standard real-world wiring:

| Row Range | Net Pattern |
|-----------|-------------|
| Power rail top (row < 0) | `rail_vcc_top` (all columns connected) |
| Ground rail top (row 0) | `rail_gnd_top` |
| Rows a-e (0-4) | `col_N_top` (5 holes per column, connected vertically) |
| Center gap | No connection |
| Rows f-j (5-9) | `col_N_bot` (5 holes per column, connected vertically) |
| Ground rail bottom | `rail_gnd_bot` |
| Power rail bottom | `rail_vcc_bot` |

### CircuitSolver

Pure-math MNA DC solver. No Lens Studio dependencies, can be tested standalone.

```typescript
const solver = new CircuitSolver();
solver.addResistor('n1', 'n2', 220);
solver.addLED('n2', 'n3', 1.8, 10);       // Vf=1.8V, internal 10R
solver.addVoltageSource('n1', 'gnd', 3.3);
const result = solver.solve();
// result.nodeVoltages.get('n1') => 3.3
// result.branchCurrents.get(0) => ~0.0068A
// result.branchPower.get(0) => ~0.010W
```

Supported elements: resistor, voltage source, wire (0.001R), LED (Vf + series R), capacitor (open for DC).

Solver uses Gaussian elimination with partial pivoting. Ground node is implicit at 0V. LED creates an internal node and models as voltage source + series resistance.

### Sim Feedback

Solver results drive the sim data texture read by ElectronicsLabShader:

| Component | Visual Feedback | Mapping |
|-----------|----------------|---------|
| LED | Additive brightness glow | `brightness = min(1, abs(current) / 0.020)` |
| Resistor | Warm orange heat overlay | `heat = min(1, power / 0.5)` |
| All | Materialization growth | GlobalGrowth ramps 0 to 1 over 2s on awake |

## Color Rules

All connectors follow Spectacles additive display constraints:

- **Black = transparent.** Minimum brightness floor of 0.05 in all shaders.
- **No purple, green, or cyan.** Warm palette only.
- **High saturation.** No washed-out steel blues.
- Board: vivid blue (#1878e0). Edges: FR4 tan (#a08050).
- Pads: vivid gold (#e8b010). Vias: vivid orange (#c85020).
- Resistor body: warm beige (0.76, 0.70, 0.56) in CircuitSim, warm brown (0.45, 0.30, 0.18) in ElectronicsLab.
- LED colors: red (0.95, 0.15, 0.10), amber (0.95, 0.60, 0.05), white (0.95, 0.92, 0.85).
- Labels: off-white fill (0.94, 0.94, 0.91), depthTest=false, renderOrder=100.

## Gotchas

- **UInt16 index limit**: max 65535 vertices per MeshBuilder mesh. KiCadBoard batches trace meshes at 63K. CircuitSim caps sim texture at 64 rows.
- **Text.size is font units, not centimeters.** Use large values (48-100) for visibility.
- **LS auto-compiles on file save.** No need to call CompileWithLogsTool after writing files via MCP.
- **SIK import path**: `require("SpectaclesInteractionKit.lspkg/...")` with `.lspkg` suffix.
- **Collider required for SIK interaction.** CircuitSim creates `Physics.ColliderComponent` + `Shape.createBoxShape()` on each grabbable.
- **InteractableManipulation handles drag transforms.** Don't manually update position during drag. Just snap on release.
- **Deploy large boards via /tmp script.** `execSync` buffer overflow for boards > 64KB. Write a .mjs to /tmp and run with node.
