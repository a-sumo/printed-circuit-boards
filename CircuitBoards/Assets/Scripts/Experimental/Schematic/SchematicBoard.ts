// SchematicBoard.ts
// Renders a KiCad schematic in 3D with symbol outlines, wire tubes, junction dots,
// net labels, and instance labels. Wire growth animation via data texture.
//
// JSON input format (from kicad-sch-to-json.mjs):
//   symbols: { lib_id: { graphics: [...], pins: [...] } }
//   instances: [{ lib_id, pos, rot, ref, value }]
//   wires: [{ points: [[x1,y1],[x2,y2]] }]
//   junctions: [[x,y], ...]
//   labels: [{ name, pos, rot }]
//
// Setup in Lens Studio:
//   1. Graph Material "KiCadTrace": KiCadTraceShader.js code node
//      + Texture 2D Object Parameter "traceTex"
//   2. Graph Material "KiCadBoard": KiCadBoardShader.js code node
//   3. Attach this script, assign materials, paste schematic JSON

// SIK loaded at runtime via require() to avoid compile-time dependency
let SIK_Interactable: any = null;
try {
    SIK_Interactable = require("SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable").Interactable;
} catch (e) {}

@component
export class SchematicBoard extends BaseScriptComponent {

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Arduino Nano", "arduino-nano"),
        new ComboBoxItem("StickHub USB", "stickhub-usb"),
        new ComboBoxItem("RPi CM4 IO", "rpi-cm4io"),
        new ComboBoxItem("ATtiny85 USB", "attiny85-usb"),
    ]))
    @hint("Select board from catalog (boards/ directory)")
    boardSlug: string = "arduino-nano";

    @input
    @hint("Material with KiCadTraceShader.js for wire rendering")
    traceMaterial: Material;

    @input
    @hint("Material with KiCadBoardShader.js for symbol/background geometry")
    boardMaterial: Material;

    @input
    labelFont: Font;

    @input
    @widget(new SliderWidget(0.1, 20.0, 0.1))
    @hint("Scale factor: KiCad mm to LS cm. 1.0 = 1mm per cm.")
    scaleFactor: number = 1.0;

    @input
    @widget(new SliderWidget(1, 100, 1))
    @hint("Label text size in LS font units")
    labelSize: number = 100;

    @input
    @hint("Auto-animate wire growth. 'all' = sequential growth.")
    autoPlay: string = "";

    // ---- Signal Flow ----
    @input
    @hint("Show animated signal flow along wires")
    signalFlow: boolean = false;

    @input
    @widget(new SliderWidget(0.5, 5.0, 0.1))
    flowSpeed: number = 1.5;

    @input
    @widget(new SliderWidget(0.1, 1.0, 0.1))
    flowIntensity: number = 0.4;

    // ---- Morph: Schematic <-> PCB ----
    @input
    @widget(new SliderWidget(0, 1, 0.01))
    @hint("Morph progress: 0 = schematic view, 1 = PCB layout")
    morphT: number = 0;

    @input
    @hint("UIKit Slider SceneObject for runtime morph control (optional)")
    @allowUndefined
    morphSliderObj: SceneObject;

    // Loaded board data (populated from catalog in onAwake)
    private schematicData: string = "";
    private pcbData: string = "";

    // ---- Schematic Colors ----
    private static readonly COL_SYMBOL = [0.88, 0.55, 0.08];       // vivid amber
    private static readonly COL_PIN = [0.91, 0.69, 0.06];           // vivid gold
    private static readonly COL_JUNCTION = [0.094, 0.471, 0.878];   // vivid blue
    private static readonly COL_BG = [0.0, 0.0, 0.0];               // black = transparent on additive

    // Track inputs that require rebuild on change
    private prevBoardSlug: string = "";
    private prevScaleFactor: number = 1.0;
    // Source material references (before cloning)
    private srcTraceMaterial: Material | null = null;
    private srcBoardMaterial: Material | null = null;

    // ---- Constants ----
    private static readonly MAX_WIRES = 4096;
    private static readonly RADIAL_SEGS = 6;
    private static readonly LINE_WIDTH = 0.3;     // mm, schematic line width
    private static readonly WIRE_RADIUS = 0.15;   // mm, wire tube radius
    private static readonly JUNCTION_RADIUS = 0.5; // mm
    private static readonly JUNCTION_SEGS = 6;
    private static readonly PIN_DOT_RADIUS = 0.3;  // mm
    private static readonly PIN_DOT_SEGS = 4;
    private static readonly VERT_LIMIT = 63000;

    // ---- State ----
    private sch: any = null;
    private cx: number = 0;
    private cy: number = 0;

    // Wire data texture
    private wireTexProvider: ProceduralTextureProvider | null = null;
    private wirePixels: Uint8Array | null = null;
    private wireCount: number = 0;
    private wireGrowths: number[] = [];

    // Animation
    private animActive: boolean = false;
    private animTimer: number = 0;
    private flowTimer: number = 0;
    private wirePass: Pass | null = null;

    // Flow story: ordered chapters of wire groups
    private flowChapters: { name: string, wires: number[], delay: number }[] = [];
    private flowChapterIdx: number = 0;
    private flowChapterTimer: number = 0;
    private flowStoryActive: boolean = false;
    private chapterPlaying: boolean = false;
    private chapterPauseTimer: number = 0;

    // Net topology: wireIndex -> netName
    private wireNetNames: string[] = [];
    // Wire endpoint position map: posKey -> wire indices (saved from buildNetTopology)
    private wireEndpointMap: Map<string, number[]> = new Map();

    // Component registry: ref -> positions, nets, pins for both views
    private componentMap: Map<string, {
        ref: string; value: string; libId: string;
        schPos: number[]; schRot: number;
        pcbPos: number[] | null; pcbRot: number; pcbLayer: string;
        nets: string[];
    }> = new Map();

    // Selection / callout
    private selectedRef: string | null = null;
    private calloutGroup: SceneObject | null = null;
    private calloutTexProv: ProceduralTextureProvider | null = null;
    private calloutPixels: Uint8Array | null = null;
    private calloutGrowth: number = 0;
    private calloutAnimating: boolean = false;

    // Schematic bounds (KiCad mm, before padding)
    private schBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

    // Chapter UI
    private chapterLabel: Text | null = null;

    // PCB position mapping: ref -> [x, y] in KiCad mm
    private pcbPositions: Map<string, number[]> = new Map();
    // PCB footprint data: ref -> { rot, layer, width, height in mm }
    private pcbFootprintData: Map<string, { rot: number, layer: string, fpW: number, fpH: number }> = new Map();

    // SceneObject groups
    private groupSymbols: SceneObject[] = [];
    private groupWires: SceneObject[] = [];
    private groupJunctions: SceneObject | null = null;
    private groupLabels: SceneObject[] = [];
    private groupBg: SceneObject | null = null;

    // Label-to-position map for net coloring
    private labelPosMap: Map<string, string> = new Map();

    // ---- Morph state ----
    private hasMorph: boolean = false;
    private prevMorphT: number = 0;
    private symbolObjects: Map<string, SceneObject> = new Map();
    private schematicPositions: Map<string, vec3> = new Map();
    private pcbLSPositions: Map<string, vec3> = new Map();
    private pcbCx: number = 0;
    private pcbCy: number = 0;
    // PCB board extent (KiCad mm) and scale ratio for morph normalization
    private pcbExtentW: number = 0;
    private pcbExtentH: number = 0;
    private pcbMorphScale: number = 1;
    // Pad-level data: "ref:padNumber" -> PCB world pos [x,y] in KiCad mm
    private pcbPadWorldPos: Map<string, number[]> = new Map();
    // Pad-level net name: "ref:padNumber" -> net name
    private pcbPadNetName: Map<string, string> = new Map();
    // Wire semantic net name from pin-to-pad matching (more complete than label-only)
    private wireSemanticNet: string[] = [];
    private pcbNetNames: Map<number, string> = new Map();
    // PCB trace rendering
    private pcbTraceGroups: SceneObject[] = [];
    private pcbTraceTexProv: ProceduralTextureProvider | null = null;
    private pcbTracePixels: Uint8Array | null = null;
    private pcbTraceCount: number = 0;
    private pcbTraceGrowths: number[] = [];
    private pcbTracePass: Pass | null = null;
    // Label refs for morph positioning
    private instanceLabelObjects: Map<string, SceneObject> = new Map();
    // Morph slider
    private sliderKnob: SceneObject | null = null;
    private sliderTrackMinX: number = 0;
    private sliderTrackMaxX: number = 0;
    private sliderDragging: boolean = false;
    private sliderValueLabel: Text | null = null;
    // Morph delta map: posKey -> vec3 delta (schLS -> pcbLS) for wire vertex offsets
    private morphDeltaMap: Map<string, vec3> = new Map();
    // Per-component schematic symbol bounds (KiCad mm, relative to instance center)
    private symbolBounds: Map<string, { w: number, h: number }> = new Map();
    // Bridge tubes: connect schematic position to PCB position per component
    private bridgeGroup: SceneObject | null = null;
    private bridgeTexProv: ProceduralTextureProvider | null = null;
    private bridgePixels: Uint8Array | null = null;
    private bridgeCount: number = 0;
    private bridgePass: Pass | null = null;

    // Build routed tube connections from each component's schematic position to its PCB position.
    // Route: horizontal stub out -> diagonal -> horizontal stub in (circuit-trace style).
    // Placed before onAwake to avoid LensifyTS forward-reference issue.
    private buildBridgeTubes(): void {
        if (!this.hasMorph || this.symbolObjects.size === 0) return;

        const matched: { ref: string, from: vec3, to: vec3 }[] = [];
        for (const [ref, schPos] of this.schematicPositions) {
            const pcbPos = this.pcbLSPositions.get(ref);
            if (pcbPos) matched.push({ ref, from: schPos, to: pcbPos });
        }
        if (matched.length === 0) return;

        this.bridgeCount = matched.length;
        const CIRC = SchematicBoard.RADIAL_SEGS;
        const tubeR = 0.08 * this.scaleFactor;

        const ccos: number[] = [], csin: number[] = [];
        for (let j = 0; j < CIRC; j++) {
            const theta = (j / CIRC) * Math.PI * 2;
            ccos.push(Math.cos(theta));
            csin.push(Math.sin(theta));
        }

        let bridgeMat: Material | null = null;
        if (this.traceMaterial) {
            bridgeMat = this.traceMaterial.clone();
            this.bridgePass = bridgeMat.mainPass;
            const texH = SchematicBoard.MAX_WIRES;
            const tex = ProceduralTextureProvider.createWithFormat(2, texH, TextureFormat.RGBA8Unorm);
            this.bridgeTexProv = tex.control as ProceduralTextureProvider;
            this.bridgePixels = new Uint8Array(2 * texH * 4);
            bridgeMat.mainPass["traceTex"] = tex;
            bridgeMat.mainPass["NumTraces"] = SchematicBoard.MAX_WIRES;
            try { bridgeMat.mainPass["flowTime"] = 0; } catch (e) {}

            for (let i = 0; i < this.bridgeCount; i++) {
                const row = i * 8;
                this.encode01(this.bridgePixels, row + 0, 0);
                const hue = this.netHue(matched[i].ref);
                this.encode01(this.bridgePixels, row + 2, hue);
                // Column 1: default flow data (bridges don't use flow)
                this.encode01(this.bridgePixels, row + 4, 1.0 / 200.0);
                this.encode01(this.bridgePixels, row + 6, 0);
            }
            this.bridgeTexProv.setPixels(0, 0, 2, texH, this.bridgePixels);
        }

        let mb = SchematicBoard.newStaticMB();
        let totalVerts = 0;

        for (let bi = 0; bi < this.bridgeCount; bi++) {
            const m = matched[bi];
            const a = m.from, b = m.to;

            // Route: horizontal stub from A, diagonal middle, horizontal stub into B
            const dx = b.x - a.x;
            const stubFrac = 0.2;
            const stubLen = Math.abs(dx) * stubFrac;
            const stubX = dx >= 0 ? stubLen : -stubLen;

            const p0 = a;                                              // start
            const p1 = new vec3(a.x + stubX, a.y, a.z);               // end of horizontal out
            const p2 = new vec3(b.x - stubX, b.y, b.z);               // start of horizontal in
            const p3 = b;                                              // end
            const pts = [p0, p1, p2, p3];
            const N = 4;

            // Cumulative arc length for parametric t
            const cumLen: number[] = [0];
            for (let i = 1; i < N; i++) {
                const sx = pts[i].x - pts[i - 1].x;
                const sy = pts[i].y - pts[i - 1].y;
                const sz = pts[i].z - pts[i - 1].z;
                cumLen.push(cumLen[i - 1] + Math.sqrt(sx * sx + sy * sy + sz * sz));
            }
            const arcLen = cumLen[N - 1];
            if (arcLen < 0.001) continue;

            const capVerts = 2 * (CIRC + 1);
            const vertsNeeded = N * CIRC + capVerts;
            if (totalVerts + vertsNeeded > SchematicBoard.VERT_LIMIT && totalVerts > 0) break;

            const base0 = mb.getVerticesCount();
            let startFrame: { rx: number, ry: number, rz: number, bx: number, by: number, bz: number, tx: number, ty: number, tz: number } | null = null;
            let endFrame: typeof startFrame = null;

            for (let pi = 0; pi < N; pi++) {
                const t = arcLen > 0.001 ? cumLen[pi] / arcLen : pi / (N - 1);
                const c = pts[pi];

                // Tangent from adjacent segments
                let ttx: number, tty: number, ttz: number;
                if (pi === 0) {
                    ttx = pts[1].x - pts[0].x; tty = pts[1].y - pts[0].y; ttz = pts[1].z - pts[0].z;
                } else if (pi === N - 1) {
                    ttx = pts[N - 1].x - pts[N - 2].x; tty = pts[N - 1].y - pts[N - 2].y; ttz = pts[N - 1].z - pts[N - 2].z;
                } else {
                    const ax2 = pts[pi].x - pts[pi - 1].x, ay = pts[pi].y - pts[pi - 1].y, az = pts[pi].z - pts[pi - 1].z;
                    const bx2 = pts[pi + 1].x - pts[pi].x, by2 = pts[pi + 1].y - pts[pi].y, bz2 = pts[pi + 1].z - pts[pi].z;
                    const la = Math.sqrt(ax2 * ax2 + ay * ay + az * az);
                    const lb = Math.sqrt(bx2 * bx2 + by2 * by2 + bz2 * bz2);
                    ttx = (la > 0.001 ? ax2 / la : 0) + (lb > 0.001 ? bx2 / lb : 0);
                    tty = (la > 0.001 ? ay / la : 0) + (lb > 0.001 ? by2 / lb : 0);
                    ttz = (la > 0.001 ? az / la : 0) + (lb > 0.001 ? bz2 / lb : 0);
                }
                let tlen = Math.sqrt(ttx * ttx + tty * tty + ttz * ttz);
                if (tlen < 0.001) { ttx = 1; tty = 0; ttz = 0; tlen = 1; }
                ttx /= tlen; tty /= tlen; ttz /= tlen;

                // Frenet frame
                let ux2: number, uy2: number, uz2: number;
                if (Math.abs(ttz) > 0.99) { ux2 = 1; uy2 = 0; uz2 = 0; }
                else { ux2 = 0; uy2 = 0; uz2 = 1; }
                let frx = uy2 * ttz - uz2 * tty;
                let fry = uz2 * ttx - ux2 * ttz;
                let frz = ux2 * tty - uy2 * ttx;
                const frl = Math.sqrt(frx * frx + fry * fry + frz * frz);
                if (frl > 0.001) { frx /= frl; fry /= frl; frz /= frl; }
                else { frx = 0; fry = 1; frz = 0; }
                const fbx = tty * frz - ttz * fry;
                const fby = ttz * frx - ttx * frz;
                const fbz = ttx * fry - tty * frx;

                const frame = { rx: frx, ry: fry, rz: frz, bx: fbx, by: fby, bz: fbz, tx: ttx, ty: tty, tz: ttz };
                if (pi === 0) startFrame = frame;
                if (pi === N - 1) endFrame = frame;

                for (let j = 0; j < CIRC; j++) {
                    const ox = ccos[j] * tubeR * frx + csin[j] * tubeR * fbx;
                    const oy = ccos[j] * tubeR * fry + csin[j] * tubeR * fby;
                    const oz = ccos[j] * tubeR * frz + csin[j] * tubeR * fbz;
                    const nx2 = ccos[j] * frx + csin[j] * fbx;
                    const ny2 = ccos[j] * fry + csin[j] * fby;
                    const nz2 = ccos[j] * frz + csin[j] * fbz;
                    mb.appendVerticesInterleaved([
                        c.x + ox, c.y + oy, c.z + oz,
                        nx2, ny2, nz2,
                        t, bi,
                        0, 0
                    ]);
                }
            }

            // Start cap
            if (startFrame) {
                const f = startFrame;
                const sc = mb.getVerticesCount();
                mb.appendVerticesInterleaved([pts[0].x, pts[0].y, pts[0].z, -f.tx, -f.ty, -f.tz, 0, bi, 0, 0]);
                for (let j = 0; j < CIRC; j++) {
                    const ox = ccos[j] * tubeR * f.rx + csin[j] * tubeR * f.bx;
                    const oy = ccos[j] * tubeR * f.ry + csin[j] * tubeR * f.by;
                    const oz = ccos[j] * tubeR * f.rz + csin[j] * tubeR * f.bz;
                    mb.appendVerticesInterleaved([pts[0].x + ox, pts[0].y + oy, pts[0].z + oz, -f.tx, -f.ty, -f.tz, 0, bi, 0, 0]);
                }
                for (let j = 0; j < CIRC; j++) {
                    const j1 = (j + 1) % CIRC;
                    mb.appendIndices([sc, sc + 1 + j1, sc + 1 + j]);
                }
            }

            // End cap
            if (endFrame) {
                const f = endFrame;
                const ec = mb.getVerticesCount();
                mb.appendVerticesInterleaved([pts[N - 1].x, pts[N - 1].y, pts[N - 1].z, f.tx, f.ty, f.tz, 1, bi, 0, 0]);
                for (let j = 0; j < CIRC; j++) {
                    const ox = ccos[j] * tubeR * f.rx + csin[j] * tubeR * f.bx;
                    const oy = ccos[j] * tubeR * f.ry + csin[j] * tubeR * f.by;
                    const oz = ccos[j] * tubeR * f.rz + csin[j] * tubeR * f.bz;
                    mb.appendVerticesInterleaved([pts[N - 1].x + ox, pts[N - 1].y + oy, pts[N - 1].z + oz, f.tx, f.ty, f.tz, 1, bi, 0, 0]);
                }
                for (let j = 0; j < CIRC; j++) {
                    const j1 = (j + 1) % CIRC;
                    mb.appendIndices([ec, ec + 1 + j, ec + 1 + j1]);
                }
            }

            // Body indices: connect adjacent rings
            for (let seg = 0; seg < N - 1; seg++) {
                const r0 = base0 + seg * CIRC;
                const r1 = base0 + (seg + 1) * CIRC;
                for (let j = 0; j < CIRC; j++) {
                    const j1 = (j + 1) % CIRC;
                    mb.appendIndices([r0 + j, r0 + j1, r1 + j1, r0 + j, r1 + j1, r1 + j]);
                }
            }
            totalVerts += vertsNeeded;
        }

        if (totalVerts > 0) {
            mb.updateMesh();
            const child = global.scene.createSceneObject("__sch_bridges");
            child.setParent(this.sceneObject);
            child.enabled = false;
            this.bridgeGroup = child;
            const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            rmv.mesh = mb.getMesh();
            if (bridgeMat) rmv.mainMaterial = bridgeMat;
        }

        print("[Schematic] Bridge tubes: " + this.bridgeCount + " connections");
    }

    // ---- Lifecycle ----

    onAwake(): void {
        // Save source material references before any cloning
        this.srcTraceMaterial = this.traceMaterial;
        this.srcBoardMaterial = this.boardMaterial;

        // Load board data from catalog (static requires: LS resolves at compile time)
        const slug = this.boardSlug || "arduino-nano";
        print("[Schematic] Loading board: " + slug);
        const boardModules: Record<string, any> = {
            "arduino-nano": require("Scripts/Board/data/arduino-nano.js"),
            "stickhub-usb": require("Scripts/Board/data/stickhub-usb.js"),
            "rpi-cm4io": require("Scripts/Board/data/rpi-cm4io.js"),
            "attiny85-usb": require("Scripts/Board/data/attiny85-usb.js"),
        };
        const mod = boardModules[slug] || boardModules["arduino-nano"];
        this.schematicData = mod.sch;
        this.pcbData = mod.pcb;
        print("[Schematic] Loaded " + slug + ": sch=" +
              Math.round(this.schematicData.length / 1024) + "KB, pcb=" +
              Math.round(this.pcbData.length / 1024) + "KB");

        try {
            this.sch = JSON.parse(this.schematicData);
        } catch (e: any) {
            print("[Schematic] Failed to parse JSON: " + e.message);
            return;
        }

        const instances = this.sch.instances || [];
        const wires = this.sch.wires || [];
        const junctions = this.sch.junctions || [];
        const labels = this.sch.labels || [];

        print("[Schematic] " + instances.length + " instances, " +
              wires.length + " wires, " + junctions.length + " junctions, " +
              labels.length + " labels");

        // Parse PCB data for morph
        let pcbObj: any = null;
        if (this.pcbData && this.pcbData.trim().length > 2) {
            try {
                pcbObj = JSON.parse(this.pcbData);
                if (pcbObj.footprints) {
                    for (const fp of pcbObj.footprints) {
                        const ref = fp.ref || fp.name || '';
                        if (ref) {
                            this.pcbPositions.set(ref, fp.pos);
                            this.pcbFootprintData.set(ref, {
                                rot: fp.rot || 0,
                                layer: fp.layer || 'F.Cu',
                                fpW: fp.fpW || 0,
                                fpH: fp.fpH || 0
                            });
                            // Build pad world positions from footprint-local coords
                            const fpRot = (fp.rot || 0) * Math.PI / 180;
                            const cosFp = Math.cos(-fpRot), sinFp = Math.sin(-fpRot);
                            const pads = fp.pads || [];
                            for (const pad of pads) {
                                const pn = pad.n || pad.number || '';
                                if (!pn) continue;
                                const lp = pad.p || pad.pos || [0, 0];
                                const [wx, wy] = this.rotPt(lp[0], lp[1], cosFp, sinFp);
                                const padKey = ref + ':' + pn;
                                this.pcbPadWorldPos.set(padKey,
                                    [fp.pos[0] + wx, fp.pos[1] + wy]);
                                const nn = pad.nn || pad.netName || '';
                                if (nn) this.pcbPadNetName.set(padKey, nn);
                            }
                        }
                    }
                }
                // Net ID -> name mapping for trace coloring
                if (pcbObj.nets) {
                    for (const [id, name] of Object.entries(pcbObj.nets)) {
                        this.pcbNetNames.set(parseInt(id), name as string);
                    }
                }
                // PCB center from board outline
                if (pcbObj.board && pcbObj.board.outline && pcbObj.board.outline.length > 0) {
                    let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
                    for (const p of pcbObj.board.outline) {
                        if (p[0] < mnX) mnX = p[0]; if (p[0] > mxX) mxX = p[0];
                        if (p[1] < mnY) mnY = p[1]; if (p[1] > mxY) mxY = p[1];
                    }
                    this.pcbCx = (mnX + mxX) * 0.5;
                    this.pcbCy = (mnY + mxY) * 0.5;
                    this.pcbExtentW = mxX - mnX;
                    this.pcbExtentH = mxY - mnY;
                    this.hasMorph = true;
                }
                print("[Schematic] PCB morph data: " + this.pcbPositions.size + " footprints, " +
                      this.pcbPadWorldPos.size + " pads, " +
                      this.pcbNetNames.size + " nets, morph=" + this.hasMorph);
            } catch (e: any) {
                print("[Schematic] Failed to parse pcbData: " + e.message);
            }
        }

        // Compute bounding-box center from all instances and wire points
        this.computeCenter(instances, wires);

        // Compute PCB morph scale: blow up PCB layout to match schematic extent
        if (this.hasMorph && this.pcbExtentW > 1 && this.pcbExtentH > 1) {
            const schW = this.schBounds.maxX - this.schBounds.minX;
            const schH = this.schBounds.maxY - this.schBounds.minY;
            this.pcbMorphScale = Math.min(schW / this.pcbExtentW, schH / this.pcbExtentH);
            print("[Schematic] PCB morph scale: " + this.pcbMorphScale.toFixed(2) +
                  "x (sch " + schW.toFixed(0) + "x" + schH.toFixed(0) +
                  " -> pcb " + this.pcbExtentW.toFixed(0) + "x" + this.pcbExtentH.toFixed(0) + ")");
        }

        // Clone boardMaterial once for all board-shader geometry
        if (this.boardMaterial) {
            this.boardMaterial = this.boardMaterial.clone();
            const pass = this.boardMaterial.mainPass;
            try { pass["boardTime"] = 1.0; } catch (e) {}
        }

        // Build label position map for net coloring (before wires)
        this.buildLabelPosMap(labels);

        // Build net topology for meaningful flow animation
        this.buildNetTopology(wires, instances, labels);

        // Build morph delta map before wires (needed for vertex offsets)
        if (this.hasMorph) {
            this.buildMorphDeltaMap();
        }

        this.buildBackground(instances, wires);
        this.buildSymbols(instances);
        this.buildWires(wires);
        this.buildJunctions(junctions);
        this.buildLabels(instances, labels);

        // Build PCB traces for morph mode
        if (this.hasMorph && pcbObj && pcbObj.traces) {
            this.buildPcbTraces(pcbObj.traces);
        }

        // Build component registry (positions, nets, descriptions for both views)
        this.buildComponentMap();

        // Build flow story (ordered chapters) from net topology
        this.buildFlowStory();
        this.buildChapterUI();

        // Build bridge tubes + morph slider if PCB data loaded
        if (this.hasMorph) {
            this.buildBridgeTubes();
            this.buildMorphSlider();
        }

        // Wire UIKit Slider if assigned
        if (this.morphSliderObj) {
            this.wireUIKitSlider();
        }

        if (this.autoPlay === 'all' && this.flowChapters.length > 0) {
            // Start chapter-based growth: all wires hidden, first chapter plays
            for (let i = 0; i < this.wireCount; i++) {
                this.wireGrowths[i] = 0;
            }
            this.flushWireGrowth();
            this.flowStoryActive = true;
            this.flowChapterIdx = 0;
            this.chapterPlaying = true;
            this.animTimer = 0;
            this.updateChapterLabel();
        }

        // Initialize prev-tracking for reactive input detection
        this.prevBoardSlug = this.boardSlug;
        this.prevScaleFactor = this.scaleFactor;

        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    // ---- Coordinate Transform ----

    private computeCenter(instances: any[], wires: any[]): void {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

        for (const inst of instances) {
            const x = inst.pos[0], y = inst.pos[1];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        for (const wire of wires) {
            for (const pt of wire.points) {
                if (pt[0] < minX) minX = pt[0];
                if (pt[0] > maxX) maxX = pt[0];
                if (pt[1] < minY) minY = pt[1];
                if (pt[1] > maxY) maxY = pt[1];
            }
        }

        if (minX > maxX) { minX = 0; maxX = 1; }
        this.cx = (minX + maxX) * 0.5;
        this.cy = (minY + maxY) * 0.5;
        this.schBounds = { minX, maxX, minY, maxY };
    }

    // KiCad mm Y-down to LS cm Y-up, centered on schematic
    private toLS(x: number, y: number, z: number = 0): vec3 {
        const s = this.scaleFactor;
        return new vec3((x - this.cx) * s, -(y - this.cy) * s, z * s);
    }

    // KiCad mm Y-down to LS cm Y-up, centered on PCB board, scaled to match schematic extent
    private toPcbLS(x: number, y: number, z: number = 0): vec3 {
        const s = this.scaleFactor * this.pcbMorphScale;
        return new vec3((x - this.pcbCx) * s, -(y - this.pcbCy) * s, z * s);
    }

    // 2D rotation
    private rotPt(lx: number, ly: number, cosR: number, sinR: number): [number, number] {
        return [lx * cosR - ly * sinR, lx * sinR + ly * cosR];
    }

    // ---- MeshBuilder Helper ----

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

    // ---- Net Hue ----

    private netHue(name: string): number {
        if (name === 'GND' || name === '/GND') return 0.0;
        if (name.includes('+3V3') || name.includes('3.3V') || name.includes('3V3')) return 0.08;
        if (name.includes('+5V') || name.includes('VCC')) return 0.12;
        // Golden ratio hash
        let h = 0;
        for (let i = 0; i < name.length; i++) {
            h = (h + name.charCodeAt(i)) * 0.618033988749895;
        }
        return h % 1.0;
    }

    // Quantize position to 0.01mm grid for label matching
    private posKey(x: number, y: number): string {
        return Math.round(x * 100) + ',' + Math.round(y * 100);
    }

    private buildLabelPosMap(labels: any[]): void {
        for (const lbl of labels) {
            const key = this.posKey(lbl.pos[0], lbl.pos[1]);
            this.labelPosMap.set(key, lbl.name);
        }
    }

    // Build morph delta map with pad-level precision.
    // For each schematic pin, compute the LS-space delta to the corresponding PCB pad position
    // (via ref + pin number matching). Falls back to component-center delta when pad data is missing.
    private buildMorphDeltaMap(): void {
        if (!this.hasMorph) return;
        const symbols = this.sch.symbols || {};
        const instances = this.sch.instances || [];
        const hasPadData = this.pcbPadWorldPos.size > 0;
        let padHits = 0, centerFallbacks = 0;

        // Also build pin-position -> {ref, pinNumber} map for semantic net matching
        const pinPosToRef: Map<string, { ref: string, pinNumber: string }> = new Map();

        for (const inst of instances) {
            const ref = inst.ref || '';
            if (ref.startsWith('#PWR') || ref.startsWith('#FLG')) continue;

            const pcbPos = this.pcbPositions.get(ref);
            if (!pcbPos) continue;

            const ix = inst.pos[0], iy = inst.pos[1];
            const schLS = this.toLS(ix, iy, 0);
            const pcbLS = this.toPcbLS(pcbPos[0], pcbPos[1], 0);
            const centerDelta = new vec3(pcbLS.x - schLS.x, pcbLS.y - schLS.y, 0);

            const sym = symbols[inst.lib_id];
            if (!sym || !sym.pins) continue;

            const rot = (inst.rot || 0) * Math.PI / 180;
            const cosR = Math.cos(rot), sinR = Math.sin(rot);

            for (const pin of sym.pins) {
                // Wires connect at pin base (pos), not tip (pos + length)
                const px = pin.pos ? pin.pos[0] : 0;
                const py = pin.pos ? pin.pos[1] : 0;
                const [rx, ry] = this.rotPt(px, py, cosR, sinR);
                const pinKey = this.posKey(ix + rx, iy + ry);
                const pinNumber = pin.number || '';

                // Store pin position for semantic net matching
                if (pinNumber) pinPosToRef.set(pinKey, { ref, pinNumber });

                // Try pad-specific delta first (pin base → pad world position)
                const padKey = ref + ':' + pinNumber;
                const padWorld = hasPadData ? this.pcbPadWorldPos.get(padKey) : null;
                if (padWorld) {
                    const pinSchLS = this.toLS(ix + rx, iy + ry, 0);
                    const padLS = this.toPcbLS(padWorld[0], padWorld[1], 0);
                    this.morphDeltaMap.set(pinKey, new vec3(
                        padLS.x - pinSchLS.x, padLS.y - pinSchLS.y, 0));
                    padHits++;
                } else {
                    // Fallback: component-center delta
                    this.morphDeltaMap.set(pinKey, centerDelta);
                    centerFallbacks++;
                }
            }
            // Also map instance center
            this.morphDeltaMap.set(this.posKey(ix, iy), centerDelta);
        }

        // Build semantic net names via pin-to-pad matching + junction propagation
        this.buildWireSemanticNets(pinPosToRef);

        // Junction propagation: BFS through wire network to spread deltas to connected endpoints
        const wires = this.sch.wires || [];
        let changed = true;
        let iters = 0;
        while (changed && iters < 20) {
            changed = false;
            iters++;
            for (const w of wires) {
                const pts = w.points;
                let foundDelta: vec3 | null = null;
                for (const p of pts) {
                    const k = this.posKey(p[0], p[1]);
                    if (this.morphDeltaMap.has(k)) {
                        foundDelta = this.morphDeltaMap.get(k)!;
                        break;
                    }
                }
                if (foundDelta) {
                    for (const p of pts) {
                        const k = this.posKey(p[0], p[1]);
                        if (!this.morphDeltaMap.has(k)) {
                            this.morphDeltaMap.set(k, foundDelta);
                            changed = true;
                        }
                    }
                }
            }
        }

        print("[Schematic] Morph delta map: " + this.morphDeltaMap.size + " entries (" +
              iters + " iterations). Pad hits: " + padHits + ", center fallbacks: " + centerFallbacks);
    }

    // Build per-wire net names using pin-to-pad matching (more complete than label-only).
    private buildWireSemanticNets(pinPosToRef: Map<string, { ref: string, pinNumber: string }>): void {
        const wires = this.sch.wires || [];
        this.wireSemanticNet = new Array(wires.length).fill('');
        if (this.pcbPadNetName.size === 0) return;

        // Build wire endpoint -> wire indices map
        const ptToWires: Map<string, number[]> = new Map();
        for (let wi = 0; wi < wires.length; wi++) {
            for (const p of wires[wi].points) {
                const k = this.posKey(p[0], p[1]);
                if (!ptToWires.has(k)) ptToWires.set(k, []);
                ptToWires.get(k)!.push(wi);
            }
        }

        // Seed: for each pin position that touches a wire, look up the PCB pad net name
        for (const [pk, { ref, pinNumber }] of pinPosToRef) {
            const netName = this.pcbPadNetName.get(ref + ':' + pinNumber);
            if (!netName) continue;
            const connWires = ptToWires.get(pk) || [];
            for (const wi of connWires) {
                if (!this.wireSemanticNet[wi]) this.wireSemanticNet[wi] = netName;
            }
        }

        // Propagate through junctions: if a wire has a net name, spread to neighbors
        let changed = true;
        let iters = 0;
        while (changed && iters < 20) {
            changed = false;
            iters++;
            for (let wi = 0; wi < wires.length; wi++) {
                const net = this.wireSemanticNet[wi];
                if (!net) continue;
                for (const p of wires[wi].points) {
                    const k = this.posKey(p[0], p[1]);
                    const neighbors = ptToWires.get(k) || [];
                    for (const nwi of neighbors) {
                        if (!this.wireSemanticNet[nwi]) {
                            this.wireSemanticNet[nwi] = net;
                            changed = true;
                        }
                    }
                }
            }
        }

        const named = this.wireSemanticNet.filter(n => n !== '').length;
        print("[Schematic] Semantic nets: " + named + "/" + wires.length +
              " wires named via pin-to-pad (" + iters + " propagation iterations)");
    }

    // Find net name for a wire by checking its endpoints against label positions
    private wireNetName(wire: any): string | null {
        const pts = wire.points;
        for (const pt of pts) {
            const key = this.posKey(pt[0], pt[1]);
            const name = this.labelPosMap.get(key);
            if (name) return name;
        }
        return null;
    }

    // ---- Net Topology (union-find on wire endpoints) ----

    private buildNetTopology(wires: any[], instances: any[], labels: any[]): void {
        const N = wires.length;
        if (N === 0) return;

        // Union-find
        const par = new Array(N);
        for (let i = 0; i < N; i++) par[i] = i;
        const find = (x: number): number => {
            while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; }
            return x;
        };
        const union = (a: number, b: number): void => { par[find(a)] = find(b); };

        // Index wire endpoints by position key -> wire indices
        const ptMap: Map<string, number[]> = new Map();
        for (let i = 0; i < N; i++) {
            for (const pt of wires[i].points) {
                const k = this.posKey(pt[0], pt[1]);
                const arr = ptMap.get(k);
                if (arr) {
                    for (const j of arr) union(i, j);
                    arr.push(i);
                } else {
                    ptMap.set(k, [i]);
                }
            }
        }

        // Build position -> net name from labels AND power symbols
        const posNet: Map<string, string> = new Map();
        for (const l of labels) {
            posNet.set(this.posKey(l.pos[0], l.pos[1]), l.name);
        }
        for (const inst of instances) {
            if ((inst.ref || '').startsWith('#PWR') || (inst.ref || '').startsWith('#FLG')) {
                posNet.set(this.posKey(inst.pos[0], inst.pos[1]), inst.value || '');
            }
        }

        // Group wires by root, label each group
        const groups: Map<number, number[]> = new Map();
        for (let i = 0; i < N; i++) {
            const r = find(i);
            const g = groups.get(r);
            if (g) g.push(i); else groups.set(r, [i]);
        }

        // Label groups: find any wire endpoint touching a labeled position
        const groupNet: Map<number, string> = new Map();
        for (const [root, indices] of groups) {
            for (const wi of indices) {
                for (const pt of wires[wi].points) {
                    const k = this.posKey(pt[0], pt[1]);
                    const name = posNet.get(k);
                    if (name) { groupNet.set(root, name); break; }
                }
                if (groupNet.has(root)) break;
            }
        }

        // Assign net name per wire
        this.wireNetNames = new Array(N).fill('');
        for (let i = 0; i < N; i++) {
            this.wireNetNames[i] = groupNet.get(find(i)) || '';
        }

        // Save endpoint map for component registry pin-to-net lookup
        this.wireEndpointMap = ptMap;

        const named = this.wireNetNames.filter(n => n !== '').length;
        print("[Schematic] Net topology: " + groups.size + " groups, " + named + "/" + N + " wires named");
    }

    private buildFlowStory(): void {
        const N = this.wireCount;
        if (N === 0) return;

        // Group wires by net name
        const netWires: Map<string, number[]> = new Map();
        for (let i = 0; i < N; i++) {
            const name = this.wireNetNames[i] || '__unnamed';
            const arr = netWires.get(name);
            if (arr) arr.push(i); else netWires.set(name, [i]);
        }

        // Functional chapters: complete current loops with plain English.
        // Ground goes first so every subsequent path visually completes a loop.
        // Each: [human description, net patterns, delay (unused in stepped mode)]
        const chapterDefs: [string, RegExp][] = [
            ["Ground connects everything.\nEvery current path returns here.",
                /^GND$/],
            ["Power enters the board.\n12V and 5V rails light up.",
                /^(\+12V|\+5V|EXD_\+12V|EXD_\+5V|VCC|VBUS)$/],
            ["The voltage regulator steps 5V down to 3.3V\nfor the microcontroller.",
                /^\+3\.3V$/],
            ["The microcontroller sends serial data\nto the RS485 transceiver chip.",
                /RS485_(TX|RX|DE)/],
            ["RS485 converts the signal to a differential pair.\nTwo wires carry inverted copies so noise cancels out.",
                /^RS485_?[AB]$/],
            ["SPI bus links the processors.\nClock, data in, data out, chip select.",
                /^SPI_/],
            ["GPIO and control signals.\nInterrupts, enables, and status lines.",
                /^(Himax_|MOS_G|EXD_INT)/],
        ];

        const used: Set<number> = new Set();

        for (const [label, pattern] of chapterDefs) {
            const chapterWires: number[] = [];
            for (const [name, indices] of netWires) {
                if (pattern.test(name)) {
                    for (const wi of indices) {
                        if (!used.has(wi)) { chapterWires.push(wi); used.add(wi); }
                    }
                }
            }
            if (chapterWires.length > 0) {
                this.flowChapters.push({ name: label, wires: chapterWires, delay: 0 });
            }
        }

        // Remaining wires
        const remaining: number[] = [];
        for (let i = 0; i < N; i++) {
            if (!used.has(i)) remaining.push(i);
        }
        if (remaining.length > 0) {
            this.flowChapters.push({
                name: "Supporting connections complete the circuit.",
                wires: remaining, delay: 0
            });
        }

        let total = 0;
        for (const ch of this.flowChapters) total += ch.wires.length;
        print("[Schematic] Flow story: " + this.flowChapters.length + " chapters, " + total + " wires");
        for (const ch of this.flowChapters) {
            print("[Schematic]   " + ch.name.split('\n')[0] + ": " + ch.wires.length + " wires");
        }
    }

    // ---- Texture Encoding ----

    private encode01(pixels: Uint8Array, offset: number, value: number): void {
        const v = Math.round(Math.max(0, Math.min(65535, value * 65535)));
        pixels[offset] = (v >> 8) & 0xFF;
        pixels[offset + 1] = v & 0xFF;
    }

    // ---- Symbol Geometry ----

    private buildSymbols(instances: any[]): void {
        if (!instances || instances.length === 0) return;
        const symbols = this.sch.symbols || {};

        const [sr, sg, sb] = SchematicBoard.COL_SYMBOL;
        const [pr, pg, pb] = SchematicBoard.COL_PIN;
        const lw = SchematicBoard.LINE_WIDTH * this.scaleFactor;
        const hw = lw * 0.5;
        const s = this.scaleFactor;

        // Batch mesh for power symbols and non-morphable instances
        let batchMB = SchematicBoard.newStaticMB();
        let batchVerts = 0;

        for (const inst of instances) {
            const sym = symbols[inst.lib_id];
            if (!sym) continue;

            const ref = inst.ref || '';
            const isPower = ref.startsWith('#PWR') || ref.startsWith('#FLG');
            const ix = inst.pos[0], iy = inst.pos[1];
            const rot = (inst.rot || 0) * Math.PI / 180;
            const cosR = Math.cos(rot), sinR = Math.sin(rot);

            // Per-component SceneObject for morphable instances, batch for power symbols
            const useLocal = !isPower && this.hasMorph;
            let mb: MeshBuilder;
            let totalVerts: number;

            if (useLocal) {
                mb = SchematicBoard.newStaticMB();
                totalVerts = 0;
            } else {
                mb = batchMB;
                totalVerts = batchVerts;
            }

            // xform returns LS-space position:
            // local mode: relative to component origin
            // batch mode: in parent-local space via toLS
            const xform = useLocal
                ? (lx: number, ly: number): vec3 => {
                    const [rx, ry] = this.rotPt(lx, ly, cosR, sinR);
                    return new vec3(rx * s, -ry * s, 0);
                }
                : (lx: number, ly: number): vec3 => {
                    const [rx, ry] = this.rotPt(lx, ly, cosR, sinR);
                    return this.toLS(ix + rx, iy + ry, 0);
                };

            // Render graphic primitives
            if (sym.graphics) {
                for (const g of sym.graphics) {
                    if (g.type === 'polyline' && g.points && g.points.length >= 2) {
                        totalVerts = this.appendPolylineQuads(mb, g.points, xform, hw, sr, sg, sb, totalVerts);
                    } else if (g.type === 'rectangle' && g.start && g.end) {
                        const [x0, y0] = g.start;
                        const [x1, y1] = g.end;
                        const rectPts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
                        totalVerts = this.appendPolylineQuads(mb, rectPts, xform, hw, sr, sg, sb, totalVerts);
                    } else if (g.type === 'circle' && g.center && g.radius) {
                        const segs = 16;
                        const circlePts: number[][] = [];
                        for (let i = 0; i <= segs; i++) {
                            const a = (i / segs) * Math.PI * 2;
                            circlePts.push([
                                g.center[0] + Math.cos(a) * g.radius,
                                g.center[1] + Math.sin(a) * g.radius
                            ]);
                        }
                        totalVerts = this.appendPolylineQuads(mb, circlePts, xform, hw, sr, sg, sb, totalVerts);
                    } else if (g.type === 'arc' && g.start && g.mid && g.end) {
                        const arcPts = [g.start, g.mid, g.end];
                        totalVerts = this.appendPolylineQuads(mb, arcPts, xform, hw, sr, sg, sb, totalVerts);
                    }
                }
            }

            // Render pins
            if (sym.pins) {
                for (const pin of sym.pins) {
                    const px = pin.pos ? pin.pos[0] : 0;
                    const py = pin.pos ? pin.pos[1] : 0;
                    const plen = pin.length || 2.54;
                    const prot = (pin.rot || 0) * Math.PI / 180;

                    const ex = px + Math.cos(prot) * plen;
                    const ey = py + Math.sin(prot) * plen;
                    const pinPts = [[px, py], [ex, ey]];
                    totalVerts = this.appendPolylineQuads(mb, pinPts, xform, hw, pr, pg, pb, totalVerts);

                    // Pin dot at connection end
                    const dotR = SchematicBoard.PIN_DOT_RADIUS * s;
                    const dotSegs = SchematicBoard.PIN_DOT_SEGS;
                    const tipPos = xform(ex, ey);

                    if (totalVerts + dotSegs + 1 < SchematicBoard.VERT_LIMIT) {
                        const center = mb.getVerticesCount();
                        mb.appendVerticesInterleaved([
                            tipPos.x, tipPos.y, tipPos.z, 0, 0, 1, pr, pg, pb, 0
                        ]);
                        for (let di = 0; di < dotSegs; di++) {
                            const a = (di / dotSegs) * Math.PI * 2;
                            mb.appendVerticesInterleaved([
                                tipPos.x + Math.cos(a) * dotR,
                                tipPos.y + Math.sin(a) * dotR,
                                tipPos.z, 0, 0, 1, pr, pg, pb, 0
                            ]);
                        }
                        for (let di = 0; di < dotSegs; di++) {
                            mb.appendIndices([center, center + 1 + di, center + 1 + (di + 1) % dotSegs]);
                        }
                        totalVerts += dotSegs + 1;
                    }
                }
            }

            if (useLocal) {
                // Compute symbol bounding box from graphics+pins (symbol-local coords)
                let smnx = Infinity, smxx = -Infinity, smny = Infinity, smxy = -Infinity;
                if (sym.graphics) {
                    for (const g of sym.graphics) {
                        const pts = g.type === 'polyline' ? g.points :
                            g.type === 'rectangle' ? [g.start, g.end] :
                            g.type === 'arc' ? [g.start, g.mid, g.end] : [];
                        for (const p of (pts || [])) {
                            if (p[0] < smnx) smnx = p[0]; if (p[0] > smxx) smxx = p[0];
                            if (p[1] < smny) smny = p[1]; if (p[1] > smxy) smxy = p[1];
                        }
                        if (g.type === 'circle' && g.center && g.radius) {
                            const cx2 = g.center[0], cy2 = g.center[1], r2 = g.radius;
                            if (cx2-r2 < smnx) smnx = cx2-r2; if (cx2+r2 > smxx) smxx = cx2+r2;
                            if (cy2-r2 < smny) smny = cy2-r2; if (cy2+r2 > smxy) smxy = cy2+r2;
                        }
                    }
                }
                if (sym.pins) {
                    for (const pin of sym.pins) {
                        const px2 = pin.pos ? pin.pos[0] : 0;
                        const py2 = pin.pos ? pin.pos[1] : 0;
                        const plen2 = pin.length || 2.54;
                        const prot2 = (pin.rot || 0) * Math.PI / 180;
                        const ex2 = px2 + Math.cos(prot2) * plen2;
                        const ey2 = py2 + Math.sin(prot2) * plen2;
                        for (const [qx, qy] of [[px2, py2], [ex2, ey2]]) {
                            if (qx < smnx) smnx = qx; if (qx > smxx) smxx = qx;
                            if (qy < smny) smny = qy; if (qy > smxy) smxy = qy;
                        }
                    }
                }
                if (smnx < smxx) {
                    this.symbolBounds.set(ref, {
                        w: smxx - smnx,
                        h: smxy - smny
                    });
                }

                // Per-component SceneObject
                if (totalVerts > 0) {
                    mb.updateMesh();
                    const compObj = global.scene.createSceneObject("__sch_comp_" + ref);
                    compObj.setParent(this.sceneObject);
                    const schPos = this.toLS(ix, iy, 0);
                    compObj.getTransform().setLocalPosition(schPos);
                    const rmv = compObj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
                    rmv.mesh = mb.getMesh();
                    if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;
                    this.symbolObjects.set(ref, compObj);
                    this.schematicPositions.set(ref, schPos);
                    this.groupSymbols.push(compObj);
                    // Compute PCB LS position
                    const pcbPos = this.pcbPositions.get(ref);
                    if (pcbPos) {
                        this.pcbLSPositions.set(ref, this.toPcbLS(pcbPos[0], pcbPos[1], 0));
                    }
                }
            } else {
                batchVerts = totalVerts;
                if (batchVerts > SchematicBoard.VERT_LIMIT - 500) {
                    batchMB.updateMesh();
                    const child = global.scene.createSceneObject("__sch_symbols");
                    child.setParent(this.sceneObject);
                    const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
                    rmv.mesh = batchMB.getMesh();
                    if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;
                    this.groupSymbols.push(child);
                    batchMB = SchematicBoard.newStaticMB();
                    batchVerts = 0;
                }
            }
        }

        // Flush remaining batch
        if (batchVerts > 0) {
            batchMB.updateMesh();
            const child = global.scene.createSceneObject("__sch_symbols");
            child.setParent(this.sceneObject);
            const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            rmv.mesh = batchMB.getMesh();
            if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;
            this.groupSymbols.push(child);
        }

        print("[Schematic] Symbols: " + instances.length + " instances, " +
              this.symbolObjects.size + " morph components, " +
              this.groupSymbols.length + " mesh groups");
    }

    // Append a polyline as flat quad strips (thin line segments on Z=0 plane)
    // xform returns final LS-space position directly
    private appendPolylineQuads(
        mb: MeshBuilder,
        localPts: number[][],
        xform: (lx: number, ly: number) => vec3,
        hw: number, // half-width in LS cm
        r: number, g: number, b: number,
        currentVerts: number
    ): number {
        for (let i = 0; i < localPts.length - 1; i++) {
            if (currentVerts + 4 > SchematicBoard.VERT_LIMIT) break;

            const p0 = xform(localPts[i][0], localPts[i][1]);
            const p1 = xform(localPts[i + 1][0], localPts[i + 1][1]);

            // Direction and perpendicular
            let dx = p1.x - p0.x, dy = p1.y - p0.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 0.0001) continue;
            dx /= len;
            dy /= len;

            // Perpendicular (in XY plane)
            const nx = -dy * hw, ny = dx * hw;

            const base = mb.getVerticesCount();
            mb.appendVerticesInterleaved([
                p0.x + nx, p0.y + ny, p0.z, 0, 0, 1, r, g, b, 0,
                p0.x - nx, p0.y - ny, p0.z, 0, 0, 1, r, g, b, 0,
                p1.x - nx, p1.y - ny, p1.z, 0, 0, 1, r, g, b, 0,
                p1.x + nx, p1.y + ny, p1.z, 0, 0, 1, r, g, b, 0,
            ]);
            mb.appendIndices([base, base + 1, base + 2, base, base + 2, base + 3]);
            currentVerts += 4;
        }
        return currentVerts;
    }

    // ---- Wire Rendering (3D tubes with data texture) ----

    // Chain connected wire segments into continuous polylines.
    // KiCad schematics store wires as individual 2-point segments. When segments
    // share endpoints they form longer paths, but each segment has independent t=[0,1].
    // This causes discontinuities in growth animation and signal flow.
    // Chaining merges connected segments so t is continuous across the full polyline.
    // Returns: array of { points: number[][], sourceWires: number[] }
    // sourceWires maps back to original wire indices for net name / hue lookup.
    // Greedy chain: same approach as KiCadBoard.mergeSegments.
    // Groups wires by net name, then greedily walks through shared endpoints
    // regardless of junction degree. This merges stubs into their parent wires.
    private chainWireSegments(wires: any[]): { points: number[][], sourceWires: number[] }[] {
        const N = wires.length;
        if (N === 0) return [];

        const pk = (p: number[]) => this.posKey(p[0], p[1]);
        const visited = new Set<number>();
        const chains: { points: number[][], sourceWires: number[] }[] = [];

        // Group wires by net name (from wireSemanticNet or wireNetNames)
        const groups: Map<string, number[]> = new Map();
        for (let i = 0; i < N; i++) {
            const net = this.wireSemanticNet[i] || this.wireNetNames[i] || '__unnamed';
            if (!groups.has(net)) groups.set(net, []);
            groups.get(net)!.push(i);
        }

        for (const [, indices] of groups) {
            // Build start-at and end-at maps within this net group
            const startAt: Map<string, number[]> = new Map();
            const endAt: Map<string, number[]> = new Map();
            for (const i of indices) {
                const pts = wires[i].points;
                const sk = pk(pts[0]);
                const ek = pk(pts[pts.length - 1]);
                if (!startAt.has(sk)) startAt.set(sk, []);
                if (!endAt.has(ek)) endAt.set(ek, []);
                startAt.get(sk)!.push(i);
                endAt.get(ek)!.push(i);
            }

            for (const i of indices) {
                if (visited.has(i)) continue;
                visited.add(i);
                const seg = wires[i];
                const sources = [i];

                // Extend forward from seg end
                const forward: number[][] = [];
                let cur = seg.points[seg.points.length - 1];
                while (true) {
                    const ck = pk(cur);
                    let found = false;
                    // Try segments that start here
                    for (const ci of (startAt.get(ck) || [])) {
                        if (!visited.has(ci)) {
                            visited.add(ci);
                            sources.push(ci);
                            const p = wires[ci].points;
                            forward.push(p[p.length - 1]);
                            cur = p[p.length - 1];
                            found = true;
                            break;
                        }
                    }
                    if (found) continue;
                    // Try segments that end here (traverse reversed)
                    for (const ci of (endAt.get(ck) || [])) {
                        if (!visited.has(ci)) {
                            visited.add(ci);
                            sources.push(ci);
                            const p = wires[ci].points;
                            forward.push(p[0]);
                            cur = p[0];
                            found = true;
                            break;
                        }
                    }
                    if (!found) break;
                }

                // Extend backward from seg start
                const backward: number[][] = [];
                cur = seg.points[0];
                while (true) {
                    const ck = pk(cur);
                    let found = false;
                    for (const ci of (endAt.get(ck) || [])) {
                        if (!visited.has(ci)) {
                            visited.add(ci);
                            sources.push(ci);
                            const p = wires[ci].points;
                            backward.push(p[0]);
                            cur = p[0];
                            found = true;
                            break;
                        }
                    }
                    if (found) continue;
                    for (const ci of (startAt.get(ck) || [])) {
                        if (!visited.has(ci)) {
                            visited.add(ci);
                            sources.push(ci);
                            const p = wires[ci].points;
                            backward.push(p[p.length - 1]);
                            cur = p[p.length - 1];
                            found = true;
                            break;
                        }
                    }
                    if (!found) break;
                }

                backward.reverse();
                const pts = [...backward, seg.points[0], seg.points[seg.points.length - 1], ...forward];
                chains.push({ points: pts, sourceWires: sources });
            }
        }

        return chains;
    }

    private buildWires(wires: any[]): void {
        if (!wires || wires.length === 0) return;

        // Chain connected segments into continuous polylines for smooth parametric t
        const chains = this.chainWireSegments(wires);
        const numChains = Math.min(chains.length, SchematicBoard.MAX_WIRES);
        this.wireCount = numChains;
        this.wireGrowths = new Array(numChains).fill(1.0);

        // Build chain-to-net mapping: use the first source wire's net name
        // Also build reverse map: original wire index -> chain index (for flow chapters)
        const chainNetNames: string[] = [];
        const wireToChain: number[] = new Array(wires.length).fill(-1);
        for (let ci = 0; ci < numChains; ci++) {
            const sources = chains[ci].sourceWires;
            let netName = '';
            for (const wi of sources) {
                wireToChain[wi] = ci;
                if (!netName && this.wireNetNames[wi]) netName = this.wireNetNames[wi];
            }
            chainNetNames.push(netName);
        }
        // Update wireNetNames to be per-chain
        this.wireNetNames = chainNetNames;

        // Collapse wireSemanticNet from per-raw-wire to per-chain
        const chainSemanticNet: string[] = [];
        for (let ci = 0; ci < numChains; ci++) {
            let net = '';
            for (const wi of chains[ci].sourceWires) {
                if (!net && this.wireSemanticNet[wi]) net = this.wireSemanticNet[wi];
            }
            chainSemanticNet.push(net);
        }
        this.wireSemanticNet = chainSemanticNet;

        print("[Schematic] Wire chaining: " + wires.length + " segments -> " + numChains + " chains");

        const CIRC = SchematicBoard.RADIAL_SEGS;
        const tubeR = SchematicBoard.WIRE_RADIUS * this.scaleFactor;

        // Precompute circle profile
        const ccos: number[] = [], csin: number[] = [];
        for (let j = 0; j < CIRC; j++) {
            const theta = (j / CIRC) * Math.PI * 2;
            ccos.push(Math.cos(theta));
            csin.push(Math.sin(theta));
        }

        // Clone traceMaterial, create texture
        let wireMat: Material | null = null;
        let wirePass: Pass | null = null;
        if (this.traceMaterial) {
            wireMat = this.traceMaterial.clone();
            wirePass = wireMat.mainPass;
            this.wirePass = wirePass;
            this.createWireTexture(wireMat);
            // Init signal flow (flowTime=0 means disabled; speed/intensity hardcoded in shader)
            try { wirePass["flowTime"] = 0; } catch (e) {}
        }

        let mb = SchematicBoard.newStaticMB();
        let totalVerts = 0;
        let batchIdx = 0;

        const finalizeBatch = () => {
            if (totalVerts === 0) return;
            mb.updateMesh();
            const child = global.scene.createSceneObject("__sch_wires_" + batchIdx);
            child.setParent(this.sceneObject);
            this.groupWires.push(child);
            const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            rmv.mesh = mb.getMesh();
            if (wireMat) rmv.mainMaterial = wireMat;
            batchIdx++;
        };

        const chainArcLens: number[] = new Array(numChains).fill(0);

        for (let ci = 0; ci < numChains; ci++) {
            const chain = chains[ci];
            const origPts = chain.points;

            // Build morph delta keyframes from ORIGINAL points (before smoothing)
            // so position keys match the morphDeltaMap exactly
            const origLS: vec3[] = [];
            for (const p of origPts) origLS.push(this.toLS(p[0], p[1], 0));
            const origCum: number[] = [0];
            for (let i = 1; i < origLS.length; i++) {
                origCum.push(origCum[i - 1] + origLS[i].sub(origLS[i - 1]).length);
            }
            const origArc = origCum[origLS.length - 1];
            const deltaKeys: { t: number, dx: number, dy: number }[] = [];
            for (let i = 0; i < origPts.length; i++) {
                const k = this.posKey(origPts[i][0], origPts[i][1]);
                const d = this.morphDeltaMap.get(k);
                if (d) {
                    const ti = origArc > 0.001 ? origCum[i] / origArc : i / (origPts.length - 1);
                    deltaKeys.push({ t: ti, dx: d.x, dy: d.y });
                }
            }

            // Smooth corners with Bezier arcs, then convert to LS space
            const smoothedRaw = this.smoothPolyline(origPts);
            const pts: vec3[] = [];
            for (const p of smoothedRaw) pts.push(this.toLS(p[0], p[1], 0));
            const N = pts.length;
            if (N < 2) continue;

            // Cap vertices: 2 flat caps (center + CIRC rim each)
            const capVerts = 2 * (CIRC + 1);
            const vertsNeeded = N * CIRC + capVerts;

            if (totalVerts + vertsNeeded > SchematicBoard.VERT_LIMIT && totalVerts > 0) {
                finalizeBatch();
                mb = SchematicBoard.newStaticMB();
                totalVerts = 0;
            }

            // Cumulative arc length for parametric t (on smoothed curve)
            const cumLen: number[] = [0];
            for (let i = 1; i < N; i++) {
                const d = pts[i].sub(pts[i - 1]);
                cumLen.push(cumLen[i - 1] + d.length);
            }
            const arcLen = cumLen[N - 1];
            chainArcLens[ci] = arcLen;

            const base0 = mb.getVerticesCount();
            let startFrame: { tx: number, ty: number, tz: number, rx: number, ry: number, rz: number, bx: number, by: number, bz: number } | null = null;
            let endFrame: typeof startFrame = null;

            // Generate body rings
            for (let pi = 0; pi < N; pi++) {
                const t = arcLen > 0.001 ? cumLen[pi] / arcLen : pi / (N - 1);
                const c = pts[pi];

                // texture1: morph displacement (LS cm). Interpolate between nearest known deltas.
                let mdx = 0, mdy = 0;
                if (deltaKeys.length === 1) {
                    mdx = deltaKeys[0].dx; mdy = deltaKeys[0].dy;
                } else if (deltaKeys.length >= 2) {
                    // Find bracketing keyframes
                    let lo = deltaKeys[0], hi = deltaKeys[deltaKeys.length - 1];
                    for (let di = 0; di < deltaKeys.length - 1; di++) {
                        if (deltaKeys[di].t <= t && deltaKeys[di + 1].t >= t) {
                            lo = deltaKeys[di]; hi = deltaKeys[di + 1];
                            break;
                        }
                    }
                    const span = hi.t - lo.t;
                    const f = span > 0.0001 ? (t - lo.t) / span : 0;
                    mdx = lo.dx * (1 - f) + hi.dx * f;
                    mdy = lo.dy * (1 - f) + hi.dy * f;
                }

                // Tangent
                let ttx: number, tty: number, ttz: number;
                if (pi === 0) {
                    ttx = pts[1].x - pts[0].x; tty = pts[1].y - pts[0].y; ttz = pts[1].z - pts[0].z;
                } else if (pi === N - 1) {
                    ttx = pts[N - 1].x - pts[N - 2].x; tty = pts[N - 1].y - pts[N - 2].y; ttz = pts[N - 1].z - pts[N - 2].z;
                } else {
                    const d1 = pts[pi].sub(pts[pi - 1]);
                    const d2 = pts[pi + 1].sub(pts[pi]);
                    const l1 = d1.length, l2 = d2.length;
                    ttx = (l1 > 0.001 ? d1.x / l1 : 0) + (l2 > 0.001 ? d2.x / l2 : 0);
                    tty = (l1 > 0.001 ? d1.y / l1 : 0) + (l2 > 0.001 ? d2.y / l2 : 0);
                    ttz = (l1 > 0.001 ? d1.z / l1 : 0) + (l2 > 0.001 ? d2.z / l2 : 0);
                }
                const tlen = Math.sqrt(ttx * ttx + tty * tty + ttz * ttz);
                if (tlen > 0.001) { ttx /= tlen; tty /= tlen; ttz /= tlen; }
                else { ttx = 1; tty = 0; ttz = 0; }

                // Construct frame (right, binormal)
                let ux: number, uy: number, uz: number;
                if (Math.abs(ttz) > 0.99) { ux = 1; uy = 0; uz = 0; }
                else { ux = 0; uy = 0; uz = 1; }

                let rx = uy * ttz - uz * tty;
                let ry = uz * ttx - ux * ttz;
                let rz = ux * tty - uy * ttx;
                const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
                if (rlen > 0.001) { rx /= rlen; ry /= rlen; rz /= rlen; }
                else { rx = 0; ry = 1; rz = 0; }

                const bx = tty * rz - ttz * ry;
                const by = ttz * rx - ttx * rz;
                const bz = ttx * ry - tty * rx;

                if (pi === 0) startFrame = { tx: ttx, ty: tty, tz: ttz, rx, ry, rz, bx, by, bz };
                if (pi === N - 1) endFrame = { tx: ttx, ty: tty, tz: ttz, rx, ry, rz, bx, by, bz };

                for (let j = 0; j < CIRC; j++) {
                    const ox = ccos[j] * tubeR * rx + csin[j] * tubeR * bx;
                    const oy = ccos[j] * tubeR * ry + csin[j] * tubeR * by;
                    const oz = ccos[j] * tubeR * rz + csin[j] * tubeR * bz;
                    const nx = ccos[j] * rx + csin[j] * bx;
                    const ny = ccos[j] * ry + csin[j] * by;
                    const nz = ccos[j] * rz + csin[j] * bz;
                    mb.appendVerticesInterleaved([
                        c.x + ox, c.y + oy, c.z + oz,
                        nx, ny, nz,
                        t, ci,
                        mdx, mdy
                    ]);
                }
            }

            // Flat start cap (morph delta from first keyframe or zero)
            const smdx = deltaKeys.length > 0 ? deltaKeys[0].dx : 0;
            const smdy = deltaKeys.length > 0 ? deltaKeys[0].dy : 0;
            const startCapCenter = mb.getVerticesCount();
            if (startFrame) {
                const f = startFrame;
                mb.appendVerticesInterleaved([
                    pts[0].x, pts[0].y, pts[0].z,
                    -f.tx, -f.ty, -f.tz, 0, ci, smdx, smdy
                ]);
                for (let j = 0; j < CIRC; j++) {
                    const ox = ccos[j] * tubeR * f.rx + csin[j] * tubeR * f.bx;
                    const oy = ccos[j] * tubeR * f.ry + csin[j] * tubeR * f.by;
                    const oz = ccos[j] * tubeR * f.rz + csin[j] * tubeR * f.bz;
                    mb.appendVerticesInterleaved([
                        pts[0].x + ox, pts[0].y + oy, pts[0].z + oz,
                        -f.tx, -f.ty, -f.tz, 0, ci, smdx, smdy
                    ]);
                }
            }

            // Flat end cap (morph delta from last keyframe or zero)
            const emdx = deltaKeys.length > 0 ? deltaKeys[deltaKeys.length - 1].dx : 0;
            const emdy = deltaKeys.length > 0 ? deltaKeys[deltaKeys.length - 1].dy : 0;
            const endCapCenter = mb.getVerticesCount();
            if (endFrame) {
                const f = endFrame;
                mb.appendVerticesInterleaved([
                    pts[N - 1].x, pts[N - 1].y, pts[N - 1].z,
                    f.tx, f.ty, f.tz, 1, ci, emdx, emdy
                ]);
                for (let j = 0; j < CIRC; j++) {
                    const ox = ccos[j] * tubeR * f.rx + csin[j] * tubeR * f.bx;
                    const oy = ccos[j] * tubeR * f.ry + csin[j] * tubeR * f.by;
                    const oz = ccos[j] * tubeR * f.rz + csin[j] * tubeR * f.bz;
                    mb.appendVerticesInterleaved([
                        pts[N - 1].x + ox, pts[N - 1].y + oy, pts[N - 1].z + oz,
                        f.tx, f.ty, f.tz, 1, ci, emdx, emdy
                    ]);
                }
            }

            // Body indices
            for (let pi = 0; pi < N - 1; pi++) {
                const rA = base0 + pi * CIRC, rB = base0 + (pi + 1) * CIRC;
                for (let j = 0; j < CIRC; j++) {
                    const j1 = (j + 1) % CIRC;
                    mb.appendIndices([rA + j, rA + j1, rB + j1, rA + j, rB + j1, rB + j]);
                }
            }

            // Start cap indices
            for (let j = 0; j < CIRC; j++) {
                const j1 = (j + 1) % CIRC;
                mb.appendIndices([startCapCenter, startCapCenter + 1 + j1, startCapCenter + 1 + j]);
            }

            // End cap indices
            for (let j = 0; j < CIRC; j++) {
                const j1 = (j + 1) % CIRC;
                mb.appendIndices([endCapCenter, endCapCenter + 1 + j, endCapCenter + 1 + j1]);
            }

            totalVerts += vertsNeeded;
        }

        finalizeBatch();

        // Compute per-chain cumulative offsets for continuous flow through junctions
        const cumOffsets = this.buildNetFlowOffsets(chains, chainArcLens, numChains);

        // Write hues + flow data, then flush
        this.writeWireHues(numChains);
        this.writeWireFlowData(chainArcLens, cumOffsets);
        this.flushWireGrowth();

        print("[Schematic] Wires: " + wires.length + " segments -> " + numChains + " chains, " + batchIdx + " mesh batches");
    }

    // BFS per net: compute cumulative arc-length offset so flow is continuous through junctions.
    // Chains in the same net get offsets such that physDist = t * arcLen + cumOffset
    // is continuous at shared junction points.
    private buildNetFlowOffsets(
        chains: { points: number[][], sourceWires: number[] }[],
        arcLens: number[],
        count: number
    ): number[] {
        const offsets = new Array(count).fill(0);

        // Group chains by net
        const netToChains: Map<string, number[]> = new Map();
        for (let ci = 0; ci < count; ci++) {
            const net = this.wireNetNames[ci] || '';
            if (!net) continue;
            if (!netToChains.has(net)) netToChains.set(net, []);
            netToChains.get(net)!.push(ci);
        }

        for (const [net, chainIds] of netToChains) {
            if (chainIds.length <= 1) continue;

            // Build junction graph: endpoint posKey -> list of { ci, endIdx (0=start, 1=end) }
            const junctions: Map<string, { ci: number, endIdx: number }[]> = new Map();
            for (const ci of chainIds) {
                const pts = chains[ci].points;
                const sKey = this.posKey(pts[0][0], pts[0][1]);
                const eKey = this.posKey(pts[pts.length - 1][0], pts[pts.length - 1][1]);
                if (!junctions.has(sKey)) junctions.set(sKey, []);
                junctions.get(sKey)!.push({ ci, endIdx: 0 });
                if (!junctions.has(eKey)) junctions.set(eKey, []);
                junctions.get(eKey)!.push({ ci, endIdx: 1 });
            }

            // BFS from first chain
            const visited = new Set<number>();
            const queue: { ci: number, offset: number }[] = [{ ci: chainIds[0], offset: 0 }];
            visited.add(chainIds[0]);

            while (queue.length > 0) {
                const { ci, offset } = queue.shift()!;
                offsets[ci] = offset;

                const pts = chains[ci].points;
                const endpoints = [
                    { key: this.posKey(pts[0][0], pts[0][1]), myEnd: 0 },
                    { key: this.posKey(pts[pts.length - 1][0], pts[pts.length - 1][1]), myEnd: 1 }
                ];

                for (const ep of endpoints) {
                    // physDist at this endpoint of current chain
                    const myPhysDist = ep.myEnd === 0 ? offset : offset + arcLens[ci];

                    const neighbors = junctions.get(ep.key) || [];
                    for (const nb of neighbors) {
                        if (visited.has(nb.ci)) continue;
                        visited.add(nb.ci);

                        // If neighbor connects at its start (endIdx=0):
                        //   neighbor physDist at start = 0 * nArcLen + nOffset = nOffset
                        //   want nOffset = myPhysDist
                        // If neighbor connects at its end (endIdx=1):
                        //   neighbor physDist at end = 1 * nArcLen + nOffset = nArcLen + nOffset
                        //   want nArcLen + nOffset = myPhysDist => nOffset = myPhysDist - nArcLen
                        const nOffset = nb.endIdx === 0
                            ? myPhysDist
                            : myPhysDist - arcLens[nb.ci];
                        queue.push({ ci: nb.ci, offset: nOffset });
                    }
                }
            }

            // Shift all offsets for this net to be non-negative
            let minOff = Infinity;
            for (const ci of chainIds) {
                if (offsets[ci] < minOff) minOff = offsets[ci];
            }
            if (minOff < 0) {
                for (const ci of chainIds) offsets[ci] -= minOff;
            }
        }

        return offsets;
    }

    private createWireTexture(mat: Material): void {
        const texH = SchematicBoard.MAX_WIRES;
        const tex = ProceduralTextureProvider.createWithFormat(2, texH, TextureFormat.RGBA8Unorm);
        this.wireTexProvider = tex.control as ProceduralTextureProvider;
        this.wirePixels = new Uint8Array(2 * texH * 4);
        mat.mainPass["traceTex"] = tex;
        mat.mainPass["NumTraces"] = SchematicBoard.MAX_WIRES;
    }

    private writeWireHues(count: number): void {
        if (!this.wirePixels) return;
        for (let i = 0; i < count; i++) {
            const row = i * 8; // 2 pixels per row (2-wide texture)
            // Column 0: growth + hue
            this.encode01(this.wirePixels, row + 0, 1.0); // growth = 1.0
            const netName = this.wireSemanticNet[i] || this.wireNetNames[i] || '';
            const hue = netName ? this.netHue(netName) : 0.6;
            this.encode01(this.wirePixels, row + 2, hue);
            // Column 1 (row + 4): written by writeWireFlowData
        }
    }

    private flushWireGrowth(): void {
        if (!this.wirePixels || !this.wireTexProvider) return;
        for (let i = 0; i < this.wireCount; i++) {
            this.encode01(this.wirePixels, i * 8, Math.max(0, Math.min(1, this.wireGrowths[i])));
        }
        this.wireTexProvider.setPixels(0, 0, 2, SchematicBoard.MAX_WIRES, this.wirePixels);
    }

    // Write arc length and cumulative offset to column 1 of the data texture.
    // These enable length-independent flow that is continuous through junctions.
    private writeWireFlowData(arcLens: number[], cumOffsets: number[]): void {
        if (!this.wirePixels) return;
        for (let i = 0; i < this.wireCount; i++) {
            const col1 = i * 8 + 4; // column 1 of row i
            this.encode01(this.wirePixels, col1 + 0, Math.min(arcLens[i] / 200.0, 1.0));
            this.encode01(this.wirePixels, col1 + 2, Math.min(cumOffsets[i] / 200.0, 1.0));
        }
    }

    // ---- Junction Dots ----

    private buildJunctions(junctions: any[]): void {
        if (!junctions || junctions.length === 0) return;

        const mb = SchematicBoard.newStaticMB();
        const [jr, jg, jb] = SchematicBoard.COL_JUNCTION;
        const dotR = SchematicBoard.JUNCTION_RADIUS * this.scaleFactor;
        const segs = SchematicBoard.JUNCTION_SEGS;

        for (const junc of junctions) {
            const pos = this.toLS(junc[0], junc[1], 0.01); // slightly in front of wires

            const center = mb.getVerticesCount();
            mb.appendVerticesInterleaved([
                pos.x, pos.y, pos.z, 0, 0, 1, jr, jg, jb, 0
            ]);
            for (let i = 0; i < segs; i++) {
                const a = (i / segs) * Math.PI * 2;
                mb.appendVerticesInterleaved([
                    pos.x + Math.cos(a) * dotR,
                    pos.y + Math.sin(a) * dotR,
                    pos.z, 0, 0, 1, jr, jg, jb, 0
                ]);
            }
            for (let i = 0; i < segs; i++) {
                mb.appendIndices([center, center + 1 + i, center + 1 + (i + 1) % segs]);
            }
        }

        mb.updateMesh();
        const child = global.scene.createSceneObject("__sch_junctions");
        child.setParent(this.sceneObject);
        this.groupJunctions = child;
        const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;

        print("[Schematic] Junctions: " + junctions.length);
    }

    // ---- Labels ----

    private buildLabels(instances: any[], labels: any[]): void {
        let count = 0;

        // Instance labels (ref + value)
        for (const inst of instances) {
            const ref = inst.ref || '';
            // Skip power symbols
            if (ref.startsWith('#PWR') || ref.startsWith('#FLG')) continue;
            if (!ref) continue;

            const ix = inst.pos[0], iy = inst.pos[1];
            // Offset label 1mm above in LS Y (which is -1mm in KiCad Y)
            const wp = this.toLS(ix, iy - 1.0, 0.05);

            const labelObj = global.scene.createSceneObject("__sch_lbl_" + ref);
            labelObj.setParent(this.sceneObject);
            labelObj.layer = this.sceneObject.layer;
            this.groupLabels.push(labelObj);
            labelObj.getTransform().setLocalPosition(wp);
            this.instanceLabelObjects.set(ref, labelObj);

            try {
                const text = labelObj.createComponent("Component.Text") as Text;
                text.depthTest = false;
                text.renderOrder = 100;
                const val = inst.value || '';
                text.text = val && val !== ref && !val.includes('*')
                    ? ref + "\n" + val : ref;
                text.size = this.labelSize;
                if (this.labelFont) (text as any).font = this.labelFont;
                text.horizontalAlignment = HorizontalAlignment.Center;
                text.verticalAlignment = VerticalAlignment.Center;
                text.textFill.color = new vec4(0.94, 0.94, 0.91, 1.0);
                count++;
            } catch (e: any) {
                print("[Schematic] Text FAILED for " + ref + ": " + e.message);
            }

            // Tap to inspect: add collider + Interactable
            if (SIK_Interactable) {
                try {
                    const collider = labelObj.createComponent("Physics.ColliderComponent") as any;
                    const shape = Shape.createBoxShape();
                    shape.size = new vec3(8 * this.scaleFactor, 5 * this.scaleFactor, 1);
                    collider.shape = shape;
                    const inter = labelObj.createComponent(SIK_Interactable.getTypeName());
                    const capturedRef = ref;
                    inter.onTriggerStart((_e: any) => { this.selectComponent(capturedRef); });
                } catch (e: any) {}
            }
        }

        // Net labels
        for (const lbl of labels) {
            const name = lbl.name || '';
            if (!name) continue;

            const wp = this.toLS(lbl.pos[0], lbl.pos[1], 0.05);

            const labelObj = global.scene.createSceneObject("__sch_netlbl_" + name);
            labelObj.setParent(this.sceneObject);
            labelObj.layer = this.sceneObject.layer;
            this.groupLabels.push(labelObj);
            labelObj.getTransform().setLocalPosition(wp);

            try {
                const text = labelObj.createComponent("Component.Text") as Text;
                text.depthTest = false;
                text.renderOrder = 100;
                text.text = name;
                text.size = Math.round(this.labelSize * 0.8);
                if (this.labelFont) (text as any).font = this.labelFont;
                text.horizontalAlignment = HorizontalAlignment.Center;
                text.verticalAlignment = VerticalAlignment.Center;
                // Tinted by net hue
                const hue = this.netHue(name);
                const [cr, cg, cb] = SchematicBoard.hsv2rgb(hue, 0.5, 0.95);
                text.textFill.color = new vec4(cr, cg, cb, 1.0);
                count++;
            } catch (e: any) {
                print("[Schematic] Net label FAILED for " + name + ": " + e.message);
            }
        }

        print("[Schematic] Labels: " + count);
    }

    // HSV to RGB (matches trace shader)
    private static hsv2rgb(h: number, s: number, v: number): [number, number, number] {
        const f = (n: number) => {
            const k = (n + h * 6) % 6;
            return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
        };
        return [f(5), f(3), f(1)];
    }

    // ---- Background Panel ----

    private buildBackground(instances: any[], wires: any[]): void {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

        for (const inst of instances) {
            const x = inst.pos[0], y = inst.pos[1];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        for (const wire of wires) {
            for (const pt of wire.points) {
                if (pt[0] < minX) minX = pt[0];
                if (pt[0] > maxX) maxX = pt[0];
                if (pt[1] < minY) minY = pt[1];
                if (pt[1] > maxY) maxY = pt[1];
            }
        }

        if (minX > maxX) return;

        this.schBounds = { minX, maxX, minY, maxY };

        // 5mm padding
        const pad = 5.0;
        minX -= pad; maxX += pad;
        minY -= pad; maxY += pad;

        const [br, bg, bb] = SchematicBoard.COL_BG;
        const bgZ = -0.5; // mm behind geometry

        const mb = SchematicBoard.newStaticMB();
        const p0 = this.toLS(minX, minY, bgZ);
        const p1 = this.toLS(maxX, minY, bgZ);
        const p2 = this.toLS(maxX, maxY, bgZ);
        const p3 = this.toLS(minX, maxY, bgZ);

        const base = mb.getVerticesCount();
        mb.appendVerticesInterleaved([
            p0.x, p0.y, p0.z, 0, 0, 1, br, bg, bb, 0,
            p1.x, p1.y, p1.z, 0, 0, 1, br, bg, bb, 0,
            p2.x, p2.y, p2.z, 0, 0, 1, br, bg, bb, 0,
            p3.x, p3.y, p3.z, 0, 0, 1, br, bg, bb, 0,
        ]);
        mb.appendIndices([base, base + 1, base + 2, base, base + 2, base + 3]);

        mb.updateMesh();
        const child = global.scene.createSceneObject("__sch_bg");
        child.setParent(this.sceneObject);
        this.groupBg = child;
        const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;
    }

    // ---- Destroy + Rebuild ----

    private destroyBoard(): void {
        // Destroy all children of this SceneObject
        var count = this.sceneObject.getChildrenCount();
        for (var i = count - 1; i >= 0; i--) {
            this.sceneObject.getChild(i).destroy();
        }

        // Reset state
        this.sch = null;
        this.wireTexProvider = null;
        this.wirePixels = null;
        this.wireCount = 0;
        this.wireGrowths = [];
        this.wirePass = null;
        this.flowTimer = 0;
        this.flowChapters = [];
        this.flowChapterIdx = 0;
        this.flowStoryActive = false;
        this.chapterPlaying = false;
        this.chapterPauseTimer = 0;
        this.wireNetNames = [];
        this.wireEndpointMap.clear();
        this.componentMap.clear();
        this.selectedRef = null;
        this.calloutGroup = null;
        this.calloutTexProv = null;
        this.calloutPixels = null;
        this.calloutGrowth = 0;
        this.calloutAnimating = false;
        this.chapterLabel = null;
        this.pcbPositions.clear();
        this.pcbFootprintData.clear();
        this.groupSymbols = [];
        this.groupWires = [];
        this.groupJunctions = null;
        this.groupLabels = [];
        this.groupBg = null;
        this.labelPosMap.clear();
        this.hasMorph = false;
        this.prevMorphT = 0;
        this.symbolObjects.clear();
        this.schematicPositions.clear();
        this.pcbLSPositions.clear();
        this.pcbCx = 0;
        this.pcbCy = 0;
        this.pcbExtentW = 0;
        this.pcbExtentH = 0;
        this.pcbMorphScale = 1;
        this.pcbPadWorldPos.clear();
        this.pcbPadNetName.clear();
        this.wireSemanticNet = [];
        this.pcbNetNames.clear();
        this.pcbTraceGroups = [];
        this.pcbTraceTexProv = null;
        this.pcbTracePixels = null;
        this.pcbTraceCount = 0;
        this.pcbTraceGrowths = [];
        this.pcbTracePass = null;
        this.instanceLabelObjects.clear();
        this.sliderKnob = null;
        this.sliderDragging = false;
        this.sliderValueLabel = null;
        this.morphDeltaMap.clear();
        this.symbolBounds.clear();
        this.bridgeGroup = null;
        this.bridgeTexProv = null;
        this.bridgePixels = null;
        this.bridgeCount = 0;
        this.bridgePass = null;

        print("[Schematic] Board destroyed");
    }

    private rebuildBoard(): void {
        this.destroyBoard();

        // Restore source materials (before cloning)
        if (this.srcTraceMaterial) this.traceMaterial = this.srcTraceMaterial;
        if (this.srcBoardMaterial) this.boardMaterial = this.srcBoardMaterial;

        // Re-run build logic (same as onAwake, minus event binding)
        var slug = this.boardSlug || "arduino-nano";
        print("[Schematic] Rebuilding: " + slug);
        var boardModules: Record<string, any> = {
            "arduino-nano": require("Scripts/Board/data/arduino-nano.js"),
            "stickhub-usb": require("Scripts/Board/data/stickhub-usb.js"),
            "rpi-cm4io": require("Scripts/Board/data/rpi-cm4io.js"),
            "attiny85-usb": require("Scripts/Board/data/attiny85-usb.js"),
        };
        var mod = boardModules[slug] || boardModules["arduino-nano"];
        this.schematicData = mod.sch;
        this.pcbData = mod.pcb;

        try {
            this.sch = JSON.parse(this.schematicData);
        } catch (e: any) {
            print("[Schematic] Failed to parse JSON: " + e.message);
            return;
        }

        var instances = this.sch.instances || [];
        var wires = this.sch.wires || [];
        var junctions = this.sch.junctions || [];
        var labels = this.sch.labels || [];

        // Parse PCB data for morph
        var pcbObj: any = null;
        if (this.pcbData && this.pcbData.trim().length > 2) {
            try {
                pcbObj = JSON.parse(this.pcbData);
                if (pcbObj.footprints) {
                    for (var fp of pcbObj.footprints) {
                        var ref = fp.ref || fp.name || '';
                        if (ref) {
                            this.pcbPositions.set(ref, fp.pos);
                            this.pcbFootprintData.set(ref, {
                                rot: fp.rot || 0,
                                layer: fp.layer || 'F.Cu',
                                fpW: fp.fpW || 0,
                                fpH: fp.fpH || 0
                            });
                            var fpRot = (fp.rot || 0) * Math.PI / 180;
                            var cosFp = Math.cos(-fpRot), sinFp = Math.sin(-fpRot);
                            var pads = fp.pads || [];
                            for (var pad of pads) {
                                var pn = pad.n || pad.number || '';
                                if (!pn) continue;
                                var lp = pad.p || pad.pos || [0, 0];
                                var rp = this.rotPt(lp[0], lp[1], cosFp, sinFp);
                                var padKey = ref + ':' + pn;
                                this.pcbPadWorldPos.set(padKey,
                                    [fp.pos[0] + rp[0], fp.pos[1] + rp[1]]);
                                var nn = pad.nn || pad.netName || '';
                                if (nn) this.pcbPadNetName.set(padKey, nn);
                            }
                        }
                    }
                }
                if (pcbObj.nets) {
                    var netKeys = Object.keys(pcbObj.nets) as string[];
                    for (var ki = 0; ki < netKeys.length; ki++) {
                        this.pcbNetNames.set(parseInt(netKeys[ki]), pcbObj.nets[netKeys[ki]] as string);
                    }
                }
                if (pcbObj.board && pcbObj.board.outline && pcbObj.board.outline.length > 0) {
                    var mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
                    for (var p of pcbObj.board.outline) {
                        if (p[0] < mnX) mnX = p[0]; if (p[0] > mxX) mxX = p[0];
                        if (p[1] < mnY) mnY = p[1]; if (p[1] > mxY) mxY = p[1];
                    }
                    this.pcbCx = (mnX + mxX) * 0.5;
                    this.pcbCy = (mnY + mxY) * 0.5;
                    this.pcbExtentW = mxX - mnX;
                    this.pcbExtentH = mxY - mnY;
                    this.hasMorph = true;
                }
            } catch (e: any) {
                print("[Schematic] Failed to parse pcbData: " + e.message);
            }
        }

        this.computeCenter(instances, wires);

        if (this.hasMorph && this.pcbExtentW > 1 && this.pcbExtentH > 1) {
            var schW = this.schBounds.maxX - this.schBounds.minX;
            var schH = this.schBounds.maxY - this.schBounds.minY;
            this.pcbMorphScale = Math.min(schW / this.pcbExtentW, schH / this.pcbExtentH);
        }

        if (this.boardMaterial) {
            this.boardMaterial = this.boardMaterial.clone();
            var pass = this.boardMaterial.mainPass;
            try { pass["boardTime"] = 1.0; } catch (e) {}
        }

        this.buildLabelPosMap(labels);
        this.buildNetTopology(wires, instances, labels);
        if (this.hasMorph) this.buildMorphDeltaMap();
        this.buildBackground(instances, wires);
        this.buildSymbols(instances);
        this.buildWires(wires);
        this.buildJunctions(junctions);
        this.buildLabels(instances, labels);
        if (this.hasMorph && pcbObj && pcbObj.traces) this.buildPcbTraces(pcbObj.traces);
        this.buildComponentMap();
        this.buildFlowStory();
        this.buildChapterUI();
        if (this.hasMorph) {
            this.buildBridgeTubes();
            this.buildMorphSlider();
        }
        if (this.morphSliderObj) this.wireUIKitSlider();

        // Set wires fully grown
        for (var i = 0; i < this.wireCount; i++) {
            this.wireGrowths[i] = 1.0;
        }
        this.flushWireGrowth();

        this.prevBoardSlug = this.boardSlug;
        this.prevScaleFactor = this.scaleFactor;

        print("[Schematic] Rebuild complete: " + slug);
    }

    // ---- Animation (onUpdate) ----

    private onUpdate(): void {
        // Detect input changes that require rebuild
        if (this.prevBoardSlug !== "" && (
            this.boardSlug !== this.prevBoardSlug ||
            this.scaleFactor !== this.prevScaleFactor
        )) {
            this.rebuildBoard();
            return;
        }

        const dt = getDeltaTime();

        // Wire pass uniforms: morphT and flowTime are independent.
        // morphT drives vertex displacement, flowTime drives signal flow pulses.
        if (this.wirePass) {
            if (this.hasMorph) {
                try { this.wirePass["morphT"] = this.morphT; } catch (e) {}
            }
            if (this.signalFlow && this.morphT < 0.001) {
                this.flowTimer += dt;
                try { this.wirePass["flowTime"] = this.flowTimer; } catch (e) {}
                try { this.wirePass["flowSpeed"] = this.flowSpeed; } catch (e) {}
                try { this.wirePass["flowIntensity"] = this.flowIntensity; } catch (e) {}
            }
        }

        // Morph animation: react to morphT slider changes
        if (this.hasMorph && this.morphT !== this.prevMorphT) {
            this.applyMorph(this.morphT);
            this.prevMorphT = this.morphT;
        }

        // Callout tube growth animation
        if (this.calloutAnimating && this.calloutTexProv && this.calloutPixels) {
            this.calloutGrowth = Math.min(1.0, this.calloutGrowth + dt * 3.0);
            this.encode01(this.calloutPixels, 0, this.calloutGrowth);
            this.calloutTexProv.setPixels(0, 0, 1, 1, this.calloutPixels);
            if (this.calloutGrowth >= 1.0) this.calloutAnimating = false;
        }

        // Morph active: skip chapter system (it would overwrite wire growth)
        if (this.hasMorph && this.morphT > 0.001) return;

        if (!this.flowStoryActive) return;

        if (this.chapterPlaying) {
            // Grow current chapter's wires
            this.animTimer += dt;
            const ch = this.flowChapters[this.flowChapterIdx];
            if (!ch) { this.flowStoryActive = false; return; }

            const wireDuration = 0.4;
            const intraDelay = 0.03;
            let allDone = true;
            let needFlush = false;

            for (let wi = 0; wi < ch.wires.length; wi++) {
                const wireIdx = ch.wires[wi];
                const wireStart = wi * intraDelay;
                if (this.animTimer < wireStart) { allDone = false; continue; }

                const elapsed = this.animTimer - wireStart;
                const growth = Math.min(1.0, elapsed / wireDuration);
                if (growth !== this.wireGrowths[wireIdx]) {
                    this.wireGrowths[wireIdx] = growth;
                    needFlush = true;
                }
                if (growth < 1.0) allDone = false;
            }

            if (needFlush) this.flushWireGrowth();

            if (allDone) {
                this.chapterPlaying = false;
                this.chapterPauseTimer = 0;
                print("[Schematic] Chapter " + (this.flowChapterIdx + 1) + "/" +
                      this.flowChapters.length + " done: " + ch.name);
            }
        } else {
            // Paused between chapters: auto-advance after delay
            this.chapterPauseTimer += dt;
            if (this.chapterPauseTimer >= 2.5) {
                if (this.flowChapterIdx < this.flowChapters.length - 1) {
                    this.stepChapter(1);
                } else {
                    this.flowStoryActive = false;
                    print("[Schematic] Flow story complete");
                }
            }
        }
    }

    // ---- Chapter Navigation ----

    private buildChapterUI(): void {
        if (this.flowChapters.length === 0) return;

        // Position below the schematic (maxY in KiCad = bottom in LS)
        const bottomY = this.schBounds.maxY + 12;
        const centerX = (this.schBounds.minX + this.schBounds.maxX) * 0.5;

        // Chapter title
        const titlePos = this.toLS(centerX, bottomY, 0.1);
        const titleObj = global.scene.createSceneObject("__sch_chapter_title");
        titleObj.setParent(this.sceneObject);
        titleObj.layer = this.sceneObject.layer;
        titleObj.getTransform().setLocalPosition(titlePos);

        try {
            const text = titleObj.createComponent("Component.Text") as Text;
            text.text = "";
            text.size = Math.round(this.labelSize * 2);
            text.depthTest = false;
            text.renderOrder = 200;
            text.horizontalAlignment = HorizontalAlignment.Center;
            text.verticalAlignment = VerticalAlignment.Center;
            text.textFill.color = new vec4(1.0, 0.95, 0.8, 1.0);
            if (this.labelFont) (text as any).font = this.labelFont;
            this.chapterLabel = text;
        } catch (e: any) {
            print("[Schematic] Chapter title text failed: " + e.message);
        }

        // Prev / Next buttons
        const btnY = bottomY + 10;
        const btnSpacing = 35;
        this.buildNavButton("< Prev", centerX - btnSpacing, btnY, () => this.stepChapter(-1));
        this.buildNavButton("Next >", centerX + btnSpacing, btnY, () => this.stepChapter(1));
    }

    private buildNavButton(label: string, kx: number, ky: number, callback: () => void): void {
        const pos = this.toLS(kx, ky, 0.05);
        const safeLabel = label.replace(/[^a-zA-Z0-9]/g, '');

        const obj = global.scene.createSceneObject("__sch_btn_" + safeLabel);
        obj.setParent(this.sceneObject);
        obj.layer = this.sceneObject.layer;
        obj.getTransform().setLocalPosition(pos);

        // Button background quad (bright so visible on additive display)
        const btnW = 22 * this.scaleFactor;
        const btnH = 7 * this.scaleFactor;
        const mb = SchematicBoard.newStaticMB();
        const hw = btnW * 0.5, hh = btnH * 0.5;
        const cr = 0.15, cg = 0.25, cb = 0.45;
        mb.appendVerticesInterleaved([
            -hw, -hh, 0,  0, 0, 1,  cr, cg, cb, 1,
             hw, -hh, 0,  0, 0, 1,  cr, cg, cb, 1,
             hw,  hh, 0,  0, 0, 1,  cr, cg, cb, 1,
            -hw,  hh, 0,  0, 0, 1,  cr, cg, cb, 1,
        ]);
        mb.appendIndices([0, 1, 2, 0, 2, 3]);
        mb.updateMesh();

        const rmv = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;

        // Collider + SIK Interactable for tap
        if (SIK_Interactable) {
            try {
                const collider = obj.createComponent("Physics.ColliderComponent") as any;
                const shape = Shape.createBoxShape();
                shape.size = new vec3(btnW, btnH, 1);
                collider.shape = shape;

                const interactable = obj.createComponent(SIK_Interactable.getTypeName());
                interactable.onTriggerStart((_e: any) => { callback(); });
                print("[Schematic] Button interactive: " + label);
            } catch (e: any) {
                print("[Schematic] Button interaction failed for " + label + ": " + e.message);
            }
        }

        // Label text (sibling to avoid scale inheritance)
        const lblObj = global.scene.createSceneObject("__sch_btnlbl_" + safeLabel);
        lblObj.setParent(this.sceneObject);
        lblObj.layer = this.sceneObject.layer;
        lblObj.getTransform().setLocalPosition(pos);

        try {
            const text = lblObj.createComponent("Component.Text") as Text;
            text.text = label;
            text.size = Math.round(this.labelSize * 1.3);
            text.depthTest = false;
            text.renderOrder = 201;
            text.horizontalAlignment = HorizontalAlignment.Center;
            text.verticalAlignment = VerticalAlignment.Center;
            text.textFill.color = new vec4(0.94, 0.94, 0.91, 1.0);
            if (this.labelFont) (text as any).font = this.labelFont;
        } catch (e: any) {
            print("[Schematic] Button label text failed: " + e.message);
        }
    }

    // ---- Morph Slider (runtime drag control) ----

    private buildMorphSlider(): void {
        if (!SIK_Interactable) {
            print("[Schematic] No SIK, skipping morph slider");
            return;
        }

        const s = this.scaleFactor;
        // Position below schematic, below chapter UI
        const bottomY = this.schBounds.maxY + 28;
        const centerX = (this.schBounds.minX + this.schBounds.maxX) * 0.5;
        const trackW = 60 * s; // track width in LS cm
        const trackH = 1.5 * s;
        const knobW = 4 * s;
        const knobH = 5 * s;

        const trackPos = this.toLS(centerX, bottomY, 0.1);
        this.sliderTrackMinX = trackPos.x - trackW * 0.5;
        this.sliderTrackMaxX = trackPos.x + trackW * 0.5;

        // Track background bar
        const trackObj = global.scene.createSceneObject("__sch_morph_track");
        trackObj.setParent(this.sceneObject);
        trackObj.layer = this.sceneObject.layer;
        trackObj.getTransform().setLocalPosition(trackPos);

        const tmb = SchematicBoard.newStaticMB();
        const thw = trackW * 0.5, thh = trackH * 0.5;
        tmb.appendVerticesInterleaved([
            -thw, -thh, 0, 0, 0, 1, 0.20, 0.18, 0.15, 1,
             thw, -thh, 0, 0, 0, 1, 0.20, 0.18, 0.15, 1,
             thw,  thh, 0, 0, 0, 1, 0.20, 0.18, 0.15, 1,
            -thw,  thh, 0, 0, 0, 1, 0.20, 0.18, 0.15, 1,
        ]);
        tmb.appendIndices([0, 1, 2, 0, 2, 3]);
        tmb.updateMesh();
        const trmv = trackObj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        trmv.mesh = tmb.getMesh();
        if (this.boardMaterial) trmv.mainMaterial = this.boardMaterial;

        // Knob (draggable)
        const knob = global.scene.createSceneObject("__sch_morph_knob");
        knob.setParent(this.sceneObject);
        knob.layer = this.sceneObject.layer;
        knob.getTransform().setLocalPosition(new vec3(this.sliderTrackMinX, trackPos.y, trackPos.z + 0.05));
        this.sliderKnob = knob;

        const kmb = SchematicBoard.newStaticMB();
        const khw = knobW * 0.5, khh = knobH * 0.5;
        kmb.appendVerticesInterleaved([
            -khw, -khh, 0, 0, 0, 1, 0.88, 0.55, 0.08, 1,
             khw, -khh, 0, 0, 0, 1, 0.88, 0.55, 0.08, 1,
             khw,  khh, 0, 0, 0, 1, 0.88, 0.55, 0.08, 1,
            -khw,  khh, 0, 0, 0, 1, 0.88, 0.55, 0.08, 1,
        ]);
        kmb.appendIndices([0, 1, 2, 0, 2, 3]);
        kmb.updateMesh();
        const krmv = knob.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        krmv.mesh = kmb.getMesh();
        if (this.boardMaterial) krmv.mainMaterial = this.boardMaterial;

        // Collider + Interactable for drag
        try {
            const collider = knob.createComponent("Physics.ColliderComponent") as any;
            const shape = Shape.createBoxShape();
            shape.size = new vec3(knobW * 2, knobH * 2, 2); // generous hit area
            collider.shape = shape;

            const inter = knob.createComponent(SIK_Interactable.getTypeName());
            inter.enableInstantDrag = true;

            inter.onDragStart.add((_e: any) => {
                this.sliderDragging = true;
            });
            inter.onDragUpdate.add((e: any) => {
                if (!this.sliderKnob) return;
                // Get planecast point in world space, convert to parent local
                const worldPt = e.interactor?.planecastPoint;
                if (!worldPt) return;
                const localPt = this.sceneObject.getTransform().getInvertedWorldTransform().multiplyPoint(worldPt);
                // Clamp X to track range
                const x = Math.max(this.sliderTrackMinX, Math.min(this.sliderTrackMaxX, localPt.x));
                const pos = this.sliderKnob.getTransform().getLocalPosition();
                this.sliderKnob.getTransform().setLocalPosition(new vec3(x, pos.y, pos.z));
                // Map to 0-1
                const t = (x - this.sliderTrackMinX) / (this.sliderTrackMaxX - this.sliderTrackMinX);
                this.morphT = Math.max(0, Math.min(1, t));
                if (this.sliderValueLabel) {
                    this.sliderValueLabel.text = "Morph: " + Math.round(this.morphT * 100) + "%";
                }
            });
            inter.onDragEnd.add((_e: any) => {
                this.sliderDragging = false;
            });

            print("[Schematic] Morph slider built with drag interaction");
        } catch (e: any) {
            print("[Schematic] Morph slider interaction failed: " + e.message);
        }

        // Labels: "Schematic" on left, "PCB" on right, value in center
        const labelY = bottomY + 5;
        for (const [text, kx] of [["Schematic", centerX - 30], ["PCB", centerX + 30]] as [string, number][]) {
            const lbl = global.scene.createSceneObject("__sch_morph_lbl_" + text);
            lbl.setParent(this.sceneObject);
            lbl.layer = this.sceneObject.layer;
            lbl.getTransform().setLocalPosition(this.toLS(kx, labelY, 0.1));
            try {
                const t = lbl.createComponent("Component.Text") as Text;
                t.text = text;
                t.size = Math.round(this.labelSize * 1.2);
                t.depthTest = false;
                t.renderOrder = 200;
                t.horizontalAlignment = HorizontalAlignment.Center;
                t.verticalAlignment = VerticalAlignment.Center;
                t.textFill.color = new vec4(0.94, 0.94, 0.91, 1.0);
                if (this.labelFont) (t as any).font = this.labelFont;
            } catch (e: any) {}
        }

        // Value label
        const valObj = global.scene.createSceneObject("__sch_morph_val");
        valObj.setParent(this.sceneObject);
        valObj.layer = this.sceneObject.layer;
        valObj.getTransform().setLocalPosition(this.toLS(centerX, labelY, 0.1));
        try {
            const t = valObj.createComponent("Component.Text") as Text;
            t.text = "Morph: 0%";
            t.size = Math.round(this.labelSize * 1.0);
            t.depthTest = false;
            t.renderOrder = 200;
            t.horizontalAlignment = HorizontalAlignment.Center;
            t.verticalAlignment = VerticalAlignment.Center;
            t.textFill.color = new vec4(0.88, 0.55, 0.08, 1.0);
            if (this.labelFont) (t as any).font = this.labelFont;
            this.sliderValueLabel = t;
        } catch (e: any) {}
    }

    private wireUIKitSlider(): void {
        try {
            const SliderClass = require("SpectaclesUIKit.lspkg/Scripts/Components/Slider/Slider").Slider;
            const slider = this.morphSliderObj.getComponent(SliderClass.getTypeName());
            if (!slider) {
                print("[Schematic] UIKit Slider component not found on morphSliderObj");
                return;
            }
            slider.onValueChange.add((value: number) => {
                this.morphT = Math.max(0, Math.min(1, value));
                if (this.sliderValueLabel) {
                    this.sliderValueLabel.text = "Morph: " + Math.round(this.morphT * 100) + "%";
                }
            });
            print("[Schematic] UIKit Slider wired to morphT");
        } catch (e: any) {
            print("[Schematic] UIKit Slider wiring failed: " + e.message);
        }
    }

    private stepChapter(delta: number): void {
        const newIdx = this.flowChapterIdx + delta;
        if (newIdx < 0 || newIdx >= this.flowChapters.length) return;

        if (delta < 0) {
            // Going backward: hide wires from current and target chapter
            for (let ci = this.flowChapterIdx; ci >= newIdx; ci--) {
                const ch = this.flowChapters[ci];
                for (const wi of ch.wires) this.wireGrowths[wi] = 0;
            }
            this.flushWireGrowth();
        }

        this.flowChapterIdx = newIdx;
        this.animTimer = 0;
        this.chapterPlaying = true;
        this.flowStoryActive = true;
        this.updateChapterLabel();
        print("[Schematic] Step to chapter " + (newIdx + 1) + ": " + this.flowChapters[newIdx].name);
    }

    private updateChapterLabel(): void {
        if (!this.chapterLabel) return;
        if (this.flowChapterIdx >= this.flowChapters.length) {
            this.chapterLabel.text = "Flow complete";
            return;
        }
        const ch = this.flowChapters[this.flowChapterIdx];
        this.chapterLabel.text = (this.flowChapterIdx + 1) + "/" + this.flowChapters.length + "  " + ch.name;
    }

    // ---- Component Registry ----

    private buildComponentMap(): void {
        const instances = this.sch.instances || [];
        const symbols = this.sch.symbols || {};

        for (const inst of instances) {
            const ref = inst.ref || '';
            if (!ref || ref.startsWith('#')) continue;

            const sym = symbols[inst.lib_id];
            const rot = (inst.rot || 0) * Math.PI / 180;
            const cosR = Math.cos(rot), sinR = Math.sin(rot);

            // Find connected nets via pin tip positions
            const nets: string[] = [];
            if (sym && sym.pins) {
                for (const pin of sym.pins) {
                    const pRad = (pin.rot || 0) * Math.PI / 180;
                    const tipLX = (pin.pos ? pin.pos[0] : 0) + Math.cos(pRad) * (pin.length || 0);
                    const tipLY = (pin.pos ? pin.pos[1] : 0) + Math.sin(pRad) * (pin.length || 0);
                    // Rotate by instance rotation, translate to global
                    const tipGX = tipLX * cosR - tipLY * sinR + inst.pos[0];
                    const tipGY = tipLX * sinR + tipLY * cosR + inst.pos[1];
                    // Lookup wire at this position
                    const key = this.posKey(tipGX, tipGY);
                    const wireIndices = this.wireEndpointMap.get(key);
                    if (wireIndices) {
                        for (const wi of wireIndices) {
                            const netName = this.wireNetNames[wi];
                            if (netName && nets.indexOf(netName) < 0) nets.push(netName);
                        }
                    }
                }
            }

            // PCB data
            const pcbPos = this.pcbPositions.get(ref) || null;
            const pcbFp = this.pcbFootprintData.get(ref);

            this.componentMap.set(ref, {
                ref,
                value: inst.value || '',
                libId: inst.lib_id || '',
                schPos: [inst.pos[0], inst.pos[1]],
                schRot: inst.rot || 0,
                pcbPos: pcbPos ? [pcbPos[0], pcbPos[1]] : null,
                pcbRot: pcbFp ? pcbFp.rot : 0,
                pcbLayer: pcbFp ? pcbFp.layer : '',
                nets,
            });
        }

        const withNets = Array.from(this.componentMap.values()).filter(c => c.nets.length > 0).length;
        print("[Schematic] Component map: " + this.componentMap.size + " components, " +
              withNets + " with net connections");
    }

    // ---- Component Selection + Callout ----

    public selectComponent(ref: string): void {
        if (this.selectedRef === ref) { this.deselectComponent(); return; }
        this.deselectComponent();

        const entry = this.componentMap.get(ref);
        if (!entry) return;
        this.selectedRef = ref;

        // Component anchor on schematic surface
        const anchor = this.toLS(entry.schPos[0], entry.schPos[1], 0.1);

        // Panel floats above the schematic in 3D
        const riseH = 12 * this.scaleFactor;
        const horizOff = 18 * this.scaleFactor;

        // 3D route: component surface -> rise vertically -> horizontal to panel
        const p0x = anchor.x, p0y = anchor.y, p0z = anchor.z;
        const p1x = anchor.x, p1y = anchor.y, p1z = anchor.z + riseH;
        const p2x = anchor.x + horizOff, p2y = anchor.y, p2z = anchor.z + riseH;

        // Create callout group
        const group = global.scene.createSceneObject("__sch_callout");
        group.setParent(this.sceneObject);
        group.layer = this.sceneObject.layer;
        this.calloutGroup = group;

        // 3D tube from component up to floating panel
        this.buildCalloutTube(group,
            [p0x, p0y, p0z], [p1x, p1y, p1z], [p2x, p2y, p2z]);

        // Info panel at end of tube
        this.buildInfoPanel(group, p2x, p2y, p2z, entry);

        print("[Schematic] Selected: " + ref + " (" + entry.value + ") nets: " + entry.nets.join(", "));
    }

    public deselectComponent(): void {
        if (this.calloutGroup) {
            this.calloutGroup.destroy();
            this.calloutGroup = null;
        }
        this.calloutTexProv = null;
        this.calloutPixels = null;
        this.calloutAnimating = false;
        this.selectedRef = null;
    }

    // Build a 3D tube along waypoints using KiCadTraceShader (Tron aesthetic)
    private buildCalloutTube(parent: SceneObject,
        p0: number[], p1: number[], p2: number[]): void {
        const pts = [p0, p1, p2];
        const SEGS = 6;
        const R = 0.12 * this.scaleFactor;
        const N = pts.length;

        // Arc lengths for parametric t
        const arcLen: number[] = [0];
        for (let i = 1; i < N; i++) {
            const dx = pts[i][0] - pts[i - 1][0];
            const dy = pts[i][1] - pts[i - 1][1];
            const dz = pts[i][2] - pts[i - 1][2];
            arcLen.push(arcLen[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        const totalLen = arcLen[N - 1] || 1;

        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
            { name: "texture1", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;

        // Build tube rings at each waypoint
        for (let pi = 0; pi < N; pi++) {
            const px = pts[pi][0], py = pts[pi][1], pz = pts[pi][2];
            const t = arcLen[pi] / totalLen;

            // Tangent direction
            let tdx: number, tdy: number, tdz: number;
            if (pi < N - 1) {
                tdx = pts[pi + 1][0] - px;
                tdy = pts[pi + 1][1] - py;
                tdz = pts[pi + 1][2] - pz;
            } else {
                tdx = px - pts[pi - 1][0];
                tdy = py - pts[pi - 1][1];
                tdz = pz - pts[pi - 1][2];
            }
            const tLen = Math.sqrt(tdx * tdx + tdy * tdy + tdz * tdz) || 1;
            tdx /= tLen; tdy /= tLen; tdz /= tLen;

            // Perpendicular frame
            let ux = 0, uy = 1, uz = 0;
            if (Math.abs(tdx * ux + tdy * uy + tdz * uz) > 0.95) { ux = 1; uy = 0; }
            // right = tangent x up
            let rx = tdy * uz - tdz * uy;
            let ry = tdz * ux - tdx * uz;
            let rz = tdx * uy - tdy * ux;
            const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
            rx /= rLen; ry /= rLen; rz /= rLen;
            // binormal = tangent x right
            const bx = tdy * rz - tdz * ry;
            const by = tdz * rx - tdx * rz;
            const bz = tdx * ry - tdy * rx;

            for (let j = 0; j < SEGS; j++) {
                const a = (j / SEGS) * Math.PI * 2;
                const cs = Math.cos(a), sn = Math.sin(a);
                const ox = rx * cs * R + bx * sn * R;
                const oy = ry * cs * R + by * sn * R;
                const oz = rz * cs * R + bz * sn * R;
                mb.appendVerticesInterleaved([
                    px + ox, py + oy, pz + oz,
                    rx * cs + bx * sn, ry * cs + by * sn, rz * cs + bz * sn,
                    t, 0,  // UV: parametric t, traceIdx=0
                    0, 0
                ]);
            }
        }

        // Connect rings
        for (let pi = 0; pi < N - 1; pi++) {
            const rA = pi * SEGS, rB = (pi + 1) * SEGS;
            for (let j = 0; j < SEGS; j++) {
                const j1 = (j + 1) % SEGS;
                mb.appendIndices([rA + j, rA + j1, rB + j1, rA + j, rB + j1, rB + j]);
            }
        }
        mb.updateMesh();

        const obj = global.scene.createSceneObject("__callout_tube");
        obj.setParent(parent);
        obj.layer = parent.layer;
        const rmv = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();

        // Clone trace material with own 1-pixel data texture for growth anim
        if (this.traceMaterial) {
            const mat = this.traceMaterial.clone();
            const tex = ProceduralTextureProvider.createWithFormat(1, 1, TextureFormat.RGBA8Unorm);
            const prov = tex.control as ProceduralTextureProvider;
            const pixels = new Uint8Array(4);
            this.encode01(pixels, 0, 0.0);  // growth starts at 0
            this.encode01(pixels, 2, 0.08); // hue = amber
            prov.setPixels(0, 0, 1, 1, pixels);
            mat.mainPass["traceTex"] = tex;
            mat.mainPass["NumTraces"] = 1;
            try { mat.mainPass["flowTime"] = 0; } catch (e) {}
            rmv.mainMaterial = mat;

            // Store for growth animation
            this.calloutTexProv = prov;
            this.calloutPixels = pixels;
            this.calloutGrowth = 0;
            this.calloutAnimating = true;
        }
    }

    private buildInfoPanel(parent: SceneObject,
        cx: number, cy: number, cz: number, entry: any): void {
        const panelW = 28 * this.scaleFactor;
        const panelH = 14 * this.scaleFactor;
        const hw = panelW * 0.5, hh = panelH * 0.5;

        // Panel with amber border frame
        const mb = SchematicBoard.newStaticMB();
        const bw = 0.3 * this.scaleFactor;
        // Border
        mb.appendVerticesInterleaved([
            -hw - bw, -hh - bw, 0, 0, 0, 1, 0.88, 0.55, 0.08, 1,
             hw + bw, -hh - bw, 0, 0, 0, 1, 0.88, 0.55, 0.08, 1,
             hw + bw,  hh + bw, 0, 0, 0, 1, 0.88, 0.55, 0.08, 1,
            -hw - bw,  hh + bw, 0, 0, 0, 1, 0.88, 0.55, 0.08, 1,
        ]);
        mb.appendIndices([0, 1, 2, 0, 2, 3]);
        // Fill
        mb.appendVerticesInterleaved([
            -hw, -hh, 0.01, 0, 0, 1, 0.14, 0.12, 0.10, 1,
             hw, -hh, 0.01, 0, 0, 1, 0.14, 0.12, 0.10, 1,
             hw,  hh, 0.01, 0, 0, 1, 0.14, 0.12, 0.10, 1,
            -hw,  hh, 0.01, 0, 0, 1, 0.14, 0.12, 0.10, 1,
        ]);
        mb.appendIndices([4, 5, 6, 4, 6, 7]);
        mb.updateMesh();

        const panelObj = global.scene.createSceneObject("__callout_panel");
        panelObj.setParent(parent);
        panelObj.layer = parent.layer;
        panelObj.getTransform().setLocalPosition(new vec3(cx, cy, cz));
        const rmv = panelObj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;

        // Text floats in front of panel
        const txtObj = global.scene.createSceneObject("__callout_text");
        txtObj.setParent(parent);
        txtObj.layer = parent.layer;
        txtObj.getTransform().setLocalPosition(new vec3(cx, cy, cz + 0.1));

        try {
            const text = txtObj.createComponent("Component.Text") as Text;
            text.depthTest = false;
            text.renderOrder = 300;
            text.size = Math.round(this.labelSize * 0.85);
            text.horizontalAlignment = HorizontalAlignment.Center;
            text.verticalAlignment = VerticalAlignment.Center;
            text.textFill.color = new vec4(0.94, 0.94, 0.91, 1.0);
            if (this.labelFont) (text as any).font = this.labelFont;

            const desc = this.componentDescription(entry);
            const netsStr = entry.nets.length > 0
                ? "\nConnected: " + entry.nets.join(", ") : "";
            text.text = entry.ref + "  " + entry.value + "\n" + desc + netsStr;
        } catch (e: any) {
            print("[Schematic] Callout text failed: " + e.message);
        }
    }

    private componentDescription(entry: any): string {
        const lid = (entry.libId || '').toLowerCase();
        const val = entry.value || '';
        const nets: string[] = entry.nets || [];

        // Resistors
        if (lid.includes(':r_') || lid.includes(':r ')) {
            if (nets.some((n: string) => n === 'GND')) return "Pull-down resistor";
            if (nets.some((n: string) => n.includes('+') || n.includes('VCC'))) return "Pull-up resistor";
            return "Limits current flow (" + val + ")";
        }
        // Capacitors
        if (lid.includes(':c_') || lid.includes(':c ') || lid.includes('polarized')) {
            if (val.includes('100n') || val.includes('0.1u')) return "Decoupling cap: smooths power noise";
            if (val.includes('10u') || val.includes('22u') || val.includes('47u')) return "Bulk cap: stores energy for load spikes";
            return "Capacitor: filters voltage ripple";
        }
        // LEDs
        if (lid.includes('led')) return "LED indicator";
        // Diodes
        if (lid.includes('diode') || lid.includes(':d_')) return "Diode: allows current one way only";
        // Voltage regulators
        if (lid.includes('ams1117') || lid.includes('ldo') || lid.includes('regulator')) {
            return "Voltage regulator: steps down to " + val;
        }
        // RS485 / UART transceiver
        if (lid.includes('max485') || lid.includes('rs485') || lid.includes('sp3485')) {
            return "RS485 transceiver: serial to differential pair";
        }
        // Connectors
        if (lid.includes('conn') || lid.includes('header') || lid.includes('usb') || lid.includes('jack')) {
            return "Connector: external interface";
        }
        // Crystal / oscillator
        if (lid.includes('crystal') || lid.includes('osc')) return "Crystal: provides clock signal";
        // IC / microcontroller
        if (lid.includes('mcu') || lid.includes('xiao') || lid.includes('esp') || lid.includes('stm')) {
            return "Microcontroller: the brain";
        }
        // Inductor
        if (lid.includes('inductor') || lid.includes(':l_')) return "Inductor: smooths current changes";
        // Transistor / MOSFET
        if (lid.includes('mosfet') || lid.includes('transistor') || lid.includes(':q_')) {
            return "Switch: controls current flow electronically";
        }
        // Fallback: show the library name
        const parts = (entry.libId || '').split(':');
        return parts.length > 1 ? parts[1] : entry.libId;
    }

    // ---- PCB Trace Helpers (ported from KiCadBoard.ts) ----

    private mergeSegments(segments: { start: number[], end: number[], width: number, net: number }[]):
        { points: number[][], width: number, net: number }[] {

        const K = 1000; // 0.001mm grid
        const key = (p: number[]) => Math.round(p[0] * K) + ',' + Math.round(p[1] * K);
        const visited = new Set<number>();
        const polylines: { points: number[][], width: number, net: number }[] = [];

        // Group by net+width
        const groups: Map<string, number[]> = new Map();
        for (let i = 0; i < segments.length; i++) {
            const gk = segments[i].net + ':' + segments[i].width;
            if (!groups.has(gk)) groups.set(gk, []);
            groups.get(gk)!.push(i);
        }

        for (const [, indices] of groups) {
            const startAt: Map<string, number[]> = new Map();
            const endAt: Map<string, number[]> = new Map();
            for (const i of indices) {
                const sk = key(segments[i].start);
                const ek = key(segments[i].end);
                if (!startAt.has(sk)) startAt.set(sk, []);
                if (!endAt.has(ek)) endAt.set(ek, []);
                startAt.get(sk)!.push(i);
                endAt.get(ek)!.push(i);
            }

            for (const i of indices) {
                if (visited.has(i)) continue;
                visited.add(i);
                const seg = segments[i];

                const forward: number[][] = [];
                let cur = seg.end;
                while (true) {
                    const ck = key(cur);
                    let found = false;
                    for (const ci of (startAt.get(ck) || [])) {
                        if (!visited.has(ci)) {
                            visited.add(ci);
                            forward.push(segments[ci].end);
                            cur = segments[ci].end;
                            found = true;
                            break;
                        }
                    }
                    if (found) continue;
                    for (const ci of (endAt.get(ck) || [])) {
                        if (!visited.has(ci)) {
                            visited.add(ci);
                            forward.push(segments[ci].start);
                            cur = segments[ci].start;
                            found = true;
                            break;
                        }
                    }
                    if (!found) break;
                }

                const backward: number[][] = [];
                cur = seg.start;
                while (true) {
                    const ck = key(cur);
                    let found = false;
                    for (const ci of (endAt.get(ck) || [])) {
                        if (!visited.has(ci)) {
                            visited.add(ci);
                            backward.push(segments[ci].start);
                            cur = segments[ci].start;
                            found = true;
                            break;
                        }
                    }
                    if (found) continue;
                    for (const ci of (startAt.get(ck) || [])) {
                        if (!visited.has(ci)) {
                            visited.add(ci);
                            backward.push(segments[ci].end);
                            cur = segments[ci].end;
                            found = true;
                            break;
                        }
                    }
                    if (!found) break;
                }

                backward.reverse();
                polylines.push({
                    points: [...backward, seg.start, seg.end, ...forward],
                    width: seg.width,
                    net: seg.net
                });
            }
        }

        return polylines;
    }

    private smoothPolyline(pts: number[][]): number[][] {
        if (pts.length <= 2) return pts;
        const result: number[][] = [pts[0]];
        for (let i = 1; i < pts.length - 1; i++) {
            const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
            const dx1 = cur[0] - prev[0], dy1 = cur[1] - prev[1];
            const dx2 = next[0] - cur[0], dy2 = next[1] - cur[1];
            const l1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
            const l2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
            if (l1 < 0.001 || l2 < 0.001) { result.push(cur); continue; }
            const dot = (dx1 * dx2 + dy1 * dy2) / (l1 * l2);
            if (dot > 0.95) {
                result.push(cur);
            } else {
                const d = Math.min(l1, l2) * 0.35;
                const p0x = cur[0] - dx1 / l1 * d, p0y = cur[1] - dy1 / l1 * d;
                const p2x = cur[0] + dx2 / l2 * d, p2y = cur[1] + dy2 / l2 * d;
                result.push([p0x, p0y]);
                const steps = dot < 0 ? 4 : 3;
                for (let si = 1; si < steps; si++) {
                    const t = si / steps;
                    const u = 1 - t;
                    result.push([
                        u * u * p0x + 2 * u * t * cur[0] + t * t * p2x,
                        u * u * p0y + 2 * u * t * cur[1] + t * t * p2y
                    ]);
                }
                result.push([p2x, p2y]);
            }
        }
        result.push(pts[pts.length - 1]);
        return result;
    }

    // ---- PCB Trace Rendering ----

    private buildPcbTraces(traces: any[]): void {
        if (!traces || traces.length === 0) return;

        // Collect segments from all layers into one set (morph flattens layers)
        const segments: { start: number[], end: number[], width: number, net: number }[] = [];
        for (const t of traces) {
            const pts = t.points;
            for (let i = 0; i < pts.length - 1; i++) {
                segments.push({ start: pts[i], end: pts[i + 1], width: t.width, net: t.net });
            }
        }

        const polylines = this.mergeSegments(segments);
        const numTraces = Math.min(polylines.length, SchematicBoard.MAX_WIRES);
        this.pcbTraceCount = numTraces;
        this.pcbTraceGrowths = new Array(numTraces).fill(0);

        // Smooth polylines
        const smoothed = polylines.map(p => ({
            points: this.smoothPolyline(p.points),
            width: p.width,
            net: p.net
        }));

        // Clone trace material, create data texture
        let traceMat: Material | null = null;
        if (this.traceMaterial) {
            traceMat = this.traceMaterial.clone();
            this.pcbTracePass = traceMat.mainPass;
            const texH = SchematicBoard.MAX_WIRES;
            const tex = ProceduralTextureProvider.createWithFormat(2, texH, TextureFormat.RGBA8Unorm);
            this.pcbTraceTexProv = tex.control as ProceduralTextureProvider;
            this.pcbTracePixels = new Uint8Array(2 * texH * 4);
            traceMat.mainPass["traceTex"] = tex;
            traceMat.mainPass["NumTraces"] = SchematicBoard.MAX_WIRES;
            try { traceMat.mainPass["flowTime"] = 0; } catch (e) {}

            // Write hues (growth=0, hue from net name) + default flow data
            for (let i = 0; i < numTraces; i++) {
                const row = i * 8; // 2 pixels per row
                // Column 0: growth + hue
                this.encode01(this.pcbTracePixels, row + 0, 0);
                const netName = this.pcbNetNames.get(polylines[i].net) || '';
                const hue = netName ? this.netHue(netName) : 0.6;
                this.encode01(this.pcbTracePixels, row + 2, hue);
                // Column 1: arcLen=1cm default, cumOffset=0 (PCB traces don't use flow)
                this.encode01(this.pcbTracePixels, row + 4, 1.0 / 200.0);
                this.encode01(this.pcbTracePixels, row + 6, 0);
            }
            this.pcbTraceTexProv.setPixels(0, 0, 2, texH, this.pcbTracePixels);
        }

        // Build tube meshes
        const CIRC = SchematicBoard.RADIAL_SEGS;
        const ccos: number[] = [], csin: number[] = [];
        for (let j = 0; j < CIRC; j++) {
            const theta = (j / CIRC) * Math.PI * 2;
            ccos.push(Math.cos(theta));
            csin.push(Math.sin(theta));
        }

        let mb = SchematicBoard.newStaticMB();
        let totalVerts = 0;
        let batchIdx = 0;

        const finalizeBatch = (): void => {
            if (totalVerts === 0) return;
            mb.updateMesh();
            const child = global.scene.createSceneObject("__pcb_traces_" + batchIdx);
            child.setParent(this.sceneObject);
            child.enabled = false; // hidden at morphT=0
            this.pcbTraceGroups.push(child);
            const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            rmv.mesh = mb.getMesh();
            if (traceMat) rmv.mainMaterial = traceMat;
            batchIdx++;
        };

        for (let ti = 0; ti < numTraces; ti++) {
            const poly = smoothed[ti];
            const tubeR = poly.width * 0.5 * this.scaleFactor;

            const pts: vec3[] = [];
            for (const p of poly.points) {
                pts.push(this.toPcbLS(p[0], p[1], 0.05));
            }
            const N = pts.length;
            if (N < 2) continue;

            const capVerts = 2 * (CIRC + 1);
            const vertsNeeded = N * CIRC + capVerts;

            if (totalVerts + vertsNeeded > SchematicBoard.VERT_LIMIT && totalVerts > 0) {
                finalizeBatch();
                mb = SchematicBoard.newStaticMB();
                totalVerts = 0;
            }

            // Cumulative arc length for parametric t
            const cumLen: number[] = [0];
            for (let i = 1; i < N; i++) {
                const d = pts[i].sub(pts[i - 1]);
                cumLen.push(cumLen[i - 1] + d.length);
            }
            const arcLen = cumLen[N - 1];

            const base0 = mb.getVerticesCount();
            let startFrame: any = null;
            let endFrame: any = null;

            // Body rings
            for (let pi = 0; pi < N; pi++) {
                const t = arcLen > 0.001 ? cumLen[pi] / arcLen : pi / (N - 1);
                const c = pts[pi];

                let ttx: number, tty: number, ttz: number;
                if (pi === 0) {
                    ttx = pts[1].x - pts[0].x; tty = pts[1].y - pts[0].y; ttz = pts[1].z - pts[0].z;
                } else if (pi === N - 1) {
                    ttx = pts[N - 1].x - pts[N - 2].x; tty = pts[N - 1].y - pts[N - 2].y; ttz = pts[N - 1].z - pts[N - 2].z;
                } else {
                    const d1 = pts[pi].sub(pts[pi - 1]);
                    const d2 = pts[pi + 1].sub(pts[pi]);
                    const l1 = d1.length, l2 = d2.length;
                    ttx = (l1 > 0.001 ? d1.x / l1 : 0) + (l2 > 0.001 ? d2.x / l2 : 0);
                    tty = (l1 > 0.001 ? d1.y / l1 : 0) + (l2 > 0.001 ? d2.y / l2 : 0);
                    ttz = (l1 > 0.001 ? d1.z / l1 : 0) + (l2 > 0.001 ? d2.z / l2 : 0);
                }
                const tlen = Math.sqrt(ttx * ttx + tty * tty + ttz * ttz);
                if (tlen > 0.001) { ttx /= tlen; tty /= tlen; ttz /= tlen; }
                else { ttx = 1; tty = 0; ttz = 0; }

                let ux: number, uy: number, uz: number;
                if (Math.abs(ttz) > 0.99) { ux = 1; uy = 0; uz = 0; }
                else { ux = 0; uy = 0; uz = 1; }

                let rx = uy * ttz - uz * tty;
                let ry = uz * ttx - ux * ttz;
                let rz = ux * tty - uy * ttx;
                const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
                if (rlen > 0.001) { rx /= rlen; ry /= rlen; rz /= rlen; }
                else { rx = 0; ry = 1; rz = 0; }

                const bx = tty * rz - ttz * ry;
                const by = ttz * rx - ttx * rz;
                const bz = ttx * ry - tty * rx;

                if (pi === 0) startFrame = { tx: ttx, ty: tty, tz: ttz, rx, ry, rz, bx, by, bz };
                if (pi === N - 1) endFrame = { tx: ttx, ty: tty, tz: ttz, rx, ry, rz, bx, by, bz };

                for (let j = 0; j < CIRC; j++) {
                    const ox = ccos[j] * tubeR * rx + csin[j] * tubeR * bx;
                    const oy = ccos[j] * tubeR * ry + csin[j] * tubeR * by;
                    const oz = ccos[j] * tubeR * rz + csin[j] * tubeR * bz;
                    const nx = ccos[j] * rx + csin[j] * bx;
                    const ny = ccos[j] * ry + csin[j] * by;
                    const nz = ccos[j] * rz + csin[j] * bz;
                    mb.appendVerticesInterleaved([
                        c.x + ox, c.y + oy, c.z + oz,
                        nx, ny, nz,
                        t, ti,
                        0, 0
                    ]);
                }
            }

            // Start cap
            const startCapCenter = mb.getVerticesCount();
            if (startFrame) {
                const f = startFrame;
                mb.appendVerticesInterleaved([
                    pts[0].x, pts[0].y, pts[0].z, -f.tx, -f.ty, -f.tz, 0, ti, 0, 0
                ]);
                for (let j = 0; j < CIRC; j++) {
                    const ox = ccos[j] * tubeR * f.rx + csin[j] * tubeR * f.bx;
                    const oy = ccos[j] * tubeR * f.ry + csin[j] * tubeR * f.by;
                    const oz = ccos[j] * tubeR * f.rz + csin[j] * tubeR * f.bz;
                    mb.appendVerticesInterleaved([
                        pts[0].x + ox, pts[0].y + oy, pts[0].z + oz,
                        -f.tx, -f.ty, -f.tz, 0, ti, 0, 0
                    ]);
                }
            }

            // End cap
            const endCapCenter = mb.getVerticesCount();
            if (endFrame) {
                const f = endFrame;
                mb.appendVerticesInterleaved([
                    pts[N - 1].x, pts[N - 1].y, pts[N - 1].z, f.tx, f.ty, f.tz, 1, ti, 0, 0
                ]);
                for (let j = 0; j < CIRC; j++) {
                    const ox = ccos[j] * tubeR * f.rx + csin[j] * tubeR * f.bx;
                    const oy = ccos[j] * tubeR * f.ry + csin[j] * tubeR * f.by;
                    const oz = ccos[j] * tubeR * f.rz + csin[j] * tubeR * f.bz;
                    mb.appendVerticesInterleaved([
                        pts[N - 1].x + ox, pts[N - 1].y + oy, pts[N - 1].z + oz,
                        f.tx, f.ty, f.tz, 1, ti, 0, 0
                    ]);
                }
            }

            // Body indices
            for (let pi = 0; pi < N - 1; pi++) {
                const rA = base0 + pi * CIRC, rB = base0 + (pi + 1) * CIRC;
                for (let j = 0; j < CIRC; j++) {
                    const j1 = (j + 1) % CIRC;
                    mb.appendIndices([rA + j, rA + j1, rB + j1, rA + j, rB + j1, rB + j]);
                }
            }

            // Cap indices
            for (let j = 0; j < CIRC; j++) {
                const j1 = (j + 1) % CIRC;
                mb.appendIndices([startCapCenter, startCapCenter + 1 + j1, startCapCenter + 1 + j]);
            }
            for (let j = 0; j < CIRC; j++) {
                const j1 = (j + 1) % CIRC;
                mb.appendIndices([endCapCenter, endCapCenter + 1 + j, endCapCenter + 1 + j1]);
            }

            totalVerts += vertsNeeded;
        }

        finalizeBatch();
        print("[Schematic] PCB traces: " + numTraces + " polylines, " + batchIdx + " batches");
    }

    private flushPcbTraceGrowth(): void {
        if (!this.pcbTracePixels || !this.pcbTraceTexProv) return;
        for (let i = 0; i < this.pcbTraceCount; i++) {
            this.encode01(this.pcbTracePixels, i * 8, Math.max(0, Math.min(1, this.pcbTraceGrowths[i])));
        }
        this.pcbTraceTexProv.setPixels(0, 0, 2, SchematicBoard.MAX_WIRES, this.pcbTracePixels);
    }

    // ---- Morph Controller ----

    private applyMorph(t: number): void {
        if (!this.hasMorph) return;

        // Component position lerp + rotation interpolation + anisotropic deformation
        for (const [ref, obj] of this.symbolObjects) {
            const schPos = this.schematicPositions.get(ref);
            const pcbPos = this.pcbLSPositions.get(ref);
            if (!schPos) continue;
            if (pcbPos) {
                obj.getTransform().setLocalPosition(new vec3(
                    schPos.x + (pcbPos.x - schPos.x) * t,
                    schPos.y + (pcbPos.y - schPos.y) * t,
                    schPos.z + (pcbPos.z - schPos.z) * t
                ));

                // Rotation interpolation: schematic rot is baked in geometry,
                // apply delta (pcbRot - schRot) via SceneObject Z-rotation.
                // Negated because Y-flip inverts rotation direction.
                const fpD = this.pcbFootprintData.get(ref);
                const compData = this.componentMap.get(ref);
                if (fpD && compData) {
                    const schRot = compData.schRot || 0;
                    let deltaRot = fpD.rot - schRot;
                    // Shortest path: normalize to [-180, 180]
                    while (deltaRot > 180) deltaRot -= 360;
                    while (deltaRot < -180) deltaRot += 360;
                    const zRad = -deltaRot * (Math.PI / 180) * t;
                    obj.getTransform().setLocalRotation(quat.fromEulerAngles(0, 0, zRad));
                }

                // Anisotropic scale: deform symbol to match PCB footprint proportions
                const symB = this.symbolBounds.get(ref);
                if (symB && fpD && symB.w > 0.1 && symB.h > 0.1 && fpD.fpW > 0.1 && fpD.fpH > 0.1) {
                    const scX = 1.0 + (fpD.fpW / symB.w - 1.0) * t;
                    const scY = 1.0 + (fpD.fpH / symB.h - 1.0) * t;
                    obj.getTransform().setLocalScale(new vec3(scX, scY, 1));
                } else {
                    obj.getTransform().setLocalScale(new vec3(1, 1, 1));
                }
            }
        }

        // Labels follow their components
        for (const [ref, labelObj] of this.instanceLabelObjects) {
            const compObj = this.symbolObjects.get(ref);
            if (compObj) {
                const pos = compObj.getTransform().getLocalPosition();
                labelObj.getTransform().setLocalPosition(new vec3(
                    pos.x, pos.y + 1.0 * this.scaleFactor, pos.z + 0.05 * this.scaleFactor
                ));
                // Fade labels out mid-morph, back in at end
                labelObj.enabled = t < 0.25 || t > 0.8;
            }
        }

        // Vertex deformation: schematic wires stay visible, shader displaces via texture1 UVs.
        // morphT uniform is set in onUpdate() every frame.
        for (const obj of this.groupWires) obj.enabled = true;

        // Ensure all wires fully grown during morph
        if (this.wirePixels && this.wireTexProvider) {
            let needFlush = false;
            for (let i = 0; i < this.wireCount; i++) {
                if (this.wireGrowths[i] < 0.99) {
                    this.wireGrowths[i] = 1.0;
                    needFlush = true;
                }
            }
            if (needFlush) this.flushWireGrowth();
        }

        // PCB traces hidden (schematic wires ARE the morphing geometry)
        for (const obj of this.pcbTraceGroups) obj.enabled = false;

        // Background and junctions fade out early
        if (this.groupBg) this.groupBg.enabled = t < 0.2;
        if (this.groupJunctions) this.groupJunctions.enabled = t < 0.3;

        // Bridge tubes: visible during the transition, grow with morphT
        if (this.bridgeGroup && this.bridgeTexProv && this.bridgePixels) {
            const bridgeVis = t > 0.05 && t < 0.95;
            this.bridgeGroup.enabled = bridgeVis;
            if (bridgeVis) {
                // Tubes grow to full at t=0.5, then hold
                const bridgeGrowth = Math.min(1.0, t * 2.0);
                for (let i = 0; i < this.bridgeCount; i++) {
                    this.encode01(this.bridgePixels, i * 8, bridgeGrowth);
                }
                this.bridgeTexProv.setPixels(0, 0, 2, SchematicBoard.MAX_WIRES, this.bridgePixels);
            }
        }
    }

    // ---- Public API ----

    public setAllGrowth(growth: number): void {
        const g = Math.max(0, Math.min(1, growth));
        for (let i = 0; i < this.wireCount; i++) {
            this.wireGrowths[i] = g;
        }
        this.flushWireGrowth();
    }

    public setWireGrowth(idx: number, growth: number): void {
        if (idx >= 0 && idx < this.wireCount) {
            this.wireGrowths[idx] = Math.max(0, Math.min(1, growth));
            this.flushWireGrowth();
        }
    }
}
