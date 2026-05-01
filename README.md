# Printed Circuit Boards

> **Try it on Spectacles:** [Open the Lens →](https://www.spectacles.com/lens/fb381feaa0184ffc99ef263365c04a61?type=SNAPCODE&metadata=01)

Interactive AR circuit board explorer for Snap Spectacles. Renders real KiCad PCB designs as 3D holograms you can grab, rotate, and pull apart layer by layer. Built with Lens Studio and the Spectacles Interaction Kit.

## Features

- **PCB rendering** from real KiCad data: substrate, copper traces, vias, pads, solder mask, silkscreen.
- **Layer explode**: pull the PCB apart into its physical layer sandwich, with labeled leader curves.
- **Signal flow**: animated particles travel along trace networks.
- **Schematic morph**: continuous interpolation between PCB layout and per-component schematic placement.
- **Tap a component** to see its reference, value, and net.
- **Board catalog**: Arduino Nano, ATtiny85 USB, RPi CM4 IO, StickHub USB, XIAO Servo.
- **Vivid or Realistic** rendering: HSV-by-net, or copper / FR4 / green solder mask.

## Repository

```
CircuitBoards/        Lens Studio project (open in Lens Studio)
converters/           KiCad .kicad_pcb / .kicad_sch -> JSON
tools/load-board.mjs  Convert + register a new board
libs/kicad-symbols/   Submodule: KiCad's open symbol library
```

## Adding a board

```bash
git clone --recurse-submodules https://github.com/a-sumo/printed-circuit-boards.git
cd printed-circuit-boards && npm install
node tools/load-board.mjs path/to/board.kicad_pcb my-board "My Board"
```

Reopen the project in Lens Studio and the new board appears in the catalog.
