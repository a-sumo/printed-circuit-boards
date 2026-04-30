# Pi 3 alignment — Blender ↔ Lens Studio

The Pi 3 board has no public KiCad layout; we render it as a hand-authored
labeled overlay (`Scripts/Board/data/raspi-3.js`) plus the GLB photoscan
(`Models/RPi3-debug/RPi3.gltf`). Both sources must align to the same physical
4 cm AR fiducial marker. This file documents the numbers extracted from the
Blender project so the LS scene matches.

## Source: Blender world coordinates (cm, Z-up, scale_length = 0.01)

| Object | World AABB min | World AABB max | World size | World center |
| --- | --- | --- | --- | --- |
| `Object_2` (Pi 3 photoscan body) | (-4.28, -2.90, 0.00) | (4.28, 2.90, 1.24) | 8.56 × 5.80 × 1.24 | (0, 0, 0.621) |
| `Marker_Plane` (4 cm fiducial) | (4.28, -1.97, 0.12) | (8.35, 2.10, 0.12) | 4.06 × 4.06 × 0 | (6.316, 0.067, 0.12) |

Marker is offset from Pi 3 board center (in Blender world coords):
```
marker_center  -  board_center  =  (6.316, 0.067, 0.12) - (0, 0, 0.621)
                                =  (+6.316, +0.067, -0.501) cm
```

i.e. board center sits at `(-6.316, -0.067, +0.501)` cm relative to the
marker.

## Axis conversion Blender → Lens Studio

Blender is **Z-up, right-handed**. Lens Studio is **Y-up, right-handed**
(glTF convention). Standard mapping:

```
Blender (X, Y, Z)   →   LS (X, Z, -Y)
```

Applied to the board-relative-to-marker offset:
```
Blender (-6.316, -0.067, +0.501)   →   LS (-6.316, +0.501, +0.067) cm
```

So in the LS scene, a child SceneObject placed at local position
`(-6.316, +0.501, +0.067)` cm relative to the marker tracker
will sit at the same world location as the Pi 3 board center in Blender.

## Scale factor (KiCad mm ↔ LS cm)

The procedural board outline lives in KiCad mm. `KiCadBoard.scaleFactor` (set
to **0.1** in the scene) converts: `1 KiCad mm → 0.1 LS cm = 1 mm`. So an
85.6 mm wide outline renders at 8.56 cm in LS — matches the Blender GLB
exactly.

The procedural Pi 3 outline (`tools/gen-raspi-3.mjs`) is now sized
**85.6 × 58.0 mm** to match the Blender `Object_2` world AABB.

## GLB photoscan in LS

`Models/RPi3-debug/RPi3.gltf` was imported with
`ConvertMetersToCentimeters: true`. The Sketchfab prefab root has scale 100 to
land at 8.5 × 5.8 cm in LS units. Assets:

| What | UUID |
| --- | --- |
| GLB Scene prefab | `2138bc12-d780-4e2a-b6bf-feef9580a6cf` |
| Mesh `Object_2` (the photoscan body) | `f606b7eb-15b4-49f5-a8c3-243215c7dde7` |
| Material (photo-textured) | `59437485-b64b-40b8-84a6-a67798d9de61` |
| Texture `Material_baseColor` (2048²) | `4f96a2a9-4771-43f9-8c28-583c29020565` |

To use the photoscan as the realistic-mode "texture" for the Pi 3 board:

1. Drag the imported GLB prefab as a child of the raspi-3 KiCadBoard
   SceneObject (UUID `d6dfd949-9552-40c4-bb3d-c71d62935ec2`).
2. In LS, the prefab's **`Sketchfab_model`** child has rotation `(-90°, 0, 0)`
   on import (Blender import convention). LS is Y-up native, so **clear
   that rotation** — set local rotation to `(0, 0, 0)` so the board lays
   flat on the XZ plane (LS convention).
3. The procedural KiCadBoard substrate is centered at LS local `(0, 0, 0)`
   with the top face at `+0.08 cm`. To put the GLB photo flush with the top
   face: set GLB local position to `(0, +0.08, 0)` cm.

## Marker-tracker offset in LS

The KiCadBoard SceneObject (the procedural board with all the labeled pads)
should be a child of whatever Marker Tracking SceneObject the camera is
detecting. To replicate the Blender scene's relative pose, set the
KiCadBoard SceneObject's local transform to:

```
position = (-6.316, +0.501, +0.067)  cm
rotation = (0, 0, 0)
scale    = (1, 1, 1)
```

(The marker is on top of the board to the right of center; this offset
shifts the rendered board left so the physical marker sits over the right
edge of the rendered board.)

## Sanity-check formula

If you ever change the Blender scene, regenerate these numbers:

```python
import bpy
m = bpy.data.objects['Marker_Plane'].matrix_world.translation
b = bpy.data.objects['Object_2'].matrix_world.to_translation()  # or center via bbox
# board-relative-to-marker, Blender Z-up:
dx, dy, dz = b.x - m.x, b.y - m.y, b.z - m.z
# Convert to LS Y-up:
ls_x, ls_y, ls_z = dx, dz, -dy
print(f'LS local pos = ({ls_x:.4f}, {ls_y:.4f}, {ls_z:.4f}) cm')
```
