/**
 * CircuitButton.ts — RectangleButton subclass with Tron theme.
 *
 * Extends UIKit RectangleButton directly (like CircuitFrame extends Frame).
 * Forces Ghost style + Tron color overrides. No polling, no grey flash.
 * Single component replaces both RectangleButton + old CircuitButton.
 *
 * All SIK interaction inherited: 6-state FSM, audio, collider,
 * toggle, tooltips, Z-depth push, scale bounce.
 *
 * Setup:
 *   1. Attach CircuitButton to a SceneObject (replaces RectangleButton)
 *   2. Set label text, variant, size in inspector
 */

import { RectangleButton } from 'SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton';
import { StateEvent } from 'SpectaclesUIKit.lspkg/Scripts/Utility/InteractableStateMachine';
import { TextLayout, TextMetricsConfig } from '../Common/FlexText';

// =====================================================================
// TEXT COLORS PER STATE
// =====================================================================

// Theme palette (ghost-white / bright-sky / jade-green) — Spectacles renders
// black as transparent so we never use near-black, and grey reads as transparent
// to the eye on the additive display so we never use grey for text either.
var TEXT_IDLE      = new vec4(0.984, 0.984, 1.000, 1.0);  // ghost-white
var TEXT_HOVER     = new vec4(0.984, 0.984, 1.000, 1.0);  // ghost-white
var TEXT_TRIGGERED = new vec4(0.125, 0.749, 0.333, 1.0);  // jade-green
var TEXT_TOGGLED   = new vec4(0.125, 0.749, 0.333, 1.0);  // jade-green
var TEXT_INACTIVE  = new vec4(0.984, 0.984, 1.000, 0.45); // ghost-white dim

@component
export class CircuitButton extends RectangleButton {

    // ── Label ──

    @input @hint("Button label text")
    label: string = "BUTTON";

    @input @hint("Label font size")
    labelSize: number = 48;

    @input @allowUndefined
    @hint("Font (optional, uses system default)")
    font: Font;

