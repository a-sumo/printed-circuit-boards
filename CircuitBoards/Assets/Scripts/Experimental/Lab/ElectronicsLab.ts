// ElectronicsLab.ts
// Interactive electronics workbench for Spectacles.
// JSON-driven: define components (resistors, LEDs, capacitors, headers, boards),
// wires between their pins, and the system builds procedural geometry with
// configurable values, blinking LEDs, signal-flow animation, and tap-to-select.
//
// Each component is a separate SceneObject for independent interaction/selection.
// Components are schematic-style (simplified 3D) rather than photorealistic.
//
// Z-layout convention:
//   z=0 is the breadboard top surface.
//   Components sit above z=0 (bodies go up, leads go down through holes).
//   All pin positions are at z=0 for clean wire routing at surface level.
//
// Setup in Lens Studio:
//   1. Assign boardMaterial (ElectronicsLabShader) for component geometry
//   2. Assign wireMaterial (KiCadTraceShader) for jumper wires
//   3. Paste scene JSON into sceneData
//   4. Optionally assign labelFont for component labels

@component
export class ElectronicsLab extends BaseScriptComponent {

    @input
    @hint("Scene JSON: components[], wires[], config{}")
    sceneData: string = '{"components":[{"id":"header","type":"header","pos":[0,0,0],"rot":0,"config":{"label":"GPIO Header","pins":20,"rows":2,"pinLabels":{"1-1":"3V3","1-6":"GND","1-11":"GPIO17","1-12":"GPIO18","1-14":"GND","1-17":"3V3"}}},{"id":"breadboard","type":"breadboard","pos":[0,-25,0],"rot":0,"config":{"label":"Breadboard","cols":30,"rows":10}},{"id":"R1","type":"resistor","pos":[5,-20,0],"rot":90,"config":{"label":"R1","value":220}},{"id":"LED1","type":"led","pos":[5,-30,0],"rot":0,"config":{"label":"LED1","color":"red","blinkRate":2}},{"id":"R2","type":"resistor","pos":[15,-20,0],"rot":90,"config":{"label":"R2","value":330}},{"id":"LED2","type":"led","pos":[15,-30,0],"rot":0,"config":{"label":"LED2","color":"amber","blinkRate":1}},{"id":"C1","type":"capacitor","pos":[-10,-25,0],"rot":0,"config":{"label":"C1","value":"100nF"}}],"wires":[{"from":{"component":"header","pin":"GPIO17"},"to":{"component":"R1","pin":"1"},"color":"yellow"},{"from":{"component":"R1","pin":"2"},"to":{"component":"LED1","pin":"anode"},"color":"yellow"},{"from":{"component":"LED1","pin":"cathode"},"to":{"component":"header","pin":"GND"},"color":"black"},{"from":{"component":"header","pin":"GPIO18"},"to":{"component":"R2","pin":"1"},"color":"orange"},{"from":{"component":"R2","pin":"2"},"to":{"component":"LED2","pin":"anode"},"color":"orange"},{"from":{"component":"LED2","pin":"cathode"},"to":{"component":"header","pin":"GND"},"color":"black"},{"from":{"component":"header","pin":"3V3"},"to":{"component":"C1","pin":"1"},"color":"red"},{"from":{"component":"C1","pin":"2"},"to":{"component":"header","pin":"GND"},"color":"blue"}]}';

    @input
    @hint("Material with ElectronicsLabShader.js for component geometry")
    boardMaterial: Material;

    @input
    @hint("Material with KiCadTraceShader.js for wire geometry")
    wireMaterial: Material;

    @input
    @hint("Font for component labels")
    labelFont: Font;

    @input
    @widget(new SliderWidget(0.5, 10.0, 0.5))
    @hint("Global scale (1 = 1mm per cm)")
    scale: number = 2.0;

    @input
    @hint("Auto-animate signal flow on start")
    autoAnimate: boolean = true;

    // ---- Colors (Spectacles-friendly, no purple/green/cyan) ----
    static readonly COL = {
        resistorBody:  [0.45, 0.30, 0.18],   // warm brown (visible on additive)
        resistorLead:  [0.75, 0.75, 0.70],   // silver
        ledLens:       [1.00, 0.95, 0.90],   // frosted white
        capBody:       [0.88, 0.69, 0.06],   // gold
        capLead:       [0.75, 0.75, 0.70],   // silver
        headerPin:     [0.91, 0.69, 0.06],   // gold
        headerPlastic: [0.35, 0.30, 0.28],   // warm dark (visible on additive)
        breadboard:    [0.85, 0.80, 0.70],   // warm off-white
        bbRail:        [0.88, 0.20, 0.15],   // red
        bbRailGnd:     [0.20, 0.40, 0.85],   // blue
    };

    // Standard resistor color bands
    static readonly BAND_COLORS: { [key: number]: number[] } = {
        0: [0.05, 0.05, 0.05],
        1: [0.55, 0.20, 0.10],
        2: [0.88, 0.20, 0.15],
        3: [0.90, 0.55, 0.10],
        4: [0.90, 0.85, 0.10],
        5: [0.15, 0.45, 0.70],
        6: [0.15, 0.30, 0.80],
        7: [0.50, 0.30, 0.60],
        8: [0.40, 0.40, 0.40],
        9: [0.95, 0.93, 0.88],
    };
    static readonly TOL_GOLD = [0.91, 0.69, 0.06];

    // ---- State ----
    private scene: any = null;
    private components: Map<string, ComponentState> = new Map();
    private wires: WireState[] = [];
    private time: number = 0;
    private selectedId: string | null = null;

