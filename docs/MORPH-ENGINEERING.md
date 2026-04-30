# Morph Engineering: Schematic to PCB

Blog scaffolding for the intent engineering post. Technical narrative of making a topological morph between KiCad schematic and PCB views work on Spectacles AR.

## 1. The Problem

- KiCad schematic: logical diagram. Symbols connected by rectilinear wires on a flat page. Components arranged for human readability, not physical proximity.
- KiCad PCB: physical layout. Footprints placed on a board, connected by copper traces that follow organic routing paths. Everything constrained by actual board geometry.
- Goal: morph between these two representations in real-time on Spectacles AR, vertex by vertex. Components slide from schematic position to PCB position, wires deform into traces, the whole topology reshapes continuously.
- This is a proper topological morph, not a crossfade or dissolve. Every vertex in the schematic view has a corresponding destination in the PCB view and they interpolate through a single `morphT` uniform (0 = schematic, 1 = PCB).
- The morph makes the relationship between logical design and physical implementation tangible in a way that flat screens can't. You hold the board in your hand and see the schematic reorganize itself into copper.

## 2. First Approach (Broken)

- Encoded morphT as negative flowTime uniform. flowTime was already used for signal-flow animation (traveling arrow pulses along fully-grown traces), so negative values were repurposed to mean "morph in progress."
  - Shader code: `float morphT = max(0.0, -flowTime);` in KiCadTraceShader.js line 42
  - This meant morphing and signal flow were mutually exclusive. Hack, but it avoided adding a new parameter to the .ss_graph binary.
- Baked per-vertex UV1 offsets as delta vectors from schematic position to PCB position.
  - `texture1: morph displacement (LS cm)` stored in UV1 channel, interpolated between wire start/end deltas
  - Shader applies: `pos.x += uv1.x * morphT; pos.y += uv1.y * morphT;`
- Inferred net correspondence from position-based label matching: find labels in the schematic, find labels in the PCB, match by name string.

### Test board: Seeed Studio XIAO RS485 (partial schematic, one page of multi-sheet design)

**Results:**
- 55/106 component matches (~52%)
- ZERO net name matches between schematic and PCB (0/N)
- Root cause: naming convention mismatch
  - Schematic used flat labels: `RS485_A`, `+3.3V`, `MISO`
  - PCB used hierarchical paths: `/IO_Banks/Z0_P`, `+3V3`, `/SPI_Bus/MOSI`
  - Different scoping, different abbreviations, different hierarchy depth
- The morph "worked" visually in the sense that vertices moved, but the mapping was wrong: wires animated to random positions because there was no actual correspondence between schematic wires and PCB traces.

## 3. Data Quality Matters

- Key insight from EDA documentation: "Reference designators are the primary link between schematic and PCB. The netlist file is the formal mapping."
- The XIAO RS485 was a bad test case: partial schematic (one sheet of a multi-sheet design), which meant half the components had no schematic representation at all.
- Switched test board to **Arduino Nano** (sabogalc/KiCad-Arduino-Boards on GitHub).
  - Single-sheet schematic, complete board
  - Clean KiCad 8 project with `.kicad_sch` + `.kicad_pcb` in same directory
  - 34 components, 33 named nets, well-understood reference design

## 4. Fixing the Converters

### Schematic converter (`kicad-sch-to-json.mjs`)

Original `extractLabels` only extracted `(label ...)` elements (local labels).

**Problem:** Arduino Nano uses `(global_label ...)` for all 64 signal names (D0-D13, A0-A7, VIN, RESET, etc.). Power symbols (GND, +5V, +3V3) are placed instances with `lib_id: "power:..."`, not label elements at all. The converter was missing every signal and every power net.

**Fix:**
- Extract `global_label` and `hierarchical_label` in addition to `label` (lines 258-269)
- New function `extractPowerLabels()`: scans instances for `#PWR`/`#FLG` refs or `power:` lib_ids, converts their `value` property to label entries with `type: 'power'` (lines 276-288)
- Merged into single `allLabels` array so power nets participate in topology propagation

### PCB converter (`kicad-to-json.mjs`)

