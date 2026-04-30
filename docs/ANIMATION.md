# Animation Controller

Scene-graph-aware animation engine for Lens Studio. Three layers: property resolution, baked sequences with per-keyframe easing, and a flat state machine with crossfade blending. Plus runtime motion primitives that read current positions and generate sequences dynamically.

## Files

- `eywa-specs/Assets/Connectors/AnimationController.ts` - the engine (1350 lines)
- `webxr-volume/examples/animator.html` - browser GSAP timeline editor for live authoring

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │         AnimationController          │
                    │                                     │
  Inputs:           │  ┌──────────┐   ┌───────────────┐   │
  bakedJson ───────>│  │ Sequence │   │ State Machine │   │
  stateJson ───────>│  │ Storage  │<──│ (states,      │   │
  relay msgs ──────>│  │          │   │  transitions, │   │
  script calls ────>│  │ name ->  │   │  params,      │   │
                    │  │ BakedSeq │   │  crossfade)   │   │
                    │  └────┬─────┘   └───────┬───────┘   │
                    │       │                 │           │
                    │       v                 v           │
                    │  ┌──────────────────────────┐       │
                    │  │  sampleTrack(track, time) │       │
                    │  │  Binary search + easing   │       │
                    │  └────────────┬──────────────┘       │
                    │               │                     │
                    │               v                     │
                    │  ┌──────────────────────────┐       │
                    │  │  Property Resolution      │       │
                    │  │  name -> SceneObject      │       │
                    │  │  prop -> transform/script │       │
                    │  └──────────────────────────┘       │
                    └─────────────────────────────────────┘