    // Wire rendering
    private wireTexProvider: ProceduralTextureProvider | null = null;
    private wirePixels: Uint8Array | null = null;
    private wireGrowth: number[] = [];

    private static readonly DEFAULT_SCENE = '{"components":[{"id":"BB","type":"breadboard","pos":[10,-18,0],"config":{"label":"Breadboard","cols":20,"rows":10}},{"id":"header","type":"header","pos":[0,0,0],"config":{"label":"GPIO","pins":20,"rows":2,"pinLabels":{"1-6":"GND","1-11":"GPIO17","1-12":"GPIO18","1-17":"3V3"}}},{"id":"R1","type":"resistor","pos":[5,-12,0],"rot":90,"config":{"label":"R1","value":220}},{"id":"LED1","type":"led","pos":[5,-22,0],"config":{"label":"LED1","color":"red","blinkRate":2}},{"id":"R2","type":"resistor","pos":[15,-12,0],"rot":90,"config":{"label":"R2","value":330}},{"id":"LED2","type":"led","pos":[15,-22,0],"config":{"label":"LED2","color":"amber","blinkRate":1}},{"id":"C1","type":"capacitor","pos":[-8,-18,0],"config":{"label":"C1","value":"100nF"}}],"wires":[{"from":{"component":"header","pin":"GPIO17"},"to":{"component":"R1","pin":"1"},"color":"yellow"},{"from":{"component":"R1","pin":"2"},"to":{"component":"LED1","pin":"anode"},"color":"yellow"},{"from":{"component":"LED1","pin":"cathode"},"to":{"component":"header","pin":"GND"},"color":"red"},{"from":{"component":"header","pin":"GPIO18"},"to":{"component":"R2","pin":"1"},"color":"orange"},{"from":{"component":"R2","pin":"2"},"to":{"component":"LED2","pin":"anode"},"color":"orange"},{"from":{"component":"LED2","pin":"cathode"},"to":{"component":"header","pin":"GND"},"color":"blue"},{"from":{"component":"header","pin":"3V3"},"to":{"component":"C1","pin":"1"},"color":"red"},{"from":{"component":"C1","pin":"2"},"to":{"component":"header","pin":"GND"},"color":"blue"}]}';

    onAwake(): void {
        let data = this.sceneData;
        if (!data || data.trim().length < 2) {
            data = ElectronicsLab.DEFAULT_SCENE;
            print("[Lab] Using default scene");
        }
        try {
            this.scene = JSON.parse(data);
        } catch (e: any) {
            print("[Lab] JSON parse error: " + e.message);
            return;
        }

        this.buildComponents();
        this.buildWires();

        if (this.autoAnimate) {
            this.startSignalFlow();
        }

        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
        print("[Lab] Built " + this.components.size + " components, " + this.wires.length + " wires");
    }

    // ==================================================================
    //  Component builders - each component gets its own SceneObject
    // ==================================================================

    private buildComponents(): void {
        if (!this.scene.components) return;

        for (const comp of this.scene.components) {
            const s = this.scale;
            const cx = comp.pos[0] * s;
            const cy = comp.pos[1] * s;
            const cz = (comp.pos[2] || 0) * s;
            const rotDeg = comp.rot || 0;
            const rotRad = rotDeg * Math.PI / 180;

            const state: ComponentState = {
                id: comp.id,
                type: comp.type,
                pos: comp.pos || [0, 0, 0],
                rot: rotDeg,
                config: comp.config || {},
                pins: new Map(),
                emissive: 0,
                blinkRate: comp.config?.blinkRate || 0,
                blinkPhase: Math.random() * Math.PI * 2,
                selected: false,
                bounds: { cx: 0, cy: 0, cz: 0, hw: 0, hh: 0, hd: 0 },
                sceneObject: null,
                material: null,
            };

            // Per-component SceneObject
            const child = global.scene.createSceneObject("__comp_" + comp.id);
            child.setParent(this.sceneObject);
            child.getTransform().setLocalPosition(new vec3(cx, cy, cz));
            if (rotRad !== 0) {
                child.getTransform().setLocalRotation(
                    quat.angleAxis(rotRad, new vec3(0, 0, 1))
                );
            }

            const mb = ElectronicsLab.newMB();
            switch (comp.type) {
                case 'resistor':  this.buildResistor(mb, state); break;
                case 'led':       this.buildLED(mb, state); break;
                case 'capacitor': this.buildCapacitor(mb, state); break;
                case 'header':    this.buildHeader(mb, state); break;
                case 'breadboard': this.buildBreadboard(mb, state); break;
            }

            mb.updateMesh();
            const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            rmv.mesh = mb.getMesh();

            if (this.boardMaterial) {
                if (comp.type === 'led') {
                    const mat = this.boardMaterial.clone();
                    rmv.mainMaterial = mat;
                    state.material = mat;
                } else {
                    rmv.mainMaterial = this.boardMaterial;
                }
            }

            state.sceneObject = child;

            // Label (before transforming bounds to parent space)
            this.buildComponentLabel(child, state);

            // Transform local pins to parent space for wire routing
            const cosR = Math.cos(rotRad);
            const sinR = Math.sin(rotRad);
            const parentPins = new Map<string, vec3>();
            for (const [name, lp] of state.pins) {
                const rx = lp.x * cosR - lp.y * sinR;
                const ry = lp.x * sinR + lp.y * cosR;
                parentPins.set(name, new vec3(cx + rx, cy + ry, cz + lp.z));
            }
            state.pins = parentPins;

            // Transform bounds to parent space for hit testing
            state.bounds.cx += cx;
            state.bounds.cy += cy;
            state.bounds.cz += cz;

            this.components.set(comp.id, state);
        }
    }

