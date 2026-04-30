/**
 * CircuitDetailPanel.ts — Secondary info panel for Circuit Board Explorer.
 *
 * Spawned below CircuitPanel when a board is selected.
 * Connected to the main panel via a ConnectorTube-style curve.
 *
 * Shows: board description, layer info, signal flow toggle, close button.
 * Has outBack scale-in entrance and scale-out dismissal.
 *
 * Setup: attach to a SceneObject that also has a UIKit Frame component.
 * CircuitPanel instantiates this from a prefab — do not place manually.
 */

import { TextLayout, TextMetricsConfig } from '../Common/FlexText';
import { outBack } from '../Common/Easing';
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { getBoardDisplayName, getBoardMeta } from '../Board/BoardCatalog';

var Z_TEXT = 0.5;
var Z_BTN  = 0.4;

type ItemKind = "title" | "subtitle" | "divider" | "row" | "spacer";

interface PanelItem {
    kind: ItemKind;
    obj: SceneObject;
    tc: any;
    text: string;
    fontSize: number;
    color: vec4;
    height: number;
}

@component
export class CircuitDetailPanel extends BaseScriptComponent {

    @input @allowUndefined
    @hint("Font for all text")
    font: Font;

    @input
    @hint("Prefab: UIKit RectangleButton with CircuitButton script")
    buttonPrefab: ObjectPrefab;

    @input @hint("Panel width (cm)")
    panelWidth: number = 36;

    @input @hint("Panel height (cm)")
    panelHeight: number = 14;

    @input @hint("Inner padding (cm)")
    padding: number = 1.8;

    @input @hint("Gap between items (cm)")
    gap: number = 0.6;

    // ---- Callbacks ----
    onClose: () => void;

    // ---- State ----
    private built: boolean = false;
    private frame: any = null;
    private items: PanelItem[] = [];
    private fontCfg: TextMetricsConfig = new TextMetricsConfig();
    private currentKb: any = null;

    // Scale animation
    private scaleT: number = 0;
    private scaleDir: number = 0;     // +1 = growing in, -1 = shrinking out
    private scaleDuration: number = 0.35;

    // Signal flow state
    private signalFlowOn: boolean = false;
    private signalFlowBtnObj: SceneObject | null = null;

    onAwake(): void {
        // Defer build so Frame component is ready
        this.createEvent("OnStartEvent").bind(() => this.build());
        this.createEvent("UpdateEvent").bind((e: UpdateEvent) => this.tick(getDeltaTime()));
    }

    private build(): void {
        if (this.built) return;
        this.built = true;

        var root = this.sceneObject;

        // Disable until show() is called
        root.enabled = false;

        // Find Frame
        var comps = root.getComponents("Component.ScriptComponent") as any[];
        for (var i = 0; i < comps.length; i++) {
            var sc = comps[i] as any;
            if (sc.innerSize !== undefined && sc.useBillboarding !== undefined) {
                this.frame = sc;
                break;
            }
        }

        if (this.frame) {
            this.frame.innerSize = new vec2(this.panelWidth, this.panelHeight);
            this.frame.autoShowHide = false;
            this.frame.allowTranslation = false;
            this.frame.useBillboarding = false;  // billboards with parent (CircuitPanel)

            var self = this;
            this.frame.onScalingUpdate.add(function() {
                var w = self.frame.innerSize.x;
                var h = self.frame.innerSize.y;
                self.panelWidth = w; self.panelHeight = h;
                self.reflowAll();
            });
        }

        var fontName = "";
        if (this.font) { try { fontName = (this.font as any).name || ""; } catch (e) {} }
        this.fontCfg = TextLayout.configForFont(fontName);

        this.buildLayout(root);
        this.reflowAll();
        print("[CircuitDetailPanel] Built");
    }

    // =====================================================================
    // LAYOUT
    // =====================================================================

    private buildLayout(root: SceneObject): void {
        var amber   = new vec4(0.94, 0.60, 0.18, 1.0);
        var dim     = new vec4(0.50, 0.54, 0.60, 1.0);
        var body    = new vec4(0.78, 0.82, 0.88, 1.0);

        // Title placeholder — filled in show()
        this.addText(root, "title",    "BOARD INFO", 42, amber);
        this.addText(root, "subtitle", "Loading...", 22, dim);
        this.addDivider(root);
        this.addText(root, "subtitle", "", 20, body);  // description body
        this.addDivider(root);

        // Action row: Signal Flow + Close
        this.addActionRow(root);
        this.addSpacer(root);
    }

    private addText(parent: SceneObject, kind: ItemKind, text: string, fontSize: number, color: vec4): void {
        var obj = global.scene.createSceneObject("DP_" + kind);
        obj.setParent(parent);
        var tc = obj.createComponent("Component.Text") as any;
        tc.horizontalAlignment = HorizontalAlignment.Center;
        tc.verticalAlignment = VerticalAlignment.Center;
        try { tc.textFill.color = color; } catch (e) { tc.textColor = color; }
        tc.size = fontSize;
        if (this.font) tc.font = this.font;
        this.items.push({ kind, obj, tc, text, fontSize, color, height: 0 });
    }