```

### Layer 1: Property Resolution

On awake, the controller walks the scene graph from `root` downward and builds a registry mapping object names to their SceneObjects, scripts, and materials. When setting a property:

1. **Transform props** (`x`, `y`, `z`, `rotX`, `rotY`, `rotZ`, `scaleX`, `scaleY`, `scaleZ`) - set directly on `getTransform()`. Rotation stores euler angles internally and converts to quaternion via `quat.fromEulerAngles`.
2. **Script methods** - dispatched by detected script type (TronFrame, CircuitConnector, KiCadBoard). Example: `seg3` calls `setSegmentGrowth(3, value)`, `conn2Bridge` calls `setConnectionBridgeGrowth(2, value)`.
3. **Script inputs** - direct property assignment for any numeric `@input` (e.g., `growth`, `exitGrowth`).
4. **Material properties** - fallback: sets `material.mainPass[prop]`. Prefix `mat_` is stripped.

### Layer 2: Baked Sequences

A sequence is a named collection of tracks, each targeting a named SceneObject and driving one or more properties over time.

```json
{
  "my-sequence": {
    "duration": 1.5,
    "tracks": [
      {
        "target": "CubeA",
        "properties": [
          {
            "property": "y",
            "keyframes": [
              { "time": 0, "value": 20 },
              { "time": 0.8, "value": 0, "ease": "bounce.out" }
            ]
          },
          {
            "property": "scaleX",
            "keyframes": [
              { "time": 0, "value": 0.8 },
              { "time": 0.8, "value": 8, "ease": "back.out" }
            ]
          }
        ]
      }
    ]
  }
}
```

**Keyframe sampling** uses binary search to find the active segment, then applies the destination keyframe's easing function. The `ease` field is on the "to" keyframe (the one you're easing into).

**Scale values are absolute** (LS centimeters). If a cube has base scale 8cm, use `8` not `1.0`. Relative multipliers must be pre-computed: `S * 1.4` = `11.2`.

**Timing uses delta-time accumulation**, not absolute timestamps. `elapsed += dt * timeScale`. This keeps playback speed correct regardless of frame rate and supports the `timeScale` slider.

### Layer 3: State Machine

Modeled after Unity Animator: flat states that reference sequences, transitions that fire on param conditions or triggers, and crossfade blending between states.

```json
{
  "sequences": { ... },
  "stateMachine": {
    "initial": "intro",
    "states": {
      "intro":  { "sequence": "cube-intro",  "loop": false, "next": "idle" },
      "idle":   { "sequence": "cube-idle",   "loop": true },
      "active": { "sequence": "cube-active", "loop": true },
      "exit":   { "sequence": "cube-exit",   "loop": false, "next": null }
    },
    "transitions": [
      { "from": "idle",   "to": "active", "conditions": [{ "param": "selected", "op": "eq", "value": true }],  "duration": 0.3 },
      { "from": "active", "to": "idle",   "conditions": [{ "param": "selected", "op": "eq", "value": false }], "duration": 0.3 },
      { "from": "*",      "to": "intro",  "trigger": "reset",   "duration": 0.0 },
      { "from": "*",      "to": "exit",   "trigger": "dismiss", "duration": 0.2 }
    ],
    "params": {
      "selected": { "type": "bool", "default": false }
    }
  }
}
```

**States** reference a sequence name, have a `loop` flag, and an optional `next` state for auto-transition when the sequence finishes. `next: null` means terminal (stays on last frame).

**Transitions** match on `from` state (`*` = any). Two trigger modes:
- **Conditions**: evaluated every frame. `param` + `op` (`eq`, `neq`, `gt`, `lt`, `gte`, `lte`) + `value`. All conditions must pass.
- **Triggers**: fire-once events, consumed on use. Set via `fireTrigger("name")`.

Optional `exitTime` (0-1 normalized) gates the transition until the current sequence reaches that point.

**Crossfade blending**: when `duration > 0`, the controller snapshots current property values, then linearly interpolates between the snapshot and the target state's sampled values. If a new transition fires mid-crossfade, it re-snapshots the current blended values as the new source.

### Motion Primitives

Runtime sequence generators that read current transforms via `readTransform()`, compute target values, and produce `BakedSequence` objects fed into the existing playback system. This means all easing, timing, and property resolution works the same as baked sequences, but the keyframes adapt to current layout.

Each primitive stores its generated sequence with a `__` prefix name (e.g., `__focus`, `__swap`). Call from other scripts or via relay messages.

#### focus(targetName, opts?)

Brings one element forward toward the viewer. Pushes sibling objects (same z-depth, within 15cm) backward. Grows TronFrame if present.

| Option | Default | Description |
|--------|---------|-------------|
| duration | 0.4s | Animation length |
| zForward | 5 | cm to move target forward |
| zBack | -3 | cm to push siblings back |
| frameTarget | same | Name of TronFrame to grow |

#### unfocus(targetName, opts?)

Shrinks TronFrame back to 0. Does not auto-restore positions (let the next motion or state handle repositioning).

| Option | Default | Description |
|--------|---------|-------------|
| duration | 0.3s | Animation length |
| frameTarget | same | Name of TronFrame to shrink |

#### swap(nameA, nameB, opts?)

Two objects exchange positions along an arc through Y. Each rotates 180 degrees during the swap.

| Option | Default | Description |
|--------|---------|-------------|
| duration | 0.6s | Animation length |
| arcHeight | 8 | cm above current Y at peak |

#### reorder(targets, opts?)

Rearranges N objects to new positions with staggered motion. Each object lifts slightly in Y (3cm) during its move.

```typescript
controller.reorder([
  { name: "PanelA", x: -20, y: 0, z: -40 },
  { name: "PanelB", x: 0,   y: 0, z: -40 },
  { name: "PanelC", x: 20,  y: 0, z: -40 },
], { stagger: 0.1 });
```

| Option | Default | Description |
|--------|---------|-------------|
| duration | 0.5s | Per-object move time |
| stagger | 0.08s | Delay between each object starting |

#### reveal(names, opts?)

Staggered entrance: each object scales from 0 with `back.out` easing and drifts up 3cm. After objects appear, optionally grows TronFrames and CircuitConnectors in sequence.

```typescript
controller.reveal(["PanelA", "PanelB"], {
  connectors: ["CircuitConnector"],
  stagger: 0.15
});
```

| Option | Default | Description |
|--------|---------|-------------|
| duration | 0.5s | Per-object appear time |
| stagger | 0.15s | Delay between objects |
| connectors | [] | CircuitConnector names to grow after objects appear |

#### dismiss(name, opts?)

Shrink + slide out. Direction controls where it goes.

| Option | Default | Description |
|--------|---------|-------------|
| duration | 0.35s | Animation length |
| direction | "back" | "down" (Y-10), "back" (Z-20), or "away" (X toward nearest edge) |

If the object has a TronFrame, its growth is animated to 0 during the first 60% of the duration.

#### connectPanels(connectorName, opts?)

Grows a CircuitConnector's exit arms first (50% of duration), then the bridge (remaining time). Reads current growth values as starting point.

| Option | Default | Description |
|--------|---------|-------------|
| duration | 0.8s | Total animation length |

#### disconnectPanels(connectorName, opts?)

Reverse of connect: bridge retracts first, then exit arms retract.

| Option | Default | Description |
|--------|---------|-------------|
| duration | 0.5s | Total animation length |

## Easing Reference

Format: `type.direction` where direction is `in`, `out`, or `inOut`.

| Type | Description |
|------|-------------|
| linear | No easing |
| power1 / quad | x^2 |
| power2 / cubic | x^3 |
| power3 / quart | x^4 |
| power4 / quint | x^5 |
| expo | 2^(10(x-1)) |
| circ | Circular arc |
| sine | Sinusoidal |
| back | Overshoots (s = 1.70158) |
| elastic | Spring oscillation |
| bounce | Ball-drop bounce |

Easing is set on the destination keyframe. `{ time: 0.8, value: 0, ease: "bounce.out" }` means "ease into this keyframe with bounce.out."

## Inspector Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| root | SceneObject | self | Parent of all animatable targets |
| relayUrl | string | ws://localhost:8766 | WebSocket relay for live authoring |
| relaySecret | string | | Relay auth secret |
| channelName | string | "anim" | WebSocket channel |
| autoConnect | bool | true | Connect to relay on start |
| bakedJson | string | | Sequences JSON (flat mode) |
| stateJson | string | | State machine JSON (includes sequences) |
| autoPlay | string | | Sequence or state name to play on awake |
| autoPlayDelay | float | 0.5 | Seconds before auto-play (0-5 slider) |
| timeScale | float | 1.0 | Playback speed multiplier (0.1-3.0 slider) |
| fpsLogInterval | float | 0 | Log FPS every N seconds (0 = off) |

## Script API

```typescript
// Get the controller
const ac = sceneObject.getComponent("Component.ScriptComponent") as AnimationController;