**Problem:** KiCad S-expressions encode forward slashes as `{slash}` in net names. The schematic converter decoded this (`name.replace(/\{slash\}/g, '/')`), but the PCB converter originally did not. A net called `Net-(U1-/RESET)` in the schematic would be `Net-(U1-{slash}RESET)` in the PCB JSON. Zero matches.

**Fix:** Added `.replace(/\{slash\}/g, '/')` normalization to both the net name map (line 198) and per-pad net names (line 338) in kicad-to-json.mjs.

## 5. Results: 100% Match

After fixing both converters and switching to the Arduino Nano:

- **34/34 components matched** (100% by reference designator)
- **33/33 schematic nets matched to PCB nets** (100% by normalized name)
- **28 nets have both schematic wires AND PCB traces** (bidirectional coverage)
- **184/219 wires assigned to a named net** (84% wire coverage)
  - Remaining 35 wires are short stubs connecting to junctions or unlabeled local connections
- **PCB-only nets** are internal connections (`Net-(D2-K)`, unconnected pads) that have no schematic representation because they're implied by component placement

### Wire-to-trace ratio (selected nets)

| Net | Sch Wires | PCB Traces | Ratio |
|-----|-----------|------------|-------|
| GND | 60 | 10 | 0.2x |
| +5V | 18 | 8 | 0.4x |
| D13/SCK | 6 | 38 | 6.3x |
| RESET | 8 | 4 | 0.5x |

- Power nets have many schematic wires (every component needs power) but few board traces (pour or star routing)
- Signal nets can have few schematic wires but many PCB traces (serpentine routing, vias, length matching)
- This ratio matters for the morph: you can't do 1:1 wire-to-trace vertex mapping when the counts differ by 6x

## 6. Correspondence Table Format

### Per-component entry
```
{
  ref: "U1",
  schPos: [152.4, 88.9],    // KiCad mm, schematic page coords
  schRot: 0,
  pcbPos: [134.62, 64.77],  // KiCad mm, board coords
  pcbRot: 270,
  pcbLayer: "F.Cu",
  pins: [
    { number: "1", name: "PC6", schNet: "RESET", pcbNet: "RESET", match: true },
    { number: "2", name: "PD0", schNet: "D0/RX", pcbNet: "D0/RX", match: true },
    ...
  ]
}
```

### Per-net entry
```
{
  name: "GND",
  schWires: 60,
  pcbTraces: 10,
  ratio: 0.17,
  bidirectional: true   // has representation in both views
}
```

### Pin-to-pad mapping
- Pin number is the primary key (not pin name, which can differ)
- Schematic pin position = symbol origin + rotated pin offset (in KiCad mm)
- PCB pad position = footprint origin + rotated pad offset (in KiCad mm)
- Match status: pin's schematic net name equals pad's PCB net name after normalization

HTML visualization generated at `/tmp/nano-correspondence.html` for debugging (color-coded match status per pin).

## 7. Architecture: Current Morph Implementation

### Component morph (SceneObject-level, SchematicBoard.ts)
- Each non-power component gets its own SceneObject (stored in `symbolObjects` map)
- `schematicPositions` and `pcbLSPositions` maps hold the two endpoints per ref
- `applyMorph(t)` lerps position: `schPos + (pcbPos - schPos) * t`
- Rotation: delta between schematic and PCB rotation, applied as Z-axis quat, shortest path normalized to [-180, 180]
- Anisotropic scale: symbol bounding box deforms toward footprint proportions (schematic symbols are often wider than tall, PCB footprints have different aspect ratios)
- Labels fade out during mid-morph (t in [0.25, 0.8]) and fade back in at endpoints

### Wire morph (vertex-level, KiCadTraceShader.js)
- `buildMorphDeltaMap()` computes per-vertex displacement vectors
- For each schematic pin: look up the corresponding PCB pad position via `ref:pinNumber` key
- Delta = padLS - pinSchLS (Lens Studio centimeter space)
- Falls back to component-center delta when pad data is missing
- BFS junction propagation: spreads known deltas through the wire network (up to 20 iterations) so wires that don't directly touch a pin still get a delta from their connected neighbors
- Deltas baked into UV1 channel at mesh build time
- Shader reads UV1 and applies: `pos.xy += uv1.xy * morphT`

