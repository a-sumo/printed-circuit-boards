// CircuitSim.ts
// Interactive circuit simulation lens for Spectacles.
// Orchestrates: component palette, SIK grab/drag/snap, breadboard connectivity,
// MNA solver, and simulation-driven visuals (LED glow, resistor heat, wire pulse).
//
// Architecture:
//   - Breadboard is the workbench (snap grid at 2.54mm pitch)
//   - Palette floats to the left with template components
//   - Pinch-grab clones a template, drag to breadboard, release to snap
//   - On topology change: rebuild netlist, solve, update visuals
//   - Sim data written to ProceduralTexture read by ElectronicsLabShader
//
// Setup in Lens Studio:
//   1. Assign boardMaterial (ElectronicsLabShader.js with simTex parameter)
//   2. Assign wireMaterial (KiCadTraceShader.js)
//   3. Optionally assign labelFont
//   4. SIK Interactable + InteractableManipulation auto-created at runtime

import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { InteractableManipulation } from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation";
import { InteractorEvent } from "SpectaclesInteractionKit.lspkg/Core/Interactor/InteractorEvent";
import { CircuitSolver, SolverResult } from "../../Sim/CircuitSolver";
import { ElectronicsLab } from "./ElectronicsLab";

// ---- Types ----

interface PlacedComponent {
    id: string;
    type: string;
    gridCol: number;
    gridRow: number;
    config: any;
    sceneObject: SceneObject;
    material: Material | null;
    simIndex: number; // row in sim data texture (1-based, 0 = unused)
    pins: Map<string, { col: number; row: number }>; // grid positions of pins
    solverIds: number[]; // element IDs in solver
}

interface BreadboardNet {
    name: string;
    pins: Array<{ compId: string; pinName: string }>;
}

// ---- Component ----

@component
export class CircuitSim extends BaseScriptComponent {

    @input
    @hint("Material with ElectronicsLabShader.js (needs simTex + SimTexHeight params)")
    boardMaterial: Material;

    @input
    @hint("Material with KiCadTraceShader.js for auto-wires")
    wireMaterial: Material;

    @input
    @hint("Font for component labels")
    labelFont: Font;

    @input
    @widget(new SliderWidget(0.5, 10.0, 0.5))
    @hint("Global scale (1 = 1mm per cm)")
    scale: number = 2.0;

    @input
    @hint("Breadboard columns")
    bbCols: number = 30;

    @input
    @hint("Breadboard rows")
    bbRows: number = 10;

    @input
    @hint("Include 3.3V voltage source template in palette")
    includeVSource: boolean = true;

    // ---- State ----
    private placed: Map<string, PlacedComponent> = new Map();
    private nextCompId: number = 0;
    private solver: CircuitSolver = new CircuitSolver();
    private lastResult: SolverResult | null = null;

    // Breadboard
    private bbObject: SceneObject | null = null;
    private bbPitch: number = 0;
    private occupancy: Set<string> = new Set(); // "col,row" -> occupied

    // Palette
    private paletteTemplates: Array<{ type: string; config: any; sceneObject: SceneObject }> = [];

    // Drag state
    private dragging: PlacedComponent | null = null;

    // Sim data texture
    private static readonly MAX_SIM_ROWS = 64;
    private simTexProvider: ProceduralTextureProvider | null = null;
    private simPixels: Uint8Array | null = null;
    private nextSimIndex: number = 1; // 0 is unused, 1-based

    // Wire rendering
    private wireObject: SceneObject | null = null;
    private wireTexProvider: ProceduralTextureProvider | null = null;
    private wirePixels: Uint8Array | null = null;
    private wireCount: number = 0;

    // Animation
    private time: number = 0;
    private globalGrowth: number = 0;
    private growthDone: boolean = false;

    // Resistor body color: warm beige
    private static readonly RESISTOR_BODY = [0.76, 0.70, 0.56]; // beige
    private static readonly RESISTOR_SEGS = 12; // smoother cylinders

    // ---- Lifecycle ----

    onAwake(): void {
        this.bbPitch = 2.54 * this.scale;

        this.buildBreadboard();
        this.buildPalette();
        this.createSimTexture();
        this.presetCircuit();

        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
        print("[CircuitSim] Ready. Breadboard " + this.bbCols + "x" + this.bbRows +
              ", pitch=" + this.bbPitch.toFixed(2) + "cm");
    }

    // ==================================================================
    //  Breadboard (with holes, proper separators)
    // ==================================================================

    // Row y-offset: centered layout with center gap
    // Rows 0-4 (a-e) above center, rows 5-9 (f-j) below
    private rowY(r: number): number {
        return (r < 5 ? (4.5 - r) : -(r - 4.5)) * this.bbPitch;
    }

    // Power rail y-positions
    private static readonly RAIL_VCC_OFFSET = 6.5;
    private static readonly RAIL_GND_OFFSET = 5.5;

