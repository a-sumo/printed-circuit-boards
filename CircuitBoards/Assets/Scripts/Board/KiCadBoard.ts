// KiCadBoard.ts
// Renders a KiCad PCB with 3D tube traces (hemisphere caps), flat board substrate,
// gold pads, orange vias, text labels, and semantic growth animation.
//
// Traces are continuous 3D tubes built on the CPU.
// Connected same-net segments are merged into polylines (variable width).
// Growth + hue per polyline stored in a 1-wide data texture.
// Growth order: BFS from power nets through component adjacency.
//
// Setup in Lens Studio:
//   1. Graph Material "KiCadTrace": KiCadTraceShader.js code node
//      + Texture 2D Object Parameter "traceTex"
//      + wire transformedPosition -> Vertex Position, vertexColor -> Fragment Color
//   2. Graph Material "KiCadBoard": KiCadBoardShader.js code node
//      + wire transformedPosition -> Vertex Position, vertexColor -> Fragment Color
//   3. Attach this script, assign materials, paste board JSON

import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { InteractorEvent } from "SpectaclesInteractionKit.lspkg/Core/Interactor/InteractorEvent";
import { outExpo } from "../Common/Easing";

// Board data modules (static requires: LS resolves at compile time).
// This map must stay in THIS file. Add new boards here AND in BoardCatalog.ts.
var BOARD_MODULES: Record<string, any> = {
    "arduino-nano": require("Scripts/Board/data/arduino-nano.js"),
    "stickhub-usb": require("Scripts/Board/data/stickhub-usb.js"),
    "rpi-cm4io": require("Scripts/Board/data/rpi-cm4io.js"),
    "attiny85-usb": require("Scripts/Board/data/attiny85-usb.js"),
    "xiao-servo": require("Scripts/Board/data/xiao-servo.js"),
};

