/**
 * ConnectorTube.ts — Manhattan-routed tube connector between two SceneObjects.
 *
 * Builds a parametric tube mesh with hemisphere caps (via TubeMeshFactory).
 * The vertex shader (ConnectorShader.js) evaluates a 5-segment piecewise
 * Manhattan route with fillet arcs at corners:
 *   horizontal exit → fillet arc → perpendicular → fillet arc → horizontal entry
 *
 * Vertex encoding:
 *   texture0 = (localX, localY) unit circle cross-section coords
 *   texture1 = (t, isBody) parametric position + body/cap flag
 *
 * Two usage modes:
 *   Inspector: wire objectA, objectB, material in the inspector
 *   Programmatic: call initRuntime(material, anchorA, anchorB) after adding component
 *
 * Ported from augmented-lerobot (FlowPanel dependency removed).
 */

import { buildTubeMesh } from '../../Common/TubeMeshFactory';

@component
export class ConnectorTube extends BaseScriptComponent {

    @input
    @hint("Material with ConnectorShader.js Code Node")
    @allowUndefined
    material: Material;

    @input
    @hint("Start object (tube exits from here)")
    @allowUndefined
    objectA: SceneObject;

    @input
    @hint("End object (tube enters here)")
    @allowUndefined
    objectB: SceneObject;

    @input @hint("Tube cross-section radius in cm")
    tubeRadius: number = 0.12;

    @input @hint("Corner fillet radius (smaller = tighter bends)")
    bendRadius: number = 2.5;

    @input @hint("Segments along tube length (more = smoother arcs)")
    lengthSegments: number = 48;

    @input @hint("Segments around tube circumference")
    radialSegments: number = 8;

    @input @hint("Hemisphere cap ring count (0 = flat caps)")
    capRings: number = 3;

    @input @hint("Parametric clip [0-1]: tube visible up to this t")
    clipT: number = 1.0;

    private mainPass: any = null;
    private rmv: RenderMeshVisual = null;
    private ready: boolean = false;

    onAwake(): void {
        // Defer init so that programmatic property assignment before OnStart works
        this.createEvent("OnStartEvent").bind(() => this.init());
        this.createEvent("UpdateEvent").bind(() => this.onUpdate());
    }

    private init(): void {
        if (this.ready) return;

        var mat = this.material;
        if (!mat) return;

        var mesh = buildTubeMesh(this.lengthSegments, this.radialSegments, this.capRings);
        if (mesh) {
            this.rmv = this.getSceneObject().createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            this.rmv.mesh = mesh;
            var cloned = mat.clone();
            this.rmv.mainMaterial = cloned;
            this.mainPass = cloned.mainPass;
        }

        this.ready = true;
        print("[ConnectorTube] Ready — " + this.getSceneObject().name);
    }

    /**
     * Programmatic init: call this after createComponent to set material and anchors
     * before the OnStartEvent fires. Can also be called after start to hot-swap.
     */
    initRuntime(mat: Material, anchorA: SceneObject, anchorB: SceneObject): void {
        this.material = mat;
        this.objectA  = anchorA;
        this.objectB  = anchorB;
        // If OnStart already fired, rebuild now
        if (this.ready) {
            this.ready = false;
            this.init();
        }
    }

    private onUpdate(): void {
        if (!this.ready || !this.mainPass) return;
        if (!this.objectA || !this.objectB) return;

        var inv = this.getSceneObject().getTransform().getInvertedWorldTransform();
        var posA = inv.multiplyPoint(this.objectA.getTransform().getWorldPosition());
        var posB = inv.multiplyPoint(this.objectB.getTransform().getWorldPosition());

        this.mainPass.PointAx = posA.x;
        this.mainPass.PointAy = posA.y;
        this.mainPass.PointAz = posA.z;
        this.mainPass.PointBx = posB.x;
        this.mainPass.PointBy = posB.y;
        this.mainPass.PointBz = posB.z;
        this.mainPass.TubeRadius  = this.tubeRadius;
        this.mainPass.BendRadius  = this.bendRadius;
        this.mainPass.ClipT       = this.clipT;
    }

    // ── Public API ──

    /** Set clip fraction (0 = fully hidden, 1 = fully visible) */
    setClipT(value: number): void {
        this.clipT = value;
        if (this.mainPass) this.mainPass.ClipT = value;
    }

    getClipT(): number { return this.clipT; }

    /** Update endpoint anchors at runtime */
    setTargets(a: SceneObject, b: SceneObject): void {
        this.objectA = a;
        this.objectB = b;
    }

    /** Set tube color scheme */
    setColors(base: vec3, tip: vec3, glow: vec3): void {
        if (!this.mainPass) return;
        this.mainPass.ColorBase = base;
        this.mainPass.ColorTip  = tip;
        this.mainPass.ColorGlow = glow;
    }

    /** Set explicit exit direction at PointA (0,0,0 = auto) */
    setExitDir(dx: number, dy: number, dz: number): void {
        if (!this.mainPass) return;
        this.mainPass.ExitDx = dx;
        this.mainPass.ExitDy = dy;
        this.mainPass.ExitDz = dz;
    }

    isReady(): boolean { return this.ready; }
}