    private buildBreadboard(): void {
        const mb = ElectronicsLab.newMB();
        const s = this.scale;
        const cols = this.bbCols;
        const rows = this.bbRows;
        const pitch = this.bbPitch;
        const COL = ElectronicsLab.COL;

        const boardW = (cols + 1) * pitch;
        const boardH = (rows + 5) * pitch;
        const boardD = 1.0 * s;

        // Board body below surface
        ElectronicsLab.appendBox(mb, 0, 0, -boardD / 2,
            boardW, boardH, boardD,
            COL.breadboard[0], COL.breadboard[1], COL.breadboard[2], 1, 0);

        // Power rail positions
        const topVccY = CircuitSim.RAIL_VCC_OFFSET * pitch;
        const topGndY = CircuitSim.RAIL_GND_OFFSET * pitch;
        const botGndY = -CircuitSim.RAIL_GND_OFFSET * pitch;
        const botVccY = -CircuitSim.RAIL_VCC_OFFSET * pitch;

        // Z-layer offsets: all surface features sit above z=0 with clear separation
        const zRail = 0.06 * s;     // rail stripes
        const zDiv = 0.04 * s;      // divider edges
        const zSep = 0.05 * s;      // separator lines
        const railThick = 0.08 * s;  // thick enough that bottom face stays above z=0

        // Power rail stripes
        const railW = boardW - pitch;
        const railH = 0.3 * s;

        ElectronicsLab.appendBox(mb, 0, topVccY, zRail,
            railW, railH, railThick, COL.bbRail[0], COL.bbRail[1], COL.bbRail[2], 1, 0);
        ElectronicsLab.appendBox(mb, 0, topGndY, zRail,
            railW, railH, railThick, COL.bbRailGnd[0], COL.bbRailGnd[1], COL.bbRailGnd[2], 1, 0);
        ElectronicsLab.appendBox(mb, 0, botGndY, zRail,
            railW, railH, railThick, COL.bbRailGnd[0], COL.bbRailGnd[1], COL.bbRailGnd[2], 1, 0);
        ElectronicsLab.appendBox(mb, 0, botVccY, zRail,
            railW, railH, railThick, COL.bbRail[0], COL.bbRail[1], COL.bbRail[2], 1, 0);

        // Center divider groove (recessed channel between row e and f)
        const dividerW = railW;
        const dividerH = 1.2 * s;
        const dividerD = 0.5 * s;
        // Groove sunk into the board - top face below z=0
        ElectronicsLab.appendBox(mb, 0, 0, -dividerD / 2 - 0.1 * s,
            dividerW, dividerH, dividerD,
            0.55, 0.50, 0.44, 1, 0);
        // Raised edges sit above surface
        const edgeH = 0.15 * s;
        ElectronicsLab.appendBox(mb, 0, dividerH / 2, zDiv,
            dividerW, edgeH, 0.1 * s, 0.72, 0.68, 0.62, 1, 0);
        ElectronicsLab.appendBox(mb, 0, -dividerH / 2, zDiv,
            dividerW, edgeH, 0.1 * s, 0.72, 0.68, 0.62, 1, 0);

        // Power rail separator lines
        const sepH = 0.1 * s;
        const topSepY = topGndY - pitch * 0.6;
        const botSepY = botGndY + pitch * 0.6;
        ElectronicsLab.appendBox(mb, 0, topSepY, zSep,
            dividerW, sepH, 0.08 * s, 0.65, 0.60, 0.54, 1, 0);
        ElectronicsLab.appendBox(mb, 0, botSepY, zSep,
            dividerW, sepH, 0.08 * s, 0.65, 0.60, 0.54, 1, 0);

        // Holes: dark recessed cylinders, like real breadboards
        // Sunk well below surface to avoid z-fighting
        const holeR = 0.3 * s;
        const holeDepth = 0.4 * s;
        const holeSurface = -0.05 * s; // start slightly below board surface
        const holeSegs = 8;
        const holeCol = [0.08, 0.06, 0.05]; // very dark, high contrast against light board

        // Main area holes (rows a-j, centered layout)
        for (let r = 0; r < rows && r < 10; r++) {
            const ly = this.rowY(r);
            for (let c = 0; c < cols; c++) {
                const lx = (c - (cols - 1) / 2) * pitch;
                ElectronicsLab.appendCylinder(mb, lx, ly, holeSurface,
                    -holeDepth, 0, holeR,
                    holeCol[0], holeCol[1], holeCol[2], 1, 0, holeSegs, true);
            }
        }

        // Power rail holes
        const railYs = [topVccY, topGndY, botGndY, botVccY];
        for (const ry of railYs) {
            for (let c = 0; c < cols; c++) {
                const lx = (c - (cols - 1) / 2) * pitch;
                ElectronicsLab.appendCylinder(mb, lx, ry, holeSurface,
                    -holeDepth, 0, holeR,
                    holeCol[0], holeCol[1], holeCol[2], 1, 0, holeSegs, true);
            }
        }

        // Column group separators (every 5 columns)
        for (let c = 5; c < cols; c += 5) {
            const lx = (c - (cols - 1) / 2) * pitch - pitch / 2;
            const topHalfH = (topSepY - dividerH / 2) - 0.5 * s;
            if (topHalfH > 0) {
                const topHalfY = dividerH / 2 + topHalfH / 2;
                ElectronicsLab.appendBox(mb, lx, topHalfY, zSep,
                    0.08 * s, topHalfH, 0.06 * s, 0.70, 0.66, 0.60, 1, 0);
            }
            const botHalfH = (-dividerH / 2 - botSepY) - 0.5 * s;
            if (botHalfH > 0) {
                const botHalfY = -dividerH / 2 - botHalfH / 2;
                ElectronicsLab.appendBox(mb, lx, botHalfY, zSep,
                    0.08 * s, botHalfH, 0.06 * s, 0.70, 0.66, 0.60, 1, 0);
            }
        }

        mb.updateMesh();

        this.bbObject = global.scene.createSceneObject("__bb");
        this.bbObject.setParent(this.sceneObject);
        const rmv = this.bbObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;

        // Collider for the breadboard
        const collider = this.bbObject.createComponent("Physics.ColliderComponent") as ColliderComponent;
        const shape = Shape.createBoxShape();
        shape.size = new vec3(boardW, boardH, boardD + 2 * s);
        collider.shape = shape;

    }

    // Breadboard connectivity: which net does grid cell (col, row) belong to?
    // Rail rows: -2 = VCC top, -1 = GND top, bbRows = GND bot, bbRows+1 = VCC bot
    private cellToNet(col: number, row: number): string {
        if (row === -2) return 'rail_vcc_top';
        if (row === -1) return 'rail_gnd_top';
        if (row === this.bbRows) return 'rail_gnd_bot';
        if (row === this.bbRows + 1) return 'rail_vcc_bot';

        if (row >= 0 && row < 5) return 'col_' + col + '_top';
        if (row >= 5 && row < this.bbRows) return 'col_' + col + '_bot';
        return 'floating';
    }

    // Map grid row to Y position using centered layout
    private gridRowToY(row: number): number {
        if (row === -2) return CircuitSim.RAIL_VCC_OFFSET * this.bbPitch;
        if (row === -1) return CircuitSim.RAIL_GND_OFFSET * this.bbPitch;
        if (row === this.bbRows) return -CircuitSim.RAIL_GND_OFFSET * this.bbPitch;
        if (row === this.bbRows + 1) return -CircuitSim.RAIL_VCC_OFFSET * this.bbPitch;
        return this.rowY(row);
    }