// Sequence playback
ac.play("my-sequence");              // play forward
ac.play("my-sequence", true);        // play reversed
ac.stopSequence("my-sequence");
ac.stopAll();

// State machine
ac.setParam("selected", true);       // set a param (triggers matching transitions)
ac.getParam("selected");             // read a param
ac.fireTrigger("reset");             // fire a one-shot trigger
ac.getCurrentState();                // "idle", "active", etc.

// Motion primitives
ac.focus("PanelA");
ac.unfocus("PanelA");
ac.swap("PanelA", "PanelB");
ac.reorder([{ name: "A", x: 0, y: 0, z: -40 }, ...]);
ac.reveal(["A", "B"], { connectors: ["Connector1"] });
ac.dismiss("PanelA", { direction: "away" });
ac.connectPanels("Connector1");
ac.disconnectPanels("Connector1");

// Remote
ac.connect();                        // connect to relay
ac.triggerRemote("my-sequence");     // tell relay to broadcast a trigger
```

## Relay Protocol

The controller connects to the relay on the `channelName` channel. Messages are JSON over WebSocket.

### Incoming (relay to controller)

| Event | Fields | Description |
|-------|--------|-------------|
| `anim` | `targets: { objName: { prop: value } }` | Live preview: apply property values directly |
| `bake` | `name`, `sequence` | Store a single baked sequence |
| `bake_all` | `sequences: { name: sequence }` | Store multiple sequences |
| `play` | `sequence`, `reverse?` | Play a stored sequence |
| `stop` | `sequence` | Stop a specific sequence |
| `stop_all` | | Stop all sequences |
| `set_param` | `name`, `value` | Set a state machine parameter |
| `trigger_sm` | `name` | Fire a state machine trigger |
| `state_json` | `data` | Hot-reload state machine definition |
| `motion` | `motion`, `target`/`a`/`b`/`names`/`connector`/`targets`, `opts?` | Trigger a motion primitive |
| `request_scene_info` | | Request scene graph info |

### Outgoing (controller to relay)

| Event | Fields | Description |
|-------|--------|-------------|
| `scene_info` | `objects: { name: { scripts, hasMaterial, hasTransform } }` | Sent on connect and on request |
| `trigger` | `sequence`, `reverse` | Broadcast a trigger (from `triggerRemote()`) |

### Motion message examples

```json
{ "event": "motion", "motion": "focus", "target": "PanelA", "opts": { "duration": 0.5 } }
{ "event": "motion", "motion": "swap", "a": "CubeA", "b": "CubeB" }
{ "event": "motion", "motion": "reveal", "names": ["A", "B"], "opts": { "connectors": ["C1"] } }
{ "event": "motion", "motion": "dismiss", "target": "PanelA", "opts": { "direction": "down" } }
{ "event": "motion", "motion": "connect", "connector": "CircuitConnector" }
```

## Setup in Lens Studio

1. Attach `AnimationController.ts` to any SceneObject
2. Set `root` to the parent of all objects you want to animate (or leave empty to use self)
3. For baked playback: paste JSON into `bakedJson`, set `autoPlay` to the sequence name
4. For state machine: paste JSON into `stateJson`, set `autoPlay` to the initial state name
5. For live authoring: set `autoConnect` to true, run the relay (`npm run relay`), open `http://localhost:8766/vol/animator.html`

