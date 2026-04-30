/**
 * BoardPanel.ts — Control panel for a focused KiCad board.
 *
 * Follows the IntroPanel pattern from AugmentedLeRobot:
 *   - UIKit Frame background (glass panel with billboard + drag)
 *   - Programmatic TextLayout-based layout (no UIKit toggles)
 *   - All items stacked vertically, reflow on resize
 *
 * Shows: board name, render mode row, action row (explode/flow/replay/lifesize).
 * Wire this to the board's KiCadBoard script via the kiCadBoard input.
 *
 * Usage: Attach to a SceneObject that also has a UIKit Frame component.
 * The panel is shown/hidden by BoardGallery when the board is focused.
 */

import { TextLayout, TextMetricsConfig } from '../../Common/FlexText';
import { outCubic } from '../../Common/Easing';
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";

var Z_TEXT = 0.5;

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
export class BoardPanel extends BaseScriptComponent {

    @input
    @hint("KiCadBoard script component to control")
    kiCadBoard: ScriptComponent;

    @input
    @allowUndefined
    @hint("Font for all text")
    font: Font;

    @input @hint("Panel width (cm)")
    panelWidth: number = 28;

    @input @hint("Panel height (cm)")
    panelHeight: number = 20;

    @input @hint("Distance in front of the board (cm)")
    offsetZ: number = 8;

    @input @hint("Vertical offset above board center (cm)")
    offsetY: number = 12;

    @input @hint("Inner padding (cm)")
    padding: number = 1.8;

    @input @hint("Gap between items (cm)")
    gap: number = 0.6;

    // ---- State ----
    private built: boolean = false;
    private frame: any = null;
    private items: PanelItem[] = [];
    private fontCfg: TextMetricsConfig = new TextMetricsConfig();