    private gridToWorld(col: number, row: number): vec3 {
        const parentPos = this.sceneObject.getTransform().getWorldPosition();
        return new vec3(
            parentPos.x + (col - (this.bbCols - 1) / 2) * this.bbPitch,
            parentPos.y + this.gridRowToY(row),
            parentPos.z
        );
    }

    private worldToGrid(worldPos: vec3): { col: number; row: number } {
        const parentPos = this.sceneObject.getTransform().getWorldPosition();
        const dx = worldPos.x - parentPos.x;
        const dy = worldPos.y - parentPos.y;
        const col = Math.round(dx / this.bbPitch + (this.bbCols - 1) / 2);

        // Find closest row by checking all rows + rail rows
        let bestRow = 0;
        let bestDist = Infinity;
        const candidates = [-2, -1];
        for (let r = 0; r < this.bbRows; r++) candidates.push(r);
        candidates.push(this.bbRows, this.bbRows + 1);

        for (const r of candidates) {
            const ry = this.gridRowToY(r);
            const dist = Math.abs(dy - ry);
            if (dist < bestDist) {
                bestDist = dist;
                bestRow = r;
            }
        }

        return { col, row: bestRow };
    }

    private isValidCell(col: number, row: number): boolean {
        return col >= 0 && col < this.bbCols &&
            (row >= -2 && row <= this.bbRows + 1);
    }

    private cellKey(col: number, row: number): string {
        return col + ',' + row;
    }

    // ==================================================================
    //  Component Palette (properly spaced)
    // ==================================================================

    private buildPalette(): void {
        const templates: Array<{ type: string; config: any }> = [
            { type: 'resistor', config: { label: '220R', value: 220 } },
            { type: 'resistor', config: { label: '1K', value: 1000 } },
            { type: 'led', config: { label: 'LED', color: 'red' } },
            { type: 'led', config: { label: 'LED', color: 'amber' } },
            { type: 'capacitor', config: { label: '100nF', value: '100nF' } },
        ];

        templates.push({ type: 'jumper', config: { label: 'Wire', color: 'red', span: 5 } });

        if (this.includeVSource) {
            templates.push({ type: 'vsource', config: { label: '3.3V', voltage: 3.3 } });
        }

        const paletteParent = global.scene.createSceneObject("__palette");
        paletteParent.setParent(this.sceneObject);

        // Position palette to the left of the breadboard
        const bbW = (this.bbCols + 1) * this.bbPitch;
        paletteParent.getTransform().setLocalPosition(
            new vec3(-bbW / 2 - 12 * this.scale, 0, 0)
        );

        // Spacing: 10 * scale between each template for clear separation
        const spacing = 10 * this.scale;
        const totalHeight = (templates.length - 1) * spacing;

        for (let i = 0; i < templates.length; i++) {
            const tmpl = templates[i];
            const obj = this.buildTemplateComponent(tmpl.type, tmpl.config, i);
            obj.setParent(paletteParent);

            const yPos = totalHeight / 2 - i * spacing;
            obj.getTransform().setLocalPosition(new vec3(0, yPos, 0));

            this.setupGrabbable(obj, (e: InteractorEvent) => {
                this.onPaletteGrab(tmpl.type, tmpl.config, e);
            });
            this.paletteTemplates.push({ type: tmpl.type, config: tmpl.config, sceneObject: obj });
        }

        print("[CircuitSim] Palette: " + templates.length + " templates, spacing=" + spacing.toFixed(1) + "cm");
    }

    // Build a resistor with beige body, higher segment count for smoother look
    private buildResistorGeometry(mb: MeshBuilder, s: number, value: number, tag: number = 0): void {
        const bodyLen = 3.5 * s;
        const bodyR = 1.0 * s;
        const leadLen = 3.0 * s;
        const leadR = 0.15 * s;
        const totalLen = bodyLen + leadLen * 2;
        const segs = CircuitSim.RESISTOR_SEGS;
        const bz = bodyR;
        const COL = ElectronicsLab.COL;
        const [br, bg, bb] = CircuitSim.RESISTOR_BODY;

        // Leads
        ElectronicsLab.appendCylinder(mb, 0, 0, bz,
            -totalLen / 2, -bodyLen / 2, leadR,
            COL.resistorLead[0], COL.resistorLead[1], COL.resistorLead[2], 1, 0, segs, false, tag);
        ElectronicsLab.appendCylinder(mb, 0, 0, bz,
            bodyLen / 2, totalLen / 2, leadR,
            COL.resistorLead[0], COL.resistorLead[1], COL.resistorLead[2], 1, 0, segs, false, tag);

        // Downward legs
        ElectronicsLab.appendCylinder(mb, -totalLen / 2, 0, 0,
            0, bz, leadR,
            COL.resistorLead[0], COL.resistorLead[1], COL.resistorLead[2], 1, 0, 8, true, tag);
        ElectronicsLab.appendCylinder(mb, totalLen / 2, 0, 0,
            0, bz, leadR,
            COL.resistorLead[0], COL.resistorLead[1], COL.resistorLead[2], 1, 0, 8, true, tag);

        // Body: beige cylinder with higher segment count for smoothness
        ElectronicsLab.appendCylinder(mb, 0, 0, bz,
            -bodyLen / 2, bodyLen / 2, bodyR,
            br, bg, bb, 1, 0, segs, false, tag);

        // End caps (slightly rounded look: small hemispheres at body ends)
        ElectronicsLab.appendHemisphere(mb, 0, 0, bz, bodyR * 0.3, br, bg, bb, 6, tag);

        // Color bands
        const bands = ElectronicsLab.resistorBands(value);
        const bandW = bodyLen * 0.06;
        const bandPositions = [-0.35, -0.2, -0.05, 0.25];
        for (let bi = 0; bi < bands.length && bi < 4; bi++) {
            const [cr, cg, cb] = bands[bi];
            const bx = bandPositions[bi] * bodyLen;
            ElectronicsLab.appendCylinder(mb, 0, 0, bz,
                bx - bandW, bx + bandW, bodyR + 0.03 * s,
                cr, cg, cb, 1, 0, segs, false, tag);
        }
    }