    private addDivider(parent: SceneObject): void {
        var obj = global.scene.createSceneObject("DP_divider");
        obj.setParent(parent);
        var tc = obj.createComponent("Component.Text") as any;
        tc.horizontalAlignment = HorizontalAlignment.Center;
        tc.verticalAlignment = VerticalAlignment.Center;
        try { tc.textFill.color = new vec4(0.18, 0.20, 0.26, 1); } catch (e) { tc.textColor = new vec4(0.18, 0.20, 0.26, 1); }
        tc.size = 18;
        if (this.font) tc.font = this.font;
        this.items.push({ kind: "divider", obj, tc, text: "─", fontSize: 18,
            color: new vec4(0.18, 0.20, 0.26, 1), height: 0 });
    }

    private addActionRow(parent: SceneObject): void {
        var rowObj = global.scene.createSceneObject("DP_actionRow");
        rowObj.setParent(parent);

        var self = this;
        var actions = [
            { label: "SIGNAL FLOW", fn: function() { self.toggleSignalFlow(); } },
            { label: "CLOSE",       fn: function() { self.dismiss(); } },
        ];

        if (this.buttonPrefab) {
            for (var i = 0; i < actions.length; i++) {
                var btnObj = this.buttonPrefab.instantiate(rowObj);
                btnObj.name = "DPBtn_" + actions[i].label.replace(/ /g, "_");
                var lbl = actions[i].label;
                this.applyLabel(btnObj, lbl);

                // Keep ref to signal flow button for label updates
                if (i === 0) {
                    this.signalFlowBtnObj = btnObj;
                }

                var capturedFn = actions[i].fn;
                var interactable = this.findInteractable(btnObj);
                if (interactable) {
                    interactable.onTriggerStart.add(capturedFn);
                }
            }
        }

        this.items.push({ kind: "row", obj: rowObj, tc: null, text: "", fontSize: 0,
            color: new vec4(0,0,0,0), height: 4.0 });
    }

    private addSpacer(parent: SceneObject): void {
        var obj = global.scene.createSceneObject("DP_spacer");
        obj.setParent(parent);
        this.items.push({ kind: "spacer", obj, tc: null, text: "", fontSize: 0,
            color: new vec4(0,0,0,0), height: 0 });
    }

    // =====================================================================
    // REFLOW
    // =====================================================================