### Scale normalization
- PCB boards are physically small (Arduino Nano is ~43x18mm), schematics are large (page-sized, ~200x150mm)
- `pcbMorphScale` = min(schW/pcbW, schH/pcbH) scales PCB positions up to match schematic extent
- Without this, components would collapse to a tiny cluster during morph

### PCB trace rendering
- Separate mesh group (`pcbTraceGroups`) with own data texture for growth
- Hidden at morphT=0, revealed as morphT increases
- Same KiCadTraceShader used for both schematic wires and PCB traces (shared tube geometry pipeline)
- All PCB layers flattened to one plane (morph is 2D, Z-layer stacking only matters in pure PCB view)

## 8. Architecture: Proper Morph (Next Step)

The current approach morphs components correctly but treats wire deformation as a per-vertex displacement. The next version needs actual curve correspondence.

### The plan
- For each matched net: collect schematic wire segments and PCB trace segments as two separate curve sets
- Resample both curve sets to equal vertex counts (1:1 vertex correspondence). This handles the wire-to-trace ratio problem: a GND net with 60 schematic wires and 10 PCB traces gets unified into one set of N vertices that represents both views.
- Build single mesh with dual position attributes: attribute0 = schematic position, UV1 = PCB position
- Shader: `pos = mix(schematicPos, pcbPos, morphT)` with a dedicated `input_float morphT`
- No more flowTime hack. morphT gets its own uniform, driven from script via `pass["morphT"] = value`

### Lens Studio constraint
- Code Node source is embedded in the binary .ss_graph file, which can't be modified via MCP or filesystem writes
- One-time manual step: open the .ss_graph in Lens Studio, add a Float Parameter named `morphT`, wire it to the Code Node input
- After that, all deployment and animation is scriptable: `pass["morphT"] = 0.5` from TypeScript

### Curve resampling strategy
- Compute total arc length for schematic wire set and PCB trace set per net
- Resample both to N points (N = max of the two original point counts, clamped to avoid over-tessellation)
- Preserve topology: junctions in the schematic map to vias/junctions in the PCB
- Open question: how to handle branching nets (T-junctions) where schematic has star topology and PCB has tree topology

## 9. Key Files

| File | Role |
|------|------|
| `scripts/kicad-sch-to-json.mjs` | Schematic S-expr to JSON (fixed: global labels, power ports) |
| `scripts/kicad-to-json.mjs` | PCB S-expr to JSON (fixed: `{slash}` normalization) |
| `spectacles/eywa-specs/Assets/Connectors/SchematicBoard.ts` | Renderer + morph engine (~2800 lines) |
| `spectacles/eywa-specs/Assets/Connectors/KiCadTraceShader.js` | Tube trace shader with morphT displacement |
| `spectacles/eywa-specs/Assets/Connectors/KiCadBoard.ts` | PCB-only renderer (non-morph, used for standalone board view) |
| `test/screenshot-mapping.mjs` | Puppeteer screenshot for correspondence HTML debug view |

### Arduino Nano reference data
- Source: `sabogalc/KiCad-Arduino-Boards` on GitHub
- Converted JSON: `/tmp/arduino-nano/` (sch.json, pcb.json)
- Correspondence HTML: `/tmp/nano-correspondence.html`

## 10. Lessons

- **Data quality beats algorithm quality.** The first morph attempt had correct math but wrong data. Fixing two string normalization bugs (`global_label` extraction, `{slash}` encoding) took the match rate from 0% to 100%.
- **Reference designators are the bridge.** Net names are unreliable across schematic/PCB boundaries because naming conventions differ (flat vs hierarchical, abbreviations, scope). Pin numbers within a reference designator are the atomic unit of correspondence.
- **Test on complete, single-sheet designs.** Multi-sheet schematics add hierarchy that breaks naive matching. Start with the simplest possible board that still has real complexity (the Arduino Nano has 34 components and 33 nets, which is enough to exercise every edge case).
- **Morph scale normalization is non-obvious.** Schematics and PCBs exist at totally different scales and the morph looks wrong (components collapsing to a point) without explicit scale matching.
- **The flowTime hack works but doesn't scale.** Overloading an existing uniform to avoid touching the .ss_graph binary was a fast shortcut, but it makes morphing and signal flow mutually exclusive. A dedicated morphT parameter is the right architecture.