    private buildTemplateComponent(type: string, config: any, _index: number): SceneObject {
        const mb = ElectronicsLab.newMB();
        const s = this.scale;
        const pitch = this.bbPitch;
        const COL = ElectronicsLab.COL;

        switch (type) {
            case 'resistor': {
                this.buildResistorGeometry(mb, s, config.value || 1000);
                break;
            }
            case 'led': {
                const color = config.color || 'red';
                const [colR, colG, colB] = ElectronicsLab.ledColor(color);
                const baseR = 1.5 * s;
                const baseH = 1.0 * s;
                const domeR = 1.5 * s;

                ElectronicsLab.appendCylinder(mb, 0, 0, 0,
                    0, baseH, baseR,
                    colR * 0.6, colG * 0.6, colB * 0.6, 1, 0, 8, true, 1);
                ElectronicsLab.appendHemisphere(mb, 0, 0, baseH,
                    domeR, colR, colG, colB, 8, 1);
                break;
            }
            case 'capacitor': {
                const bodyR = 1.2 * s;
                const bodyH = 2.5 * s;
                ElectronicsLab.appendCylinder(mb, 0, 0, 0,
                    0, bodyH, bodyR,
                    COL.capBody[0], COL.capBody[1], COL.capBody[2], 1, 0, 8, true);
                break;
            }
            case 'jumper': {
                const span = (config.span || 5) * this.bbPitch;
                const wireR = 0.3 * s;
                const [jr, jg, jb] = this.jumperColor(config.color || 'red');
                ElectronicsLab.appendCylinder(mb, 0, 0, 0.5 * s,
                    -span / 2, span / 2, wireR,
                    jr, jg, jb, 1, 0, 6, false);
                // End caps as small vertical legs
                ElectronicsLab.appendCylinder(mb, -span / 2, 0, 0,
                    0, 0.5 * s, wireR * 0.8,
                    jr * 0.7, jg * 0.7, jb * 0.7, 1, 0, 6, true);
                ElectronicsLab.appendCylinder(mb, span / 2, 0, 0,
                    0, 0.5 * s, wireR * 0.8,
                    jr * 0.7, jg * 0.7, jb * 0.7, 1, 0, 6, true);
                break;
            }
            case 'vsource': {
                const sz = 2.0 * s;
                ElectronicsLab.appendBox(mb, 0, 0, sz / 2,
                    sz * 2, sz, sz,
                    0.88, 0.20, 0.15, 1, 0);
                break;
            }
        }

        mb.updateMesh();

        const obj = global.scene.createSceneObject("__tmpl_" + type);
        const rmv = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.boardMaterial) rmv.mainMaterial = this.boardMaterial;

        this.addLabel(obj, config.label || type, 4 * this.scale);