@component
export class KiCadBoard extends BaseScriptComponent {

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Arduino Nano", "arduino-nano"),
        new ComboBoxItem("StickHub USB", "stickhub-usb"),
        new ComboBoxItem("RPi CM4 IO", "rpi-cm4io"),
        new ComboBoxItem("ATtiny85 USB", "attiny85-usb"),
        new ComboBoxItem("XIAO Servo", "xiao-servo"),
    ]))
    @hint("Select board from catalog (boards/ directory)")
    boardSlug: string = "arduino-nano";

    // Loaded at runtime from catalog
    private boardData: string = "";

    @input
    @hint("Unified trace material (KiCadTraceShader.js) with traceTex texture parameter")
    traceMaterial!: Material;

    @input
    @hint("Unified board material (KiCadBoardShader.js)")
    boardMaterial!: Material;

    @input
    @hint("Sequence name to auto-play on awake (empty = none). Use 'all' to grow all nets.")
    autoPlay: string = "";

    @input
    @widget(new SliderWidget(0.1, 20.0, 0.1))
    @hint("Scale factor: KiCad mm to LS cm. 1.0 = 1mm per cm.")
    scaleFactor: number = 1.0;

    @input
    @hint("Font asset for component labels (optional)")
    labelFont: Font | null = null;

    @input
    @widget(new SliderWidget(1, 100, 1))
    @hint("Label text size in LS font units")
    labelSize: number = 100;

    // ---- Visibility Toggles ----
    @input
    @hint("Show board substrate")
    showBoard: boolean = true;

    @input
    @hint("Show copper traces")
    showTraces: boolean = true;

    @input
    @hint("Show vias")
    showVias: boolean = true;

    @input
    @hint("Show pads")
    showPads: boolean = true;

    @input
    @hint("Show component labels")
    showLabels: boolean = true;

    /* [ARCHIVED] Hand-Proximity Interaction — disabled for performance
    @input
    @hint("Hand proximity drives reveal instead of auto-play timer")
    handDriven: boolean = false;

    @input
    @widget(new SliderWidget(5, 60, 1))
    @hint("Distance (cm) at which hand has no effect")
    handFarDist: number = 30;

    @input
    @widget(new SliderWidget(2, 20, 1))
    @hint("Distance (cm) at which reveal is 100%")
    handNearDist: number = 8;
    */

    // ---- Layer Explosion ----
    @input
    @widget(new SliderWidget(0, 1, 0.01))
    @hint("0 = flat board, 1 = fully exploded. Drag to explode/collapse.")
    explodeAmount: number = 0;

    @input
    @widget(new SliderWidget(1, 50, 1))
    @hint("Vertical spacing between exploded layers (cm)")
    explodeSpread: number = 10.0;

    // ---- Signal Flow ----
    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Off", "off"),
        new ComboBoxItem("On", "on"),
    ]))
    @hint("Animated current/signal flow along traces")
    signalFlowMode: string = "off";

    @input
    @widget(new SliderWidget(0.5, 5.0, 0.1))
    @hint("Signal flow pulse speed (pulses per second)")
    flowSpeed: number = 1.5;

    @input
    @widget(new SliderWidget(0.1, 1.0, 0.1))
    @hint("Signal flow pulse brightness")
    flowIntensity: number = 0.4;

    // ---- Rendering Mode ----
    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Vivid", "vivid"),
        new ComboBoxItem("Realistic", "realistic"),
    ]))
    @hint("Vivid = rainbow traces, Realistic = copper/FR4/solder mask")
    renderMode: string = "vivid";

    /* [ARCHIVED] Effector System — disabled for performance (requires hand tracking)
    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Off", "off"),
        new ComboBoxItem("Growth", "growth"),
        new ComboBoxItem("Morph", "morph"),
        new ComboBoxItem("Flow", "flow"),
        new ComboBoxItem("All", "all"),
    ]))
    @hint("Spatially-varying parameter driven by hand proximity")
    effectorMode: string = "off";

    @input
    @widget(new SliderWidget(2, 40, 1))
    @hint("Effector influence radius in KiCad mm")
    effectorRadius: number = 15;
    */

    // ---- PCB Colors (vivid mode) ----
    private static readonly COL_BOARD_V = [0.094, 0.471, 0.878];     // #1878e0 vivid blue
    private static readonly COL_BOARD_EDGE_V = [0.627, 0.502, 0.314]; // #a08050 FR4 tan
    private static readonly COL_PAD_V = [0.91, 0.69, 0.063];          // #e8b010 vivid gold
    private static readonly COL_VIA_V = [0.784, 0.314, 0.125];        // #c85020 vivid orange
    private static readonly COL_VIA_HOLE_V = [0.30, 0.25, 0.22];      // via hole (warm dark, visible on additive)
    private static readonly COL_SILK_V = [0.94, 0.94, 0.91];          // #f0f0e8 white silkscreen

    // ---- PCB Colors (realistic mode) ----
    // Boosted brightness for additive display (black = transparent on Spectacles)
    private static readonly COL_BOARD_R = [0.60, 0.52, 0.32];         // FR4 tan/amber substrate
    private static readonly COL_BOARD_EDGE_R = [0.60, 0.52, 0.32];    // FR4 tan/khaki
    private static readonly COL_PAD_R = [0.85, 0.85, 0.80];           // HASL tin/silver
    private static readonly COL_VIA_R = [0.85, 0.85, 0.80];           // HASL tin
    private static readonly COL_VIA_HOLE_R = [0.35, 0.28, 0.22];      // via hole (warm dark, visible on additive)
    private static readonly COL_SILK_R = [0.95, 0.95, 0.90];          // white silkscreen

    // Runtime palette (set in onAwake based on realistic toggle)
    private COL_BOARD: number[] = KiCadBoard.COL_BOARD_V;
    private COL_BOARD_EDGE: number[] = KiCadBoard.COL_BOARD_EDGE_V;
    private COL_PAD: number[] = KiCadBoard.COL_PAD_V;
    private COL_VIA: number[] = KiCadBoard.COL_VIA_V;
    private COL_VIA_HOLE: number[] = KiCadBoard.COL_VIA_HOLE_V;
    private COL_SILK: number[] = KiCadBoard.COL_SILK_V;

    // ---- State helpers (read from ComboBox strings) ----
    private isExploded(): boolean { return this.explodeAmount > 0.5; }
    private isSignalFlow(): boolean { return this.signalFlowMode === "on"; }
    private isRealistic(): boolean { return this.renderMode === "realistic"; }
    private isV2(): boolean { return this.board && this.board.version === 2; }

    // ---- Source material references (originals, never cloned) ----
    private srcBoardMat: Material | null = null;
    private srcTraceMat: Material | null = null;

    // ---- Constants ----
    private static readonly MAX_TRACES = 4096;
    private static readonly VIA_SNAP_TOL2 = 0.1; // squared mm tolerance for endpoint-to-via matching

    // ---- Trace data ----
    private traceTexProviders: Map<string, ProceduralTextureProvider> = new Map();
    private tracePixels: Map<string, Uint8Array> = new Map();
    private traceCount: Map<string, number> = new Map();
    private tracePasses: Map<string, Pass> = new Map();
    private traceGrowth: Map<string, number[]> = new Map();
    private traceDirtyMin: Map<string, number> = new Map();
    private traceDirtyMax: Map<string, number> = new Map();
    private netTraceMap: Map<string, Map<number, number[]>> = new Map();

    private board: any = null;
    private cx: number = 0;
    private cy: number = 0;

    // Animation (wave-based BFS)
    private animActive: boolean = false;
    private animWaves: number[][] = [];
    private animWaveIdx: number = 0;
    private animWaveProgress: number = 0;

    // Footprint data (for selection)
    private fpBounds: { ref: string, cx: number, cy: number, hw: number, hh: number, nets: number[] }[] = [];
    private labelObjects: Map<string, SceneObject> = new Map();
    private selectedFP: string = "";

    // Group parents for visibility toggling + explode view
    // Physical layer groups (top to bottom):
    //   topSilk -> topMask -> topCopper (traces+pads) -> core -> botCopper -> botMask -> botSilk
    private groupBoard: SceneObject[] = [];       // FR4 core substrate
    private groupTraces: SceneObject[] = [];      // copper traces (named F.Cu / B.Cu)
    private groupVias: SceneObject | null = null;
    private groupPadsTop: SceneObject | null = null;  // F.Cu pads
    private groupPadsBot: SceneObject | null = null;  // B.Cu pads
    private groupLabels: SceneObject[] = [];       // silkscreen labels
    private groupTopMask: SceneObject | null = null;  // top solder mask sheet
    private groupBotMask: SceneObject | null = null;  // bottom solder mask sheet
    private groupZones: SceneObject[] = [];       // copper zone fills
    private groupDrawings: SceneObject[] = [];    // center / unsided drawings (Edge.Cuts, Margin)
    private groupTopDrawings: SceneObject[] = [];  // F.* drawings (top side — silkscreen, fab)
    private groupBotDrawings: SceneObject[] = [];  // B.* drawings (bottom side)

    private boardHalfWidth: number = 0;  // LS cm, used for label X offset
    private boardHalfHeight: number = 0; // LS cm, used for gallery layout

    // Track inputs that require rebuild on change
    private prevBoardSlug: string = "";
    private prevRenderMode: string = "vivid";
    private prevScaleFactor: number = 1.0;

    // Eased explode transition: target = explodeAmount (input slider / panel toggle),
    // displayed = currently-applied geometry offset. outExpo decelerates fast
    // and lands smoothly — no overshoot, no bounce.
    private explodeDisplayed: number = 0;
    private explodeAnimFrom: number = 0;
    private explodeAnimTo: number = 0;
    private explodeAnimT: number = 0;
    private explodeAnimDuration: number = 0.55;

    // Board reveal animation
    private maxRadius: number = 1;
    private boardMatPass: Pass | null = null;
    private traceGrowTriggered: boolean = false;
    // Store label positions for wavefront-based reveal
    private labelRevealDist: Map<string, number> = new Map();

    /* [ARCHIVED] Hand-proximity state
    private handInputData: any = null;
    private handRevealT: number = 0;
    */
    // Store original label Z positions for explosion offset
    private labelBaseZ: Map<SceneObject, number> = new Map();
    // Signal flow
    private flowTimer: number = 0;

    // Via rebuild tracking for explode view
    private viaExplodeProgress: number = -1;  // last explode progress vias were built at
    private viaData: { pos: number[], size: number, drill: number, net: number, layers: string[] }[] = [];

    // Simulation state
    private simNodeVoltages: Map<string, number> = new Map();
    private simBranchCurrents: Map<number, number> = new Map();
    private simValid: boolean = false;

    /* [ARCHIVED] Effector system state
    private effectors: { x: number, y: number, z: number, radius: number }[] = [];
    private traceCentroids: Map<string, number[][]> = new Map();
    */

    /* [ARCHIVED] Clap gesture detection
    private prevPalmDist: number = Infinity;
    private clapCooldown: number = 0;
    private static readonly CLAP_DIST_THRESH = 6.0;
    private static readonly CLAP_CLOSE_SPEED = 40.0;
    private static readonly CLAP_COOLDOWN_S = 1.0;
    */

    // (tube profile + vtxBuf removed: traces use flat ribbons now)

    private traceDelayTimer: number = -1;

    // Activation state — controls whether this board is rendered/ticked.
    // CircuitPanel calls activate()/deactivate() to swap which board is live;
    // deactivated boards have their geometry destroyed and onUpdate gated.
    private boardBuilt: boolean = false;
    private active: boolean = true;

    onAwake(): void {
        // Save source material references before any cloning
        this.srcBoardMat = this.boardMaterial;
        this.srcTraceMat = this.traceMaterial;

        this.applyPalette(this.isRealistic());

        // Load board data from catalog
        var slug = this.boardSlug || "arduino-nano";
        print("[KiCad] Building board: " + slug);
        var mod = BOARD_MODULES[slug] || BOARD_MODULES["arduino-nano"];
        if (!mod) { print("[KiCad] WARNING: unknown slug '" + slug + "'"); return; }
        this.boardData = mod.pcb;
        print("[KiCad] Loaded " + slug + ": pcb=" +
              Math.round(this.boardData.length / 1024) + "KB");

        try {
            this.board = JSON.parse(this.boardData);
        } catch (e: any) {
            print("[KiCad] Failed to parse board JSON: " + e.message);
            return;
        }

        var traceInfo = this.isV2()
            ? this.board.segments.length + " segments (V2)"
            : this.board.polylines
                ? this.board.polylines.length + " polylines (precomputed)"
                : (this.board.traces ? this.board.traces.length + " traces" : "0 traces");
        print("[KiCad] Board: " + traceInfo + ", " +
              (this.board.vias ? this.board.vias.length : 0) + " vias, " +
              this.board.footprints.length + " footprints");

        this.ensureOutline();
        this.computeBounds();
        this.cloneBoardMaterial(1.0);
        this.computeHalfExtents();

        this.buildBoard();
        this.buildSolderMasks();
        if (this.isV2()) {
            this.buildSegmentsV2();
            this.buildZones();
            this.buildDrawingsV2();
        } else {
            this.buildTraces();
        }
        this.buildVias();
        this.buildFootprints();
        this.buildLabels();
        this.buildCollider();
        this.runSimulation();

        this.applyVisibility();

        if (this.autoPlay === 'all') {
            this.traceGrowTriggered = false;
            this.traceDelayTimer = 0.5;
            for (const o of this.groupLabels) { if (o && !isNull(o)) o.enabled = false; }
        }

        this.syncPrevTracking();
        this.boardBuilt = true;
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    // KiCad mm Y-down -> LS cm Y-up
    private toLS(x: number, y: number, z: number = 0): vec3 {
        const s = this.scaleFactor;
        return new vec3((x - this.cx) * s, -(y - this.cy) * s, z * s);
    }

    // Normalized distance from board center [0,1] for reveal animation
    private revealDist(kx: number, ky: number): number {
        const dx = kx - this.cx, dy = ky - this.cy;
        return Math.sqrt(dx * dx + dy * dy) / this.maxRadius;
    }

    // Rotate a point by (cosR, sinR) - standard 2D rotation
    private rotPt(lx: number, ly: number, cosR: number, sinR: number): [number, number] {
        return [lx * cosR - ly * sinR, lx * sinR + ly * cosR];
    }

    // ---- Helper: create a static mesh builder ----
    private static newStaticMB(): MeshBuilder {
        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
            { name: "texture1", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;
        return mb;
    }

    // ---- Z-level constants (in KiCad mm, toLS scales to cm) ----
    private thickHalf(): number {
        return (this.board.board.thickness || 1.6) / 2;
    }

    // Find a via at the given KiCad-space position (within snap tolerance).
    // Returns { idx, pos, outerR, drillR } or null.
    private findViaAt(kx: number, ky: number): { idx: number, pos: number[], outerR: number, drillR: number } | null {
        if (!this.board.vias) return null;
        var tol2 = KiCadBoard.VIA_SNAP_TOL2;
        for (var vi = 0; vi < this.board.vias.length; vi++) {
            var v = this.board.vias[vi];
            var dx = kx - v.pos[0], dy = ky - v.pos[1];
            if (dx * dx + dy * dy < tol2) {
                return {
                    idx: vi,
                    pos: v.pos,
                    outerR: (v.size || 0.8) / 2,
                    drillR: (v.drill || 0.4) / 2
                };
            }
        }
        return null;
    }

    // Generate a rounded-rectangle outline from element bounds when outline is missing/degenerate
    private ensureOutline(): void {
        var outline = this.board.board.outline;
        if (outline && outline.length >= 3) {
            var allSame = true;
            for (var i = 1; i < outline.length; i++) {
                if (Math.abs(outline[i][0] - outline[0][0]) > 0.01 ||
                    Math.abs(outline[i][1] - outline[0][1]) > 0.01) {
                    allSame = false;
                    break;
                }
            }
            if (!allSame) return;
        }

        // Tight bounds from rotated pads, polylines, and vias
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        var found = false;

        for (var fi = 0; fi < this.board.footprints.length; fi++) {
            var fp = this.board.footprints[fi];
            var fpx = fp.pos[0], fpy = fp.pos[1];
            var kRad = -(fp.rot || 0) * Math.PI / 180;
            var cosK = Math.cos(kRad), sinK = Math.sin(kRad);
            if (fp.pads) {
                for (var pi = 0; pi < fp.pads.length; pi++) {
                    var pad = fp.pads[pi];
                    var rlx = pad.pos[0] * cosK - pad.pos[1] * sinK;
                    var rly = pad.pos[0] * sinK + pad.pos[1] * cosK;
                    var px = fpx + rlx, py = fpy + rly;
                    var hw = pad.size[0] * 0.5, hh = pad.size[1] * 0.5;
                    if (px - hw < minX) minX = px - hw;
                    if (px + hw > maxX) maxX = px + hw;
                    if (py - hh < minY) minY = py - hh;
                    if (py + hh > maxY) maxY = py + hh;
                    found = true;
                }
            }
        }

        if (this.isV2() && this.board.segments) {
            for (var ti = 0; ti < this.board.segments.length; ti++) {
                var seg = this.board.segments[ti];
                var pts = [seg.start, seg.end];
                for (var j = 0; j < pts.length; j++) {
                    if (pts[j][0] < minX) minX = pts[j][0];
                    if (pts[j][0] > maxX) maxX = pts[j][0];
                    if (pts[j][1] < minY) minY = pts[j][1];
                    if (pts[j][1] > maxY) maxY = pts[j][1];
                    found = true;
                }
            }
        } else if (this.board.polylines) {
            for (var ti = 0; ti < this.board.polylines.length; ti++) {
                var tpts = this.board.polylines[ti].points;
                for (var j = 0; j < tpts.length; j++) {
                    if (tpts[j][0] < minX) minX = tpts[j][0];
                    if (tpts[j][0] > maxX) maxX = tpts[j][0];
                    if (tpts[j][1] < minY) minY = tpts[j][1];
                    if (tpts[j][1] > maxY) maxY = tpts[j][1];
                    found = true;
                }
            }
        }

        if (this.board.vias) {
            for (var vi = 0; vi < this.board.vias.length; vi++) {
                var v = this.board.vias[vi];
                var vr = v.size * 0.5;
                if (v.pos[0] - vr < minX) minX = v.pos[0] - vr;
                if (v.pos[0] + vr > maxX) maxX = v.pos[0] + vr;
                if (v.pos[1] - vr < minY) minY = v.pos[1] - vr;
                if (v.pos[1] + vr > maxY) maxY = v.pos[1] + vr;
                found = true;
            }
        }

        if (!found) return;

        // Margin and corner radius proportional to board size
        var bw = maxX - minX, bh = maxY - minY;
        var margin = Math.max(1.0, Math.min(bw, bh) * 0.04);
        var cornerR = Math.max(0.5, Math.min(bw, bh) * 0.06);
        minX -= margin; minY -= margin;
        maxX += margin; maxY += margin;

        // Rounded rectangle: arc segments at each corner
        var outlinePts: number[][] = [];
        var arcN = 8;
        // top-right
        for (var a = 0; a <= arcN; a++) {
            var t = Math.PI * 1.5 + (a / arcN) * Math.PI * 0.5;
            outlinePts.push([maxX - cornerR + cornerR * Math.cos(t),
                             minY + cornerR + cornerR * Math.sin(t)]);
        }
        // bottom-right
        for (var a = 0; a <= arcN; a++) {
            var t = (a / arcN) * Math.PI * 0.5;
            outlinePts.push([maxX - cornerR + cornerR * Math.cos(t),
                             maxY - cornerR + cornerR * Math.sin(t)]);
        }
        // bottom-left
        for (var a = 0; a <= arcN; a++) {
            var t = Math.PI * 0.5 + (a / arcN) * Math.PI * 0.5;
            outlinePts.push([minX + cornerR + cornerR * Math.cos(t),
                             maxY - cornerR + cornerR * Math.sin(t)]);
        }
        // top-left
        for (var a = 0; a <= arcN; a++) {
            var t = Math.PI + (a / arcN) * Math.PI * 0.5;
            outlinePts.push([minX + cornerR + cornerR * Math.cos(t),
                             minY + cornerR + cornerR * Math.sin(t)]);
        }
        outlinePts.push([outlinePts[0][0], outlinePts[0][1]]);

        this.board.board.outline = outlinePts;
        if (!this.board.board.thickness) this.board.board.thickness = 1.6;
        print("[KiCad] Generated outline: " + (maxX - minX).toFixed(1) + " x " +
              (maxY - minY).toFixed(1) + " mm, r=" + cornerR.toFixed(1) + " mm, " +
              outlinePts.length + " points");
    }

    // ---- Board substrate ----

    private buildBoard(): void {
        const outline = this.board.board.outline;
        if (!outline || outline.length < 3) return;

        const mb = KiCadBoard.newStaticMB();
        const [br, bg, bb] = this.COL_BOARD;
        const [er, eg, eb] = this.COL_BOARD_EDGE;
        const topZ = this.thickHalf();
        const botZ = -this.thickHalf();

        // Top face: center-fan triangulation (avoids thin slivers from corner-fan)
        const topBase = mb.getVerticesCount();
        var ocx = 0, ocy = 0;
        for (const p of outline) { ocx += p[0]; ocy += p[1]; }
        ocx /= outline.length; ocy /= outline.length;
        const cPosT = this.toLS(ocx, ocy, topZ);
        const cRdT = this.revealDist(ocx, ocy);
        mb.appendVerticesInterleaved([cPosT.x, cPosT.y, cPosT.z, 0, 0, 1, br, bg, bb, cRdT]);
        for (const p of outline) {
            const pos = this.toLS(p[0], p[1], topZ);
            const rd = this.revealDist(p[0], p[1]);
            mb.appendVerticesInterleaved([pos.x, pos.y, pos.z, 0, 0, 1, br, bg, bb, rd]);
        }
        for (let i = 0; i < outline.length - 1; i++) {
            mb.appendIndices([topBase, topBase + 1 + i, topBase + 1 + i + 1]);
        }

        // Bottom face: center-fan
        const botBase = mb.getVerticesCount();
        const cPosB = this.toLS(ocx, ocy, botZ);
        mb.appendVerticesInterleaved([cPosB.x, cPosB.y, cPosB.z, 0, 0, -1, br * 0.7, bg * 0.7, bb * 0.7, cRdT]);
        for (const p of outline) {
            const pos = this.toLS(p[0], p[1], botZ);
            const rd = this.revealDist(p[0], p[1]);
            mb.appendVerticesInterleaved([pos.x, pos.y, pos.z, 0, 0, -1, br * 0.7, bg * 0.7, bb * 0.7, rd]);
        }
        for (let i = 0; i < outline.length - 1; i++) {
            mb.appendIndices([botBase, botBase + 1 + i + 1, botBase + 1 + i]);
        }

        // Side walls
        const n = outline.length;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const a = this.toLS(outline[i][0], outline[i][1], topZ);
            const bv = this.toLS(outline[j][0], outline[j][1], topZ);
            const c = this.toLS(outline[i][0], outline[i][1], botZ);
            const d = this.toLS(outline[j][0], outline[j][1], botZ);
            const rdI = this.revealDist(outline[i][0], outline[i][1]);
            const rdJ = this.revealDist(outline[j][0], outline[j][1]);

            const edge = bv.sub(a);
            const norm = new vec3(-edge.y, edge.x, 0);
            const nl = norm.length;
            const nn = nl > 0.001 ? norm.uniformScale(1 / nl) : new vec3(0, 0, 1);

            const base = mb.getVerticesCount();
            mb.appendVerticesInterleaved([
                a.x, a.y, a.z, nn.x, nn.y, nn.z, er, eg, eb, rdI,
                bv.x, bv.y, bv.z, nn.x, nn.y, nn.z, er, eg, eb, rdJ,
                c.x, c.y, c.z, nn.x, nn.y, nn.z, er * 0.7, eg * 0.7, eb * 0.7, rdI,
                d.x, d.y, d.z, nn.x, nn.y, nn.z, er * 0.7, eg * 0.7, eb * 0.7, rdJ,
            ]);
            mb.appendIndices([base, base + 1, base + 2, base + 1, base + 3, base + 2]);
        }

        mb.updateMesh();
        const child = global.scene.createSceneObject("__board");
        child.setParent(this.sceneObject);
        const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;
        this.groupBoard.push(child);

        print("[KiCad] Board substrate: " + outline.length + " outline points");
    }

    // ---- Solder Mask layers ----
    // Solid colored sheet over the board with holes punched where pads are exposed.
    // Builds one sheet per side (F.Cu / B.Cu).

    private buildSolderMasks(): void {
        const outline = this.board.board.outline;
        if (!outline || outline.length < 3) return;

        const th = this.thickHalf();
        // Solder mask color: green in realistic, slightly darker board color in vivid
        const maskColor: number[] = this.isRealistic()
            ? [0.10, 0.42, 0.18]    // solder mask green (boosted for additive display)
            : [this.COL_BOARD[0] * 0.85, this.COL_BOARD[1] * 0.85, this.COL_BOARD[2] * 0.85];

        // Collect all pad positions + sizes for hole punching
        const padHoles: { gx: number, gy: number, hw: number, hh: number, layer: string }[] = [];
        for (const fp of this.board.footprints) {
            const fpx = fp.pos[0], fpy = fp.pos[1];
            const fpRot = fp.rot || 0;
            const kRad = -fpRot * Math.PI / 180;
            const cosK = Math.cos(kRad), sinK = Math.sin(kRad);
            const fpLayer = fp.layer || 'F.Cu';
            if (fp.pads) {
                for (const pad of fp.pads) {
                    const [rlx, rly] = this.rotPt(pad.pos[0], pad.pos[1], cosK, sinK);
                    padHoles.push({
                        gx: fpx + rlx,
                        gy: fpy + rly,
                        hw: pad.size[0] * 0.5 + 0.05,  // solder mask expansion
                        hh: pad.size[1] * 0.5 + 0.05,
                        layer: fpLayer
                    });
                }
            }
        }

        // Via holes in mask
        for (const via of this.board.vias) {
            const hs = via.size * 0.5 + 0.05;
            padHoles.push({ gx: via.pos[0], gy: via.pos[1], hw: hs, hh: hs, layer: 'F.Cu' });
            padHoles.push({ gx: via.pos[0], gy: via.pos[1], hw: hs, hh: hs, layer: 'B.Cu' });
        }

        const s = this.scaleFactor;
        for (const side of ['F.Cu', 'B.Cu'] as const) {
            const isTop = side === 'F.Cu';
            // Mask sits between board surface and traces (traces at th + 0.06)
            const z = isTop ? th + 0.02 : -th - 0.02;
            const nz = isTop ? 1 : -1;
            const mr = maskColor[0], mg = maskColor[1], mb2 = maskColor[2];

            const meshB = KiCadBoard.newStaticMB();

            // Main sheet: center-fan triangulation
            var mcx = 0, mcy = 0;
            for (const p of outline) { mcx += p[0]; mcy += p[1]; }
            mcx /= outline.length; mcy /= outline.length;
            const base = meshB.getVerticesCount();
            const cPosM = this.toLS(mcx, mcy, z);
            const cRdM = this.revealDist(mcx, mcy);
            meshB.appendVerticesInterleaved([cPosM.x, cPosM.y, cPosM.z, 0, 0, nz, mr, mg, mb2, cRdM]);
            for (const p of outline) {
                const pos = this.toLS(p[0], p[1], z);
                const rd = this.revealDist(p[0], p[1]);
                meshB.appendVerticesInterleaved([pos.x, pos.y, pos.z, 0, 0, nz, mr, mg, mb2, rd]);
            }
            for (let i = 0; i < outline.length - 1; i++) {
                if (isTop) meshB.appendIndices([base, base + 1 + i, base + 1 + i + 1]);
                else meshB.appendIndices([base, base + 1 + i + 1, base + 1 + i]);
            }

            // Pad openings: match mask color so they blend seamlessly.
            // Pads/vias render above as separate geometry with their own colors.
            const br = mr, bg = mg, bb = mb2;
            const holes = padHoles.filter(h => h.layer === side);
            for (const h of holes) {
                const pos = this.toLS(h.gx, h.gy, z + nz * 0.01);
                const hw = h.hw * s, hh = h.hh * s;
                const rd = this.revealDist(h.gx, h.gy);
                const hb = meshB.getVerticesCount();
                meshB.appendVerticesInterleaved([
                    pos.x - hw, pos.y - hh, pos.z, 0, 0, nz, br, bg, bb, rd,
                    pos.x + hw, pos.y - hh, pos.z, 0, 0, nz, br, bg, bb, rd,
                    pos.x + hw, pos.y + hh, pos.z, 0, 0, nz, br, bg, bb, rd,
                    pos.x - hw, pos.y + hh, pos.z, 0, 0, nz, br, bg, bb, rd,
                ]);
                if (isTop) meshB.appendIndices([hb, hb+1, hb+2, hb, hb+2, hb+3]);
                else meshB.appendIndices([hb, hb+2, hb+1, hb, hb+3, hb+2]);
            }

            meshB.updateMesh();
            const name = isTop ? "__maskTop" : "__maskBot";
            const child = global.scene.createSceneObject(name);
            child.setParent(this.sceneObject);
            const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            rmv.mesh = meshB.getMesh();
            if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;

            if (isTop) this.groupTopMask = child;
            else this.groupBotMask = child;
        }

        print("[KiCad] Solder masks built: " + padHoles.length + " pad openings");
    }

    // ---- Traces (continuous 3D tubes) ----
    // Legacy merge/smooth code removed. All boards now use precomputed polylines.
    // To regenerate boards: node converters/regenerate-boards.mjs

    // Get precomputed polylines grouped by layer
    private getPolylinesPerLayer(): Map<string, any[]> {
        var result: Map<string, any[]> = new Map();

        if (!this.board.polylines) {
            if (!this.isV2()) print("[KiCad] ERROR: board missing precomputed polylines. Regenerate with converters/regenerate-boards.mjs");
            return result;
        }

        for (var pi = 0; pi < this.board.polylines.length; pi++) {
            var pl = this.board.polylines[pi];
            var layer = pl.layer || 'F.Cu';
            if (!result.has(layer)) result.set(layer, []);
            result.get(layer)!.push(pl);
        }
        return result;
    }

    private buildTraces(): void {
        var polysPerLayer = this.getPolylinesPerLayer();

        var th = this.thickHalf();
        let layerZ: Record<string, number> = { 'F.Cu': th + 0.04, 'B.Cu': -th - 0.04 };
        var VERT_LIMIT = 63000;

        let layerKeys = Array.from(polysPerLayer.keys()) as string[];
        for (var lk = 0; lk < layerKeys.length; lk++) {
            let layer = layerKeys[lk];
            var smoothed = polysPerLayer.get(layer)!;
            var numTraces = Math.min(smoothed.length, KiCadBoard.MAX_TRACES);
            this.traceCount.set(layer, numTraces);

            var netMap: Map<number, number[]> = new Map();
            for (var i = 0; i < numTraces; i++) {
                var net = smoothed[i].net;
                if (!netMap.has(net)) netMap.set(net, []);
                netMap.get(net)!.push(i);
            }
            this.netTraceMap.set(layer, netMap);
            this.traceGrowth.set(layer, new Array(numTraces).fill(1.0));

            var z = layerZ[layer] || 0;
            var nz = layer === 'F.Cu' ? 1 : -1;

            // Create one unified material clone per layer
            let layerMat: Material | null = null;
            var srcTrace = this.srcTraceMat || this.traceMaterial;
            if (srcTrace) {
                layerMat = srcTrace.clone();
                var pass = layerMat.mainPass;
                this.tracePasses.set(layer, pass);
                this.createTraceTexture(layer, layerMat);
                try { pass["flowTime"] = 0; } catch (e) {}
                try { pass["realisticMode"] = this.isRealistic() ? 1.0 : 0.0; } catch (e) {}
                // Alpha blending for growth animation and layer compositing
                try { pass.blendMode = BlendMode.PremultipliedAlpha; } catch (e) {}
                // B.Cu renders at reduced opacity behind F.Cu
                try { pass["layerAlpha"] = layer === 'B.Cu' ? 0.5 : 1.0; } catch (e) {}
            }

            // Build flat ribbon meshes with batching at vertex limit
            var mb = KiCadBoard.newStaticMB();
            var totalVerts = 0;
            var batchIdx = 0;
            var grandTotalVerts = 0;

            var finalizeBatch = () => {
                if (totalVerts === 0) return;
                mb.updateMesh();
                var child = global.scene.createSceneObject("__traces_" + layer + "_" + batchIdx);
                child.setParent(this.sceneObject);
                this.groupTraces.push(child);
                var rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
                rmv.mesh = mb.getMesh();
                if (layerMat) rmv.mainMaterial = layerMat;
                batchIdx++;
            };

            for (var ti = 0; ti < numTraces; ti++) {
                var poly = smoothed[ti];
                var polyWidths = poly.widths;

                // Match endpoints to vias for trimming
                var rawPts = poly.points;
                var startVia = this.findViaAt(rawPts[0][0], rawPts[0][1]);
                var endVia = this.findViaAt(rawPts[rawPts.length - 1][0], rawPts[rawPts.length - 1][1]);

                var pts: vec3[] = [];
                for (var pi = 0; pi < rawPts.length; pi++) {
                    pts.push(this.toLS(rawPts[pi][0], rawPts[pi][1], z));
                }
                var N = pts.length;
                if (N < 2) continue;

                // Trim ribbon endpoints back by outerR so they stop at the via edge
                if (startVia && N >= 2) {
                    var sOR = startVia.outerR * this.scaleFactor;
                    var sdx = pts[1].x - pts[0].x, sdy = pts[1].y - pts[0].y;
                    var sdl = Math.sqrt(sdx * sdx + sdy * sdy);
                    if (sdl > 0.001) {
                        pts[0] = new vec3(pts[0].x + (sdx / sdl) * sOR, pts[0].y + (sdy / sdl) * sOR, pts[0].z);
                    }
                }
                if (endVia && N >= 2) {
                    var eOR = endVia.outerR * this.scaleFactor;
                    var edx = pts[N - 2].x - pts[N - 1].x, edy = pts[N - 2].y - pts[N - 1].y;
                    var edl = Math.sqrt(edx * edx + edy * edy);
                    if (edl > 0.001) {
                        pts[N - 1] = new vec3(pts[N - 1].x + (edx / edl) * eOR, pts[N - 1].y + (edy / edl) * eOR, pts[N - 1].z);
                    }
                }

                var vertsNeeded = N * 2;

                if (totalVerts + vertsNeeded > VERT_LIMIT && totalVerts > 0) {
                    finalizeBatch();
                    mb = KiCadBoard.newStaticMB();
                    totalVerts = 0;
                }

                // Cumulative arc length (use precomputed if available)
                var cumLen: number[];
                if (poly.arcLengths && poly.arcLengths.length === N) {
                    cumLen = poly.arcLengths;
                } else {
                    cumLen = [0];
                    for (var i = 1; i < N; i++) {
                        var d = pts[i].sub(pts[i - 1]);
                        cumLen.push(cumLen[i - 1] + d.length);
                    }
                }
                var totalLen = cumLen[N - 1];

                var base0 = mb.getVerticesCount();

                // Generate ribbon vertices: 2 per point (left edge, right edge)
                for (var pi = 0; pi < N; pi++) {
                    var t = totalLen > 0.001 ? cumLen[pi] / totalLen : pi / (N - 1);
                    var c = pts[pi];
                    var halfW = polyWidths[pi] * 0.5 * this.scaleFactor;

                    // 2D tangent direction (XY plane)
                    var ttx: number, tty: number;
                    if (pi === 0) {
                        ttx = pts[1].x - pts[0].x; tty = pts[1].y - pts[0].y;
                    } else if (pi === N - 1) {
                        ttx = pts[N - 1].x - pts[N - 2].x; tty = pts[N - 1].y - pts[N - 2].y;
                    } else {
                        var d1x = pts[pi].x - pts[pi - 1].x, d1y = pts[pi].y - pts[pi - 1].y;
                        var d2x = pts[pi + 1].x - pts[pi].x, d2y = pts[pi + 1].y - pts[pi].y;
                        var l1 = Math.sqrt(d1x * d1x + d1y * d1y);
                        var l2 = Math.sqrt(d2x * d2x + d2y * d2y);
                        ttx = (l1 > 0.001 ? d1x / l1 : 0) + (l2 > 0.001 ? d2x / l2 : 0);
                        tty = (l1 > 0.001 ? d1y / l1 : 0) + (l2 > 0.001 ? d2y / l2 : 0);
                    }
                    // Perpendicular in XY: rotate tangent 90 degrees
                    var tlen = Math.sqrt(ttx * ttx + tty * tty);
                    var px: number, py: number;
                    if (tlen > 0.001) { px = -tty / tlen; py = ttx / tlen; }
                    else { px = 0; py = 1; }

                    // Left edge vertex (UV1.x = +1 for edge fade)
                    mb.appendVerticesInterleaved([
                        c.x + px * halfW, c.y + py * halfW, c.z,
                        0, 0, nz,
                        t, ti, 1.0, 0
                    ]);
                    // Right edge vertex (UV1.x = -1 for edge fade)
                    mb.appendVerticesInterleaved([
                        c.x - px * halfW, c.y - py * halfW, c.z,
                        0, 0, nz,
                        t, ti, -1.0, 0
                    ]);
                }

                // Quad strip indices (2 triangles per segment)
                for (var pi = 0; pi < N - 1; pi++) {
                    var a0 = base0 + pi * 2;      // left current
                    var a1 = a0 + 1;               // right current
                    var b0 = base0 + (pi + 1) * 2; // left next
                    var b1 = b0 + 1;               // right next
                    mb.appendIndices([a0, a1, b1, a0, b1, b0]);
                }

                totalVerts += vertsNeeded;
                grandTotalVerts += vertsNeeded;
            }

            // Finalize last batch
            finalizeBatch();

            this.writeTraceHues(layer, smoothed, numTraces);
            this.flushTraceGrowth(layer);

            print("[KiCad] Traces " + layer + ": " +
                  numTraces + " ribbons, " + netMap.size + " nets, " + grandTotalVerts + " verts, " + batchIdx + " meshes");
        }
    }

    // ---- V2 Per-Segment Rendering with Round Caps ----
    // Each segment rendered individually as ribbon body + 2 semicircle caps.
    // Matches KiCad's per-segment constant-width round-cap line style.

    private static readonly CAP_SEGS = 6; // semicircle segments per cap

    private buildSegmentsV2(): void {
        if (!this.board.segments) return;

        var th = this.thickHalf();
        var layerZ: Record<string, number> = { 'F.Cu': th + 0.04, 'B.Cu': -th - 0.04 };
        var VERT_LIMIT = 63000;
        var CAP_N = KiCadBoard.CAP_SEGS;

        // Group segments + arcs by layer
        var segsByLayer: Map<string, any[]> = new Map();
        var allItems: any[] = (this.board.segments || []).concat(this.board.arcs || []);
        for (var si = 0; si < allItems.length; si++) {
            var item = allItems[si];
            var layer = item.layer || 'F.Cu';
            if (!segsByLayer.has(layer)) segsByLayer.set(layer, []);
            segsByLayer.get(layer)!.push(item);
        }

        // Precompute cap angle table (semicircle, CAP_N+1 points from 0 to PI)
        var capCos: number[] = [];
        var capSin: number[] = [];
        for (var ci = 0; ci <= CAP_N; ci++) {
            var angle = Math.PI * ci / CAP_N;
            capCos.push(Math.cos(angle));
            capSin.push(Math.sin(angle));
        }

        var layerKeys = Array.from(segsByLayer.keys()) as string[];
        for (var lk = 0; lk < layerKeys.length; lk++) {
            var traceLayer = layerKeys[lk];
            var items = segsByLayer.get(traceLayer)!;
            var numItems = Math.min(items.length, KiCadBoard.MAX_TRACES);
            this.traceCount.set(traceLayer, numItems);

            // Build net map (segment index -> net)
            var netMap: Map<number, number[]> = new Map();
            for (var i = 0; i < numItems; i++) {
                var net = items[i].net;
                if (!netMap.has(net)) netMap.set(net, []);
                netMap.get(net)!.push(i);
            }
            this.netTraceMap.set(traceLayer, netMap);
            this.traceGrowth.set(traceLayer, new Array(numItems).fill(1.0));

            var z = layerZ[traceLayer] || 0;
            var nz = traceLayer === 'F.Cu' ? 1 : -1;

            // Clone trace material for this layer
            var layerMat: Material | null = null;
            var srcTrace = this.srcTraceMat || this.traceMaterial;
            if (srcTrace) {
                layerMat = srcTrace.clone();
                var pass = layerMat.mainPass;
                this.tracePasses.set(traceLayer, pass);
                this.createTraceTexture(traceLayer, layerMat);
                try { pass["flowTime"] = 0; } catch (e) {}
                try { pass["realisticMode"] = this.isRealistic() ? 1.0 : 0.0; } catch (e) {}
                try { pass.blendMode = BlendMode.PremultipliedAlpha; } catch (e) {}
                try { pass["layerAlpha"] = traceLayer === 'B.Cu' ? 0.5 : 1.0; } catch (e) {}
            }

            var mb = KiCadBoard.newStaticMB();
            var totalVerts = 0;
            var batchIdx = 0;
            var grandTotalVerts = 0;

            var finalizeBatch = () => {
                if (totalVerts === 0) return;
                mb.updateMesh();
                var child = global.scene.createSceneObject("__traces_" + traceLayer + "_" + batchIdx);
                child.setParent(this.sceneObject);
                this.groupTraces.push(child);
                var rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
                rmv.mesh = mb.getMesh();
                if (layerMat) rmv.mainMaterial = layerMat;
                batchIdx++;
            };

            for (var ti = 0; ti < numItems; ti++) {
                var item = items[ti];

                // Expand arcs into sub-segments for rendering
                var subSegs: { sx: number, sy: number, ex: number, ey: number }[] = [];
                if (item.mid !== undefined && item.center) {
                    // Arc: tessellate
                    var arcSpan = Math.abs(item.endAngle - item.startAngle);
                    var arcN = Math.max(8, Math.ceil(arcSpan / (Math.PI / 12)));
                    var sweep = item.endAngle - item.startAngle;
                    var prevX = item.center[0] + item.radius * Math.cos(item.startAngle);
                    var prevY = item.center[1] + item.radius * Math.sin(item.startAngle);
                    for (var ai = 1; ai <= arcN; ai++) {
                        var aFrac = ai / arcN;
                        var arcAngle = item.startAngle + sweep * aFrac;
                        var curX = item.center[0] + item.radius * Math.cos(arcAngle);
                        var curY = item.center[1] + item.radius * Math.sin(arcAngle);
                        subSegs.push({ sx: prevX, sy: prevY, ex: curX, ey: curY });
                        prevX = curX;
                        prevY = curY;
                    }
                } else {
                    // Straight segment
                    subSegs.push({ sx: item.start[0], sy: item.start[1], ex: item.end[0], ey: item.end[1] });
                }

                // Verts per sub-segment: body(4) + startCap(CAP_N+1) + endCap(CAP_N+1)
                var vertsPerSub = 4 + (CAP_N + 1) + (CAP_N + 1);
                var vertsNeeded = subSegs.length * vertsPerSub;

                if (totalVerts + vertsNeeded > VERT_LIMIT && totalVerts > 0) {
                    finalizeBatch();
                    mb = KiCadBoard.newStaticMB();
                    totalVerts = 0;
                }

                var hw = (item.width || 0.25) * 0.5 * this.scaleFactor;

                for (var ssi = 0; ssi < subSegs.length; ssi++) {
                    var ss = subSegs[ssi];

                    // Transform to LS coords
                    var ax = (ss.sx - this.cx) * this.scaleFactor;
                    var ay = -(ss.sy - this.cy) * this.scaleFactor;
                    var bx = (ss.ex - this.cx) * this.scaleFactor;
                    var by = -(ss.ey - this.cy) * this.scaleFactor;
                    var az = z * this.scaleFactor;

                    // Direction and perpendicular
                    var dx = bx - ax, dy = by - ay;
                    var dlen = Math.sqrt(dx * dx + dy * dy);
                    if (dlen < 0.0001) continue;
                    var ndx = dx / dlen, ndy = dy / dlen;
                    var px = -ndy, py = ndx; // perpendicular

                    var base0 = mb.getVerticesCount();

                    // ---- Body: 4 verts (2 at start, 2 at end) ----
                    // Left start
                    mb.appendVerticesInterleaved([
                        ax + px * hw, ay + py * hw, az,  0, 0, nz,  0, ti, 1.0, 0
                    ]);
                    // Right start
                    mb.appendVerticesInterleaved([
                        ax - px * hw, ay - py * hw, az,  0, 0, nz,  0, ti, -1.0, 0
                    ]);
                    // Left end
                    mb.appendVerticesInterleaved([
                        bx + px * hw, by + py * hw, az,  0, 0, nz,  1, ti, 1.0, 0
                    ]);
                    // Right end
                    mb.appendVerticesInterleaved([
                        bx - px * hw, by - py * hw, az,  0, 0, nz,  1, ti, -1.0, 0
                    ]);

                    // Body triangles (2)
                    mb.appendIndices([base0, base0 + 1, base0 + 3, base0, base0 + 3, base0 + 2]);

                    // ---- Start cap (semicircle facing backward) ----
                    var capBase = mb.getVerticesCount();
                    // Center vertex
                    mb.appendVerticesInterleaved([
                        ax, ay, az,  0, 0, nz,  0, ti, 0, 0
                    ]);
                    // Rim vertices (from left edge, sweeping backward to right edge)
                    for (var ci = 0; ci <= CAP_N; ci++) {
                        // Rotate perpendicular backward: angles from +perp through -dir to -perp
                        var rx = px * capCos[ci] - (-ndx) * capSin[ci];
                        var ry = py * capCos[ci] - (-ndy) * capSin[ci];
                        var crossVal = ci <= CAP_N / 2 ? 1.0 - 2.0 * ci / CAP_N : -1.0 + 2.0 * (ci - CAP_N / 2) / (CAP_N / 2);
                        mb.appendVerticesInterleaved([
                            ax + rx * hw, ay + ry * hw, az,  0, 0, nz,  0, ti, crossVal, 0
                        ]);
                    }
                    // Start cap fan triangles
                    for (var ci = 0; ci < CAP_N; ci++) {
                        mb.appendIndices([capBase, capBase + 1 + ci, capBase + 2 + ci]);
                    }

                    // ---- End cap (semicircle facing forward) ----
                    var capBase2 = mb.getVerticesCount();
                    // Center vertex
                    mb.appendVerticesInterleaved([
                        bx, by, az,  0, 0, nz,  1, ti, 0, 0
                    ]);
                    // Rim vertices (from left edge, sweeping forward to right edge)
                    for (var ci = 0; ci <= CAP_N; ci++) {
                        var rx = px * capCos[ci] - ndx * capSin[ci];
                        var ry = py * capCos[ci] - ndy * capSin[ci];
                        var crossVal = ci <= CAP_N / 2 ? 1.0 - 2.0 * ci / CAP_N : -1.0 + 2.0 * (ci - CAP_N / 2) / (CAP_N / 2);
                        mb.appendVerticesInterleaved([
                            bx + rx * hw, by + ry * hw, az,  0, 0, nz,  1, ti, crossVal, 0
                        ]);
                    }
                    // End cap fan triangles
                    for (var ci = 0; ci < CAP_N; ci++) {
                        mb.appendIndices([capBase2, capBase2 + 1 + ci, capBase2 + 2 + ci]);
                    }

                    totalVerts += vertsPerSub;
                    grandTotalVerts += vertsPerSub;
                }
            }

            // Finalize last batch
            finalizeBatch();

            // Write hues to data texture (per-segment, indexed by ti)
            this.writeTraceHuesV2(traceLayer, items, numItems);
            this.flushTraceGrowth(traceLayer);

            print("[KiCad] Segments V2 " + traceLayer + ": " +
                  numItems + " items, " + netMap.size + " nets, " + grandTotalVerts + " verts, " + batchIdx + " meshes");
        }
    }

    // ---- V2 Zone Rendering (pre-triangulated copper fills) ----

    private buildZones(): void {
        if (!this.board.zones || this.board.zones.length === 0) return;

        var th = this.thickHalf();
        var layerZ: Record<string, number> = { 'F.Cu': th + 0.03, 'B.Cu': -th - 0.03 }; // slightly below traces
        var VERT_LIMIT = 63000;
        var zoneCount = 0;

        // Group zones by layer
        var zonesByLayer: Map<string, any[]> = new Map();
        for (var zi = 0; zi < this.board.zones.length; zi++) {
            var zone = this.board.zones[zi];
            if (!zone.filledPolygons || zone.filledPolygons.length === 0) continue;
            for (var fi = 0; fi < zone.filledPolygons.length; fi++) {
                var fp = zone.filledPolygons[fi];
                var layer = fp.layer || zone.layer || 'F.Cu';
                if (!zonesByLayer.has(layer)) zonesByLayer.set(layer, []);
                zonesByLayer.get(layer)!.push({ net: zone.net, netName: zone.netName, points: fp.points, triangles: fp.triangles });
            }
        }

        var layerKeys = Array.from(zonesByLayer.keys()) as string[];
        for (var lk = 0; lk < layerKeys.length; lk++) {
            var zoneLayer = layerKeys[lk];
            var fills = zonesByLayer.get(zoneLayer)!;
            var z = (layerZ[zoneLayer] || 0) * this.scaleFactor;
            var nz = zoneLayer === 'F.Cu' ? 1 : -1;

            var mb = KiCadBoard.newStaticMB();
            var totalVerts = 0;
            var batchIdx = 0;

            var finalizeBatch = () => {
                if (totalVerts === 0) return;
                mb.updateMesh();
                var child = global.scene.createSceneObject("__zones_" + zoneLayer + "_" + batchIdx);
                child.setParent(this.sceneObject);
                this.groupZones.push(child);
                var rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
                rmv.mesh = mb.getMesh();
                if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;
                batchIdx++;
            };

            for (var fi = 0; fi < fills.length; fi++) {
                var fill = fills[fi];
                var pts = fill.points;
                var tris = fill.triangles;
                if (!pts || !tris || pts.length < 3 || tris.length < 3) continue;

                if (totalVerts + pts.length > VERT_LIMIT && totalVerts > 0) {
                    finalizeBatch();
                    mb = KiCadBoard.newStaticMB();
                    totalVerts = 0;
                }

                var rgb = this.netRGB(fill.net);
                var base0 = mb.getVerticesCount();

                // Emit zone vertices
                for (var pi = 0; pi < pts.length; pi++) {
                    var lx = (pts[pi][0] - this.cx) * this.scaleFactor;
                    var ly = -(pts[pi][1] - this.cy) * this.scaleFactor;
                    mb.appendVerticesInterleaved([
                        lx, ly, z,  0, 0, nz,  0, 0,  0, 0
                    ]);
                }

                // Emit pre-computed triangle indices
                for (var ti = 0; ti < tris.length; ti += 3) {
                    mb.appendIndices([base0 + tris[ti], base0 + tris[ti + 1], base0 + tris[ti + 2]]);
                }

                totalVerts += pts.length;
                zoneCount++;
            }

            finalizeBatch();
        }

        if (zoneCount > 0) print("[KiCad] Zones: " + zoneCount + " fills on " + layerKeys.length + " layers");
    }

    // ---- V2 Board Drawings (gr_line, gr_circle, gr_arc, gr_rect on all layers) ----

    private buildDrawingsV2(): void {
        if (!this.board.drawings || this.board.drawings.length === 0) return;

        var th = this.thickHalf();
        // Z-stack (KiCad mm pre-scale). Different-color line layers need real
        // Z separation or they z-fight at small scaleFactor. Order from board
        // surface up: traces (th+0.04) → F.Cu drawings (+0.05, same copper
        // color so cohabiting is fine) → mask (+0.08) → pads (+0.10/0.12) →
        // F.Fab drawings (+0.30) → F.SilkS drawings (+0.50) → labels (+0.70).
        // The big jump between pads and F.Fab is the one that matters: those
        // are different colors and were previously stacked on top of the mask
        // at the same Z, which is where the z-fighting was happening.
        var layerZMap: Record<string, number> = {
            'F.SilkS': th + 0.50, 'B.SilkS': -th - 0.50,
            'F.Fab': th + 0.30, 'B.Fab': -th - 0.30,
            'F.Cu': th + 0.05, 'B.Cu': -th - 0.05,
            'Dwgs.User': th + 0.40, 'Cmts.User': th + 0.40
        };
        // Drawing layer colors (vivid/warm palette, no purple/green/cyan)
        var layerColors: Record<string, number[]> = {
            'F.SilkS': [0.94, 0.94, 0.91], 'B.SilkS': [0.75, 0.75, 0.72],
            'F.Fab': [0.70, 0.65, 0.55], 'B.Fab': [0.55, 0.50, 0.43],
            'F.Cu': [0.88, 0.25, 0.15], 'B.Cu': [0.25, 0.45, 0.78],
            'Dwgs.User': [0.80, 0.70, 0.40], 'Cmts.User': [0.60, 0.55, 0.40]
        };
        var defaultColor = [0.70, 0.65, 0.55];

        // Three independent batches keyed by board side: top (F.*), bottom
        // (B.*), and center (Edge.Cuts, Margin, etc.). Each side gets its own
        // batch index so explode can offset them in opposite directions.
        var sides = {
            top:    { mb: KiCadBoard.newStaticMB(), total: 0, idx: 0, group: this.groupTopDrawings, tag: "top"    as const },
            bot:    { mb: KiCadBoard.newStaticMB(), total: 0, idx: 0, group: this.groupBotDrawings, tag: "bot"    as const },
            center: { mb: KiCadBoard.newStaticMB(), total: 0, idx: 0, group: this.groupDrawings,    tag: "center" as const },
        };
        var VERT_LIMIT = 63000;
        var drawCount = 0;

        var finalizeBatch = (side: any) => {
            if (side.total === 0) return;
            side.mb.updateMesh();
            var child = global.scene.createSceneObject("__drawings_" + side.tag + "_" + side.idx);
            child.setParent(this.sceneObject);
            side.group.push(child);
            var rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            rmv.mesh = side.mb.getMesh();
            if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;
            side.mb = KiCadBoard.newStaticMB();
            side.total = 0;
            side.idx++;
        };

        for (var di = 0; di < this.board.drawings.length; di++) {
            var dr = this.board.drawings[di];
            var layer = dr.layer || 'F.Fab';
            var z = (layerZMap[layer] || th + 0.10) * this.scaleFactor;
            var nz = layer.startsWith('B.') ? -1 : 1;
            var side = layer.startsWith('B.') ? sides.bot
                     : layer.startsWith('F.') ? sides.top
                     : sides.center;
            var mb = side.mb;
            var hw = (dr.width || 0.1) * 0.5 * this.scaleFactor;
            if (hw < 0.001 * this.scaleFactor) hw = 0.05 * this.scaleFactor;

            // Collect line segments to render
            var segs: { sx: number, sy: number, ex: number, ey: number }[] = [];

            if (dr.type === 'line') {
                segs.push({ sx: dr.start[0], sy: dr.start[1], ex: dr.end[0], ey: dr.end[1] });
            } else if (dr.type === 'rect') {
                var x0 = dr.start[0], y0 = dr.start[1], x1 = dr.end[0], y1 = dr.end[1];
                segs.push({ sx: x0, sy: y0, ex: x1, ey: y0 });
                segs.push({ sx: x1, sy: y0, ex: x1, ey: y1 });
                segs.push({ sx: x1, sy: y1, ex: x0, ey: y1 });
                segs.push({ sx: x0, sy: y1, ex: x0, ey: y0 });
            } else if (dr.type === 'circle' && dr.center && dr.radius) {
                var CIRCLE_N = 24;
                for (var ci = 0; ci < CIRCLE_N; ci++) {
                    var a0 = 2 * Math.PI * ci / CIRCLE_N;
                    var a1 = 2 * Math.PI * (ci + 1) / CIRCLE_N;
                    segs.push({
                        sx: dr.center[0] + dr.radius * Math.cos(a0),
                        sy: dr.center[1] + dr.radius * Math.sin(a0),
                        ex: dr.center[0] + dr.radius * Math.cos(a1),
                        ey: dr.center[1] + dr.radius * Math.sin(a1)
                    });
                }
            } else if (dr.type === 'arc' && dr.center && dr.radius) {
                var arcSpan = Math.abs(dr.endAngle - dr.startAngle);
                var arcN = Math.max(8, Math.ceil(arcSpan / (Math.PI / 12)));
                var sweep = dr.endAngle - dr.startAngle;
                for (var ai = 0; ai < arcN; ai++) {
                    var t0 = ai / arcN, t1 = (ai + 1) / arcN;
                    segs.push({
                        sx: dr.center[0] + dr.radius * Math.cos(dr.startAngle + sweep * t0),
                        sy: dr.center[1] + dr.radius * Math.sin(dr.startAngle + sweep * t0),
                        ex: dr.center[0] + dr.radius * Math.cos(dr.startAngle + sweep * t1),
                        ey: dr.center[1] + dr.radius * Math.sin(dr.startAngle + sweep * t1)
                    });
                }
            } else if (dr.type === 'poly' && dr.points && dr.points.length >= 2) {
                for (var pi = 0; pi < dr.points.length - 1; pi++) {
                    segs.push({ sx: dr.points[pi][0], sy: dr.points[pi][1], ex: dr.points[pi + 1][0], ey: dr.points[pi + 1][1] });
                }
            }
            // Skip text drawings (would need Text components, handled by labels)

            if (segs.length === 0) continue;

            // Each seg: 4 body verts + simplified caps (just 2 extra triangles per end)
            var vertsNeeded = segs.length * 6; // 6 verts per segment (body + simplified cap)
            if (side.total + vertsNeeded > VERT_LIMIT && side.total > 0) {
                finalizeBatch(side);
                mb = side.mb; // finalizeBatch reset mb on the side
            }

            for (var si = 0; si < segs.length; si++) {
                var seg = segs[si];
                var ax = (seg.sx - this.cx) * this.scaleFactor;
                var ay = -(seg.sy - this.cy) * this.scaleFactor;
                var bx = (seg.ex - this.cx) * this.scaleFactor;
                var by = -(seg.ey - this.cy) * this.scaleFactor;

                var dx = bx - ax, dy = by - ay;
                var dlen = Math.sqrt(dx * dx + dy * dy);
                if (dlen < 0.0001) continue;
                var ndx = dx / dlen, ndy = dy / dlen;
                var px = -ndy, py = ndx;

                var base0 = mb.getVerticesCount();

                // Ribbon body with extended endpoints for pseudo-caps
                mb.appendVerticesInterleaved([
                    ax - ndx * hw + px * hw, ay - ndy * hw + py * hw, z, 0, 0, nz, 0, 0, 0, 0
                ]);
                mb.appendVerticesInterleaved([
                    ax - ndx * hw - px * hw, ay - ndy * hw - py * hw, z, 0, 0, nz, 0, 0, 0, 0
                ]);
                mb.appendVerticesInterleaved([
                    bx + ndx * hw + px * hw, by + ndy * hw + py * hw, z, 0, 0, nz, 0, 0, 0, 0
                ]);
                mb.appendVerticesInterleaved([
                    bx + ndx * hw - px * hw, by + ndy * hw - py * hw, z, 0, 0, nz, 0, 0, 0, 0
                ]);
                // Center caps (extends slightly past endpoints)
                mb.appendVerticesInterleaved([
                    ax - ndx * hw, ay - ndy * hw, z, 0, 0, nz, 0, 0, 0, 0
                ]);
                mb.appendVerticesInterleaved([
                    bx + ndx * hw, by + ndy * hw, z, 0, 0, nz, 0, 0, 0, 0
                ]);

                // Body quad
                mb.appendIndices([base0, base0 + 1, base0 + 3, base0, base0 + 3, base0 + 2]);
                // Start cap triangle
                mb.appendIndices([base0 + 4, base0, base0 + 1]);
                // End cap triangle
                mb.appendIndices([base0 + 5, base0 + 3, base0 + 2]);

                side.total += 6;
            }

            drawCount++;
        }

        finalizeBatch(sides.top);
        finalizeBatch(sides.bot);
        finalizeBatch(sides.center);
        if (drawCount > 0) print("[KiCad] Drawings: " + drawCount + " items");
    }

    private writeTraceHuesV2(layer: string, items: { net: number }[], count: number): void {
        var pixels = this.tracePixels.get(layer)!;
        for (var i = 0; i < count; i++) {
            var row = i * 4;
            this.encode01(pixels, row + 0, 1.0); // growth = 1 (fully visible)
            this.encode01(pixels, row + 2, this.netHue(items[i].net)); // hue
        }
        this.markAllTracesDirty(layer);
    }

    // 2-wide data texture per trace row:
    //   Column 0 (x=0.25): R,G = growth (16-bit), B,A = hue (16-bit)
    //   Column 1 (x=0.75): R,G = arcLen (16-bit, /200 cm), B,A = avgWidth (16-bit, /10 mm)
    private createTraceTexture(layer: string, mat: Material): void {
        const texH = KiCadBoard.MAX_TRACES;
        const tex = ProceduralTextureProvider.createWithFormat(2, texH, TextureFormat.RGBA8Unorm);
        this.traceTexProviders.set(layer, tex.control as ProceduralTextureProvider);
        this.tracePixels.set(layer, new Uint8Array(texH * 8));
        mat.mainPass["traceTex"] = tex;
        mat.mainPass["NumTraces"] = KiCadBoard.MAX_TRACES;
    }

    private encode01(pixels: Uint8Array, offset: number, value: number): void {
        const v = Math.round(Math.max(0, Math.min(65535, value * 65535)));
        pixels[offset] = (v >> 8) & 0xFF;
        pixels[offset + 1] = v & 0xFF;
    }

    private writeTraceHues(layer: string, polylines: { net: number }[], count: number): void {
        const pixels = this.tracePixels.get(layer)!;
        for (let i = 0; i < count; i++) {
            const row = i * 4;
            this.encode01(pixels, row + 0, 1.0);
            this.encode01(pixels, row + 2, this.netHue(polylines[i].net));
        }
        // Mark all rows dirty for the initial upload
        this.markAllTracesDirty(layer);
    }

    private netHue(netId: number): number {
        const netName = this.board.nets[netId] || '';
        if (netName === 'GND' || netName === '/GND') return 0.0;
        if (netName.includes('+3V3') || netName.includes('3.3V')) return 0.08;
        if (netName.includes('+5V') || netName.includes('VCC')) return 0.12;
        if (netName.includes('+1V2') || netName.includes('1.2V')) return 0.15;
        return (netId * 0.618033988749895) % 1.0;
    }

    // HSV to RGB conversion (matches trace shader)
    private static hsv2rgb(h: number, s: number, v: number): [number, number, number] {
        const f = (n: number) => {
            const k = (n + h * 6) % 6;
            return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
        };
        return [f(5), f(3), f(1)];
    }

    // Get RGB color for a net (vivid per-net hue or realistic copper)
    private netRGB(netId: number): [number, number, number] {
        if (netId <= 0) return [0.3, 0.3, 0.3];
        if (this.isRealistic()) {
            // Copper/bronze with slight warmth variation per net (synced with shader)
            const hue = this.netHue(netId);
            const warm = 0.03 * Math.sin(hue * 6.28);
            return [0.82 + warm, 0.50 + warm * 0.5, 0.28];
        }
        const hue = this.netHue(netId);
        return KiCadBoard.hsv2rgb(hue, 0.85, 0.9);
    }

    private isPowerNet(netId: number): boolean {
        const name = this.board.nets[netId] || '';
        if (name === 'GND' || name === '/GND') return true;
        if (name.includes('+3V3') || name.includes('3.3V')) return true;
        if (name.includes('+5V') || name.includes('VCC')) return true;
        if (name.includes('+1V2') || name.includes('1.2V')) return true;
        if (name.includes('VBUS') || name.includes('VIN')) return true;
        return false;
    }

    private markTraceDirty(layer: string, idx: number): void {
        var cur = this.traceDirtyMin.get(layer);
        if (cur === undefined || idx < cur) this.traceDirtyMin.set(layer, idx);
        var curMax = this.traceDirtyMax.get(layer);
        if (curMax === undefined || idx > curMax) this.traceDirtyMax.set(layer, idx);
    }

    private markAllTracesDirty(layer: string): void {
        this.traceDirtyMin.set(layer, 0);
        this.traceDirtyMax.set(layer, (this.traceCount.get(layer) || 1) - 1);
    }

    private flushTraceGrowth(layer: string): void {
        const pixels = this.tracePixels.get(layer);
        const growths = this.traceGrowth.get(layer);
        if (!pixels || !growths) return;

        var dMin = this.traceDirtyMin.get(layer);
        var dMax = this.traceDirtyMax.get(layer);
        if (dMin === undefined || dMax === undefined) {
            // No dirty rows, nothing to upload
            return;
        }

        // Clamp to valid range
        var numTraces = this.traceCount.get(layer) || 0;
        if (dMin >= numTraces) return;
        if (dMax >= numTraces) dMax = numTraces - 1;

        // Encode only dirty rows
        for (var i = dMin; i <= dMax; i++) {
            this.encode01(pixels, i * 4, Math.max(0, Math.min(1, growths[i])));
        }

        var provider = this.traceTexProviders.get(layer);
        if (provider) {
            // Upload only the dirty row range (column 0, rows dMin..dMax)
            var rowCount = dMax - dMin + 1;
            var subPixels = pixels.subarray(dMin * 4, (dMax + 1) * 4);
            provider.setPixels(0, dMin, 1, rowCount, subPixels);
        }

        // Clear dirty state
        this.traceDirtyMin.delete(layer);
        this.traceDirtyMax.delete(layer);
    }

    private flushAllTraceGrowth(): void {
        var fk: string[] = Array.from(this.traceGrowth.keys()) as string[];
        for (var fi = 0; fi < fk.length; fi++) {
            this.flushTraceGrowth(fk[fi]);
        }
    }

    // ---- Vias (cylinder barrels spanning copper layers) ----

    private buildVias(): void {
        if (!this.board.vias || this.board.vias.length === 0) return;

        // Cache via data for explode rebuild
        this.viaData = [];
        for (var vi = 0; vi < this.board.vias.length; vi++) {
            var v = this.board.vias[vi];
            this.viaData.push({
                pos: v.pos, size: v.size, drill: v.drill,
                net: v.net, layers: v.layers || ['F.Cu', 'B.Cu']
            });
        }

        this.rebuildViaMesh(this.explodeAmount);
        print("[KiCad] Vias: " + this.board.vias.length + " (cylinder barrels)");
    }

    // Rebuild via geometry at given explode progress (called on explode change)
    private rebuildViaMesh(progress: number): void {
        // Destroy existing via mesh
        if (this.groupVias) {
            this.groupVias.destroy();
            this.groupVias = null;
        }
        if (this.viaData.length === 0) return;

        var mb = KiCadBoard.newStaticMB();
        var s = this.scaleFactor;
        var th = this.thickHalf();
        var sp = this.explodeSpread * progress;
        var CYL_SEGS = 12;

        // Precompute unit circle (shared across all vias)
        var circX: number[] = [], circY: number[] = [];
        for (var ci = 0; ci < CYL_SEGS; ci++) {
            var ang = (ci / CYL_SEGS) * Math.PI * 2;
            circX.push(Math.cos(ang));
            circY.push(Math.sin(ang));
        }

        for (var vi = 0; vi < this.viaData.length; vi++) {
            var via = this.viaData[vi];
            var cx2d = via.pos[0], cy2d = via.pos[1];
            var lsXY = this.toLS(cx2d, cy2d, 0);
            var rd = this.revealDist(cx2d, cy2d);
            var rgb = via.net > 0 ? this.netRGB(via.net) : this.COL_VIA;
            var vr = rgb[0], vg = rgb[1], vb2 = rgb[2];

            var outerR = (via.size * 0.5) * s;
            var drillR = (via.drill * 0.5) * s;
            if (drillR < 0.001) drillR = outerR * 0.4;

            var topZ = (th + 0.06) * s + sp * 3.0;
            var botZ = (-th - 0.06) * s - sp * 3.0;

            // Continuous via: top pad + barrel + bottom pad (shared edge positions)
            // 1. Top annular ring (outer_r -> drill_r, normal up)
            var topRingBase = mb.getVerticesCount();
            for (var ci = 0; ci < CYL_SEGS; ci++) {
                var ox = circX[ci] * outerR, oy = circY[ci] * outerR;
                var ix = circX[ci] * drillR, iy = circY[ci] * drillR;
                mb.appendVerticesInterleaved([
                    lsXY.x + ox, lsXY.y + oy, topZ, 0, 0, 1, vr, vg, vb2, rd
                ]);
                mb.appendVerticesInterleaved([
                    lsXY.x + ix, lsXY.y + iy, topZ, 0, 0, 1, vr, vg, vb2, rd
                ]);
            }
            for (var ci = 0; ci < CYL_SEGS; ci++) {
                var o0 = topRingBase + ci * 2, i0 = o0 + 1;
                var o1 = topRingBase + ((ci + 1) % CYL_SEGS) * 2, i1 = o1 + 1;
                mb.appendIndices([o0, o1, i1, o0, i1, i0]);
            }

            // 2. Barrel (cylinder at outer_r from topZ to botZ, outward normals)
            var barrelBase = mb.getVerticesCount();
            for (var ci = 0; ci < CYL_SEGS; ci++) {
                var nx = circX[ci], ny = circY[ci];
                var ox = nx * outerR, oy = ny * outerR;
                mb.appendVerticesInterleaved([
                    lsXY.x + ox, lsXY.y + oy, topZ, nx, ny, 0, vr, vg, vb2, rd
                ]);
                mb.appendVerticesInterleaved([
                    lsXY.x + ox, lsXY.y + oy, botZ, nx, ny, 0, vr, vg, vb2, rd
                ]);
            }
            for (var ci = 0; ci < CYL_SEGS; ci++) {
                var c0t = barrelBase + ci * 2, c0b = c0t + 1;
                var c1t = barrelBase + ((ci + 1) % CYL_SEGS) * 2, c1b = c1t + 1;
                mb.appendIndices([c0t, c0b, c1b, c0t, c1b, c1t]);
            }

            // 3. Bottom annular ring (outer_r -> drill_r, normal down)
            var botRingBase = mb.getVerticesCount();
            for (var ci = 0; ci < CYL_SEGS; ci++) {
                var ox = circX[ci] * outerR, oy = circY[ci] * outerR;
                var ix = circX[ci] * drillR, iy = circY[ci] * drillR;
                mb.appendVerticesInterleaved([
                    lsXY.x + ox, lsXY.y + oy, botZ, 0, 0, -1, vr, vg, vb2, rd
                ]);
                mb.appendVerticesInterleaved([
                    lsXY.x + ix, lsXY.y + iy, botZ, 0, 0, -1, vr, vg, vb2, rd
                ]);
            }
            for (var ci = 0; ci < CYL_SEGS; ci++) {
                var o0 = botRingBase + ci * 2, i0 = o0 + 1;
                var o1 = botRingBase + ((ci + 1) % CYL_SEGS) * 2, i1 = o1 + 1;
                mb.appendIndices([o0, i1, o1, o0, i0, i1]);
            }
        }

        mb.updateMesh();
        var child = global.scene.createSceneObject("__vias");
        child.setParent(this.sceneObject);
        this.groupVias = child;
        var rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;
        rmv.renderOrder = 5; // draw over traces so via caps hide flat trace tips
        this.viaExplodeProgress = progress;
    }

    // ---- Footprints ----

    private buildFootprints(): void {
        if (!this.board.footprints) return;

        // Separate mesh builders for F.Cu and B.Cu pads
        var mbTop = KiCadBoard.newStaticMB();
        var mbBot = KiCadBoard.newStaticMB();
        var [defaultPr, defaultPg, defaultPb] = this.COL_PAD;
        var [sr, sg, sb] = this.COL_SILK;
        var th = this.thickHalf();
        var s = this.scaleFactor;
        var topCount = 0, botCount = 0;

        for (var fi = 0; fi < this.board.footprints.length; fi++) {
            var fp = this.board.footprints[fi];
            var fpx = fp.pos[0], fpy = fp.pos[1];
            var fpRot = fp.rot || 0;

            // KiCad-space rotation (matching web viewer: negate angle)
            var kRad = -fpRot * Math.PI / 180;
            var cosK = Math.cos(kRad), sinK = Math.sin(kRad);

            // LS-space rotation for shape corners (Y-flip reverses rotation)
            var lRad = fpRot * Math.PI / 180;
            var cosL = Math.cos(lRad), sinL = Math.sin(lRad);

            var isBot = fp.layer === 'B.Cu';
            var layerZ = isBot ? -th : th;
            var mb = isBot ? mbBot : mbTop;

            // Collect nets and bounds for selection
            var fpNets: number[] = [];
            var bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;

            if (fp.pads) {
                for (var pi = 0; pi < fp.pads.length; pi++) {
                    var pad = fp.pads[pi];
                    if (pad.net > 0) fpNets.push(pad.net);

                    // Per-net color for pad (default gold for NC pads)
                    var pr: number, pg: number, pb: number;
                    if (pad.net > 0) {
                        var rgb = this.netRGB(pad.net);
                        pr = rgb[0]; pg = rgb[1]; pb = rgb[2];
                    } else {
                        pr = defaultPr; pg = defaultPg; pb = defaultPb;
                    }

                    // Rotate pad local pos in KiCad space
                    var rp = this.rotPt(pad.pos[0], pad.pos[1], cosK, sinK);
                    var gx = fpx + rp[0], gy = fpy + rp[1];
                    // Pads sit above traces (traces at th + 0.06) to avoid z-fighting
                    var padArea = pad.size[0] * pad.size[1];
                    var padZOff = padArea > 4.0 ? 0.10 : 0.12;
                    var wp = this.toLS(gx, gy, layerZ + padZOff);
                    var rd = this.revealDist(gx, gy);

                    var hw = pad.size[0] * 0.5 * s;
                    var hh = pad.size[1] * 0.5 * s;

                    // Update bounds
                    var padR = Math.max(hw, hh);
                    bMinX = Math.min(bMinX, wp.x - padR);
                    bMaxX = Math.max(bMaxX, wp.x + padR);
                    bMinY = Math.min(bMinY, wp.y - padR);
                    bMaxY = Math.max(bMaxY, wp.y + padR);

                    // Combined footprint + pad rotation for shape orientation
                    var totalPadRot = fpRot + (pad.rot || 0);
                    var pRad = totalPadRot * Math.PI / 180;
                    var cosP = Math.cos(pRad), sinP = Math.sin(pRad);
                    // Normal faces away from board surface
                    var nz = isBot ? -1 : 1;

                    if (pad.type === 'thru_hole' && pad.drill) {
                        // Solid rounded square for thru-hole pads
                        var hs = Math.max(hw, hh);
                        var cr = hs * 0.3;
                        var inner = hs - cr;
                        var cSegs = 2;
                        var padCorners = [
                            [inner, inner], [-inner, inner], [-inner, -inner], [inner, -inner]
                        ];
                        var startAngles = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
                        var outline: number[][] = [];
                        for (var ci = 0; ci < 4; ci++) {
                            var ccx = padCorners[ci][0], ccy = padCorners[ci][1];
                            var sa = startAngles[ci];
                            for (var si = 0; si <= cSegs; si++) {
                                var a = sa + (si / cSegs) * Math.PI * 0.5;
                                var ox = ccx + Math.cos(a) * cr;
                                var oy = ccy + Math.sin(a) * cr;
                                // Rotate outline by combined rotation
                                var rOL = this.rotPt(ox, oy, cosP, sinP);
                                outline.push(rOL);
                            }
                        }
                        var center = mb.getVerticesCount();
                        mb.appendVerticesInterleaved([wp.x, wp.y, wp.z, 0, 0, nz, pr, pg, pb, rd]);
                        for (var oi = 0; oi < outline.length; oi++) {
                            mb.appendVerticesInterleaved([wp.x + outline[oi][0], wp.y + outline[oi][1], wp.z, 0, 0, nz, pr, pg, pb, rd]);
                        }
                        var n = outline.length;
                        for (var i = 0; i < n; i++) {
                            if (isBot) {
                                mb.appendIndices([center, center + 1 + (i + 1) % n, center + 1 + i]);
                            } else {
                                mb.appendIndices([center, center + 1 + i, center + 1 + (i + 1) % n]);
                            }
                        }
                    } else {
                        var c0 = this.rotPt(-hw, -hh, cosP, sinP);
                        var c1 = this.rotPt( hw, -hh, cosP, sinP);
                        var c2 = this.rotPt( hw,  hh, cosP, sinP);
                        var c3 = this.rotPt(-hw,  hh, cosP, sinP);
                        var base = mb.getVerticesCount();
                        mb.appendVerticesInterleaved([
                            wp.x + c0[0], wp.y + c0[1], wp.z, 0, 0, nz, pr, pg, pb, rd,
                            wp.x + c1[0], wp.y + c1[1], wp.z, 0, 0, nz, pr, pg, pb, rd,
                            wp.x + c2[0], wp.y + c2[1], wp.z, 0, 0, nz, pr, pg, pb, rd,
                            wp.x + c3[0], wp.y + c3[1], wp.z, 0, 0, nz, pr, pg, pb, rd,
                        ]);
                        if (isBot) {
                            mb.appendIndices([base, base + 2, base + 1, base, base + 3, base + 2]);
                        } else {
                            mb.appendIndices([base, base + 1, base + 2, base, base + 2, base + 3]);
                        }
                    }
                    if (isBot) botCount++; else topCount++;
                }
            }

            // Store bounds for selection
            var ref = fp.ref || fp.name || "FP";
            if (bMinX < Infinity) {
                this.fpBounds.push({
                    ref,
                    cx: (bMinX + bMaxX) * 0.5,
                    cy: (bMinY + bMaxY) * 0.5,
                    hw: (bMaxX - bMinX) * 0.5,
                    hh: (bMaxY - bMinY) * 0.5,
                    nets: [...new Set(fpNets)]
                });
            }
        }

        // Create top pads SceneObject
        if (topCount > 0) {
            mbTop.updateMesh();
            var childTop = global.scene.createSceneObject("__pads_top");
            childTop.setParent(this.sceneObject);
            this.groupPadsTop = childTop;
            var rmvTop = childTop.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            rmvTop.mesh = mbTop.getMesh();
            if (this.boardMaterial) rmvTop.mainMaterial = this.boardMaterial;
        }

        // Create bottom pads SceneObject
        if (botCount > 0) {
            mbBot.updateMesh();
            var childBot = global.scene.createSceneObject("__pads_bot");
            childBot.setParent(this.sceneObject);
            this.groupPadsBot = childBot;
            var rmvBot = childBot.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            rmvBot.mesh = mbBot.getMesh();
            if (this.boardMaterial) rmvBot.mainMaterial = this.boardMaterial;
        }

        print("[KiCad] Footprints: " + this.board.footprints.length + ", " + this.fpBounds.length + " selectable (" + topCount + " top, " + botCount + " bot pads)");
    }

    // ---- Text labels ----

    private buildLabels(): void {
        if (!this.board.footprints) return;

        const th = this.thickHalf();
        const s = this.scaleFactor;
        let count = 0;

        for (const fp of this.board.footprints) {
            const ref = fp.ref || '';
            // Skip fiducials, test points, mounting holes, unref'd
            if (!ref || ref.startsWith('FID') || ref.startsWith('TP') ||
                ref.startsWith('REF') || ref.startsWith('MK')) continue;

            const fpx = fp.pos[0], fpy = fp.pos[1];
            const isBack = fp.layer === 'B.Cu';
            const layerZ = isBack ? -th : th;
            // Labels sit just above pads (pads at +0.10~0.12, labels at +0.14)
            const labelZ = layerZ + (isBack ? -0.14 : 0.14);

            // Use text position offset from KiCad if available (rotated by footprint angle)
            var textX = fpx, textY = fpy;
            if (fp.refPos) {
                var fpRad = (fp.rot || 0) * Math.PI / 180;
                var cosF = Math.cos(fpRad), sinF = Math.sin(fpRad);
                textX = fpx + fp.refPos[0] * cosF - fp.refPos[1] * sinF;
                textY = fpy + fp.refPos[0] * sinF + fp.refPos[1] * cosF;
            }
            const wp = this.toLS(textX, textY, labelZ);

            const labelObj = global.scene.createSceneObject("__lbl_" + ref);
            labelObj.setParent(this.sceneObject);
            labelObj.layer = this.sceneObject.layer;
            this.groupLabels.push(labelObj);
            labelObj.getTransform().setLocalPosition(wp);
            this.labelBaseZ.set(labelObj, wp.z);

            try {
                const text = labelObj.createComponent("Component.Text") as Text;
                // Depth-tested so labels are properly occluded, but high renderOrder
                // ensures they render after opaque board geometry (avoids z-fighting)
                text.depthTest = false;
                text.renderOrder = 200;

                // Show ref only (silkscreen style) - value shown on selection
                text.text = ref;

                // KiCad silkscreen text height in mm, scale to LS units.
                // text.size is in font "points" - we map kicadTextH (mm) through scaleFactor.
                var kicadTextH = 1.0;
                if (fp.textSize && fp.textSize > 0) kicadTextH = fp.textSize;
                text.size = Math.max(1, Math.round(this.labelSize * s * kicadTextH));

                if (this.labelFont) {
                    (text as any).font = this.labelFont;
                }
                text.horizontalAlignment = HorizontalAlignment.Center;
                text.verticalAlignment = VerticalAlignment.Center;

                // Silkscreen label color
                const [slr, slg, slb] = this.COL_SILK;
                text.textFill.color = new vec4(slr, slg, slb, 1.0);

                this.labelObjects.set(ref, labelObj);
                this.labelRevealDist.set(ref, this.revealDist(fpx, fpy));
                count++;
                if (count <= 10) {
                    print("[KiCad] Label " + ref + " at (" +
                        wp.x.toFixed(1) + "," + wp.y.toFixed(1) + "," + wp.z.toFixed(1) +
                        ") size=" + text.size + " kicadH=" + kicadTextH.toFixed(1));
                }
            } catch (e: any) {
                print("[KiCad] Text FAILED for " + ref + ": " + e.message);
            }
        }

        print("[KiCad] Labels: " + count + " (labelSize=" + this.labelSize + ", hasFont=" + !!this.labelFont + ")");
    }

    // ---- Collider for whole-board interaction ----

    // Per-component interactables for precise SIK hover + tap
    private fpInteractables: SceneObject[] = [];

    // Collider padding: extra size beyond the visual geometry so hands can
    // grab the board comfortably. The normal-axis padding is the most critical
    // because a 1.6 mm PCB is nearly impossible to pinch otherwise.
    @input
    @hint("Extra collider extent along the board normal (cm per side)")
    colliderPadNormal: number = 3.0;

    @input
    @hint("Extra collider extent along the board plane (cm per side)")
    colliderPadPlanar: number = 1.0;

    private buildCollider(): void {
        var s = this.scaleFactor;
        var th = this.thickHalf() * s;
        var colliderDepth = th * 2 + this.colliderPadNormal * 2;

        // Board-level collider: resize the SceneObject's own ColliderComponent
        // (authored, or created on first build) so InteractableManipulation
        // catches grabs on the current board's actual bounds. Without this,
        // switching from a small board (e.g. Arduino Nano) to a big one
        // (e.g. RPi CM4 IO) leaves the collider sized for the small board and
        // grab raycasts miss the rebuilt geometry.
        var outline = this.board.board.outline;
        if (outline && outline.length >= 3) {
            var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (var oi = 0; oi < outline.length; oi++) {
                if (outline[oi][0] < minX) minX = outline[oi][0];
                if (outline[oi][0] > maxX) maxX = outline[oi][0];
                if (outline[oi][1] < minY) minY = outline[oi][1];
                if (outline[oi][1] > maxY) maxY = outline[oi][1];
            }
            var boardW = (maxX - minX) * s + this.colliderPadPlanar * 2;
            var boardH = (maxY - minY) * s + this.colliderPadPlanar * 2;
            var boardCollider = this.sceneObject.getComponent(
                "Physics.ColliderComponent") as ColliderComponent;
            if (!boardCollider || isNull(boardCollider)) {
                boardCollider = this.sceneObject.createComponent(
                    "Physics.ColliderComponent") as ColliderComponent;
            }
            var boardShape = Shape.createBoxShape();
            boardShape.size = new vec3(boardW, boardH, colliderDepth);
            boardCollider.shape = boardShape;
            // Tangible — InteractableManipulation needs this to land grabs.
            // Per-footprint colliders below are created without intangible too;
            // SIK resolves overlap by raycast distance, and the per-footprint
            // colliders sit slightly above the board surface so they win on hover.
            boardCollider.intangible = false;
        }

        // Per-component colliders (for hover/tap selection)
        if (this.fpBounds.length === 0) return;
        var self = this;
        var count = 0;

        for (var fi = 0; fi < this.fpBounds.length; fi++) {
            var fpb = this.fpBounds[fi];
            if (fpb.hw < 0.001 && fpb.hh < 0.001) continue;

            var lsPos = this.toLS(fpb.cx, fpb.cy, 0);
            var hw = Math.max(fpb.hw * s, 0.3 * s);
            var hh = Math.max(fpb.hh * s, 0.3 * s);

            var obj = global.scene.createSceneObject("__sel_" + fpb.ref);
            obj.setParent(this.sceneObject);
            obj.getTransform().setLocalPosition(lsPos);
            this.fpInteractables.push(obj);

            var collider = obj.createComponent("Physics.ColliderComponent") as ColliderComponent;
            var shape = Shape.createBoxShape();
            shape.size = new vec3(hw * 2 + this.colliderPadPlanar, hh * 2 + this.colliderPadPlanar, colliderDepth);
            collider.shape = shape;

            try {
                var interactable = obj.createComponent(Interactable.getTypeName()) as Interactable;
                self.setupFpInteractable(interactable, fpb.ref);
                count++;
            } catch (err: any) {}
        }

        print("[KiCad] Colliders: 1 board + " + count + " components");
    }

    private selectionPinned: boolean = false;

    // Closure factory: captures ref by value for each footprint's event handlers
    private setupFpInteractable(interactable: Interactable, ref: string): void {
        var self = this;
        interactable.onHoverEnter(function() {
            if (!self.selectedFP || !self.selectionPinned) {
                self.selectFootprint(ref);
            }
        });
        interactable.onHoverExit(function() {
            if (self.selectedFP === ref && !self.selectionPinned) {
                self.deselectFootprint();
            }
        });
        interactable.onTriggerStart(function() {
            if (self.selectedFP === ref && self.selectionPinned) {
                self.selectionPinned = false;
                self.deselectFootprint();
            } else {
                self.selectionPinned = true;
                self.selectFootprint(ref);
            }
        });
    }

    // ---- Semantic growth (BFS from power nets) ----

    private buildGrowthOrder(): number[][] {
        // Build net-to-net adjacency through shared footprints
        const netAdj: Map<number, Set<number>> = new Map();
        const allTraceNets = new Set<number>();
        var traceSource: any[] = this.isV2()
            ? (this.board.segments || []).concat(this.board.arcs || [])
            : (this.board.polylines || this.board.traces || []);
        for (const t of traceSource) {
            if (t.net > 0) allTraceNets.add(t.net);
        }

        for (const fp of this.board.footprints) {
            if (!fp.pads) continue;
            const fpNets: number[] = [];
            for (const pad of fp.pads) {
                if (pad.net > 0 && allTraceNets.has(pad.net)) fpNets.push(pad.net);
            }
            const unique = [...new Set(fpNets)];
            for (const a of unique) {
                if (!netAdj.has(a)) netAdj.set(a, new Set());
                for (const b of unique) {
                    if (a !== b) netAdj.get(a)!.add(b);
                }
            }
        }

        // BFS from power nets
        const visited = new Set<number>();
        const waves: number[][] = [];
        const queue: number[] = [];

        // Seed: power nets
        const powerNets: number[] = [];
        for (const netId of allTraceNets) {
            if (this.isPowerNet(netId)) {
                powerNets.push(netId);
                visited.add(netId);
            }
        }
        if (powerNets.length > 0) {
            waves.push(powerNets);
            for (const n of powerNets) queue.push(n);
        }

        // BFS layers
        while (queue.length > 0) {
            const nextQueue: number[] = [];
            const wave: number[] = [];
            for (const netId of queue) {
                const neighbors = netAdj.get(netId);
                if (!neighbors) continue;
                for (const n of neighbors) {
                    if (!visited.has(n)) {
                        visited.add(n);
                        wave.push(n);
                        nextQueue.push(n);
                    }
                }
            }
            if (wave.length > 0) {
                waves.push(wave);
            }
            queue.length = 0;
            for (const n of nextQueue) queue.push(n);
        }

        // Any remaining nets not reachable from power
        const orphans: number[] = [];
        for (const netId of allTraceNets) {
            if (!visited.has(netId)) orphans.push(netId);
        }
        if (orphans.length > 0) {
            waves.push(orphans);
        }

        return waves;
    }

    // ---- Animation ----

    public startGrowAll(): void {
        this.animWaves = this.buildGrowthOrder();

        // Reset all growth to 0
        for (const [layer, growths] of this.traceGrowth) {
            for (let i = 0; i < growths.length; i++) growths[i] = 0;
            this.markAllTracesDirty(layer);
        }
        this.animActive = true;
        this.animWaveIdx = 0;
        this.animWaveProgress = 0;

        this.flushAllTraceGrowth();

        const totalNets = this.animWaves.reduce((s, w) => s + w.length, 0);
        print("[KiCad] Semantic grow: " + totalNets + " nets in " + this.animWaves.length + " waves");
    }

    private applyVisibility(): void {
        for (const o of this.groupBoard) { if (o && !isNull(o)) o.enabled = this.showBoard; }
        for (const o of this.groupTraces) { if (o && !isNull(o)) o.enabled = this.showTraces; }
        if (this.groupVias && !isNull(this.groupVias)) this.groupVias.enabled = this.showVias;
        if (this.groupPadsTop && !isNull(this.groupPadsTop)) this.groupPadsTop.enabled = this.showPads;
        if (this.groupPadsBot && !isNull(this.groupPadsBot)) this.groupPadsBot.enabled = this.showPads;
        for (const o of this.groupLabels) { if (o && !isNull(o)) o.enabled = this.showLabels; }
        var maskOn = this.showBoard && !this.isExploded();
        if (this.groupTopMask && !isNull(this.groupTopMask)) this.groupTopMask.enabled = maskOn;
        if (this.groupBotMask && !isNull(this.groupBotMask)) this.groupBotMask.enabled = maskOn;
    }

    private syncVisibility(): void {
        for (const o of this.groupBoard) { if (o && !isNull(o)) o.enabled = this.showBoard; }
        var maskOn = this.showBoard && !this.isExploded();
        if (this.groupTopMask && !isNull(this.groupTopMask)) this.groupTopMask.enabled = maskOn;
        if (this.groupBotMask && !isNull(this.groupBotMask)) this.groupBotMask.enabled = maskOn;
        for (const o of this.groupTraces) { if (o && !isNull(o)) o.enabled = this.showTraces; }
        if (this.groupVias && !isNull(this.groupVias)) this.groupVias.enabled = this.showVias;
        if (this.groupPadsTop && !isNull(this.groupPadsTop)) this.groupPadsTop.enabled = this.showPads;
        if (this.groupPadsBot && !isNull(this.groupPadsBot)) this.groupPadsBot.enabled = this.showPads;
        for (const o of this.groupLabels) { if (o && !isNull(o)) o.enabled = this.showLabels; }
    }

    /* [ARCHIVED] Hand tracking + clap gesture methods — disabled for performance

    private getClosestHandDist(): number {
        if (!this.handInputData) return Infinity;
        const boardPos = this.sceneObject.getTransform().getWorldPosition();
        let minDist = Infinity;
        for (const side of ["right", "left"]) {
            try {
                const hand = this.handInputData.getHand(side);
                if (!hand || !hand.isTracked()) continue;
                const pts = hand.points;
                if (!pts || pts.length === 0) continue;
                const wrist = pts[0];
                if (!wrist || !wrist.position) continue;
                const wp = wrist.position;
                const dx = wp.x - boardPos.x;
                const dy = wp.y - boardPos.y;
                const dz = wp.z - boardPos.z;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d < minDist) minDist = d;
            } catch {}
        }
        return minDist;
    }

    private getPalmCenter(hand: any): vec3 | null {
        if (!hand || !hand.isTracked()) return null;
        const ik = hand.indexKnuckle?.position;
        const mk = hand.middleKnuckle?.position;
        const rk = hand.ringKnuckle?.position;
        if (!ik || !mk || !rk) return null;
        return new vec3(
            (ik.x + mk.x + rk.x) / 3,
            (ik.y + mk.y + rk.y) / 3,
            (ik.z + mk.z + rk.z) / 3
        );
    }

    private updateClapDetection(dt: number): void {
        if (!this.handInputData) return;
        if (this.clapCooldown > 0) { this.clapCooldown -= dt; return; }
        let rPalm: vec3 | null = null;
        let lPalm: vec3 | null = null;
        try { rPalm = this.getPalmCenter(this.handInputData.getHand("right")); } catch {}
        try { lPalm = this.getPalmCenter(this.handInputData.getHand("left")); } catch {}
        if (!rPalm || !lPalm) { this.prevPalmDist = Infinity; return; }
        const dist = rPalm.distance(lPalm);
        const closingSpeed = (this.prevPalmDist - dist) / Math.max(dt, 0.001);
        this.prevPalmDist = dist;
        if (dist < KiCadBoard.CLAP_DIST_THRESH && closingSpeed > KiCadBoard.CLAP_CLOSE_SPEED) {
            this.explodeAmount = this.isExploded() ? 0 : 1;
            this.clapCooldown = KiCadBoard.CLAP_COOLDOWN_S;
            print("[KiCad] CLAP -> explode=" + this.isExploded());
        }
    }
    */

    private findCamera(obj: SceneObject): SceneObject | null {
        try {
            if (obj.getComponent("Component.Camera")) return obj;
        } catch {}
        for (let i = 0; i < obj.getChildrenCount(); i++) {
            const found = this.findCamera(obj.getChild(i));
            if (found) return found;
        }
        return null;
    }

    // Apply layer explosion offsets to group SceneObjects
    // Stack reordered for visual clarity in explode view (copper outermost so
    // traces are unobstructed; solder mask hidden during explode to avoid
    // occluding the layers below it):
    //   Top Copper F.Cu (traces/pads/zones)  +3.0 sp
    //   Top Solder Mask                       (hidden in explode)
    //   Top Silkscreen (drawings + labels)   +1.0 sp
    //   FR4 Core (board)                      0.0
    //   Bottom Silkscreen                    -1.0 sp
    //   Bottom Solder Mask                    (hidden in explode)
    //   Bottom Copper B.Cu                   -3.0 sp
    //   Vias span full height (stretched)
    private applyExplode(progress: number): void {
        const sp = this.explodeSpread * progress;

        // Disable per-footprint interactables in explode mode — colliders don't follow layers
        var exploding = progress > 0.05;
        for (var fii = 0; fii < this.fpInteractables.length; fii++) {
            if (this.fpInteractables[fii] && !isNull(this.fpInteractables[fii])) {
                this.fpInteractables[fii].enabled = !exploding;
            }
        }

        // No rotation, layers push apart along local Z (board normal)
        // FR4 core stays at 0
        for (const o of this.groupBoard) {
            if (!o || isNull(o)) continue;
            o.getTransform().setLocalPosition(new vec3(0, 0, 0));
        }

        // Solder masks: hide in explode mode so they don't occlude copper/silk;
        // restore visibility (subject to showBoard) when collapsed.
        if (this.groupTopMask && !isNull(this.groupTopMask)) {
            this.groupTopMask.enabled = this.showBoard && !exploding;
            this.groupTopMask.getTransform().setLocalPosition(new vec3(0, 0, sp * 2.0));
        }
        if (this.groupBotMask && !isNull(this.groupBotMask)) {
            this.groupBotMask.enabled = this.showBoard && !exploding;
            this.groupBotMask.getTransform().setLocalPosition(new vec3(0, 0, -sp * 2.0));
        }

        // Copper traces: outermost in explode (×3) so traces are fully visible
        for (const o of this.groupTraces) {
            if (!o || isNull(o)) continue;
            const t = o.getTransform();
            if (o.name.includes('B.Cu')) {
                t.setLocalPosition(new vec3(0, 0, -sp * 3.0));
            } else {
                t.setLocalPosition(new vec3(0, 0, sp * 3.0));
            }
        }

        // Pads follow their copper layer
        if (this.groupPadsTop && !isNull(this.groupPadsTop)) {
            this.groupPadsTop.getTransform().setLocalPosition(new vec3(0, 0, sp * 3.0));
        }
        if (this.groupPadsBot && !isNull(this.groupPadsBot)) {
            this.groupPadsBot.getTransform().setLocalPosition(new vec3(0, 0, -sp * 3.0));
        }

        // Zones follow their copper layer
        for (var zi = 0; zi < this.groupZones.length; zi++) {
            var zo = this.groupZones[zi];
            if (!zo || isNull(zo)) continue;
            var zt = zo.getTransform();
            if (zo.name.includes('B.Cu')) {
                zt.setLocalPosition(new vec3(0, 0, -sp * 3.0));
            } else {
                zt.setLocalPosition(new vec3(0, 0, sp * 3.0));
            }
        }

        // Silkscreen drawings (F.SilkS / F.Fab) ride innermost (×1) so they
        // sit behind copper in the explode spread; Edge.Cuts/Margin stay with
        // the FR4 core so the board outline doesn't fly off.
        for (var dri = 0; dri < this.groupTopDrawings.length; dri++) {
            var dro = this.groupTopDrawings[dri];
            if (!dro || isNull(dro)) continue;
            dro.getTransform().setLocalPosition(new vec3(0, 0, sp * 1.0));
        }
        for (var dri2 = 0; dri2 < this.groupBotDrawings.length; dri2++) {
            var dro2 = this.groupBotDrawings[dri2];
            if (!dro2 || isNull(dro2)) continue;
            dro2.getTransform().setLocalPosition(new vec3(0, 0, -sp * 1.0));
        }
        for (var dri3 = 0; dri3 < this.groupDrawings.length; dri3++) {
            var dro3 = this.groupDrawings[dri3];
            if (!dro3 || isNull(dro3)) continue;
            dro3.getTransform().setLocalPosition(new vec3(0, 0, 0));
        }

        // Silkscreen text labels ride with their drawing layer at ±sp*1.0
        for (var li = 0; li < this.groupLabels.length; li++) {
            var lo = this.groupLabels[li];
            if (!lo || isNull(lo)) continue;
            var baseZ = this.labelBaseZ.get(lo);
            if (baseZ === undefined) continue;
            var side = baseZ >= 0 ? 1 : -1;
            var lpos = lo.getTransform().getLocalPosition();
            lo.getTransform().setLocalPosition(
                new vec3(lpos.x, lpos.y, baseZ + side * sp * 1.0));
        }

        // Vias: rebuild cylinder mesh when explode progress changes significantly
        if (this.viaData.length > 0 && Math.abs(progress - this.viaExplodeProgress) > 0.01) {
            this.rebuildViaMesh(progress);
        }
    }

    // Animate displayedExplode toward explodeAmount. outExpo: fast onset,
    // smooth elegant landing into the final state. Same curve both directions.
    private tickExplode(dt: number): void {
        var target = this.explodeAmount;
        // New target → start a fresh transition from current displayed value.
        if (Math.abs(target - this.explodeAnimTo) > 0.001) {
            this.explodeAnimFrom = this.explodeDisplayed;
            this.explodeAnimTo = target;
            this.explodeAnimT = 0;
        }
        // Only apply transforms while the animation is actively moving.
        // Once settled, layer positions are stable and re-applying every frame
        // is pure waste (dozens of setLocalPosition calls × 4 boards × 60fps).
        if (Math.abs(this.explodeDisplayed - this.explodeAnimTo) > 0.0005) {
            this.explodeAnimT = Math.min(this.explodeAnimDuration, this.explodeAnimT + dt);
            var t = this.explodeAnimT / this.explodeAnimDuration;
            var eased = outExpo(t);
            this.explodeDisplayed = this.explodeAnimFrom +
                (this.explodeAnimTo - this.explodeAnimFrom) * eased;
            this.applyExplode(this.explodeDisplayed);
        }
    }

    // Snap the displayed explode value to the current target without animating.
    // Use after rebuilds where geometry should appear at its final state instantly.
    private syncExplodeImmediate(): void {
        this.explodeDisplayed = this.explodeAmount;
        this.explodeAnimFrom = this.explodeAmount;
        this.explodeAnimTo = this.explodeAmount;
        this.explodeAnimT = this.explodeAnimDuration;
    }

    // Fast render mode switch: update realisticMode uniform on unified shaders.
    // No material swap needed; geometry preserved, only shader parameters change.
    private swapRenderMode(useRealistic: boolean): void {
        this.renderMode = useRealistic ? "realistic" : "vivid";
        this.applyPalette(useRealistic);

        // Update realisticMode uniform on board material (no material swap needed)
        if (this.boardMatPass) {
            try { this.boardMatPass["realisticMode"] = useRealistic ? 1.0 : 0.0; } catch (e) {}
        }

        // Update realisticMode uniform on all trace passes (no material swap needed)
        var layerKeys = Array.from(this.traceCount.keys()) as string[];
        for (var li = 0; li < layerKeys.length; li++) {
            var layer = layerKeys[li];
            var pass = this.tracePasses.get(layer);
            if (pass) {
                try { pass["realisticMode"] = useRealistic ? 1.0 : 0.0; } catch (e) {}
            }
        }

        // Flush current growth state to the new trace passes
        this.flushAllTraceGrowth();

        // Rebuild color-dependent elements (pads, vias, masks, labels)
        // These are lightweight compared to trace geometry
        this.rebuildColorDependentElements();

        this.prevRenderMode = this.renderMode;
        print("[KiCad] swapRenderMode: " + this.renderMode + " (geometry preserved)");
    }

    // Rebuild lightweight elements that depend on color palette (not trace geometry)
    private rebuildColorDependentElements(): void {
        // Destroy and rebuild pads, vias, masks, labels
        if (this.groupPadsTop && !isNull(this.groupPadsTop)) this.groupPadsTop.destroy();
        this.groupPadsTop = null;
        if (this.groupPadsBot && !isNull(this.groupPadsBot)) this.groupPadsBot.destroy();
        this.groupPadsBot = null;
        if (this.groupVias && !isNull(this.groupVias)) this.groupVias.destroy();
        this.groupVias = null;
        if (this.groupTopMask && !isNull(this.groupTopMask)) this.groupTopMask.destroy();
        this.groupTopMask = null;
        if (this.groupBotMask && !isNull(this.groupBotMask)) this.groupBotMask.destroy();
        this.groupBotMask = null;
        for (var i = 0; i < this.groupLabels.length; i++) {
            if (this.groupLabels[i] && !isNull(this.groupLabels[i])) this.groupLabels[i].destroy();
        }
        this.groupLabels = [];
        this.labelObjects.clear();
        this.labelRevealDist.clear();
        this.labelBaseZ.clear();
        // Reset via state
        this.viaData = [];
        this.viaExplodeProgress = -1;

        // Rebuild
        this.buildSolderMasks();
        this.buildVias();
        this.buildFootprints();
        this.buildLabels();
        this.applyVisibility();
        this.syncExplodeImmediate();
        this.applyExplode(this.explodeDisplayed);
    }

    // ========== INIT HELPERS (shared by onAwake / switchBoard / loadFromJson) ==========

    private applyPalette(useRealistic: boolean): void {
        if (useRealistic) {
            this.COL_BOARD = KiCadBoard.COL_BOARD_R;
            this.COL_BOARD_EDGE = KiCadBoard.COL_BOARD_EDGE_R;
            this.COL_PAD = KiCadBoard.COL_PAD_R;
            this.COL_VIA = KiCadBoard.COL_VIA_R;
            this.COL_VIA_HOLE = KiCadBoard.COL_VIA_HOLE_R;
            this.COL_SILK = KiCadBoard.COL_SILK_R;
        } else {
            this.COL_BOARD = KiCadBoard.COL_BOARD_V;
            this.COL_BOARD_EDGE = KiCadBoard.COL_BOARD_EDGE_V;
            this.COL_PAD = KiCadBoard.COL_PAD_V;
            this.COL_VIA = KiCadBoard.COL_VIA_V;
            this.COL_VIA_HOLE = KiCadBoard.COL_VIA_HOLE_V;
            this.COL_SILK = KiCadBoard.COL_SILK_V;
        }
    }

    private computeBounds(): void {
        var outline = this.board.board.outline;
        if (!outline || outline.length === 0) return;
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (var i = 0; i < outline.length; i++) {
            var p = outline[i];
            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1];
            if (p[1] > maxY) maxY = p[1];
        }
        this.cx = (minX + maxX) * 0.5;
        this.cy = (minY + maxY) * 0.5;
        this.maxRadius = 1;
        for (var i = 0; i < outline.length; i++) {
            var dx = outline[i][0] - this.cx, dy = outline[i][1] - this.cy;
            var r = Math.sqrt(dx * dx + dy * dy);
            if (r > this.maxRadius) this.maxRadius = r;
        }
        if (this.maxRadius < 0.001) this.maxRadius = 1;
    }

    private cloneBoardMaterial(boardTimeInit: number): void {
        var activeBoardSrc = this.srcBoardMat;
        if (!activeBoardSrc) return;
        this.boardMaterial = activeBoardSrc.clone();
        this.boardMatPass = this.boardMaterial.mainPass;
        this.boardMatPass["boardTime"] = boardTimeInit;
        try { this.boardMatPass["realisticMode"] = this.isRealistic() ? 1.0 : 0.0; } catch (e) {}
    }

    private computeHalfExtents(): void {
        var outline = this.board.board.outline;
        if (!outline || outline.length === 0) return;
        var minX = Infinity, maxX = -Infinity;
        var minY = Infinity, maxY = -Infinity;
        for (var i = 0; i < outline.length; i++) {
            var lx = (outline[i][0] - this.cx) * this.scaleFactor;
            var ly = -(outline[i][1] - this.cy) * this.scaleFactor;
            if (lx < minX) minX = lx;
            if (lx > maxX) maxX = lx;
            if (ly < minY) minY = ly;
            if (ly > maxY) maxY = ly;
        }
        this.boardHalfWidth = Math.max(Math.abs(minX), Math.abs(maxX));
        this.boardHalfHeight = Math.max(Math.abs(minY), Math.abs(maxY));
    }

    private initChunkedBuild(): void {
        this.prepareTraceBuild();
        this.buildPhase = 0;
        this.buildLayerIdx = 0;
        this.buildTraceIdx = 0;
        this.buildMb = null;
        this.buildTotalVerts = 0;
        this.buildBatchIdx = 0;
        this.buildGrandTotalVerts = 0;
    }

    private syncPrevTracking(): void {
        this.prevBoardSlug = this.boardSlug;
        this.prevRenderMode = this.renderMode;
        this.prevScaleFactor = this.scaleFactor;
    }

    // ========== UPDATE LOOP ==========

    private onUpdate(): void {
        // Deactivated boards skip all per-frame work. CircuitPanel toggles
        // active via activate()/deactivate() so only the focused board ticks.
        if (!this.active) return;

        // ---- Detect input changes that require a full rebuild ----
        // Must run BEFORE buildPhase guard so changes during a build restart it
        if (this.prevBoardSlug !== "" && (
            this.boardSlug !== this.prevBoardSlug ||
            this.renderMode !== this.prevRenderMode ||
            this.scaleFactor !== this.prevScaleFactor
        )) {
            // Render mode change on same board: fast material swap (no geometry rebuild)
            if (this.boardSlug === this.prevBoardSlug &&
                this.scaleFactor === this.prevScaleFactor &&
                this.renderMode !== this.prevRenderMode) {
                this.swapRenderMode(this.isRealistic());
                return;
            }
            this.prevBoardSlug = this.boardSlug;
            this.prevRenderMode = this.renderMode;
            this.prevScaleFactor = this.scaleFactor;
            this.switchBoard(this.boardSlug, this.isRealistic());
            return;
        }

        // Drive chunked build state machine
        if (this.buildPhase >= 0) {
            this.onBuildTick();
            return; // skip normal update during build
        }

        this.syncVisibility();
        const dt = getDeltaTime();

        /* [ARCHIVED] Clap gesture + hand-proximity reveal
        this.updateClapDetection(dt);

        if (this.handDriven && this.handInputData) {
            const dist = this.getClosestHandDist();
            const far = this.handFarDist;
            const near = this.handNearDist;
            const rawT = dist < Infinity ? 1.0 - Math.max(0, Math.min(1, (dist - near) / (far - near))) : 0;
            this.handRevealT += (rawT - this.handRevealT) * Math.min(1, dt * 4);
            const t = this.handRevealT;
            const boardVisible = t > 0.05;
            for (const o of this.groupBoard) o.enabled = boardVisible;
            if (this.boardMatPass) {
                this.boardMatPass["boardTime"] = Math.min(1, t / 0.4);
            }
            const labelsVisible = t > 0.3;
            for (const o of this.groupLabels) o.enabled = labelsVisible;
            const padsVisible = t > 0.2;
            if (this.groupPadsTop) this.groupPadsTop.enabled = padsVisible;
            if (this.groupPadsBot) this.groupPadsBot.enabled = padsVisible;
            if (this.groupVias) this.groupVias.enabled = padsVisible;
            const traceVisible = t > 0.35;
            for (const o of this.groupTraces) o.enabled = traceVisible;
            if (traceVisible) {
                const traceT = Math.max(0, Math.min(1, (t - 0.4) / 0.6));
                this.setAllGrowth(traceT);
                this.flushAllTraceGrowth();
            }
        }
        */

        // ---- Layer explosion (eased transition, snappy) ----
        this.tickExplode(dt);

        /* [ARCHIVED] Effector system — disabled for performance
        if (this.effectorMode !== "off") {
            this.updateEffectors();
            if (this.effectors.length > 0) {
                var em = this.effectorMode;
                if (em === "growth" || em === "all") {
                    this.applySpatialGrowth();
                }
                if (em === "morph" || em === "all") {
                    this.applySpatialMorph();
                }
                if (em === "flow" || em === "all") {
                    this.applySpatialFlow();
                }
            }
        }
        */

        // ---- Signal flow animation ----
        var sf = this.isSignalFlow();
        if (sf) {
            this.flowTimer = (this.flowTimer || 0) + dt;
            for (const [, pass] of this.tracePasses) {
                try { pass["flowTime"] = this.flowTimer; } catch (e) {}
                try { pass["flowSpeed"] = this.flowSpeed; } catch (e) {}
                try { pass["flowIntensity"] = this.flowIntensity; } catch (e) {}
            }
        } else if (this.flowTimer > 0) {
            // Just turned off, reset
            this.flowTimer = 0;
            for (const [, pass] of this.tracePasses) {
                try { pass["flowTime"] = 0; } catch (e) {}
            }
        }

        // Trace delay timer
        if (this.traceDelayTimer > 0) {
            this.traceDelayTimer -= dt;
            if (this.traceDelayTimer <= 0) {
                this.traceDelayTimer = -1;
                if (!this.traceGrowTriggered) {
                    this.traceGrowTriggered = true;
                    this.startGrowAll();
                    if (this.showLabels) {
                        for (const o of this.groupLabels) { if (o && !isNull(o)) o.enabled = true; }
                    }
                }
            }
        }

        // Trace growth animation (BFS waves)
        if (this.animActive) {
            if (this.animWaveIdx >= this.animWaves.length) {
                this.animActive = false;
            } else {
                const wave = this.animWaves[this.animWaveIdx];
                const waveDuration = 0.3 + wave.length * 0.02;
                this.animWaveProgress += dt / waveDuration;

                if (this.animWaveProgress >= 1.0) {
                    for (const netId of wave) {
                        this.setNetGrowth(netId, 1.0);
                    }
                    this.animWaveIdx++;
                    this.animWaveProgress = 0;
                } else {
                    for (const netId of wave) {
                        this.setNetGrowth(netId, this.animWaveProgress);
                    }
                }

                this.flushAllTraceGrowth();
            }
        }
    }

    // ---- Public API ----

    public setNetGrowth(netId: number, growth: number): void {
        const g = Math.max(0, Math.min(1, growth));
        for (const [, netMap] of this.netTraceMap) {
            const indices = netMap.get(netId);
            if (!indices) continue;
            for (const [layer] of this.traceGrowth) {
                const growths = this.traceGrowth.get(layer);
                if (!growths) continue;
                for (const idx of indices) {
                    if (idx < growths.length) {
                        growths[idx] = g;
                        this.markTraceDirty(layer, idx);
                    }
                }
            }
        }
    }

    public setAllGrowth(growth: number): void {
        const g = Math.max(0, Math.min(1, growth));
        for (const [layer, growths] of this.traceGrowth) {
            for (let i = 0; i < growths.length; i++) growths[i] = g;
            this.markAllTracesDirty(layer);
        }
    }

    public setTraceGrowth(layer: string, traceIdx: number, growth: number): void {
        const growths = this.traceGrowth.get(layer);
        if (growths && traceIdx >= 0 && traceIdx < growths.length) {
            growths[traceIdx] = Math.max(0, Math.min(1, growth));
            this.markTraceDirty(layer, traceIdx);
        }
    }

    public getNetTraceIndices(layer: string, netId: number): number[] {
        const netMap = this.netTraceMap.get(layer);
        if (!netMap) return [];
        return netMap.get(netId) || [];
    }

    public getNetNames(): Record<string, string> {
        return this.board ? this.board.nets : {};
    }

    // Select a footprint by ref, highlight its nets
    public selectFootprint(ref: string): void {
        this.deselectFootprint();
        var fp: any = null;
        for (var si = 0; si < this.fpBounds.length; si++) {
            if (this.fpBounds[si].ref === ref) { fp = this.fpBounds[si]; break; }
        }
        if (!fp) return;
        this.selectedFP = ref;

        // Highlight label
        var label = this.labelObjects.get(ref);
        if (label) {
            var text = label.getComponent("Component.Text") as Text;
            if (text) {
                text.textFill.color = new vec4(0.91, 0.69, 0.063, 1.0); // gold
            }
        }

        // Grow only this footprint's nets
        this.setAllGrowth(0.15); // dim everything
        var fpNets: number[] = fp.nets as number[];
        for (var ni = 0; ni < fpNets.length; ni++) {
            this.setNetGrowth(fpNets[ni], 1.0);
        }
        this.flushAllTraceGrowth();

        print("[KiCad] Selected: " + ref);
    }

    public deselectFootprint(): void {
        if (this.selectedFP) {
            var label = this.labelObjects.get(this.selectedFP);
            if (label) {
                var text = label.getComponent("Component.Text") as Text;
                if (text) {
                    text.textFill.color = new vec4(0.94, 0.94, 0.91, 1.0); // white
                }
            }
        }
        var wasSelected = this.selectedFP;
        this.selectedFP = "";
        this.setAllGrowth(1.0);
        this.flushAllTraceGrowth();

    }



    private buildNetAdjacency(allTraceNets: Set<number>): Map<number, number[]> {
        var netAdj = new Map<number, number[]>();
        if (!this.board) return netAdj;
        var fps: any[] = this.board.footprints;
        for (var fj = 0; fj < fps.length; fj++) {
            if (!fps[fj].pads) continue;
            var pads: any[] = fps[fj].pads;
            var fpNets: number[] = [];
            for (var pk = 0; pk < pads.length; pk++) {
                if (pads[pk].net > 0 && allTraceNets.has(pads[pk].net)) {
                    fpNets.push(pads[pk].net as number);
                }
            }
            var uniqueNets: number[] = [];
            var seen = new Set<number>();
            for (var ui = 0; ui < fpNets.length; ui++) {
                if (!seen.has(fpNets[ui])) {
                    seen.add(fpNets[ui]);
                    uniqueNets.push(fpNets[ui]);
                }
            }
            for (var ai = 0; ai < uniqueNets.length; ai++) {
                var na = uniqueNets[ai];
                if (!netAdj.has(na)) netAdj.set(na, []);
                var adjList: number[] = netAdj.get(na) as number[];
                for (var bi = 0; bi < uniqueNets.length; bi++) {
                    if (uniqueNets[bi] !== na && adjList.indexOf(uniqueNets[bi]) < 0) {
                        adjList.push(uniqueNets[bi]);
                    }
                }
            }
        }
        return netAdj;
    }

    private bfsWaves(seedNets: number[], netAdj: Map<number, number[]>): number[][] {
        var visited = new Set<number>();
        var waves: number[][] = [];
        waves.push(seedNets);
        for (var sj = 0; sj < seedNets.length; sj++) visited.add(seedNets[sj]);

        var queue = seedNets.slice();
        while (queue.length > 0) {
            var nextQueue: number[] = [];
            var wave: number[] = [];
            for (var qi = 0; qi < queue.length; qi++) {
                var neighbors: number[] = (netAdj.get(queue[qi]) || []) as number[];
                for (var ni = 0; ni < neighbors.length; ni++) {
                    if (!visited.has(neighbors[ni])) {
                        visited.add(neighbors[ni]);
                        wave.push(neighbors[ni]);
                        nextQueue.push(neighbors[ni]);
                    }
                }
            }
            if (wave.length > 0) waves.push(wave);
            queue = nextQueue;
        }
        return waves;
    }

    // Destroy all generated geometry so the board can be rebuilt
    private destroyBoard(): void {
        this.buildGeneration++;
        // Hide loading indicator before bulk destroy (it's a child of this SceneObject)
        this.hideLoadingIndicator();
        // Destroy all children of this SceneObject (traces, board, vias, pads, labels, explode labels)
        var childCount = this.sceneObject.getChildrenCount();
        for (var ci = childCount - 1; ci >= 0; ci--) {
            this.sceneObject.getChild(ci).destroy();
        }
        // Reset all state
        this.traceTexProviders.clear();
        this.tracePixels.clear();
        this.traceCount.clear();
        this.tracePasses.clear();
        this.traceGrowth.clear();
        this.netTraceMap.clear();
        this.groupBoard = [];
        this.groupTraces = [];
        this.groupVias = null;
        this.groupPadsTop = null;
        this.groupPadsBot = null;
        this.groupLabels = [];
        this.groupTopMask = null;
        this.groupBotMask = null;
        this.groupZones = [];
        this.groupDrawings = [];
        this.groupTopDrawings = [];
        this.groupBotDrawings = [];
        this.fpBounds = [];
        // fpInteractables live on children that were just destroyed above,
        // so the components are already gone — calling .destroy() on them
        // throws "Object is null". Just drop the references.
        this.fpInteractables = [];
        this.selectionPinned = false;
        this.labelObjects.clear();
        this.labelRevealDist.clear();
        this.labelBaseZ.clear();
        this.selectedFP = "";
        this.boardMatPass = null;
        this.board = null;
        this.animActive = false;
        this.animWaves = [];
        this.animWaveIdx = 0;
        this.animWaveProgress = 0;
        this.traceGrowTriggered = false;
        this.traceDelayTimer = -1;
        this.flowTimer = 0;
        // [ARCHIVED] this.handRevealT = 0;
        this.maxRadius = 1;
        this.boardHalfWidth = 0;
        this.boardHalfHeight = 0;
        this.viaData = [];
        this.viaExplodeProgress = -1;
        this.simNodeVoltages.clear();
        this.simBranchCurrents.clear();
        this.simValid = false;
        // [ARCHIVED] this.effectors = [];
        // [ARCHIVED] this.traceCentroids.clear();
        // Reset chunked build state
        this.buildPhase = -1;
        this.buildPreparedLayers = [];
        this.buildPreparedPolys.clear();
        this.buildPreparedSegCounts.clear();
        this.buildMb = null;
        this.buildLayerIdx = 0;
        this.buildTraceIdx = 0;
    }

    // ---- Chunked build state machine ----
    private buildGeneration: number = 0;  // incremented on destroyBoard; guards stale builds
    private buildPhase: number = -1;  // -1 = idle
    private buildPreparedLayers: string[] = [];
    private buildPreparedPolys: Map<string, any[]> = new Map();
    private buildPreparedSegCounts: Map<string, number> = new Map();
    private buildLayerIdx: number = 0;
    private buildTraceIdx: number = 0;
    private buildMb: MeshBuilder | null = null;
    private buildTotalVerts: number = 0;
    private buildBatchIdx: number = 0;
    private buildLayerMat: Material | null = null;
    private buildGrandTotalVerts: number = 0;
    private buildLoadingLabel: SceneObject | null = null;

    // Public: bring this board online. Enables the SceneObject and rebuilds
    // geometry if it was previously destroyed by deactivate(). Idempotent and
    // safe to call mid-build (won't restart an in-flight chunked build).
    public activate(): void {
        if (this.active && this.boardBuilt) {
            this.sceneObject.enabled = true;
            return;
        }
        if (this.active && this.buildPhase >= 0) {
            // Build already in progress — just keep the SceneObject on and let
            // the chunked state machine finish.
            this.sceneObject.enabled = true;
            return;
        }
        this.active = true;
        this.sceneObject.enabled = true;
        if (!this.boardBuilt) {
            this.switchBoard(this.boardSlug, this.isRealistic());
        }
    }

    // Public: take this board offline. Destroys geometry to free memory and
    // disables the SceneObject so onUpdate stops firing. Idempotent.
    public deactivate(): void {
        if (!this.active && !this.boardBuilt) {
            this.sceneObject.enabled = false;
            return;
        }
        this.active = false;
        this.destroyBoard();
        this.boardBuilt = false;
        this.sceneObject.enabled = false;
    }

    // Public: switch to a different board and/or rendering mode at runtime
    public switchBoard(slug: string, useRealistic: boolean): void {
        print("[KiCad] switchBoard: " + slug + " realistic=" + useRealistic);
        this.destroyBoard();

        this.boardSlug = slug;
        this.renderMode = useRealistic ? "realistic" : "vivid";
        this.applyPalette(useRealistic);

        var mod = BOARD_MODULES[slug] || BOARD_MODULES["arduino-nano"];
        if (!mod) { print("[KiCad] WARNING: unknown slug '" + slug + "'"); return; }
        this.boardData = mod.pcb;

        try { this.board = JSON.parse(this.boardData); }
        catch (e: any) { print("[KiCad] Failed to parse board JSON: " + e.message); return; }

        this.ensureOutline();
        this.computeBounds();
        this.cloneBoardMaterial(0.0);
        this.computeHalfExtents();

        this.buildBoard();
        this.buildSolderMasks();
        if (this.boardMatPass) this.boardMatPass["boardTime"] = 1.0;
        this.showLoadingIndicator();

        this.initChunkedBuild();
        this.syncPrevTracking();
        print("[KiCad] switchBoard started chunked build for: " + slug);
    }

    private showLoadingIndicator(): void {
        if (this.buildLoadingLabel) return;
        var obj = global.scene.createSceneObject("__loading");
        obj.setParent(this.sceneObject);
        var text = obj.createComponent("Component.Text") as Text;
        text.text = "Loading...";
        text.size = 48;
        if (this.labelFont) text.font = this.labelFont;
        text.textFill.color = new vec4(0.91, 0.69, 0.063, 1.0); // gold
        text.horizontalAlignment = HorizontalAlignment.Center;
        var t = obj.getTransform();
        t.setLocalPosition(new vec3(0, 0, 2));
        t.setLocalScale(new vec3(0.1, 0.1, 0.1));
        this.buildLoadingLabel = obj;
    }

    private hideLoadingIndicator(): void {
        if (this.buildLoadingLabel) {
            this.buildLoadingLabel.destroy();
            this.buildLoadingLabel = null;
        }
    }

    private prepareTraceBuild(): void {
        if (this.isV2()) {
            this.prepareSegmentBuildV2();
            return;
        }

        var polysPerLayer = this.getPolylinesPerLayer();

        this.buildPreparedLayers = [];
        this.buildPreparedPolys = new Map();
        this.buildPreparedSegCounts = new Map();

        var layerKeys = Array.from(polysPerLayer.keys()) as string[];
        for (var li = 0; li < layerKeys.length; li++) {
            var layer = layerKeys[li];
            var polys = polysPerLayer.get(layer)!;
            var numTraces = Math.min(polys.length, KiCadBoard.MAX_TRACES);

            // Build net map
            var netMap: Map<number, number[]> = new Map();
            for (var ni = 0; ni < numTraces; ni++) {
                var net = polys[ni].net;
                if (!netMap.has(net)) netMap.set(net, []);
                netMap.get(net)!.push(ni);
            }
            this.netTraceMap.set(layer, netMap);
            this.traceGrowth.set(layer, new Array(numTraces).fill(1.0));
            this.traceCount.set(layer, numTraces);

            this.buildPreparedLayers.push(layer);
            this.buildPreparedPolys.set(layer, polys);
            this.buildPreparedSegCounts.set(layer, polys.length);
        }
    }

    private prepareSegmentBuildV2(): void {
        this.buildPreparedLayers = [];
        this.buildPreparedPolys = new Map();
        this.buildPreparedSegCounts = new Map();

        // Group segments + arcs by layer
        var allItems = (this.board.segments || []).concat(this.board.arcs || []);
        var segsByLayer: Map<string, any[]> = new Map();
        for (var si = 0; si < allItems.length; si++) {
            var item = allItems[si];
            var layer = item.layer || 'F.Cu';
            if (!segsByLayer.has(layer)) segsByLayer.set(layer, []);
            segsByLayer.get(layer)!.push(item);
        }

        var layerKeys = Array.from(segsByLayer.keys()) as string[];
        for (var li = 0; li < layerKeys.length; li++) {
            var preparedLayer = layerKeys[li];
            var items = segsByLayer.get(preparedLayer)!;
            var numItems = Math.min(items.length, KiCadBoard.MAX_TRACES);

            var netMap: Map<number, number[]> = new Map();
            for (var ni = 0; ni < numItems; ni++) {
                var net = items[ni].net;
                if (!netMap.has(net)) netMap.set(net, []);
                netMap.get(net)!.push(ni);
            }
            this.netTraceMap.set(preparedLayer, netMap);
            this.traceGrowth.set(preparedLayer, new Array(numItems).fill(1.0));
            this.traceCount.set(preparedLayer, numItems);

            this.buildPreparedLayers.push(preparedLayer);
            this.buildPreparedPolys.set(preparedLayer, items);
            this.buildPreparedSegCounts.set(preparedLayer, items.length);
        }
    }

    private onBuildTick(): void {
        if (this.buildPhase < 0) return;
        var gen = this.buildGeneration;

        var startTime = getTime();
        var BUDGET_S = 0.008; // 8ms per frame budget

        if (this.buildPhase === 0) {
            // Phase 0: build traces/segments incrementally
            var done = this.isV2()
                ? this.buildSegmentsIncrementalV2(BUDGET_S)
                : this.buildTracesIncremental(BUDGET_S);
            if (done) {
                this.buildPhase = 1;
            }
        } else if (this.buildPhase === 1) {
            // Phase 1: zones + drawings + vias + footprints + labels + collider
            if (this.buildGeneration !== gen) return; // build was cancelled
            if (this.isV2()) {
                this.buildZones();
                this.buildDrawingsV2();
            }
            this.buildVias();
            this.buildFootprints();
            this.buildLabels();
            this.buildCollider();
            this.runSimulation();
            this.buildPhase = 2;
        } else if (this.buildPhase === 2) {
            // Phase 2: finalize
            if (this.buildGeneration !== gen) return; // build was cancelled
            this.applyVisibility();
            this.hideLoadingIndicator();
            this.syncExplodeImmediate();
            this.applyExplode(this.explodeDisplayed);
            this.setAllGrowth(1.0);
            this.flushAllTraceGrowth();
            this.syncPrevTracking();
            this.buildPhase = -1;
            this.boardBuilt = true;
            print("[KiCad] switchBoard complete: " + this.boardSlug);
        }
    }

    // ---- DYNAMIC LOADING ----
    // Runtime path for swapping a board's content from a JSON string. Useful
    // for any code path that fetches a converted .kicad_pcb at runtime.
    public loadFromJson(jsonString: string, displayName: string): void {
        print("[KiCad] loadFromJson: " + displayName + " (" + Math.round(jsonString.length / 1024) + "KB)");

        var step = "destroyBoard";
        try {
            this.destroyBoard();

            step = "applyPalette";
            this.applyPalette(this.isRealistic());

            step = "JSON.parse";
            try { this.board = JSON.parse(jsonString); }
            catch (e: any) { print("[KiCad] loadFromJson parse failed: " + e.message); return; }

            // Validate minimum board structure before proceeding.
            if (!this.board || !this.board.board) {
                print("[KiCad] loadFromJson: missing board.board section, aborting");
                return;
            }
            if (!this.board.footprints) this.board.footprints = [];

            this.boardSlug = "dynamic";
            this.boardData = jsonString;

            step = "ensureOutline";
            this.ensureOutline();
            step = "computeBounds";
            this.computeBounds();
            step = "cloneBoardMaterial";
            this.cloneBoardMaterial(0.0);
            step = "computeHalfExtents";
            this.computeHalfExtents();

            step = "buildBoard";
            this.buildBoard();
            step = "buildSolderMasks";
            this.buildSolderMasks();
            if (this.boardMatPass) this.boardMatPass["boardTime"] = 1.0;
            step = "showLoadingIndicator";
            this.showLoadingIndicator();

            step = "initChunkedBuild";
            this.initChunkedBuild();
            step = "syncPrevTracking";
            this.syncPrevTracking();
            print("[KiCad] loadFromJson started chunked build for: " + displayName);
        } catch (e: any) {
            var msg = e && e.message ? e.message : String(e);
            print("[KiCad] loadFromJson failed at step '" + step + "': " + msg);
        }
    }

    private buildTracesIncremental(budgetS: number): boolean {
        var startTime = getTime();
        var th = this.thickHalf();
        let layerZ: Record<string, number> = { 'F.Cu': th + 0.04, 'B.Cu': -th - 0.04 };
        var VERT_LIMIT = 63000;

        while (this.buildLayerIdx < this.buildPreparedLayers.length) {
            let layer = this.buildPreparedLayers[this.buildLayerIdx];
            var polys = this.buildPreparedPolys.get(layer)!;
            var numTraces = polys.length;
            var z = layerZ[layer] || 0;

            // Initialize layer on first visit
            if (this.buildTraceIdx === 0 && this.buildMb === null) {
                this.buildLayerMat = null;
                // Clone unified trace material (PBR preferred)
                var srcTrace = this.srcTraceMat || this.traceMaterial;
                if (srcTrace) {
                    this.buildLayerMat = srcTrace.clone();
                    var pass = this.buildLayerMat.mainPass;
                    this.tracePasses.set(layer, pass);
                    this.createTraceTexture(layer, this.buildLayerMat);
                    try { pass["flowTime"] = 0; } catch (e) {}
                    try { pass["realisticMode"] = this.isRealistic() ? 1.0 : 0.0; } catch (e) {}
                    try { pass["flowSpeed"] = this.flowSpeed; } catch (e) {}
                    try { pass["flowIntensity"] = this.flowIntensity; } catch (e) {}
                    try { pass.blendMode = BlendMode.PremultipliedAlpha; } catch (e) {}
                    try { pass["layerAlpha"] = layer === 'B.Cu' ? 0.5 : 1.0; } catch (e) {}
                }
                this.buildMb = KiCadBoard.newStaticMB();
                this.buildTotalVerts = 0;
                this.buildBatchIdx = 0;
                this.buildGrandTotalVerts = 0;
            }

            while (this.buildTraceIdx < numTraces) {
                this.buildOneTrace(layer, this.buildTraceIdx, z, polys, numTraces);
                this.buildTraceIdx++;

                // Check budget every 10 traces
                if (this.buildTraceIdx % 10 === 0) {
                    if (getTime() - startTime > budgetS) return false;
                }
            }

            // Finalize layer
            this.finalizeBuildBatch(layer);
            var segCount = this.buildPreparedSegCounts.get(layer) || 0;
            this.writeTraceHues(layer, polys, numTraces);
            this.flushTraceGrowth(layer);
            print("[KiCad] Traces " + layer + ": " + segCount + " segs -> " +
                  numTraces + " polylines, " + this.buildGrandTotalVerts + " verts, " + (this.buildBatchIdx) + " meshes");

            this.buildLayerIdx++;
            this.buildTraceIdx = 0;
            this.buildMb = null;
        }

        return true;
    }

    // Build a single trace as a flat ribbon (used by incremental builder)
    private buildOneTrace(layer: string, ti: number, z: number, polys: any[], numTraces: number): void {
        var VERT_LIMIT = 63000;
        var nz = layer === 'F.Cu' ? 1 : -1;

        var poly = polys[ti];
        var polyWidths: number[] = poly.widths;
        var rawPts = poly.points;

        // Match endpoints to vias for trimming
        var startVia = this.findViaAt(rawPts[0][0], rawPts[0][1]);
        var endVia = this.findViaAt(rawPts[rawPts.length - 1][0], rawPts[rawPts.length - 1][1]);

        var pts: vec3[] = [];
        for (var pi = 0; pi < rawPts.length; pi++) {
            pts.push(this.toLS(rawPts[pi][0], rawPts[pi][1], z));
        }
        var N = pts.length;
        if (N < 2) return;

        // Trim ribbon endpoints back by outerR so they stop at the via edge
        if (startVia && N >= 2) {
            var sOR = startVia.outerR * this.scaleFactor;
            var sdx = pts[1].x - pts[0].x, sdy = pts[1].y - pts[0].y;
            var sdl = Math.sqrt(sdx * sdx + sdy * sdy);
            if (sdl > 0.001) {
                pts[0] = new vec3(pts[0].x + (sdx / sdl) * sOR, pts[0].y + (sdy / sdl) * sOR, pts[0].z);
            }
        }
        if (endVia && N >= 2) {
            var eOR = endVia.outerR * this.scaleFactor;
            var edx = pts[N - 2].x - pts[N - 1].x, edy = pts[N - 2].y - pts[N - 1].y;
            var edl = Math.sqrt(edx * edx + edy * edy);
            if (edl > 0.001) {
                pts[N - 1] = new vec3(pts[N - 1].x + (edx / edl) * eOR, pts[N - 1].y + (edy / edl) * eOR, pts[N - 1].z);
            }
        }

        var vertsNeeded = N * 2;

        if (this.buildTotalVerts + vertsNeeded > VERT_LIMIT && this.buildTotalVerts > 0) {
            this.finalizeBuildBatch(layer);
            this.buildMb = KiCadBoard.newStaticMB();
            this.buildTotalVerts = 0;
        }

        var mb = this.buildMb!;

        var cumLen: number[];
        if (poly.arcLengths && poly.arcLengths.length === N) {
            cumLen = poly.arcLengths;
        } else {
            cumLen = [0];
            for (var i = 1; i < N; i++) {
                var d = pts[i].sub(pts[i - 1]);
                cumLen.push(cumLen[i - 1] + d.length);
            }
        }
        var totalLen = cumLen[N - 1];
        var base0 = mb.getVerticesCount();

        for (var pi = 0; pi < N; pi++) {
            var t = totalLen > 0.001 ? cumLen[pi] / totalLen : pi / (N - 1);
            var c = pts[pi];
            var halfW = polyWidths[pi] * 0.5 * this.scaleFactor;

            var ttx: number, tty: number;
            if (pi === 0) {
                ttx = pts[1].x - pts[0].x; tty = pts[1].y - pts[0].y;
            } else if (pi === N - 1) {
                ttx = pts[N - 1].x - pts[N - 2].x; tty = pts[N - 1].y - pts[N - 2].y;
            } else {
                var d1x = pts[pi].x - pts[pi - 1].x, d1y = pts[pi].y - pts[pi - 1].y;
                var d2x = pts[pi + 1].x - pts[pi].x, d2y = pts[pi + 1].y - pts[pi].y;
                var l1 = Math.sqrt(d1x * d1x + d1y * d1y);
                var l2 = Math.sqrt(d2x * d2x + d2y * d2y);
                ttx = (l1 > 0.001 ? d1x / l1 : 0) + (l2 > 0.001 ? d2x / l2 : 0);
                tty = (l1 > 0.001 ? d1y / l1 : 0) + (l2 > 0.001 ? d2y / l2 : 0);
            }
            var tlen = Math.sqrt(ttx * ttx + tty * tty);
            var px: number, py: number;
            if (tlen > 0.001) { px = -tty / tlen; py = ttx / tlen; }
            else { px = 0; py = 1; }

            mb.appendVerticesInterleaved([
                c.x + px * halfW, c.y + py * halfW, c.z,
                0, 0, nz, t, ti, 1.0, 0
            ]);
            mb.appendVerticesInterleaved([
                c.x - px * halfW, c.y - py * halfW, c.z,
                0, 0, nz, t, ti, -1.0, 0
            ]);
        }

        for (var pi = 0; pi < N - 1; pi++) {
            var a0 = base0 + pi * 2;
            var a1 = a0 + 1;
            var b0 = base0 + (pi + 1) * 2;
            var b1 = b0 + 1;
            mb.appendIndices([a0, a1, b1, a0, b1, b0]);
        }

        this.buildTotalVerts += vertsNeeded;
        this.buildGrandTotalVerts += vertsNeeded;
    }

    private finalizeBuildBatch(layer: string): void {
        if (!this.buildMb || this.buildTotalVerts === 0) return;
        this.buildMb.updateMesh();
        var child = global.scene.createSceneObject("__traces_" + layer + "_" + this.buildBatchIdx);
        child.setParent(this.sceneObject);
        this.groupTraces.push(child);
        var rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = this.buildMb.getMesh();
        if (this.buildLayerMat) rmv.mainMaterial = this.buildLayerMat;
        this.buildBatchIdx++;
    }

    // ---- V2 Incremental Segment Builder (for switchBoard / loadFromJson) ----
    private buildSegmentsIncrementalV2(budgetS: number): boolean {
        var startTime = getTime();
        var th = this.thickHalf();
        var layerZ: Record<string, number> = { 'F.Cu': th + 0.04, 'B.Cu': -th - 0.04 };
        var VERT_LIMIT = 63000;
        var CAP_N = KiCadBoard.CAP_SEGS;

        // Precompute cap angle table
        var capCos: number[] = [];
        var capSin: number[] = [];
        for (var ci = 0; ci <= CAP_N; ci++) {
            var angle = Math.PI * ci / CAP_N;
            capCos.push(Math.cos(angle));
            capSin.push(Math.sin(angle));
        }

        while (this.buildLayerIdx < this.buildPreparedLayers.length) {
            var layer = this.buildPreparedLayers[this.buildLayerIdx];
            var items = this.buildPreparedPolys.get(layer)!;
            var numItems = items.length;
            var z = layerZ[layer] || 0;
            var nz = layer === 'F.Cu' ? 1 : -1;

            // Initialize layer on first visit
            if (this.buildTraceIdx === 0 && this.buildMb === null) {
                this.buildLayerMat = null;
                var srcTrace = this.srcTraceMat || this.traceMaterial;
                if (srcTrace) {
                    this.buildLayerMat = srcTrace.clone();
                    var pass = this.buildLayerMat.mainPass;
                    this.tracePasses.set(layer, pass);
                    this.createTraceTexture(layer, this.buildLayerMat);
                    try { pass["flowTime"] = 0; } catch (e) {}
                    try { pass["realisticMode"] = this.isRealistic() ? 1.0 : 0.0; } catch (e) {}
                    try { pass["flowSpeed"] = this.flowSpeed; } catch (e) {}
                    try { pass["flowIntensity"] = this.flowIntensity; } catch (e) {}
                    try { pass.blendMode = BlendMode.PremultipliedAlpha; } catch (e) {}
                    try { pass["layerAlpha"] = layer === 'B.Cu' ? 0.5 : 1.0; } catch (e) {}
                }
                this.buildMb = KiCadBoard.newStaticMB();
                this.buildTotalVerts = 0;
                this.buildBatchIdx = 0;
                this.buildGrandTotalVerts = 0;
            }

            while (this.buildTraceIdx < numItems) {
                var item = items[this.buildTraceIdx];
                var ti = this.buildTraceIdx;

                // Expand arcs into sub-segments
                var subSegs: { sx: number, sy: number, ex: number, ey: number }[] = [];
                if (item.mid !== undefined && item.center) {
                    var arcSpan = Math.abs(item.endAngle - item.startAngle);
                    var arcN = Math.max(8, Math.ceil(arcSpan / (Math.PI / 12)));
                    var sweep = item.endAngle - item.startAngle;
                    var prevX = item.center[0] + item.radius * Math.cos(item.startAngle);
                    var prevY = item.center[1] + item.radius * Math.sin(item.startAngle);
                    for (var ai = 1; ai <= arcN; ai++) {
                        var aFrac = ai / arcN;
                        var ang = item.startAngle + sweep * aFrac;
                        var curX = item.center[0] + item.radius * Math.cos(ang);
                        var curY = item.center[1] + item.radius * Math.sin(ang);
                        subSegs.push({ sx: prevX, sy: prevY, ex: curX, ey: curY });
                        prevX = curX;
                        prevY = curY;
                    }
                } else {
                    subSegs.push({ sx: item.start[0], sy: item.start[1], ex: item.end[0], ey: item.end[1] });
                }

                var vertsPerSub = 4 + (CAP_N + 1) + (CAP_N + 1);
                var vertsNeeded = subSegs.length * vertsPerSub;

                if (this.buildTotalVerts + vertsNeeded > VERT_LIMIT && this.buildTotalVerts > 0) {
                    this.finalizeBuildBatch(layer);
                    this.buildMb = KiCadBoard.newStaticMB();
                    this.buildTotalVerts = 0;
                }

                var mb = this.buildMb!;
                var hw = (item.width || 0.25) * 0.5 * this.scaleFactor;

                for (var ssi = 0; ssi < subSegs.length; ssi++) {
                    var ss = subSegs[ssi];
                    var ax = (ss.sx - this.cx) * this.scaleFactor;
                    var ay = -(ss.sy - this.cy) * this.scaleFactor;
                    var bx = (ss.ex - this.cx) * this.scaleFactor;
                    var by = -(ss.ey - this.cy) * this.scaleFactor;
                    var az = z * this.scaleFactor;

                    var dx = bx - ax, dy = by - ay;
                    var dlen = Math.sqrt(dx * dx + dy * dy);
                    if (dlen < 0.0001) continue;
                    var ndx = dx / dlen, ndy = dy / dlen;
                    var px = -ndy, py = ndx;

                    var base0 = mb.getVerticesCount();

                    // Body: 4 verts
                    mb.appendVerticesInterleaved([ax + px * hw, ay + py * hw, az, 0, 0, nz, 0, ti, 1.0, 0]);
                    mb.appendVerticesInterleaved([ax - px * hw, ay - py * hw, az, 0, 0, nz, 0, ti, -1.0, 0]);
                    mb.appendVerticesInterleaved([bx + px * hw, by + py * hw, az, 0, 0, nz, 1, ti, 1.0, 0]);
                    mb.appendVerticesInterleaved([bx - px * hw, by - py * hw, az, 0, 0, nz, 1, ti, -1.0, 0]);
                    mb.appendIndices([base0, base0 + 1, base0 + 3, base0, base0 + 3, base0 + 2]);

                    // Start cap
                    var capBase = mb.getVerticesCount();
                    mb.appendVerticesInterleaved([ax, ay, az, 0, 0, nz, 0, ti, 0, 0]);
                    for (var ci = 0; ci <= CAP_N; ci++) {
                        var rx = px * capCos[ci] - (-ndx) * capSin[ci];
                        var ry = py * capCos[ci] - (-ndy) * capSin[ci];
                        var crossVal = ci <= CAP_N / 2 ? 1.0 - 2.0 * ci / CAP_N : -1.0 + 2.0 * (ci - CAP_N / 2) / (CAP_N / 2);
                        mb.appendVerticesInterleaved([ax + rx * hw, ay + ry * hw, az, 0, 0, nz, 0, ti, crossVal, 0]);
                    }
                    for (var ci = 0; ci < CAP_N; ci++) {
                        mb.appendIndices([capBase, capBase + 1 + ci, capBase + 2 + ci]);
                    }

                    // End cap
                    var capBase2 = mb.getVerticesCount();
                    mb.appendVerticesInterleaved([bx, by, az, 0, 0, nz, 1, ti, 0, 0]);
                    for (var ci = 0; ci <= CAP_N; ci++) {
                        var rx = px * capCos[ci] - ndx * capSin[ci];
                        var ry = py * capCos[ci] - ndy * capSin[ci];
                        var crossVal = ci <= CAP_N / 2 ? 1.0 - 2.0 * ci / CAP_N : -1.0 + 2.0 * (ci - CAP_N / 2) / (CAP_N / 2);
                        mb.appendVerticesInterleaved([bx + rx * hw, by + ry * hw, az, 0, 0, nz, 1, ti, crossVal, 0]);
                    }
                    for (var ci = 0; ci < CAP_N; ci++) {
                        mb.appendIndices([capBase2, capBase2 + 1 + ci, capBase2 + 2 + ci]);
                    }

                    this.buildTotalVerts += vertsPerSub;
                    this.buildGrandTotalVerts += vertsPerSub;
                }

                this.buildTraceIdx++;

                // Check budget every 20 segments
                if (this.buildTraceIdx % 20 === 0) {
                    if (getTime() - startTime > budgetS) return false;
                }
            }

            // Finalize layer
            this.finalizeBuildBatch(layer);
            this.writeTraceHuesV2(layer, items, numItems);
            this.flushTraceGrowth(layer);
            print("[KiCad] Segments V2 " + layer + ": " +
                  numItems + " items, " + this.buildGrandTotalVerts + " verts, " + this.buildBatchIdx + " meshes");

            this.buildLayerIdx++;
            this.buildTraceIdx = 0;
            this.buildMb = null;
        }

        return true;
    }

    // Replay growth animation
    public replayGrowth(): void {
        if (!this.board) return;
        this.startGrowAll();
        // Hide labels during growth, they'll show after
        for (var li = 0; li < this.groupLabels.length; li++) {
            this.groupLabels[li].enabled = false;
        }
    }

    public growFromFootprint(ref: string): void {
        if (!this.board) return;
        var fp: any = null;
        for (var gi = 0; gi < this.fpBounds.length; gi++) {
            if (this.fpBounds[gi].ref === ref) {
                fp = this.fpBounds[gi];
                break;
            }
        }
        if (!fp) return;
        var nets: number[] = fp.nets as number[];
        if (!nets || nets.length === 0) return;

        var allTraceNets = new Set<number>();
        var traceSource2: any[] = this.isV2()
            ? (this.board.segments || []).concat(this.board.arcs || [])
            : (this.board.polylines || this.board.traces || []);
        for (var ti = 0; ti < traceSource2.length; ti++) {
            if (traceSource2[ti].net > 0) allTraceNets.add(traceSource2[ti].net as number);
        }

        var seedNets: number[] = [];
        for (var si = 0; si < nets.length; si++) {
            if (allTraceNets.has(nets[si])) seedNets.push(nets[si]);
        }
        if (seedNets.length === 0) return;

        var netAdj = this.buildNetAdjacency(allTraceNets);
        var waves = this.bfsWaves(seedNets, netAdj);

        this.setAllGrowth(0);
        this.animWaves = waves;
        this.animWaveIdx = 0;
        this.animWaveProgress = 0;
        this.animActive = true;
        this.flushAllTraceGrowth();
        print("[KiCad] Grow from footprint: " + seedNets.length + " seed nets, " + waves.length + " waves");
    }

    // ---- Simulation Integration ----
    // If board data includes a simulation section (precomputed by converter),
    // build and solve the DC operating point using CircuitSolver.

    private runSimulation(): void {
        if (!this.board || !this.board.simulation) return;
        var sim = this.board.simulation;
        if (!sim.elements || sim.elements.length === 0) return;

        try {
            var CircuitSolverMod = require("Scripts/Sim/CircuitSolver");
            var solver = new CircuitSolverMod.CircuitSolver();

            var groundNets: string[] = sim.groundNets || ["GND", "/GND"];

            for (var ei = 0; ei < sim.elements.length; ei++) {
                var el = sim.elements[ei];
                if (!el.pins || el.pins.length < 2) continue;

                // Map pin nets, replacing ground net names with "gnd"
                var nPlus = el.pins[0].net || "";
                var nMinus = el.pins[1].net || "";
                for (var gi = 0; gi < groundNets.length; gi++) {
                    if (nPlus === groundNets[gi]) nPlus = "gnd";
                    if (nMinus === groundNets[gi]) nMinus = "gnd";
                }
                if (!nPlus || !nMinus) continue;

                var val = el.value || 0;
                if (el.type === "R") {
                    solver.addResistor(nPlus, nMinus, val);
                } else if (el.type === "C") {
                    solver.addCapacitor(nPlus, nMinus, val);
                } else if (el.type === "LED") {
                    solver.addLED(nPlus, nMinus, val, 10);
                } else if (el.type === "V") {
                    solver.addVoltageSource(nPlus, nMinus, val);
                } else if (el.type === "wire") {
                    solver.addWire(nPlus, nMinus);
                }
            }

            var result = solver.solve();
            if (result.valid) {
                this.simNodeVoltages = result.nodeVoltages;
                this.simBranchCurrents = result.branchCurrents;
                this.simValid = true;
                print("[KiCad] Simulation solved: " + result.nodeVoltages.size + " nodes");
            } else {
                print("[KiCad] Simulation failed: " + (result.error || "unknown"));
                this.simValid = false;
            }
        } catch (e: any) {
            print("[KiCad] Simulation error: " + e.message);
            this.simValid = false;
        }
    }

    // Get solved voltage for a net name
    public simVoltage(netName: string): number {
        if (!this.simValid) return 0;
        return this.simNodeVoltages.get(netName) || 0;
    }

    // Board dimension getters (LS cm, at scaleFactor=1 of this object's local space)
    public getBoardHalfWidth(): number  { return this.boardHalfWidth; }
    public getBoardHalfHeight(): number { return this.boardHalfHeight; }

}