    // ── Visual ──

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Default", "default"),
        new ComboBoxItem("Destructive", "destructive"),
        new ComboBoxItem("Ghost", "ghost")
    ]))
    @hint("Tron color variant")
    variant: string = "default";

    @input @hint("Border thickness (cm)")
    tronBorderSize: number = 0.12;

    @input @hint("Corner radius (cm, 0 = keep UIKit default)")
    tronCornerRadius: number = 0;

    // ── Runtime ──
    private textComp: any = null;
    private hovered: boolean = false;
    private hoverFlowTime: number = 0;
    // Period (seconds) for one full sweep of the white highlight across the border.
    private static HOVER_FLOW_PERIOD: number = 1.4;

    // SnapOS2 style lookup uses constructor.name as key.
    // Override so it finds "RectangleButton" styles, not "CircuitButton".
    get typeString(): string { return "RectangleButton"; }

    onAwake() {
        this._style = "Ghost";
        super.onAwake();
        // Best-effort: super.onAwake may have created the visual already.
        // Apply skin immediately so the very first frame renders with the
        // correct theme — no flicker between UIKit defaults and Tron colors.
        if (this._visual) this.applySkin();
    }

    // Skin at visual creation time — before any frame renders
    protected createDefaultVisual(): void {
        super.createDefaultVisual();
        this.applySkin();
    }

    initialize() {
        super.initialize();
        // Re-apply after initialize since setState may have overwritten our colors
        this.applySkin();
        this.ensureTextLabel();
        this.setTextColor(TEXT_IDLE);

        // Final settle: re-apply once after the state machine has driven any
        // post-init state transitions on the next tick. This guards against
        // UIKit overwriting our gradients when it lands on its initial state.
        var self = this;
        var settleEv = self.createEvent("UpdateEvent");
        settleEv.bind(function() {
            self.applySkin();
            settleEv.enabled = false;
        });

        // Continuous tick: when hovered, slide a white highlight across the
        // border so the focused element pulls the eye. This is the only effect
        // that needs per-frame updates.
        var flowEv = self.createEvent("UpdateEvent");
        flowEv.bind(function() {
            if (!self.hovered) return;
            self.hoverFlowTime += getDeltaTime();
            self.applyHoverFlowGradient();
        });
    }

    // =====================================================================
    // SKIN — applied once during initialize, no polling needed
    // =====================================================================

    private applySkin() {
        var v = this._visual as any;
        if (!v) return;

        // Kill ALL background gradients via the public setters so the visual
        // marks itself dirty (needsVisualStateUpdate). Direct private-field
        // writes here would skip dirtying — see "first-hover flicker" below.
        v.defaultIsBaseGradient = false;
        v.hoverIsBaseGradient = false;
        v.triggeredIsBaseGradient = false;
        v.inactiveIsBaseGradient = false;
        v.toggledDefaultIsBaseGradient = false;
        v.toggledHoverIsBaseGradient = false;
        v.toggledTriggeredIsBaseGradient = false;

        // Belt-and-suspenders: also write empty gradient objects so any path
        // that ignores the boolean toggle (e.g. UIKit's Ghost preset re-asserts
        // its own gradient) renders nothing. Without this, taps end up with a
        // post-hover bright fill that never clears.
        var blankGrad = {
            enabled: false,
            start: new vec2(0, 0),
            end: new vec2(0, 0),
            stop0: { enabled: false, percent: 0,   color: new vec4(0, 0, 0, 0) },
            stop1: { enabled: false, percent: 0.5, color: new vec4(0, 0, 0, 0) },
            stop2: { enabled: false, percent: 1,   color: new vec4(0, 0, 0, 0) },
        };
        try {
            v.defaultGradient = blankGrad;
            v.hoverGradient = blankGrad;
            v.triggeredGradient = blankGrad;
            v.toggledDefaultGradient = blankGrad;
            v.toggledHoverGradient = blankGrad;
            v.toggledTriggeredGradient = blankGrad;
            v.inactiveGradient = blankGrad;
        } catch (e) {}

        // Lock scale across every state so the button doesn't grow/shrink as
        // it transitions between default → hover → toggled.
        try {
            v.defaultShouldScale = false;
            v.hoverShouldScale = false;
            v.triggeredShouldScale = false;
            v.toggledDefaultShouldScale = false;
            v.toggledHoverShouldScale = false;
            v.toggledTriggeredShouldScale = false;
            v.inactiveShouldScale = false;
        } catch (e) {}

        if (this.variant === "ghost") {
            this.applyGhost(v);
        } else if (this.variant === "destructive") {
            this.applyDestructive(v);
        } else {
            this.applyDefault(v);
        }

        // Border gradients — themed.
        //   selected (toggled)  → jade-green ↔ ghost-white  (the focused state)
        //   hover/triggered     → bright-sky ↔ ghost-white
        //   idle/inactive       → bright-sky dim
        var jadeBorderGrad = {
            enabled: true,
            start: new vec2(-1, 0),
            end: new vec2(1, 0),
            stop0: { enabled: true, percent: 0,   color: new vec4(0.125, 0.749, 0.333, 1) },
            stop1: { enabled: true, percent: 0.5, color: new vec4(0.984, 0.984, 1.000, 1) },
            stop2: { enabled: true, percent: 1,   color: new vec4(0.125, 0.749, 0.333, 1) },
        };
        var skyBorderGrad = {
            enabled: true,
            start: new vec2(-1, 0),
            end: new vec2(1, 0),
            stop0: { enabled: true, percent: 0,   color: new vec4(0.004, 0.729, 0.937, 1) },
            stop1: { enabled: true, percent: 0.5, color: new vec4(0.984, 0.984, 1.000, 1) },
            stop2: { enabled: true, percent: 1,   color: new vec4(0.004, 0.729, 0.937, 1) },
        };
        var dimBorderGrad = {
            enabled: true,
            start: new vec2(-1, 0),
            end: new vec2(1, 0),
            stop0: { enabled: true, percent: 0,   color: new vec4(0.004, 0.729, 0.937, 0.55) },
            stop1: { enabled: true, percent: 0.5, color: new vec4(0.004, 0.729, 0.937, 0.85) },
            stop2: { enabled: true, percent: 1,   color: new vec4(0.004, 0.729, 0.937, 0.55) },
        };
        try {
            v.borderDefaultGradient = dimBorderGrad;
            v.borderHoverGradient = skyBorderGrad;
            v.borderTriggeredGradient = skyBorderGrad;
            v.borderToggledDefaultGradient = jadeBorderGrad;
            v.borderToggledHoverGradient = jadeBorderGrad;
            v.borderToggledTriggeredGradient = jadeBorderGrad;
            v.borderInactiveGradient = dimBorderGrad;
        } catch (e) {}

        // Geometry overrides
        v.hasBorder = true;
        v.borderSize = this.tronBorderSize;
        if (this.tronCornerRadius > 0) {
            v.cornerRadius = this.tronCornerRadius;
        }

        // Force the visual to re-snapshot its per-state property table and
        // re-apply the current state. Without this the state map captured at
        // initialize() time keeps the UIKit Ghost preset values, and the
        // visual only refreshes after the first hover→exit transition (which
        // is what produced the "background changes after first hover" flash).
        try {
            if (typeof v.updateVisualStates === "function") {
                v.updateVisualStates();
            }
            var sn = (this as any).stateName;
            if (sn !== undefined) {
                (this as any).setState(sn);
            }
        } catch (e) {}
    }

    // Circulate a white highlight around the border, going one direction.
    // The gradient axis (start→end) rotates around the button origin; the
    // highlight stop sits off-center at percent 0.2 so the bright spot rides
    // the rotating axis and traces a circle around the button rather than
    // bouncing across it.
    private applyHoverFlowGradient(): void {
        var v = this._visual as any;
        if (!v) return;

        var period = CircuitButton.HOVER_FLOW_PERIOD;
        var phase = (this.hoverFlowTime % period) / period;             // 0..1 monotonic
        var angle = phase * Math.PI * 2;                                // counterclockwise
        var ax = Math.cos(angle);
        var ay = Math.sin(angle);

        var isToggled = !!(this as any).isOn;
        var base = isToggled
            ? new vec4(0.125, 0.749, 0.333, 1.0)  // jade-green
            : new vec4(0.004, 0.729, 0.937, 1.0); // bright-sky
        var highlight = new vec4(0.984, 0.984, 1.0, 1.0); // ghost-white

        // Highlight at percent 0.2 along the gradient line traces a circle of
        // radius 0.6 around the origin as the axis rotates: with start=-axis,
        // end=+axis, the position 0.8·start + 0.2·end = -0.6·axis.
        var grad = {
            enabled: true,
            start: new vec2(-ax, -ay),
            end:   new vec2( ax,  ay),
            stop0: { enabled: true, percent: 0.00, color: base },
            stop1: { enabled: true, percent: 0.20, color: highlight },
            stop2: { enabled: true, percent: 1.00, color: base },
        };

        try {
            if (isToggled) v.borderToggledHoverGradient = grad;
            else           v.borderHoverGradient = grad;
        } catch (e) {}
        // Nudge UIKit to re-read the gradient (assignment alone doesn't always
        // mark the visual dirty). Re-applying the current state is cheap and
        // matches what applySkin does for the same reason.
        try {
            var sn = (this as any).stateName;
            if (sn !== undefined && typeof (this as any).setState === "function") {
                (this as any).setState(sn);
            }
        } catch (e) {}
    }

    // ── DEFAULT — bright-sky / jade theme ──

    private applyDefault(v: any) {
        // Backgrounds fully transparent — UIKit's RoundedRectangleVisual maps
        // toggledDefault → baseTriggeredColor (a quirk of the Visual class), so
        // any non-zero alpha on these "fills" leaks across states. Border-only
        // styling sidesteps the whole problem.
        var clear = new vec4(0, 0, 0, 0);
        v.baseDefaultColor          = clear;
        v.baseHoverColor            = clear;
        v.baseTriggeredColor        = clear;
        v.baseToggledDefaultColor   = clear;
        v.baseToggledHoverColor     = clear;
        v.baseToggledTriggeredColor = clear;
        v.baseInactiveColor         = clear;

        // Borders: vivid theme colors, jade marks "selected" so the focused
        // board button is unambiguous.
        v.borderDefaultColor          = new vec4(0.004, 0.729, 0.937, 0.85);
        v.borderHoverColor            = new vec4(0.004, 0.729, 0.937, 1.00);
        v.borderTriggeredColor        = new vec4(0.984, 0.984, 1.000, 1.00);
        v.borderToggledDefaultColor   = new vec4(0.125, 0.749, 0.333, 1.00);
        v.borderToggledHoverColor     = new vec4(0.125, 0.749, 0.333, 1.00);
        v.borderToggledTriggeredColor = new vec4(0.984, 0.984, 1.000, 1.00);
        v.borderInactiveColor         = new vec4(0.004, 0.729, 0.937, 0.40);
    }

    // ── DESTRUCTIVE — red ──

    private applyDestructive(v: any) {
        v.baseDefaultColor         = new vec4(0.12, 0.04, 0.04, 1.0);
        v.baseHoverColor           = new vec4(0.18, 0.06, 0.04, 1.0);
        v.baseTriggeredColor       = new vec4(0.22, 0.04, 0.02, 1.0);
        v.baseToggledDefaultColor  = new vec4(0.18, 0.06, 0.04, 1.0);
        v.baseToggledHoverColor    = new vec4(0.22, 0.06, 0.04, 1.0);
        v.baseToggledTriggeredColor = new vec4(0.22, 0.04, 0.02, 1.0);
        v.baseInactiveColor        = new vec4(0.06, 0.04, 0.04, 0.5);

        v.borderDefaultColor          = new vec4(0.50, 0.10, 0.06, 1.0);
        v.borderHoverColor            = new vec4(0.85, 0.15, 0.08, 1.0);
        v.borderTriggeredColor        = new vec4(1.00, 0.25, 0.10, 1.0);
        v.borderToggledDefaultColor   = new vec4(0.85, 0.15, 0.08, 1.0);
        v.borderToggledHoverColor     = new vec4(1.00, 0.25, 0.10, 1.0);
        v.borderToggledTriggeredColor = new vec4(1.00, 0.25, 0.10, 1.0);
        v.borderInactiveColor         = new vec4(0.18, 0.08, 0.08, 0.3);
    }

    // ── GHOST — transparent bg, border only — themed ──

    private applyGhost(v: any) {
        // All-transparent backgrounds; same border palette as default variant.
        var clear = new vec4(0, 0, 0, 0);
        v.baseDefaultColor          = clear;
        v.baseHoverColor            = clear;
        v.baseTriggeredColor        = clear;
        v.baseToggledDefaultColor   = clear;
        v.baseToggledHoverColor     = clear;
        v.baseToggledTriggeredColor = clear;
        v.baseInactiveColor         = clear;

        v.borderDefaultColor          = new vec4(0.004, 0.729, 0.937, 0.85);
        v.borderHoverColor            = new vec4(0.004, 0.729, 0.937, 1.00);
        v.borderTriggeredColor        = new vec4(0.984, 0.984, 1.000, 1.00);
        v.borderToggledDefaultColor   = new vec4(0.125, 0.749, 0.333, 1.00);
        v.borderToggledHoverColor     = new vec4(0.125, 0.749, 0.333, 1.00);
        v.borderToggledTriggeredColor = new vec4(0.984, 0.984, 1.000, 1.00);
        v.borderInactiveColor         = new vec4(0.004, 0.729, 0.937, 0.40);
    }

    // =====================================================================
    // TEXT LABEL
    // =====================================================================

    private ensureTextLabel() {
        var obj = this.getSceneObject();
        this.textComp = this.findTextInChildren(obj);

        if (!this.textComp) {
            var textObj = global.scene.createSceneObject("CircuitBtn_Label");
            textObj.setParent(obj);
            textObj.getTransform().setLocalPosition(new vec3(0, 0, 0.5));
            this.textComp = textObj.createComponent("Component.Text") as any;
            this.textComp.horizontalAlignment = HorizontalAlignment.Center;
            this.textComp.verticalAlignment = VerticalAlignment.Center;
        }

        if (this.font) this.textComp.font = this.font;
        this.applyFittedLabel(this.label);
    }

    private applyFittedLabel(text: string) {
        if (!this.textComp) return;

        // 70% of inner width keeps a comfortable margin so labels never
        // touch the border. Floor at 35% of labelSize so we can shrink hard
        // on long labels ("Arduino Nano", "ATtiny85 USB") before wrapping.
        var btnW = 0;
        if (this._visual && (this._visual as any)._size) {
            btnW = (this._visual as any)._size.x * 0.7;
        }
        if (btnW <= 0) btnW = 5;

        var fontName = "";
        if (this.font) { try { fontName = (this.font as any).name || ""; } catch (e) {} }
        var cfg = TextLayout.configForFont(fontName);

        var result = TextLayout.wrap(text, this.labelSize, btnW, true,
            Math.max(8, Math.floor(this.labelSize * 0.35)), cfg);
        this.textComp.text = TextLayout.joinLines(result.lines);
        this.textComp.size = result.effectiveFontSize;
    }

    private findTextInChildren(obj: SceneObject): any {
        var tc = obj.getComponent("Component.Text");
        if (tc) return tc;
        for (var i = 0; i < obj.getChildrenCount(); i++) {
            tc = this.findTextInChildren(obj.getChild(i));
            if (tc) return tc;
        }
        return null;
    }

    private setTextColor(color: vec4) {
        if (!this.textComp) return;
        var tc = this.textComp as any;
        if (tc.textFill && tc.textFill.color !== undefined) {
            tc.textFill.color = color;
        } else if (tc.textColor !== undefined) {
            tc.textColor = color;
        }
    }

    // =====================================================================
    // SIK TEXT COLOR EVENTS — inherited Interactable drives these
    // =====================================================================

    // Override Element state handlers for text color changes
    protected onHoverEnterHandler(e: StateEvent) {
        super.onHoverEnterHandler(e);
        this.setTextColor(TEXT_HOVER);
        this.hovered = true;
        this.hoverFlowTime = 0;
        this.applyHoverFlowGradient();
    }

    protected onHoverExitHandler(e: StateEvent) {
        super.onHoverExitHandler(e);
        this.setTextColor(TEXT_IDLE);
        this.hovered = false;
        // Restore the static gradient. UIKit reads borderDefaultGradient on
        // state transition out of hover, so we just re-apply the skin to make
        // sure our base gradients (jade / sky) are the source of truth again.
        this.applySkin();
    }

    protected onTriggerDownHandler(e: StateEvent) {
        super.onTriggerDownHandler(e);
        this.setTextColor(TEXT_TRIGGERED);
    }

    protected onTriggerUpHandler(e: StateEvent) {
        super.onTriggerUpHandler(e);
        this.setTextColor(TEXT_IDLE);
    }

    // =====================================================================
    // PUBLIC API
    // =====================================================================

    setLabel(text: string) {
        this.label = text;
        this.applyFittedLabel(text);
    }

    getLabel(): string { return this.label; }
}