        return obj;
    }

    // ==================================================================
    //  SIK Grabbable Setup (Interactable + InteractableManipulation + Collider)
    // ==================================================================

    private setupGrabbable(
        obj: SceneObject,
        onGrab: (e: InteractorEvent) => void,
        onRelease?: (e: InteractorEvent) => void,
    ): void {
        // Physics collider (box AABB)
        const collider = obj.createComponent("Physics.ColliderComponent") as ColliderComponent;
        const shape = Shape.createBoxShape();
        shape.size = new vec3(8 * this.scale, 5 * this.scale, 5 * this.scale);
        collider.shape = shape;

        // SIK Interactable (hover + trigger events)
        const interactable = obj.createComponent(Interactable.getTypeName()) as Interactable;

        // SIK InteractableManipulation (handles transform tracking during drag)
        obj.createComponent(InteractableManipulation.getTypeName()) as InteractableManipulation;

        interactable.onTriggerStart((e: InteractorEvent) => {
            onGrab(e);
        });

        if (onRelease) {
            interactable.onTriggerEnd((e: InteractorEvent) => {
                onRelease(e);
            });
        }
    }

    // ==================================================================
    //  Grab & Place
    // ==================================================================

    private onPaletteGrab(type: string, config: any, e: InteractorEvent): void {
        const placed = this.createPlacedComponent(type, { ...config });
        if (!placed) return;

        this.dragging = placed;

        const worldPos = e.interactor?.targetHitInfo?.hit?.position;
        if (worldPos) {
            placed.sceneObject.getTransform().setWorldPosition(worldPos);
        }

        print("[CircuitSim] Grabbed " + type + " from palette -> " + placed.id);
    }

    private createPlacedComponent(type: string, config: any): PlacedComponent | null {
        const id = type + '_' + (this.nextCompId++);
        const simIdx = this.nextSimIndex++;

        const mb = ElectronicsLab.newMB();
        const s = this.scale;
        const pitch = this.bbPitch;
        const COL = ElectronicsLab.COL;
        const tag = simIdx; // sim-driven tag (>=1.0)

        const pins = new Map<string, { col: number; row: number }>();

        switch (type) {
            case 'resistor': {
                this.buildResistorGeometry(mb, s, config.value || 1000, tag);
                pins.set('1', { col: -2, row: 0 });
                pins.set('2', { col: 2, row: 0 });
                break;
            }
            case 'led': {
                const color = config.color || 'red';
                const [colR, colG, colB] = ElectronicsLab.ledColor(color);
                const baseR = 1.5 * s;
                const baseH = 1.0 * s;
                const domeR = 1.5 * s;
                const leadSpacing = 1.27 * s;
                const leadR = 0.15 * s;
                const leadLen = 4.0 * s;

                ElectronicsLab.appendCylinder(mb, 0, 0, 0,
                    0, baseH, baseR,
                    colR * 0.6, colG * 0.6, colB * 0.6, 1, 0, 8, true, tag);
                ElectronicsLab.appendHemisphere(mb, 0, 0, baseH,
                    domeR, colR, colG, colB, 8, tag);
                ElectronicsLab.appendCylinder(mb, -leadSpacing, 0, 0,
                    -leadLen, 0, leadR,
                    COL.resistorLead[0], COL.resistorLead[1], COL.resistorLead[2], 1, 0, 6, true, tag);
                ElectronicsLab.appendCylinder(mb, leadSpacing, 0, 0,
                    -leadLen * 0.8, 0, leadR,
                    COL.resistorLead[0], COL.resistorLead[1], COL.resistorLead[2], 1, 0, 6, true, tag);

                pins.set('anode', { col: -1, row: 0 });
                pins.set('cathode', { col: 1, row: 0 });
                break;
            }
            case 'capacitor': {
                const bodyR = 1.2 * s;
                const bodyH = 2.5 * s;
                const leadSpacing = 1.27 * s;
                const leadR = 0.15 * s;
                const leadLen = 3.0 * s;

                ElectronicsLab.appendCylinder(mb, 0, 0, 0,
                    0, bodyH, bodyR,
                    COL.capBody[0], COL.capBody[1], COL.capBody[2], 1, 0, 8, true, tag);
                ElectronicsLab.appendCylinder(mb, -leadSpacing, 0, 0,
                    -leadLen, 0, leadR,
                    COL.capLead[0], COL.capLead[1], COL.capLead[2], 1, 0, 6, true, tag);
                ElectronicsLab.appendCylinder(mb, leadSpacing, 0, 0,
                    -leadLen, 0, leadR,
                    COL.capLead[0], COL.capLead[1], COL.capLead[2], 1, 0, 6, true, tag);

                pins.set('1', { col: -1, row: 0 });
                pins.set('2', { col: 1, row: 0 });
                break;
            }
            case 'jumper': {
                const spanCols = config.span || 5;
                const spanW = spanCols * this.bbPitch;
                const wireR = 0.3 * s;
                const [jr, jg, jb] = this.jumperColor(config.color || 'red');
                ElectronicsLab.appendCylinder(mb, 0, 0, 0.5 * s,
                    -spanW / 2, spanW / 2, wireR,
                    jr, jg, jb, 1, 0, 6, false, tag);
                ElectronicsLab.appendCylinder(mb, -spanW / 2, 0, 0,
                    0, 0.5 * s, wireR * 0.8,
                    jr * 0.7, jg * 0.7, jb * 0.7, 1, 0, 6, true, tag);
                ElectronicsLab.appendCylinder(mb, spanW / 2, 0, 0,
                    0, 0.5 * s, wireR * 0.8,
                    jr * 0.7, jg * 0.7, jb * 0.7, 1, 0, 6, true, tag);

                const halfSpan = Math.floor(spanCols / 2);
                pins.set('1', { col: -halfSpan, row: 0 });
                pins.set('2', { col: halfSpan, row: 0 });
                break;
            }
            case 'vsource': {
                const sz = 2.0 * s;
                ElectronicsLab.appendBox(mb, 0, 0, sz / 2,
                    sz * 2, sz, sz,
                    0.88, 0.20, 0.15, 1, 0, tag);

                pins.set('+', { col: -1, row: 0 });
                pins.set('-', { col: 1, row: 0 });
                break;
            }
        }

        mb.updateMesh();

        const obj = global.scene.createSceneObject("__placed_" + id);
        obj.setParent(this.sceneObject);
        const rmv = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();

        let mat: Material | null = null;
        if (this.boardMaterial) {
            mat = this.boardMaterial.clone();
            rmv.mainMaterial = mat;
        }

        const compRef = { id };

        this.setupGrabbable(
            obj,
            (_e: InteractorEvent) => { this.onPlacedGrab(compRef.id); },
            (_e: InteractorEvent) => { this.onPlacedRelease(); },
        );

        this.addLabel(obj, config.label || id, 4 * this.scale);

        const placed: PlacedComponent = {
            id, type, gridCol: -999, gridRow: -999,
            config, sceneObject: obj, material: mat,
            simIndex: simIdx, pins, solverIds: [],
        };

        this.placed.set(id, placed);
        return placed;
    }

    private onPlacedGrab(compId: string): void {
        const comp = this.placed.get(compId);
        if (!comp) return;

        this.unregisterFromGrid(comp);
        this.dragging = comp;
        print("[CircuitSim] Picked up " + compId);
    }

    private onPlacedRelease(): void {
        if (!this.dragging) return;

        const comp = this.dragging;
        this.dragging = null;

        // Snap to nearest grid cell
        const worldPos = comp.sceneObject.getTransform().getWorldPosition();
        const grid = this.worldToGrid(worldPos);

        // Validate: all pin positions must be valid and unoccupied
        let valid = true;
        for (const [, pinOffset] of comp.pins) {
            const pc = grid.col + pinOffset.col;
            const pr = grid.row + pinOffset.row;
            if (!this.isValidCell(pc, pr) || this.occupancy.has(this.cellKey(pc, pr))) {
                valid = false;
                break;
            }
        }

        if (!valid) {
            const found = this.findNearestValidPosition(grid.col, grid.row, comp);
            if (found) {
                grid.col = found.col;
                grid.row = found.row;
                valid = true;
            }
        }

        if (valid) {
            comp.gridCol = grid.col;
            comp.gridRow = grid.row;
            this.registerOnGrid(comp);

            // Hard snap to grid position
            const snapPos = this.gridToWorld(grid.col, grid.row);
            comp.sceneObject.getTransform().setWorldPosition(snapPos);

            print("[CircuitSim] Snapped " + comp.id + " to grid (" + grid.col + "," + grid.row + ")");

            this.onTopologyChanged();
        } else {
            comp.sceneObject.destroy();
            this.placed.delete(comp.id);
            print("[CircuitSim] No valid position, removed " + comp.id);
        }
    }

    private findNearestValidPosition(col: number, row: number, comp: PlacedComponent): { col: number; row: number } | null {
        for (let radius = 1; radius <= 5; radius++) {
            for (let dc = -radius; dc <= radius; dc++) {
                for (let dr = -radius; dr <= radius; dr++) {
                    if (Math.abs(dc) !== radius && Math.abs(dr) !== radius) continue;
                    const c = col + dc;
                    const r = row + dr;
                    let ok = true;
                    for (const [, pinOffset] of comp.pins) {
                        const pc = c + pinOffset.col;
                        const pr = r + pinOffset.row;
                        if (!this.isValidCell(pc, pr) || this.occupancy.has(this.cellKey(pc, pr))) {
                            ok = false;
                            break;
                        }
                    }
                    if (ok) return { col: c, row: r };
                }
            }
        }
        return null;
    }

    private registerOnGrid(comp: PlacedComponent): void {
        for (const [, pinOffset] of comp.pins) {
            const key = this.cellKey(comp.gridCol + pinOffset.col, comp.gridRow + pinOffset.row);
            this.occupancy.add(key);
        }
    }

    private unregisterFromGrid(comp: PlacedComponent): void {
        for (const [, pinOffset] of comp.pins) {
            const key = this.cellKey(comp.gridCol + pinOffset.col, comp.gridRow + pinOffset.row);
            this.occupancy.delete(key);
        }
        comp.gridCol = -999;
        comp.gridRow = -999;
    }

    // ==================================================================
    //  Topology -> Netlist -> Solve
    // ==================================================================

    private onTopologyChanged(): void {
        const nets = this.buildNetlist();
        this.runSolver(nets);
        this.rebuildWires(nets);
        this.updateSimVisuals();
    }

    private buildNetlist(): Map<string, BreadboardNet> {
        const nets = new Map<string, BreadboardNet>();

        for (const [, comp] of this.placed) {
            if (comp.gridCol < -100) continue;

            for (const [pinName, pinOffset] of comp.pins) {
                const absCol = comp.gridCol + pinOffset.col;
                const absRow = comp.gridRow + pinOffset.row;
                const netName = this.cellToNet(absCol, absRow);

                if (!nets.has(netName)) {
                    nets.set(netName, { name: netName, pins: [] });
                }
                nets.get(netName)!.pins.push({ compId: comp.id, pinName });
            }
        }

        return nets;
    }

    private runSolver(nets: Map<string, BreadboardNet>): void {
        this.solver.clear();

        const gndNets = new Set(['rail_gnd_top', 'rail_gnd_bot']);

        for (const [, comp] of this.placed) {
            if (comp.gridCol < -100) continue;
            comp.solverIds = [];

            const pinNets = new Map<string, string>();
            for (const [pinName, pinOffset] of comp.pins) {
                const absCol = comp.gridCol + pinOffset.col;
                const absRow = comp.gridRow + pinOffset.row;
                let netName = this.cellToNet(absCol, absRow);
                if (gndNets.has(netName)) netName = 'gnd';
                pinNets.set(pinName, netName);
            }

            switch (comp.type) {
                case 'resistor': {
                    const n1 = pinNets.get('1') || 'floating_' + comp.id + '_1';
                    const n2 = pinNets.get('2') || 'floating_' + comp.id + '_2';
                    const eid = this.solver.addResistor(n1, n2, comp.config.value || 1000);
                    comp.solverIds.push(eid);
                    break;
                }
                case 'led': {
                    const nA = pinNets.get('anode') || 'floating_' + comp.id + '_a';
                    const nC = pinNets.get('cathode') || 'floating_' + comp.id + '_c';
                    const vf = comp.config.vForward || 1.8;
                    const eid = this.solver.addLED(nA, nC, vf, 10);
                    comp.solverIds.push(eid);
                    break;
                }
                case 'capacitor': {
                    const n1 = pinNets.get('1') || 'floating_' + comp.id + '_1';
                    const n2 = pinNets.get('2') || 'floating_' + comp.id + '_2';
                    const eid = this.solver.addCapacitor(n1, n2, 0);
                    comp.solverIds.push(eid);
                    break;
                }
                case 'jumper': {
                    const n1 = pinNets.get('1') || 'floating_' + comp.id + '_1';
                    const n2 = pinNets.get('2') || 'floating_' + comp.id + '_2';
                    const eid = this.solver.addWire(n1, n2);
                    comp.solverIds.push(eid);
                    break;
                }
                case 'vsource': {
                    const nP = pinNets.get('+') || 'floating_' + comp.id + '_p';
                    const nM = pinNets.get('-') || 'floating_' + comp.id + '_m';
                    const eid = this.solver.addVoltageSource(nP, nM, comp.config.voltage || 3.3);
                    comp.solverIds.push(eid);
                    break;
                }
            }
        }

        this.lastResult = this.solver.solve();

        if (this.lastResult.valid) {
            print("[CircuitSim] Solved: " + this.lastResult.nodeVoltages.size + " nodes");
            for (const [name, v] of this.lastResult.nodeVoltages) {
                if (name === 'gnd') continue;
                print("  " + name + " = " + v.toFixed(3) + "V");
            }
        } else {
            print("[CircuitSim] Solver error: " + (this.lastResult.error || "unknown"));
        }
    }

    // ==================================================================
    //  Wire auto-generation
    // ==================================================================

    private rebuildWires(nets: Map<string, BreadboardNet>): void {
        if (this.wireObject) {
            this.wireObject.destroy();
            this.wireObject = null;
        }

        const CIRC = 6;
        const wireR = 0.3 * this.scale;
        const wires: Array<{ from: vec3; to: vec3; hue: number }> = [];

        for (const [, net] of nets) {
            if (net.pins.length < 2) continue;

            const positions: vec3[] = [];
            for (const pin of net.pins) {
                const comp = this.placed.get(pin.compId);
                if (!comp || comp.gridCol < -100) continue;
                const pinOffset = comp.pins.get(pin.pinName);
                if (!pinOffset) continue;
                positions.push(this.gridToWorld(
                    comp.gridCol + pinOffset.col,
                    comp.gridRow + pinOffset.row
                ));
            }

            if (positions.length < 2) continue;

            for (let i = 0; i < positions.length - 1; i++) {
                wires.push({ from: positions[i], to: positions[i + 1], hue: 0.15 });
            }
        }

        if (wires.length === 0) return;

        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
            { name: "texture1", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;

        const circX: number[] = [], circY: number[] = [];
        for (let j = 0; j < CIRC; j++) {
            const theta = (j / CIRC) * Math.PI * 2;
            circX.push(Math.cos(theta));
            circY.push(Math.sin(theta));
        }

        for (let wi = 0; wi < wires.length; wi++) {
            const wire = wires[wi];
            const dx = wire.to.x - wire.from.x;
            const dy = wire.to.y - wire.from.y;
            const dz = wire.to.z - wire.from.z;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len < 0.001) continue;

            const tx = dx / len, ty = dy / len, tz = dz / len;
            const abstz = tz < 0 ? -tz : tz;
            const ux = abstz > 0.99 ? 1 : 0;
            const uz = abstz > 0.99 ? 0 : 1;

            let rx = -uz * ty, ry = uz * tx - ux * tz, rz = ux * ty;
            const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
            if (rLen < 0.001) continue;
            rx /= rLen; ry /= rLen; rz /= rLen;

            const bx = ty * rz - tz * ry;
            const by = tz * rx - tx * rz;
            const bz = tx * ry - ty * rx;

            const base = mb.getVerticesCount();
            for (let ring = 0; ring < 2; ring++) {
                const t = ring;
                const cx = wire.from.x + dx * t;
                const cy = wire.from.y + dy * t;
                const cz = wire.from.z + dz * t;

                for (let j = 0; j < CIRC; j++) {
                    const ox = (circX[j] * rx + circY[j] * bx) * wireR;
                    const oy = (circX[j] * ry + circY[j] * by) * wireR;
                    const oz = (circX[j] * rz + circY[j] * bz) * wireR;
                    mb.appendVerticesInterleaved([
                        cx + ox, cy + oy, cz + oz,
                        circX[j] * rx + circY[j] * bx,
                        circX[j] * ry + circY[j] * by,
                        circX[j] * rz + circY[j] * bz,
                        t, wi, 0, 0,
                    ]);
                }
            }

            mb.appendVerticesInterleaved([
                wire.from.x, wire.from.y, wire.from.z,
                -tx, -ty, -tz, 0, wi, 0, 0,
            ]);
            mb.appendVerticesInterleaved([
                wire.to.x, wire.to.y, wire.to.z,
                tx, ty, tz, 1, wi, 0, 0,
            ]);

            for (let j = 0; j < CIRC; j++) {
                const j1 = (j + 1) % CIRC;
                const a = base + j, b = base + j1;
                const c = base + CIRC + j, d = base + CIRC + j1;
                mb.appendIndices([a, b, d, a, d, c]);
            }

            const capS = base + 2 * CIRC;
            const capE = base + 2 * CIRC + 1;
            for (let j = 0; j < CIRC; j++) {
                const j1 = (j + 1) % CIRC;
                mb.appendIndices([capS, base + j1, base + j]);
                mb.appendIndices([capE, base + CIRC + j, base + CIRC + j1]);
            }
        }

        this.wireCount = wires.length;
        mb.updateMesh();

        this.wireObject = global.scene.createSceneObject("__sim_wires");
        this.wireObject.setParent(this.sceneObject);
        const rmv = this.wireObject.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.wireMaterial) rmv.mainMaterial = this.wireMaterial;

        this.createWireTexture(wires);
    }

    private createWireTexture(wires: Array<{ from: vec3; to: vec3; hue: number }>): void {
        const texH = 256;
        const tex = ProceduralTextureProvider.createWithFormat(1, texH, TextureFormat.RGBA8Unorm);
        this.wireTexProvider = tex.control as ProceduralTextureProvider;
        this.wirePixels = new Uint8Array(1 * texH * 4);

        for (let i = 0; i < wires.length && i < texH; i++) {
            const row = i * 4;
            this.wirePixels[row + 0] = 0xFF;
            this.wirePixels[row + 1] = 0xFF;
            const hv = Math.round(Math.max(0, Math.min(1, wires[i].hue)) * 65535);
            this.wirePixels[row + 2] = (hv >> 8) & 0xFF;
            this.wirePixels[row + 3] = hv & 0xFF;
        }

        this.wireTexProvider.setPixels(0, 0, 1, texH, this.wirePixels);

        if (this.wireMaterial) {
            this.wireMaterial.mainPass["traceTex"] = tex;
            this.wireMaterial.mainPass["NumTraces"] = texH;
        }
    }

    // ==================================================================
    //  Sim data texture
    // ==================================================================

    private createSimTexture(): void {
        const texH = CircuitSim.MAX_SIM_ROWS;
        const tex = ProceduralTextureProvider.createWithFormat(1, texH, TextureFormat.RGBA8Unorm);
        this.simTexProvider = tex.control as ProceduralTextureProvider;
        this.simPixels = new Uint8Array(1 * texH * 4);

        if (this.boardMaterial) {
            this.boardMaterial.mainPass["simTex"] = tex;
            this.boardMaterial.mainPass["SimTexHeight"] = texH;
            this.boardMaterial.mainPass["GlobalGrowth"] = 0.0;
        }
    }

    private updateSimVisuals(): void {
        if (!this.lastResult || !this.lastResult.valid) return;
        if (!this.simPixels || !this.simTexProvider) return;

        const result = this.lastResult;

        for (const [, comp] of this.placed) {
            if (comp.simIndex <= 0 || comp.simIndex >= CircuitSim.MAX_SIM_ROWS) continue;
            const row = (comp.simIndex - 1) * 4;

            let brightness = 0;
            let heat = 0;

            for (const eid of comp.solverIds) {
                const current = result.branchCurrents.get(eid) || 0;
                const power = result.branchPower.get(eid) || 0;

                switch (comp.type) {
                    case 'led':
                        brightness = Math.max(brightness, Math.min(1, Math.abs(current) / 0.020));
                        break;
                    case 'resistor':
                        heat = Math.max(heat, Math.min(1, power / 0.5));
                        break;
                }
            }

            this.simPixels[row + 0] = Math.round(brightness * 255);
            this.simPixels[row + 1] = Math.round(heat * 255);
            this.simPixels[row + 2] = 255;
            this.simPixels[row + 3] = 0;
        }

        this.simTexProvider.setPixels(0, 0, 1, CircuitSim.MAX_SIM_ROWS, this.simPixels);
    }

    // ==================================================================
    //  Update loop
    // ==================================================================

    private onUpdate(): void {
        const dt = getDeltaTime();
        this.time += dt;

        // Materialization growth
        if (!this.growthDone) {
            this.globalGrowth = Math.min(1, this.globalGrowth + dt * 1.5);
            if (this.boardMaterial) {
                this.boardMaterial.mainPass["GlobalGrowth"] = this.globalGrowth;
            }
            if (this.globalGrowth >= 1) this.growthDone = true;
        }
    }

    // ==================================================================
    //  Helpers
    // ==================================================================

    private jumperColor(color: string): [number, number, number] {
        switch (color) {
            case 'red':    return [0.90, 0.15, 0.10];
            case 'black':  return [0.25, 0.22, 0.20];
            case 'yellow': return [0.90, 0.85, 0.10];
            case 'blue':   return [0.15, 0.40, 0.90];
            case 'white':  return [0.90, 0.88, 0.82];
            case 'orange': return [0.90, 0.45, 0.10];
            default:       return [0.90, 0.15, 0.10];
        }
    }

    private addLabel(parent: SceneObject, text: string, zOffset: number): void {
        const labelObj = global.scene.createSceneObject("__label");
        labelObj.setParent(parent);
        labelObj.getTransform().setLocalPosition(new vec3(0, 0, zOffset));

        try {
            const textComp = labelObj.createComponent("Component.Text") as Text;
            textComp.depthTest = false;
            textComp.renderOrder = 100;
            if (this.labelFont) (textComp as any).font = this.labelFont;
            textComp.size = 48;
            textComp.horizontalAlignment = HorizontalAlignment.Center;
            textComp.verticalAlignment = VerticalAlignment.Center;
            textComp.textFill.color = new vec4(0.94, 0.94, 0.91, 1.0);
            const outline = textComp.outlineSettings;
            outline.enabled = true;
            outline.size = 0.15;
            outline.fill.color = new vec4(0, 0, 0, 1);
            textComp.text = text;
        } catch (e: any) {
            print("[CircuitSim] Text error: " + e.message);
        }
    }

    // ==================================================================
    //  Preset Circuit
    // ==================================================================

    private presetCircuit(): void {
        // Working LED circuit: 3.3V -> 220R -> LED -> GND
        // Expected: (3.3 - 1.8) / 220 = ~6.8mA, LED at ~34% brightness
        //
        // Layout (all on col 5-11):
        //   VCC rail (row -2): voltage source + pin, red jumper pin 1
        //   GND rail (row -1): voltage source - pin, black jumper pin 2
        //   Row c (row 2, top half): resistor pin 1 at col 5, pin 2 at col 9
        //   Row h (row 7, bot half): LED anode at col 9, cathode at col 11
        //   Jumpers bridge rails to grid and top-half to bottom-half

        // 3.3V voltage source: + on VCC rail, - on GND rail (same column)
        this.placePresetComponent('vsource', { label: '3.3V', voltage: 3.3 }, 2, -2,
            new Map([
                ['+', { col: 0, row: 0 }],
                ['-', { col: 0, row: 1 }],
            ]));

        // Red jumper: VCC rail (row -2) to row a (row 0), col 5
        this.placePresetComponent('jumper', { label: 'VCC', color: 'red', span: 1 }, 5, -2,
            new Map([
                ['1', { col: 0, row: 0 }],
                ['2', { col: 0, row: 2 }],
            ]));

        // 220R resistor at row c (row 2): pin 1 at col 5, pin 2 at col 9
        this.placePresetComponent('resistor', { label: '220R', value: 220 }, 7, 2);

        // Orange jumper: col 9 top half (row 2) to col 9 bottom half (row 7)
        this.placePresetComponent('jumper', { label: 'Bridge', color: 'orange', span: 1 }, 9, 2,
            new Map([
                ['1', { col: 0, row: 0 }],
                ['2', { col: 0, row: 5 }],
            ]));

        // Red LED at row h (row 7): anode at col 9, cathode at col 11
        this.placePresetComponent('led', { label: 'LED', color: 'red' }, 10, 7);

        // Black jumper: col 11 bottom half (row 7) to GND rail (row -1)
        this.placePresetComponent('jumper', { label: 'GND', color: 'black', span: 1 }, 11, 7,
            new Map([
                ['1', { col: 0, row: 0 }],
                ['2', { col: 0, row: -8 }],
            ]));

        this.onTopologyChanged();
        print("[CircuitSim] Preset LED circuit: 3.3V -> 220R -> LED -> GND");
    }

    private placePresetComponent(
        type: string, config: any,
        col: number, row: number,
        pinOverrides?: Map<string, { col: number; row: number }>
    ): PlacedComponent | null {
        const placed = this.createPlacedComponent(type, { ...config });
        if (!placed) return null;

        // Override pin offsets if provided
        if (pinOverrides) {
            placed.pins = pinOverrides;
        }

        placed.gridCol = col;
        placed.gridRow = row;
        this.registerOnGrid(placed);

        // Snap to world position
        const snapPos = this.gridToWorld(col, row);
        placed.sceneObject.getTransform().setWorldPosition(snapPos);

        return placed;
    }

    // ==================================================================
    //  Public API
    // ==================================================================

    public getPlacedComponents(): Map<string, PlacedComponent> {
        return this.placed;
    }

    public getLastResult(): SolverResult | null {
        return this.lastResult;
    }

    public removeComponent(id: string): void {
        const comp = this.placed.get(id);
        if (!comp) return;
        this.unregisterFromGrid(comp);
        comp.sceneObject.destroy();
        this.placed.delete(id);
        this.onTopologyChanged();
    }

    public resetWorkbench(): void {
        for (const [, comp] of this.placed) {
            comp.sceneObject.destroy();
        }
        this.placed.clear();
        this.occupancy.clear();
        this.nextCompId = 0;
        this.nextSimIndex = 1;
        if (this.wireObject) {
            this.wireObject.destroy();
            this.wireObject = null;
        }
        this.lastResult = null;
        print("[CircuitSim] Workbench reset");
    }
}