    private explodeOn: boolean = false;
    private signalFlowOn: boolean = false;
    private lifeSizeOn: boolean = false;
    private savedLocalScale: vec3 = new vec3(1, 1, 1);

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.build());
    }

    private build(): void {
        if (this.built) return;
        this.built = true;

        var root = this.sceneObject;

        // Position relative to parent board
        root.getTransform().setLocalPosition(new vec3(0, this.offsetY, this.offsetZ));

        // Find Frame component
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
            this.frame.allowTranslation = true;
            this.frame.useBillboarding = true;

            var self = this;
            var lastW = this.panelWidth, lastH = this.panelHeight;
            this.frame.onScalingUpdate.add(function() {
                var w = self.frame.innerSize.x;
                var h = self.frame.innerSize.y;
                if (Math.abs(w - lastW) > 0.2 || Math.abs(h - lastH) > 0.2) {
                    lastW = w; lastH = h;
                    self.panelWidth = w; self.panelHeight = h;
                    self.reflowAll();
                }
            });
        }

        // Font metrics
        var fontName = "";
        if (this.font) { try { fontName = (this.font as any).name || ""; } catch (e) {} }
        this.fontCfg = TextLayout.configForFont(fontName);

        // Board name
        var kb = this.kiCadBoard as any;
        var boardName = this.getBoardDisplayName(kb ? kb.boardSlug : "");
        var accent = new vec4(0.94, 0.60, 0.18, 1);       // vivid amber
        var dimColor = new vec4(0.55, 0.58, 0.64, 1);
        var bodyColor = new vec4(0.80, 0.82, 0.86, 1);

        this.addText(root, "title",    boardName,      52, accent);
        this.addText(root, "subtitle", "KiCad PCB",    26, dimColor);
        this.addDivider(root);

        // Render mode label
        this.addText(root, "subtitle", "RENDER MODE",  22, dimColor);

        // Render mode toggle row (Vivid / Realistic) — built as text buttons
        this.addActionRow(root, [
            { label: "Vivid",     action: () => this.setRenderMode(false) },
            { label: "Realistic", action: () => this.setRenderMode(true) },
        ], bodyColor, accent);

        this.addDivider(root);

        // Controls label
        this.addText(root, "subtitle", "CONTROLS",  22, dimColor);

        // Control row
        this.addActionRow(root, [
            { label: "Explode",     action: () => this.toggleExplode() },
            { label: "Signal Flow", action: () => this.toggleSignalFlow() },
            { label: "Replay",      action: () => this.replay() },
            { label: "Life Size",   action: () => this.toggleLifeSize() },
        ], bodyColor, accent);

        this.addSpacer(root);

        this.reflowAll();
        print("[BoardPanel] Built for: " + boardName);
    }

    // =====================================================================
    // CONTROLS
    // =====================================================================

    private setRenderMode(realistic: boolean): void {
        var kb = this.kiCadBoard as any;
        if (!kb) return;
        kb.renderMode = realistic ? "realistic" : "vivid";
    }

    private toggleExplode(): void {
        var kb = this.kiCadBoard as any;
        if (!kb) return;
        this.explodeOn = !this.explodeOn;
        kb.explodeAmount = this.explodeOn ? 1.0 : 0.0;
    }

    private toggleSignalFlow(): void {
        var kb = this.kiCadBoard as any;
        if (!kb) return;
        this.signalFlowOn = !this.signalFlowOn;
        kb.signalFlowMode = this.signalFlowOn ? "on" : "off";
    }

    private replay(): void {
        var kb = this.kiCadBoard as any;
        if (kb && kb.replayGrowth) kb.replayGrowth();
    }

    private toggleLifeSize(): void {
        var kb = this.kiCadBoard as any;
        if (!kb || !kb.sceneObject) return;
        var so = kb.sceneObject;
        this.lifeSizeOn = !this.lifeSizeOn;
        if (this.lifeSizeOn) {
            this.savedLocalScale = so.getTransform().getLocalScale();
            var sf = kb.scaleFactor || 1.0;
            var ls = 0.1 / sf;
            so.getTransform().setLocalScale(new vec3(ls, ls, ls));
        } else {
            so.getTransform().setLocalScale(this.savedLocalScale);
        }
    }

    // =====================================================================
    // ITEM CREATION
    // =====================================================================

    private addText(parent: SceneObject, kind: ItemKind, text: string, fontSize: number, color: vec4): void {
        var obj = global.scene.createSceneObject("PT_" + text.slice(0, 10));
        obj.setParent(parent);
        var tc = obj.createComponent("Component.Text") as any;
        tc.horizontalAlignment = HorizontalAlignment.Center;
        tc.verticalAlignment = VerticalAlignment.Center;
        tc.textFill = { color: color };
        tc.size = fontSize;
        if (this.font) tc.font = this.font;
        this.items.push({ kind, obj, tc, text, fontSize, color, height: 0 });
    }

    private addDivider(parent: SceneObject): void {
        var obj = global.scene.createSceneObject("PT_divider");
        obj.setParent(parent);
        var tc = obj.createComponent("Component.Text") as any;
        tc.horizontalAlignment = HorizontalAlignment.Center;
        tc.verticalAlignment = VerticalAlignment.Center;
        tc.textFill = { color: new vec4(0.18, 0.20, 0.26, 1) };
        tc.size = 20;
        if (this.font) tc.font = this.font;
        this.items.push({ kind: "divider", obj, tc, text: "─", fontSize: 20,
            color: new vec4(0.18, 0.20, 0.26, 1), height: 0 });
    }

    private addActionRow(parent: SceneObject, actions: { label: string, action: () => void }[],
                         color: vec4, accentColor: vec4): void {
        var obj = global.scene.createSceneObject("PT_row");
        obj.setParent(parent);

        // Create text labels for each action
        var n = actions.length;
        for (var i = 0; i < n; i++) {
            var btn = global.scene.createSceneObject("PT_btn_" + actions[i].label);
            btn.setParent(obj);
            var tc = btn.createComponent("Component.Text") as any;
            tc.horizontalAlignment = HorizontalAlignment.Center;
            tc.verticalAlignment = VerticalAlignment.Center;
            tc.textFill = { color: accentColor };
            tc.size = 28;
            if (this.font) tc.font = this.font;
            tc.text = actions[i].label.toUpperCase();

            // Add interactable for tap
            var capturedAction = actions[i].action;
            var interactable = btn.createComponent(Interactable.getTypeName()) as Interactable;
            if (interactable) {
                interactable.onTriggerStart.add(capturedAction);
            }
        }

        this.items.push({ kind: "row", obj, tc: null, text: "", fontSize: 28,
            color: accentColor, height: 3.5 });
    }

    private addSpacer(parent: SceneObject): void {
        var obj = global.scene.createSceneObject("PT_spacer");
        obj.setParent(parent);
        this.items.push({ kind: "spacer", obj, tc: null, text: "", fontSize: 0,
            color: new vec4(0, 0, 0, 0), height: 0 });
    }

    // =====================================================================
    // REFLOW
    // =====================================================================

    private reflowAll(): void {
        var contentW = this.panelWidth - this.padding * 2;
        var contentH = this.panelHeight - this.padding * 2;
        if (contentW < 1) contentW = 1;

        var fixedH = 0, spacerCount = 0;

        for (var i = 0; i < this.items.length; i++) {
            var item = this.items[i];
            if (item.kind === "spacer") { item.height = 0; spacerCount++; continue; }
            if (item.kind === "row") { fixedH += item.height; continue; }

            if (item.kind === "divider") {
                var dashW = TextLayout.estimateWidth("─", item.fontSize, this.fontCfg);
                var count = dashW > 0 ? Math.floor(contentW / dashW) : 8;
                var divText = "";
                for (var d = 0; d < count; d++) divText += "─";
                item.tc.text = divText;
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

        // Compute total and compress gaps if needed
        var effectiveGap = this.gap;
        var totalH = fixedH + spacerCount * spacerH + gapTotal;
        if (totalH > contentH && this.items.length > 1) {
            var excess = totalH - contentH;
            effectiveGap = Math.max(0.05, this.gap - excess / (this.items.length - 1));
        }

        // Position vertically
        var y = contentH / 2;
        for (var i = 0; i < this.items.length; i++) {
            var h = this.items[i].height;
            y -= h / 2;

            if (this.items[i].kind === "row") {
                // Spread row children horizontally
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
            child.getTransform().setLocalPosition(new vec3(x, centerY, Z_TEXT));
        }
        rowObj.getTransform().setLocalPosition(new vec3(0, 0, 0));
    }

    // =====================================================================
    // HELPERS
    // =====================================================================

    private getBoardDisplayName(slug: string): string {
        var names: { [key: string]: string } = {
            "arduino-nano":  "Arduino Nano",
            "stickhub-usb":  "StickHub USB",
            "rpi-cm4io":     "RPi CM4 IO",
            "attiny85-usb":  "ATtiny85 USB",
            "xiao-servo":    "XIAO Servo",
        };
        return names[slug] || slug || "Circuit Board";
    }

    /** Called by BoardGallery when this board gets focus. */
    showForBoard(kb: any): void {
        this.sceneObject.enabled = true;
        // Update board name if needed
        if (kb && this.items.length > 0) {
            var name = this.getBoardDisplayName(kb.boardSlug || "");
            var item = this.items[0];
            if (item.tc) {
                item.tc.text = name;
                this.reflowAll();
            }
        }
    }
}
