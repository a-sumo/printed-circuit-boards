# Printed Circuit Boards

Interactive AR circuit board explorer for Snap Spectacles. Renders real KiCad PCB designs as 3D holograms with animated trace growth, layer explode view, signal flow visualization, schematic-to-board morph, and hand gesture controls.

Built with Lens Studio and the Spectacles Interaction Kit.

## Features

- **PCB rendering**: Board substrate, copper traces, vias, pads, solder mask, silkscreen labels, all driven from real KiCad data
- **Layer explode**: Separates the board into a physical layer sandwich with labeled Bezier leader curves
- **Signal flow**: Animated particles travel along trace networks
- **Schematic morph**: Continuous interpolation between PCB layout and per-component schematic placement
- **Hand gestures**: Proximity-driven reveal, double clap to toggle explode view
- **Board catalog**: Switch between bundled boards (Arduino Nano, ATtiny85 USB, RPi CM4 IO, StickHub USB, XIAO Servo) or load your own at runtime
- **Dual rendering**: Vivid (HSV rainbow by net) or Realistic (copper, FR4, green solder mask)

## Repository structure

```
CircuitBoards/                # Lens Studio project (open in LS)
  Assets/
    Scripts/                  # TS source: rendering, UI, sim, tracking
    Shaders/                  # Code Node shader binaries
    Materials/                # .mat / .ss_graph
    Scene.scene               # Main scene
converters/                   # KiCad file converters (.kicad_pcb / .kicad_sch -> JSON)
tools/load-board.mjs          # Convert + patch helper for adding boards
libs/kicad-symbols/           # Submodule: KiCad's open-source symbol library
docs/                         # Engineering docs (rendering, morph, FastDNN, …)
```

## Loading a new board

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/<you>/printed-circuit-boards.git
cd printed-circuit-boards
npm install

# If the .kicad_pcb has footprints but no traces, autoroute it:
node converters/autoroute.mjs path/to/board.kicad_pcb

# Convert + register the board:
node tools/load-board.mjs path/to/board.kicad_pcb my-board "My Board"
```

This converts the PCB, writes `CircuitBoards/Assets/Scripts/Board/data/my-board.js`, and patches `BOARD_MODULES` and `BOARD_CATALOG`. Reopen the project in Lens Studio and the new board appears in the catalog.

You can also load boards at runtime from a JSON string:

```ts
kiCadBoard.loadFromJson(jsonString, "My Board");
```

## Autorouter

`converters/autoroute.mjs` generates plausible PCB trace routing from a `.kicad_pcb` that has placed footprints with net assignments but missing or incorrect traces. Grid-based A* on a 0.2mm grid, two layers (F.Cu/B.Cu), 8-directional movement, MST per net.

```bash
node converters/autoroute.mjs board.kicad_pcb              # in place
node converters/autoroute.mjs board.kicad_pcb routed.kicad_pcb
```

Tuning constants (`VIA_COST`, `NET_WIDTHS`, `GRID_RES`) live at the top of the file. Limitations: no courtyard/keepout obstacles, no copper pour, via count tends to be high. Acceptable for AR visualization, not for fabrication.

## Architecture highlights

- **Shader pipeline**: Two Code Node shaders (`KiCadBoardShader.js`, `KiCadTraceShader.js`) handle both vivid and realistic modes, switching on a `realisticMode` uniform. Per-trace state (growth, hue, arc length) is encoded as 16-bit fixed-point in RGBA8 data textures.
- **Coordinate system**: KiCad is mm/Y-down, Lens Studio is cm/Y-up. `toLS(x, y, z)` applies `(x - cx) * scale, -(y - cy) * scale, z * scale`.
- **Schematic morph**: Per-component local placement above each footprint, with continuous shape interpolation between PCB pad bounds and schematic symbol body. Pin tips slide along body edges; trace pairs are matched by greedy nearest-midpoint.
- **Hand gestures**: SIK `HandInputData`, double-clap detection on palm distance + closing speed.

See `docs/` for deeper notes on rendering, morphing, FastDNN constraints, and the Unity port guide.

## License

MIT. See [LICENSE](LICENSE).