## Live Authoring with animator.html

Visual timeline editor served by the relay at `http://localhost:8766/vol/animator.html`. Connects to an AnimationController in Lens Studio over WebSocket for live preview, or works standalone for authoring sequences.

### Layout

Top to bottom: relay connection bar, sequence tabs with playback controls, 2D preview canvas, timeline (label panel + canvas), details bar, action bar, collapsible GSAP code editor, status log.

The timeline has a left label panel (130px) showing collapsible target groups with disclosure triangles and property tracks with color-coded dots. The canvas area renders a time ruler, easing curves between keyframes, and diamond keyframes.

### Workflow

1. Open `http://localhost:8766/vol/animator.html`
2. Create sequences via the + tab or write GSAP code and click "Run Code" to bake
3. Edit visually: double-click timeline to add keyframes, drag to reposition, click to select and edit in the details bar
4. Right-click keyframes for context menu (duplicate, delete, quick easing presets)
5. Click "Bake All" to send sequences to LS via relay, or "Deploy to LS" to push via MCP
6. "Export JSON" to copy baked JSON for pasting into AnimationController's `bakedJson` input

### Timeline Interaction

| Action | What |
|--------|------|
| Click ruler | Set playhead position |
| Click keyframe | Select (shows value label, populates details bar) |
| Drag keyframe | Move in time (snaps to 0.05s grid, hold Shift for free drag) |
| Double-click track | Add keyframe at cursor time |
| Right-click keyframe | Context menu: Duplicate, Delete, quick easing presets |
| Scroll wheel | Zoom timeline (60-800 px/sec) |
| Space | Play/pause |
| Delete/Backspace | Delete selected keyframe |
| Ctrl+Z / Cmd+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+S / Cmd+S | Save to browser localStorage |
| Ctrl+D / Cmd+D | Duplicate selected keyframe |
| Click group header | Collapse/expand property tracks (aggregate diamonds shown when collapsed) |

### Keyframe Visuals

Three-state rendering (adapted from Rive): outlined with subtle fill (default), solid fill (at playhead position), solid fill with white stroke and glow (selected). Color-coded by property type: blue for position (x,y,z), gold for rotation, red for scale, orange for script properties.

Easing curves render as filled waveforms between keyframes with a connector line. The easing function name appears as a label when the segment is wide enough.

### Persistence

The editor auto-saves to browser localStorage on every edit. On reload, it restores the last session. Additional save/load options: Save button (Ctrl+S), Download (exports .json file), Import (loads .json file). Undo history holds up to 80 snapshots.

## MCP Deployment

Push state data to an existing AnimationController via MCP:

```javascript
// Set state machine JSON
await mcp("SetLensStudioProperty", {
  objectUUID: componentId,       // AnimationController component UUID
  propertyPath: "stateJson",
  value: JSON.stringify(stateData),
  valueType: "string"
});

// Set auto-play state
await mcp("SetLensStudioProperty", {
  objectUUID: componentId,
  propertyPath: "autoPlay",
  value: "intro",
  valueType: "string"
});
```

The component UUID is the `id` field on the ScriptComponent, found via `GetLensStudioSceneObjectByName`.