    private buildComponentLabel(parent: SceneObject, state: ComponentState): void {
        const labelStr = state.config.label || state.id;
        const labelObj = global.scene.createSceneObject("__label_" + state.id);
        labelObj.setParent(parent);
        labelObj.layer = this.sceneObject.layer;

        const b = state.bounds;
        labelObj.getTransform().setLocalPosition(
            new vec3(0, 0, b.cz + b.hd + 1.5 * this.scale)
        );

        try {
            const text = labelObj.createComponent("Component.Text") as Text;
            // Render on top of geometry (ReactPanel pattern)
            text.depthTest = false;
            text.renderOrder = 100;

            if (this.labelFont) {
                (text as any).font = this.labelFont;
            }
            text.size = 48;
            text.horizontalAlignment = HorizontalAlignment.Center;
            text.verticalAlignment = VerticalAlignment.Center;

            // White fill (black = transparent on Spectacles additive display)
            text.textFill.color = new vec4(0.94, 0.94, 0.91, 1.0);

            // Dark outline for readability
            const outline = text.outlineSettings;
            outline.enabled = true;
            outline.size = 0.15;
            outline.fill.color = new vec4(0, 0, 0, 1);

            if (state.type === 'resistor' && state.config.value) {
                text.text = labelStr + "\n" + ElectronicsLab.formatResistance(state.config.value);
            } else if (state.type === 'capacitor' && state.config.value) {
                text.text = labelStr + "\n" + state.config.value;
            } else if (state.type === 'led') {
                text.text = labelStr + "\n" + (state.config.color || 'red').toUpperCase();
            } else {
                text.text = labelStr;
            }
        } catch (e: any) {
            print("[Lab] Text failed for " + state.id + ": " + e.message);
        }
    }

    // ---- Resistor: horizontal body sitting on surface + leads with downward legs ----
    // Built in LOCAL space centered at (0,0). Body at z=bodyR above surface.

    private buildResistor(mb: MeshBuilder, state: ComponentState): void {
        const s = this.scale;
        const value = state.config.value || 1000;
        const bodyLen = 3.5 * s;
        const bodyR = 1.0 * s;
        const leadLen = 3.0 * s;
        const leadR = 0.15 * s;
        const totalLen = bodyLen + leadLen * 2;
        const segs = 8;
        const bz = bodyR; // body center Z so bottom touches surface

        const [br, bg, bb] = ElectronicsLab.COL.resistorBody;
        const [lr, lg, lb] = ElectronicsLab.COL.resistorLead;

        // Horizontal leads from body ends
        ElectronicsLab.appendCylinder(mb, 0, 0, bz,
            -totalLen / 2, -bodyLen / 2, leadR,
            lr, lg, lb, 1, 0, segs, false);
        ElectronicsLab.appendCylinder(mb, 0, 0, bz,
            bodyLen / 2, totalLen / 2, leadR,
            lr, lg, lb, 1, 0, segs, false);

        // Downward legs from lead tips to surface (z=0)
        ElectronicsLab.appendCylinder(mb, -totalLen / 2, 0, 0,
            0, bz, leadR,
            lr, lg, lb, 1, 0, 6, true);
        ElectronicsLab.appendCylinder(mb, totalLen / 2, 0, 0,
            0, bz, leadR,
            lr, lg, lb, 1, 0, 6, true);

        // Body cylinder
        ElectronicsLab.appendCylinder(mb, 0, 0, bz,
            -bodyLen / 2, bodyLen / 2, bodyR,
            br, bg, bb, 1, 0, segs, false);

        // Color bands
        const bands = ElectronicsLab.resistorBands(value);
        const bandW = bodyLen * 0.08;
        const bandPositions = [-0.35, -0.2, -0.05, 0.25];
        for (let i = 0; i < bands.length && i < 4; i++) {
            const [cr, cg, cb] = bands[i];
            const bx = bandPositions[i] * bodyLen;
            ElectronicsLab.appendCylinder(mb, 0, 0, bz,
                bx - bandW, bx + bandW, bodyR + 0.02 * s,
                cr, cg, cb, 1, 0, segs, false);
        }

        // Pins at surface level (z=0) for clean wire routing
        state.pins.set('1', new vec3(-totalLen / 2, 0, 0));
        state.pins.set('2', new vec3(totalLen / 2, 0, 0));
        state.bounds = { cx: 0, cy: 0, cz: bz, hw: totalLen / 2, hh: bodyR, hd: bodyR };
    }

    // ---- LED: dome + base standing on surface + leads downward ----
    // Built in LOCAL space. Base from z=0 to z=baseH, dome on top.