    private reflowAll(): void {
        var contentW = this.panelWidth  - this.padding * 2;
        var contentH = this.panelHeight - this.padding * 2;
        if (contentW < 1) contentW = 1;

        var fixedH = 0, spacerCount = 0;

        for (var i = 0; i < this.items.length; i++) {
            var item = this.items[i];
            if (item.kind === "spacer") { spacerCount++; item.height = 0; continue; }
            if (item.kind === "row")    { fixedH += item.height; continue; }

            if (item.kind === "divider") {
                var dashW = TextLayout.estimateWidth("─", item.fontSize, this.fontCfg);
                var count = dashW > 0 ? Math.floor(contentW / dashW) : 8;
                var s = "";
                for (var d = 0; d < count; d++) s += "─";
                item.tc.text = s;
                item.height = TextLayout.lineHeight(item.fontSize) * 0.7;
                fixedH += item.height;
                continue;
            }

            var shrink = (item.kind === "title" || item.kind === "subtitle");
            var result = TextLayout.wrap(item.text, item.fontSize, contentW,
                shrink, Math.floor(item.fontSize * 0.5), this.fontCfg);
            item.tc.text = TextLayout.joinLines(result.lines);
            item.tc.size = result.effectiveFontSize;
            item.height = result.height;
            fixedH += item.height;
        }

        var gapTotal = (this.items.length - 1) * this.gap;
        var spacerH = 0;
        if (spacerCount > 0 && fixedH + gapTotal < contentH) {
            spacerH = (contentH - fixedH - gapTotal) / spacerCount;
        }
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].kind === "spacer") this.items[i].height = spacerH;
        }

        var effectiveGap = this.gap;
        var totalH = fixedH + spacerCount * spacerH + gapTotal;
        if (totalH > contentH && this.items.length > 1) {
            var excess = totalH - contentH;
            effectiveGap = Math.max(0.05, this.gap - excess / (this.items.length - 1));
        }

        var y = contentH / 2;
        for (var i = 0; i < this.items.length; i++) {
            var h = this.items[i].height;
            y -= h / 2;

            if (this.items[i].kind === "row") {
                this.layoutRow(this.items[i].obj, contentW, y);
            } else {
                this.items[i].obj.getTransform().setLocalPosition(new vec3(0, y, Z_TEXT));
            }

            y -= h / 2 + effectiveGap;
        }
    }

    private layoutRow(rowObj: SceneObject, contentW: number, centerY: number): void {
        var n = rowObj.getChildrenCount();
        if (n === 0) return;
        var colW = contentW / n;
        for (var i = 0; i < n; i++) {
            var child = rowObj.getChild(i);
            var x = -contentW / 2 + colW * i + colW / 2;
            child.getTransform().setLocalPosition(new vec3(x, centerY, Z_BTN));
        }
        rowObj.getTransform().setLocalPosition(new vec3(0, 0, 0));
    }

    // =====================================================================
    // PUBLIC API
    // =====================================================================

    /** Called by CircuitPanel to populate and show this panel */
    showForBoard(kb: any): void {
        this.currentKb = kb;
        this.signalFlowOn = false;

        var slug = kb ? (kb.boardSlug || "") : "";
        var meta = getBoardMeta(slug);

        // Update title
        if (this.items[0] && this.items[0].tc) {
            this.items[0].tc.text = getBoardDisplayName(slug).toUpperCase();
        }
        // Update subtitle (layer + MCU)
        if (this.items[1] && this.items[1].tc) {
            this.items[1].tc.text = meta.layers + "-layer  ·  " + meta.mcu;
            this.items[1].text   = this.items[1].tc.text;
        }
        // Update description body
        if (this.items[3] && this.items[3].tc) {
            this.items[3].text = meta.desc;
        }

        // Reset signal flow button label
        if (this.signalFlowBtnObj) {
            this.applyLabel(this.signalFlowBtnObj, "SIGNAL FLOW");
        }

        this.reflowAll();

        // Animate in
        this.sceneObject.enabled = true;
        this.sceneObject.getTransform().setLocalScale(new vec3(0.001, 0.001, 0.001));
        this.scaleT = 0;
        this.scaleDir = 1;
    }

    /** Called by CircuitPanel to trigger close animation */
    dismiss(): void {
        this.scaleDir = -1;
        this.scaleT = this.scaleDuration;
        if (this.currentKb) {
            this.currentKb.signalFlowMode = "off";
        }
        // onClose fires after scale-out completes (in tick)
    }

    private toggleSignalFlow(): void {
        if (!this.currentKb) return;
        this.signalFlowOn = !this.signalFlowOn;
        this.currentKb.signalFlowMode = this.signalFlowOn ? "on" : "off";
        // Update button label via CircuitButton.setLabel if available
        if (this.signalFlowBtnObj) {
            var newLbl = this.signalFlowOn ? "FLOW OFF" : "SIGNAL FLOW";
            this.applyLabel(this.signalFlowBtnObj, newLbl);
        }
        print("[CircuitDetailPanel] Signal flow: " + (this.signalFlowOn ? "on" : "off"));
    }

    // =====================================================================
    // TICK — scale animation
    // =====================================================================

    private tick(dt: number): void {
        if (!this.built || this.scaleDir === 0) return;

        this.scaleT += this.scaleDir * dt;

        if (this.scaleDir > 0) {
            // Growing in
            var t = Math.min(this.scaleT / this.scaleDuration, 1.0);
            var s = outBack(t, 1.3);
            s = Math.max(0.001, s);
            this.sceneObject.getTransform().setLocalScale(new vec3(s, s, s));
            if (t >= 1.0) {
                this.scaleDir = 0;
                this.sceneObject.getTransform().setLocalScale(new vec3(1, 1, 1));
            }
        } else {
            // Shrinking out
            var t = Math.max(0, this.scaleT / this.scaleDuration);
            var s = Math.max(0.001, t * t);  // ease-in collapse
            this.sceneObject.getTransform().setLocalScale(new vec3(s, s, s));
            if (t <= 0) {
                this.scaleDir = 0;
                this.sceneObject.enabled = false;
                if (this.onClose) this.onClose();
            }
        }
    }

    // =====================================================================
    // HELPERS
    // =====================================================================


    private applyLabel(btnObj: SceneObject, label: string): void {
        var scripts = btnObj.getComponents("Component.ScriptComponent") as any[];
        for (var i = 0; i < scripts.length; i++) {
            var sc = scripts[i] as any;
            if (sc && typeof sc.setLabel === "function") { sc.setLabel(label); return; }
        }
        var tc = this.findText(btnObj);
        if (tc) (tc as any).text = label;
    }

    private findInteractable(obj: SceneObject): any {
        var scripts = obj.getComponents("Component.ScriptComponent") as any[];
        for (var i = 0; i < scripts.length; i++) {
            var sc = scripts[i] as any;
            if (sc && sc.onTriggerStart !== undefined && sc.onHoverEnter !== undefined) return sc;
        }
        for (var i = 0; i < obj.getChildrenCount(); i++) {
            var found = this.findInteractable(obj.getChild(i));
            if (found) return found;
        }
        return null;
    }

    private findText(obj: SceneObject): any {
        var tc = obj.getComponent("Component.Text");
        if (tc) return tc;
        for (var i = 0; i < obj.getChildrenCount(); i++) {
            var r = this.findText(obj.getChild(i));
            if (r) return r;
        }
        return null;
    }
}
