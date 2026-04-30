/**
 * CircuitRoundButton.ts — RoundButton subclass with Tron theme + icon.
 *
 * Extends UIKit RoundButton directly (like CircuitButton extends RectangleButton).
 * Forces Ghost style + Tron color overrides. Displays an icon texture on a
 * child plane mesh, swappable at runtime via setIcon().
 *
 * All SIK interaction inherited: 6-state FSM, audio, collider,
 * toggle, tooltips, Z-depth push, scale bounce.
 *
 * Setup:
 *   1. Attach CircuitRoundButton to a SceneObject (replaces RoundButton)
 *   2. Set icon texture in inspector
 */

import { RoundButton } from 'SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton';
import { StateEvent } from 'SpectaclesUIKit.lspkg/Scripts/Utility/InteractableStateMachine';

// =====================================================================
// ICON TINT PER STATE
// =====================================================================

var ICON_IDLE      = new vec4(0.75, 0.72, 0.70, 1.0);
var ICON_HOVER     = new vec4(0.95, 0.90, 0.88, 1.0);
var ICON_TRIGGERED = new vec4(0.00, 0.50, 1.00, 1.0);
var ICON_TOGGLED   = new vec4(0.00, 0.50, 1.00, 1.0);
var ICON_INACTIVE  = new vec4(0.40, 0.38, 0.38, 0.5);

@component
export class CircuitRoundButton extends RoundButton {

    @input @allowUndefined
    @hint("Icon texture (white on transparent)")
    icon: Texture;

    @input @allowUndefined
    @hint("Alternate icon when toggled on (e.g. mic-off)")
    iconToggled: Texture;

    @input @allowUndefined
    @hint("Flat/unlit material to clone for icon rendering")
    iconMaterial: Material;

    @input @hint("Icon scale relative to button width (0-1)")
    @widget(new SliderWidget(0.1, 1.0, 0.05))
    iconScale: number = 0.5;

    // ── Runtime ──
    private iconMat: Material = null;
    private iconRmv: RenderMeshVisual = null;

    // SnapOS2 style lookup uses constructor.name as key.
    // Override so it finds "RoundButton" styles, not "CircuitRoundButton".
    get typeString(): string { return "RoundButton"; }

    onAwake() {
        this._style = "Ghost";
        super.onAwake();
    }

    protected createDefaultVisual(): void {
        super.createDefaultVisual();
        this.applySkin();
    }

    initialize() {
        super.initialize();
        this.applySkin();
        this.buildIcon();
    }

    // =====================================================================
    // SKIN
    // =====================================================================

    private applySkin() {
        var v = this._visual as any;
        if (!v) return;

        // Kill ALL background gradients
        (v as any)._defaultIsBaseGradient = false;
        (v as any)._hoverIsBaseGradient = false;
        (v as any)._triggeredIsBaseGradient = false;
        (v as any)._inactiveIsBaseGradient = false;
        (v as any)._toggledDefaultIsBaseGradient = false;
        (v as any)._toggledHoverIsBaseGradient = false;
        (v as any)._toggledTriggeredIsBaseGradient = false;

        // Ghost-style backgrounds (transparent)
        v.baseDefaultColor         = new vec4(0, 0, 0, 0);
        v.baseHoverColor           = new vec4(0.04, 0.06, 0.12, 0.4);
        v.baseTriggeredColor       = new vec4(0.04, 0.08, 0.16, 0.6);
        v.baseToggledDefaultColor  = new vec4(0.04, 0.06, 0.12, 0.3);
        v.baseToggledHoverColor    = new vec4(0.06, 0.08, 0.14, 0.5);
        v.baseToggledTriggeredColor = new vec4(0.04, 0.08, 0.16, 0.6);
        v.baseInactiveColor        = new vec4(0, 0, 0, 0);

        // Borders
        v.borderDefaultColor          = new vec4(0.20, 0.24, 0.32, 0.6);
        v.borderHoverColor            = new vec4(0.00, 0.50, 1.00, 1.0);
        v.borderTriggeredColor        = new vec4(0.10, 0.90, 1.00, 1.0);
        v.borderToggledDefaultColor   = new vec4(0.00, 0.50, 1.00, 0.8);
        v.borderToggledHoverColor     = new vec4(0.10, 0.90, 1.00, 1.0);
        v.borderToggledTriggeredColor = new vec4(0.10, 0.90, 1.00, 1.0);
        v.borderInactiveColor         = new vec4(0.12, 0.14, 0.18, 0.2);

        // Border gradients
        var accentBorderGrad = {
            enabled: true,
            start: new vec2(-1, 0), end: new vec2(1, 0),
            stop0: { enabled: true, percent: 0, color: new vec4(0.00, 0.50, 1.00, 1) },
            stop1: { enabled: true, percent: 0.5, color: new vec4(0.10, 0.90, 1.00, 1) },
            stop2: { enabled: true, percent: 1, color: new vec4(0.00, 0.50, 1.00, 1) }
        };
        var dimBorderGrad = {
            enabled: true,
            start: new vec2(-1, 0), end: new vec2(1, 0),
            stop0: { enabled: true, percent: 0, color: new vec4(0.20, 0.24, 0.32, 1) },
            stop1: { enabled: true, percent: 0.5, color: new vec4(0.14, 0.18, 0.24, 1) },
            stop2: { enabled: true, percent: 1, color: new vec4(0.20, 0.24, 0.32, 1) }
        };
        try {
            v.borderDefaultGradient = dimBorderGrad;
            v.borderHoverGradient = accentBorderGrad;
            v.borderTriggeredGradient = accentBorderGrad;
            v.borderToggledDefaultGradient = accentBorderGrad;
            v.borderToggledHoverGradient = accentBorderGrad;
            v.borderToggledTriggeredGradient = accentBorderGrad;
            v.borderInactiveGradient = dimBorderGrad;
        } catch (e) {}

        v.hasBorder = true;
        v.borderSize = 0.12;
    }