    private buildLED(mb: MeshBuilder, state: ComponentState): void {
        const s = this.scale;
        const color = state.config.color || 'red';
        const [colR, colG, colB] = ElectronicsLab.ledColor(color);
        const baseR = 1.5 * s;
        const baseH = 1.0 * s;
        const domeR = 1.5 * s;
        const leadLen = 4.0 * s;
        const leadSpacing = 1.27 * s;
        const leadR = 0.15 * s;
        const [lr, lg, lb] = ElectronicsLab.COL.resistorLead;

        // Base cylinder (vertical, z=0 to z=baseH) - LED tagged (tag=1)
        ElectronicsLab.appendCylinder(mb, 0, 0, 0,
            0, baseH, baseR,
            colR * 0.6, colG * 0.6, colB * 0.6, 1, 0, 8, true, 1);

        // Dome hemisphere at z=baseH (NOT baseH*s - that was the double-scale bug)
        ElectronicsLab.appendHemisphere(mb, 0, 0, baseH,
            domeR, colR, colG, colB, 8, 1);

        // Leads downward from surface (z=0 to z=-leadLen)
        ElectronicsLab.appendCylinder(mb, -leadSpacing, 0, 0,
            -leadLen, 0, leadR,
            lr, lg, lb, 1, 0, 6, true);
        ElectronicsLab.appendCylinder(mb, leadSpacing, 0, 0,
            -leadLen * 0.8, 0, leadR,
            lr, lg, lb, 1, 0, 6, true);

        // Pins at surface level (z=0)
        state.pins.set('anode', new vec3(-leadSpacing, 0, 0));
        state.pins.set('cathode', new vec3(leadSpacing, 0, 0));
        state.bounds = { cx: 0, cy: 0, cz: (baseH + domeR) / 2, hw: baseR, hh: baseR, hd: (baseH + domeR) / 2 };
    }

    // ---- Capacitor: cylinder standing on surface + leads downward ----

    private buildCapacitor(mb: MeshBuilder, state: ComponentState): void {
        const s = this.scale;
        const [cr, cg, cb] = ElectronicsLab.COL.capBody;
        const [lr, lg, lb] = ElectronicsLab.COL.capLead;
        const bodyR = 1.2 * s;
        const bodyH = 2.5 * s;
        const leadLen = 3.0 * s;
        const leadSpacing = 1.27 * s;
        const leadR = 0.15 * s;

        // Body (vertical, z=0 to z=bodyH)
        ElectronicsLab.appendCylinder(mb, 0, 0, 0,
            0, bodyH, bodyR,
            cr, cg, cb, 1, 0, 8, true);

        // Value marking band
        const markH = bodyH * 0.15;
        ElectronicsLab.appendCylinder(mb, 0, 0, 0,
            bodyH * 0.3, bodyH * 0.3 + markH, bodyR + 0.02 * s,
            0.12, 0.12, 0.14, 1, 0, 8, true);

        // Leads downward
        ElectronicsLab.appendCylinder(mb, -leadSpacing, 0, 0,
            -leadLen, 0, leadR,
            lr, lg, lb, 1, 0, 6, true);
        ElectronicsLab.appendCylinder(mb, leadSpacing, 0, 0,
            -leadLen, 0, leadR,
            lr, lg, lb, 1, 0, 6, true);

        state.pins.set('1', new vec3(-leadSpacing, 0, 0));
        state.pins.set('2', new vec3(leadSpacing, 0, 0));
        state.bounds = { cx: 0, cy: 0, cz: bodyH / 2, hw: bodyR, hh: bodyR, hd: bodyH / 2 };
    }

    // ---- Pin header: gold pins in black plastic housing ----

    private buildHeader(mb: MeshBuilder, state: ComponentState): void {
        const s = this.scale;
        const nPins = state.config.pins || 8;
        const rows = state.config.rows || 1;
        const pitch = 2.54 * s;
        const [pr, pg, pb] = ElectronicsLab.COL.headerPin;
        const [hr, hg, hb] = ElectronicsLab.COL.headerPlastic;

        const totalW = nPins * pitch;
        const totalH = rows * pitch;
        const plasticH = 2.5 * s;
        const pinAbove = 0.9 * s;  // pin sticking above plastic
        const pinBelow = 1.2 * s;  // pin below surface

        // Plastic housing (z=0 to z=plasticH)
        ElectronicsLab.appendBox(mb, 0, 0, plasticH / 2,
            totalW, totalH, plasticH,
            hr, hg, hb, 1, 0);

        // Individual pins
        for (let r = 0; r < rows; r++) {
            for (let p = 0; p < nPins; p++) {
                const lx = (p - (nPins - 1) / 2) * pitch;
                const ly = (r - (rows - 1) / 2) * pitch;

                // Pin extends from below surface through plastic and above
                ElectronicsLab.appendCylinder(mb, lx, ly, 0,
                    -pinBelow, plasticH + pinAbove, 0.25 * s,
                    pr, pg, pb, 1, 0, 4, true);

                // Register pin at surface level
                const pinName = rows > 1 ? `${r + 1}-${p + 1}` : `${p + 1}`;
                const label = state.config.pinLabels?.[pinName] || pinName;
                state.pins.set(label, new vec3(lx, ly, 0));
            }
        }

        state.bounds = { cx: 0, cy: 0, cz: plasticH / 2, hw: totalW / 2, hh: totalH / 2, hd: plasticH / 2 };
    }

    // ---- Breadboard: flat board with holes, surface at z=0, body below ----