    // =====================================================================
    // ICON
    // =====================================================================

    private buildIcon(): void {
        if (!this.icon) return;

        var obj = global.scene.createSceneObject("CircuitRndBtn_Icon");
        obj.setParent(this.getSceneObject());
        obj.getTransform().setLocalPosition(new vec3(0, 0, 0.3));

        // Scale icon relative to button width
        var s = (this.width || 3) * this.iconScale;
        obj.getTransform().setLocalScale(new vec3(s, s, 1));

        // Plane mesh for icon quad
        var mb = new MeshBuilder([
            { name: "position",  components: 3 },
            { name: "normal",    components: 3 },
            { name: "texture0",  components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;
        mb.appendVerticesInterleaved([
            -0.5, -0.5, 0,  0, 0, 1,  0, 1,
             0.5, -0.5, 0,  0, 0, 1,  1, 1,
             0.5,  0.5, 0,  0, 0, 1,  1, 0,
            -0.5,  0.5, 0,  0, 0, 1,  0, 0,
        ]);
        mb.appendIndices([0, 1, 2, 0, 2, 3]);
        mb.updateMesh();

        var rmv = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();

        // Clone the input material for the icon, or use RMV default
        var mat: Material = null;
        if (this.iconMaterial) {
            mat = this.iconMaterial.clone();
        } else if (rmv.mainMaterial) {
            mat = rmv.mainMaterial.clone();
        }
        if (!mat) return;
        try { mat.mainPass.blendMode = BlendMode.PremultipliedAlpha; } catch (e) {}
        try { mat.mainPass.depthTest = true; } catch (e) {}
        try { mat.mainPass.depthWrite = false; } catch (e) {}
        try { mat.mainPass.baseTex = this.icon; } catch (e) {}
        try { mat.mainPass.baseColor = ICON_IDLE; } catch (e) {}
        rmv.mainMaterial = mat;

        this.iconMat = mat;
        this.iconRmv = rmv;
    }

    private setIconTint(color: vec4): void {
        if (this.iconMat) {
            this.iconMat.mainPass.baseColor = color;
        }
    }

    // =====================================================================
    // STATE HANDLERS — icon tint on hover/trigger
    // =====================================================================

    protected onHoverEnterHandler(e: StateEvent) {
        super.onHoverEnterHandler(e);
        this.setIconTint(ICON_HOVER);
    }

    protected onHoverExitHandler(e: StateEvent) {
        super.onHoverExitHandler(e);
        this.setIconTint(this.isOn ? ICON_TOGGLED : ICON_IDLE);
    }

    protected onTriggerDownHandler(e: StateEvent) {
        super.onTriggerDownHandler(e);
        this.setIconTint(ICON_TRIGGERED);
    }

    protected onTriggerUpHandler(e: StateEvent) {
        super.onTriggerUpHandler(e);
        // Swap icon texture on toggle if alternate provided
        if (this.iconToggled && this.iconMat) {
            var nowOn = this.isOn;
            this.iconMat.mainPass.baseTex = nowOn ? this.iconToggled : this.icon;
        }
        this.setIconTint(this.isOn ? ICON_TOGGLED : ICON_IDLE);
    }

    // =====================================================================
    // PUBLIC API
    // =====================================================================

    setIcon(tex: Texture): void {
        this.icon = tex;
        if (this.iconMat) this.iconMat.mainPass.baseTex = tex;
    }

    setToggledIcon(tex: Texture): void {
        this.iconToggled = tex;
    }
}