    private buildBreadboard(mb: MeshBuilder, state: ComponentState): void {
        const s = this.scale;
        const cols = state.config.cols || 30;
        const rows = state.config.rows || 10;
        const pitch = 2.54 * s;
        const [br, bg, bb] = ElectronicsLab.COL.breadboard;

        const boardW = (cols + 1) * pitch;
        const boardH = (rows + 3) * pitch;
        const boardD = 1.0 * s;

        // Board body (z=-boardD to z=0, surface at z=0)
        ElectronicsLab.appendBox(mb, 0, 0, -boardD / 2,
            boardW, boardH, boardD,
            br, bg, bb, 1, 0);

        // Power rail stripes on top surface
        const railW = boardW - pitch;
        const railH = 0.3 * s;
        const [rr, rg, rb] = ElectronicsLab.COL.bbRail;
        const [gr, gg, gb] = ElectronicsLab.COL.bbRailGnd;
        const topRailY = boardH / 2 - pitch;
        const botRailY = -boardH / 2 + pitch;

        ElectronicsLab.appendBox(mb, 0, topRailY, 0.01 * s,
            railW, railH, 0.05 * s, rr, rg, rb, 1, 0);
        ElectronicsLab.appendBox(mb, 0, topRailY - pitch, 0.01 * s,
            railW, railH, 0.05 * s, gr, gg, gb, 1, 0);
        ElectronicsLab.appendBox(mb, 0, botRailY + pitch, 0.01 * s,
            railW, railH, 0.05 * s, rr, rg, rb, 1, 0);
        ElectronicsLab.appendBox(mb, 0, botRailY, 0.01 * s,
            railW, railH, 0.05 * s, gr, gg, gb, 1, 0);

        // Center divider
        ElectronicsLab.appendBox(mb, 0, 0, 0.01 * s,
            railW, 0.8 * s, 0.05 * s,
            0.75, 0.72, 0.68, 1, 0);

        // Pin positions at z=0 (surface)
        // Centered layout: rows 0-4 above center gap, rows 5-9 below
        const letters = 'abcdefghij';
        for (let r = 0; r < rows && r < letters.length; r++) {
            for (let c = 0; c < cols; c++) {
                const lx = (c - (cols - 1) / 2) * pitch;
                const ly = (r < 5 ? (4.5 - r) : -(r - 4.5)) * pitch;
                const pinName = letters[r] + (c + 1);
                state.pins.set(pinName, new vec3(lx, ly, 0));
            }
        }

        // Power rail pins
        for (let c = 0; c < cols; c++) {
            const lx = (c - (cols - 1) / 2) * pitch;
            state.pins.set(`+${c + 1}`, new vec3(lx, topRailY, 0));
            state.pins.set(`-${c + 1}`, new vec3(lx, topRailY - pitch, 0));
            state.pins.set(`+b${c + 1}`, new vec3(lx, botRailY + pitch, 0));
            state.pins.set(`-b${c + 1}`, new vec3(lx, botRailY, 0));
        }

        state.bounds = { cx: 0, cy: 0, cz: -boardD / 2, hw: boardW / 2, hh: boardH / 2, hd: boardD / 2 };
    }

    // ==================================================================
    //  Wire builder (baked tube geometry + growth data texture)
    // ==================================================================

    private static readonly MAX_WIRES = 256;
    private static readonly WIRE_SEGS = 6;

    private buildWires(): void {
        if (!this.scene.wires || this.scene.wires.length === 0) return;

        const wires = this.scene.wires;
        const numWires = Math.min(wires.length, ElectronicsLab.MAX_WIRES);
        const CIRC = ElectronicsLab.WIRE_SEGS;
        const wireR = 0.3 * this.scale;

        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
            { name: "texture1", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;

        // Pre-compute unit circle
        const circX: number[] = [], circY: number[] = [];
        for (let j = 0; j < CIRC; j++) {
            const theta = (j / CIRC) * Math.PI * 2;
            circX.push(Math.cos(theta));
            circY.push(Math.sin(theta));
        }

        for (let wi = 0; wi < numWires; wi++) {
            const wire = wires[wi];
            const fromComp = this.components.get(wire.from?.component);
            const toComp = this.components.get(wire.to?.component);
            if (!fromComp || !toComp) continue;

            const fromPin = fromComp.pins.get(wire.from.pin);
            const toPin = toComp.pins.get(wire.to.pin);
            if (!fromPin || !toPin) {
                print("[Lab] Wire " + wi + ": pin not found (" +
                    wire.from.component + "." + wire.from.pin + " -> " +
                    wire.to.component + "." + wire.to.pin + ")");
                continue;
            }

            const ws: WireState = {
                index: this.wires.length,
                from: fromPin,
                to: toPin,
                color: wire.color || 'red',
                growth: 0,
                signal: 0,
            };
            this.wires.push(ws);
            this.wireGrowth.push(0);

            // Compute Frenet frame for the wire segment
            const dx = toPin.x - fromPin.x;
            const dy = toPin.y - fromPin.y;
            const dz = toPin.z - fromPin.z;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len < 0.001) continue;

            const tx = dx / len, ty = dy / len, tz = dz / len;

            // Reference up vector
            const abstz = tz < 0 ? -tz : tz;
            const ux = abstz > 0.99 ? 1 : 0;
            const uy = 0;
            const uz = abstz > 0.99 ? 0 : 1;

            // right = cross(up, tangent)
            let rx = uy * tz - uz * ty;
            let ry = uz * tx - ux * tz;
            let rz = ux * ty - uy * tx;
            const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
            rx /= rLen; ry /= rLen; rz /= rLen;

            // binormal = cross(tangent, right)
            const bx = ty * rz - tz * ry;
            const by = tz * rx - tx * rz;
            const bz = tx * ry - ty * rx;

            // Bake tube vertices: 2 rings + 2 cap centers
            const base = mb.getVerticesCount();
            for (let ring = 0; ring < 2; ring++) {
                const t = ring;
                const cx = fromPin.x + dx * t;
                const cy = fromPin.y + dy * t;
                const cz = fromPin.z + dz * t;

                for (let j = 0; j < CIRC; j++) {
                    const ox = (circX[j] * rx + circY[j] * bx) * wireR;
                    const oy = (circX[j] * ry + circY[j] * by) * wireR;
                    const oz = (circX[j] * rz + circY[j] * bz) * wireR;
                    const nx = circX[j] * rx + circY[j] * bx;
                    const ny = circX[j] * ry + circY[j] * by;
                    const nz = circX[j] * rz + circY[j] * bz;
                    mb.appendVerticesInterleaved([
                        cx + ox, cy + oy, cz + oz,
                        nx, ny, nz,
                        t, ws.index,  // texture0 = (t, wireIdx) for trace shader
                        0, 0,
                    ]);
                }
            }

            // Cap centers
            mb.appendVerticesInterleaved([
                fromPin.x, fromPin.y, fromPin.z,
                -tx, -ty, -tz,
                0, ws.index, 0, 0,
            ]);
            mb.appendVerticesInterleaved([
                toPin.x, toPin.y, toPin.z,
                tx, ty, tz,
                1, ws.index, 0, 0,
            ]);

            // Body indices
            for (let j = 0; j < CIRC; j++) {
                const j1 = (j + 1) % CIRC;
                const a = base + j, b = base + j1;
                const c = base + CIRC + j, d = base + CIRC + j1;
                mb.appendIndices([a, b, d, a, d, c]);
            }

            // Cap indices
            const capS = base + 2 * CIRC;
            const capE = base + 2 * CIRC + 1;
            for (let j = 0; j < CIRC; j++) {
                const j1 = (j + 1) % CIRC;
                mb.appendIndices([capS, base + j1, base + j]);
                mb.appendIndices([capE, base + CIRC + j, base + CIRC + j1]);
            }
        }

        if (this.wires.length === 0) return;

        mb.updateMesh();
        const child = global.scene.createSceneObject("__lab_wires");
        child.setParent(this.sceneObject);
        const rmv = child.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.wireMaterial) rmv.mainMaterial = this.wireMaterial;

        this.createWireTexture();
        this.writeWireData();
    }

    private createWireTexture(): void {
        const texH = ElectronicsLab.MAX_WIRES;
        const tex = ProceduralTextureProvider.createWithFormat(1, texH, TextureFormat.RGBA8Unorm);
        this.wireTexProvider = tex.control as ProceduralTextureProvider;
        this.wirePixels = new Uint8Array(1 * texH * 4);

        if (this.wireMaterial) {
            this.wireMaterial.mainPass["traceTex"] = tex;
            this.wireMaterial.mainPass["NumTraces"] = ElectronicsLab.MAX_WIRES;
        }
    }

    private writeWireData(): void {
        if (!this.wirePixels || !this.wireTexProvider) return;

        for (let i = 0; i < this.wires.length; i++) {
            const w = this.wires[i];
            const row = i * 4;
            const growth = this.wireGrowth[i];
            const hue = this.wireHue(w.color);

            const gv = Math.round(Math.max(0, Math.min(1, growth)) * 65535);
            this.wirePixels[row + 0] = (gv >> 8) & 0xFF;
            this.wirePixels[row + 1] = gv & 0xFF;
            const hv = Math.round(Math.max(0, Math.min(1, hue)) * 65535);
            this.wirePixels[row + 2] = (hv >> 8) & 0xFF;
            this.wirePixels[row + 3] = hv & 0xFF;
        }

        this.wireTexProvider.setPixels(0, 0, 1, ElectronicsLab.MAX_WIRES, this.wirePixels);
    }

    private wireHue(color: string): number {
        switch (color) {
            case 'red':    return 0.0;
            case 'orange': return 0.08;
            case 'yellow': return 0.15;
            case 'blue':   return 0.6;
            case 'white':  return 0.17;
            case 'black':  return 0.0;
            default:       return 0.0;
        }
    }

    // ==================================================================
    //  Animation
    // ==================================================================

    private animActive: boolean = false;
    private animPhase: number = 0;

    private startSignalFlow(): void {
        this.animActive = true;
        this.animPhase = 0;
        for (let i = 0; i < this.wireGrowth.length; i++) {
            this.wireGrowth[i] = 0;
        }
    }

    private onUpdate(): void {
        const dt = getDeltaTime();
        this.time += dt;

        // LED emissive animation (per-LED material)
        for (const [, comp] of this.components) {
            if (comp.type === 'led' && comp.blinkRate > 0) {
                comp.emissive = Math.sin(this.time * comp.blinkRate * Math.PI * 2 + comp.blinkPhase) > 0 ? 1.0 : 0.2;
                if (comp.material) {
                    comp.material.mainPass["EmissivePulse"] = comp.emissive;
                }
            }
        }

        // Wire growth animation
        if (this.animActive) {
            this.animPhase += dt * 0.8;
            let allDone = true;
            for (let i = 0; i < this.wires.length; i++) {
                const target = Math.max(0, Math.min(1, (this.animPhase - i * 0.3)));
                this.wireGrowth[i] = Math.min(1, this.wireGrowth[i] + dt * 2.0);
                if (target < 1) {
                    this.wireGrowth[i] = Math.min(this.wireGrowth[i], target);
                    allDone = false;
                }
            }
            this.writeWireData();
            if (allDone) {
                this.animActive = false;
                for (const [, comp] of this.components) {
                    if (comp.type === 'led' && comp.blinkRate === 0) {
                        comp.blinkRate = comp.config.blinkRate || 1.0;
                    }
                }
            }
        }
    }

    // ==================================================================
    //  Geometry helpers (static for reuse by CircuitSim)
    // ==================================================================

    static newMB(): MeshBuilder {
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

    // Cylinder along X (isVertical=false) or Z (isVertical=true).
    // tag goes into texture1.y (1=LED for emissive shader, >=1 for sim index).
    static appendCylinder(mb: MeshBuilder,
        cx: number, cy: number, cz: number,
        startX: number, endX: number, radius: number,
        r: number, g: number, b: number,
        cosR: number, sinR: number,
        segs: number, isVertical: boolean = false, tag: number = 0): void {

        const base = mb.getVerticesCount();

        for (let ring = 0; ring < 2; ring++) {
            const x = ring === 0 ? startX : endX;
            for (let j = 0; j < segs; j++) {
                const theta = (j / segs) * Math.PI * 2;
                const lx = Math.cos(theta) * radius;
                const ly = Math.sin(theta) * radius;

                let px: number, py: number, pz: number;
                let nx: number, ny: number, nz: number;
                if (isVertical) {
                    px = cx + lx;
                    py = cy + ly;
                    pz = cz + x;
                    nx = Math.cos(theta);
                    ny = Math.sin(theta);
                    nz = 0;
                } else {
                    const rx = x * cosR - ly * sinR;
                    const ry = x * sinR + ly * cosR;
                    px = cx + rx;
                    py = cy + ry;
                    pz = cz + lx;
                    nx = 0;
                    ny = Math.sin(theta);
                    nz = Math.cos(theta);
                }
                mb.appendVerticesInterleaved([px, py, pz, nx, ny, nz, r, g, b, tag]);
            }
        }

        // Body quads
        for (let j = 0; j < segs; j++) {
            const j1 = (j + 1) % segs;
            const a = base + j, bv = base + j1;
            const c = base + segs + j, d = base + segs + j1;
            mb.appendIndices([a, bv, d, a, d, c]);
        }

        // End caps
        const capS = mb.getVerticesCount();
        if (isVertical) {
            mb.appendVerticesInterleaved([cx, cy, cz + startX, 0, 0, -1, r, g, b, tag]);
        } else {
            const scx = startX * cosR;
            const scy = startX * sinR;
            mb.appendVerticesInterleaved([cx + scx, cy + scy, cz, 0, 0, -1, r, g, b, tag]);
        }
        for (let j = 0; j < segs; j++) {
            mb.appendIndices([capS, base + (j + 1) % segs, base + j]);
        }

        const capE = mb.getVerticesCount();
        if (isVertical) {
            mb.appendVerticesInterleaved([cx, cy, cz + endX, 0, 0, 1, r, g, b, tag]);
        } else {
            const ecx = endX * cosR;
            const ecy = endX * sinR;
            mb.appendVerticesInterleaved([cx + ecx, cy + ecy, cz, 0, 0, 1, r, g, b, tag]);
        }
        for (let j = 0; j < segs; j++) {
            mb.appendIndices([capE, base + segs + j, base + segs + (j + 1) % segs]);
        }
    }

    // Axis-aligned box centered at (cx, cy, cz)
    static appendBox(mb: MeshBuilder,
        cx: number, cy: number, cz: number,
        w: number, h: number, d: number,
        r: number, g: number, b: number,
        cosR: number, sinR: number, tag: number = 0): void {

        const hw = w / 2, hh = h / 2, hd = d / 2;
        const corners: vec3[] = [];
        for (const [sx, sy, sz] of [
            [-1,-1,-1], [1,-1,-1], [1,1,-1], [-1,1,-1],
            [-1,-1,1], [1,-1,1], [1,1,1], [-1,1,1]
        ]) {
            const lx = sx * hw, ly = sy * hh;
            const rx = lx * cosR - ly * sinR;
            const ry = lx * sinR + ly * cosR;
            corners.push(new vec3(cx + rx, cy + ry, cz + sz * hd));
        }

        const faces: [number[], vec3][] = [
            [[0,1,2,3], new vec3(0,0,-1)],
            [[4,7,6,5], new vec3(0,0,1)],
            [[0,4,5,1], new vec3(0,-1,0)],
            [[2,6,7,3], new vec3(0,1,0)],
            [[0,3,7,4], new vec3(-1,0,0)],
            [[1,5,6,2], new vec3(1,0,0)],
        ];

        for (const [indices, n] of faces) {
            const fbase = mb.getVerticesCount();
            for (const idx of indices) {
                const c = corners[idx];
                mb.appendVerticesInterleaved([c.x, c.y, c.z, n.x, n.y, n.z, r, g, b, tag]);
            }
            mb.appendIndices([fbase, fbase + 1, fbase + 2, fbase, fbase + 2, fbase + 3]);
        }
    }

    // Hemisphere pointing up along Z
    static appendHemisphere(mb: MeshBuilder,
        cx: number, cy: number, cz: number,
        radius: number, r: number, g: number, b: number,
        segs: number, tag: number = 0): void {

        const rings = 3;
        const base = mb.getVerticesCount();

        // Tip
        mb.appendVerticesInterleaved([cx, cy, cz + radius, 0, 0, 1, r, g, b, tag]);

        // Latitude rings
        for (let ring = 1; ring <= rings; ring++) {
            const phi = (ring / (rings + 1)) * Math.PI * 0.5;
            const rr = Math.sin(phi) * radius;
            const zz = Math.cos(phi) * radius;
            for (let j = 0; j < segs; j++) {
                const theta = (j / segs) * Math.PI * 2;
                const nx = Math.cos(theta) * Math.sin(phi);
                const ny = Math.sin(theta) * Math.sin(phi);
                const nz = Math.cos(phi);
                mb.appendVerticesInterleaved([
                    cx + Math.cos(theta) * rr,
                    cy + Math.sin(theta) * rr,
                    cz + zz,
                    nx, ny, nz, r, g, b, tag
                ]);
            }
        }

        // Equator ring
        for (let j = 0; j < segs; j++) {
            const theta = (j / segs) * Math.PI * 2;
            mb.appendVerticesInterleaved([
                cx + Math.cos(theta) * radius,
                cy + Math.sin(theta) * radius,
                cz,
                Math.cos(theta), Math.sin(theta), 0, r, g, b, tag
            ]);
        }

        // Tip to first ring
        for (let j = 0; j < segs; j++) {
            const j1 = (j + 1) % segs;
            mb.appendIndices([base, base + 1 + j, base + 1 + j1]);
        }

        // Ring to ring
        for (let ring = 0; ring < rings; ring++) {
            const ringBase = base + 1 + ring * segs;
            const nextBase = ringBase + segs;
            for (let j = 0; j < segs; j++) {
                const j1 = (j + 1) % segs;
                mb.appendIndices([
                    ringBase + j, nextBase + j, nextBase + j1,
                    ringBase + j, nextBase + j1, ringBase + j1,
                ]);
            }
        }
    }

    // ==================================================================
    //  Helpers
    // ==================================================================

    static resistorBands(ohms: number): number[][] {
        if (ohms <= 0) return [[0,0,0], [0,0,0], [0,0,0]];
        let val = ohms;
        let mult = 0;
        while (val >= 100) { val /= 10; mult++; }
        while (val < 10 && mult > 0) { val *= 10; mult--; }
        const d1 = Math.floor(val / 10) % 10;
        const d2 = Math.floor(val) % 10;
        const b1 = ElectronicsLab.BAND_COLORS[d1] || [0,0,0];
        const b2 = ElectronicsLab.BAND_COLORS[d2] || [0,0,0];
        const b3 = ElectronicsLab.BAND_COLORS[mult] || [0,0,0];
        return [b1, b2, b3, ElectronicsLab.TOL_GOLD];
    }

    static formatResistance(ohms: number): string {
        if (ohms >= 1000000) return (ohms / 1000000).toFixed(ohms % 1000000 === 0 ? 0 : 1) + "M";
        if (ohms >= 1000) return (ohms / 1000).toFixed(ohms % 1000 === 0 ? 0 : 1) + "K";
        return ohms + "R";
    }

    static ledColor(color: string): [number, number, number] {
        switch (color) {
            case 'red':    return [0.95, 0.15, 0.10];
            case 'amber':  return [0.95, 0.60, 0.05];
            case 'yellow': return [0.95, 0.90, 0.10];
            case 'blue':   return [0.15, 0.40, 0.95];
            case 'white':  return [0.95, 0.93, 0.88];
            default:       return [0.95, 0.15, 0.10];
        }
    }

    // ==================================================================
    //  Public API
    // ==================================================================

    public setLED(id: string, state: 'on' | 'off' | number): void {
        const comp = this.components.get(id);
        if (!comp || comp.type !== 'led') return;
        if (state === 'on') { comp.emissive = 1.0; comp.blinkRate = 0; }
        else if (state === 'off') { comp.emissive = 0; comp.blinkRate = 0; }
        else { comp.blinkRate = state as number; }
        if (comp.material) {
            comp.material.mainPass["EmissivePulse"] = comp.emissive;
        }
    }

    public setResistorValue(id: string, ohms: number): void {
        const comp = this.components.get(id);
        if (!comp || comp.type !== 'resistor') return;
        comp.config.value = ohms;
        print("[Lab] Resistor " + id + " set to " + ElectronicsLab.formatResistance(ohms));
    }

    public getPin(componentId: string, pinName: string): vec3 | null {
        const comp = this.components.get(componentId);
        if (!comp) return null;
        return comp.pins.get(pinName) || null;
    }

    public select(id: string): void {
        this.selectedId = id;
        for (const [cid, comp] of this.components) {
            comp.selected = (cid === id);
        }
    }

    public animateSignal(): void {
        this.startSignalFlow();
    }

    public setWireGrowth(index: number, growth: number): void {
        if (index >= 0 && index < this.wireGrowth.length) {
            this.wireGrowth[index] = Math.max(0, Math.min(1, growth));
            this.writeWireData();
        }
    }

    public showAllWires(): void {
        for (let i = 0; i < this.wireGrowth.length; i++) {
            this.wireGrowth[i] = 1.0;
        }
        this.writeWireData();
    }

    public hitTest(x: number, y: number, z: number): string | null {
        for (const [id, comp] of this.components) {
            const b = comp.bounds;
            if (Math.abs(x - b.cx) <= b.hw &&
                Math.abs(y - b.cy) <= b.hh &&
                Math.abs(z - b.cz) <= b.hd) {
                return id;
            }
        }
        return null;
    }
}

// ---- Types ----

interface ComponentState {
    id: string;
    type: string;
    pos: number[];
    rot: number;
    config: any;
    pins: Map<string, vec3>;
    emissive: number;
    blinkRate: number;
    blinkPhase: number;
    selected: boolean;
    bounds: { cx: number; cy: number; cz: number; hw: number; hh: number; hd: number };
    sceneObject: SceneObject | null;
    material: Material | null;
}

interface WireState {
    index: number;
    from: vec3;
    to: vec3;
    color: string;
    growth: number;
    signal: number;
}
