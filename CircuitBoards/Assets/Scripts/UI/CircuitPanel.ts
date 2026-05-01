/**
 * CircuitPanel.ts — Unified control panel for Circuit Board Explorer.
 *
 * UIKit Frame background (glass + billboard + drag).
 * TextLayout-based vertical layout — reflows on frame resize.
 *
 * Board row: one CircuitButton per KiCadBoard child.
 * 3D boards float above the panel in local space, column-aligned with buttons.
 * Settings row: Explode, Life Size, Return.
 *
 * Setup in Lens Studio:
 *   1. Add UIKit Frame component to a SceneObject
 *   2. Attach CircuitPanel to the SAME SceneObject
 *   3. Set boardParent to the SceneObject whose children are KiCadBoard objects
 *   4. Set buttonPrefab to a UIKit RectangleButton prefab with CircuitButton attached
 *   5. Optionally set font
 */

import { TextLayout, TextMetricsConfig } from '../Common/FlexText';
import { outCubic } from '../Common/Easing';
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { ToggleGroup } from "SpectaclesUIKit.lspkg/Scripts/Components/Toggle/ToggleGroup";
import { buildTubeMesh } from '../Common/TubeMeshFactory';
import { CircuitFrame } from './CircuitFrame';
import { CircuitDetailPanel } from './CircuitDetailPanel';
import { getBoardDisplayName, getBoardButtonLabel } from '../Board/BoardCatalog';

var Z_TEXT = 1.5;
var Z_BTN  = 1.2;

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

interface BoardEntry {
    obj: SceneObject;
    kb: any;
    currentScale: number;
    targetScale: number;
    outlineObj: SceneObject | null;
    prevSlug: string;
}

@component
export class CircuitPanel extends BaseScriptComponent {

    @input
    @hint("Parent SceneObject whose direct children are KiCadBoard SceneObjects")
    boardParent: SceneObject;

    @input
    @hint("Prefab: UIKit RectangleButton with CircuitButton script attached")
    buttonPrefab: ObjectPrefab;

    @input @allowUndefined
    @hint("Font for all text")
    font: Font;

    @input @hint("Panel width (cm)")
    panelWidth: number = 44;

    @input @hint("Panel height (cm)")
    panelHeight: number = 22;

    @input @hint("Inner padding (cm)")
    padding: number = 2.0;

    @input @hint("Gap between items (cm)")
    gap: number = 0.7;

    @input @hint("Distance below panel top for the board row baseline (cm). Legacy; use boardCardHeight to size the boards row.")
    boardGap: number = 4.0;

    @input @hint("Push boards toward camera in panel-local Z (cm). Higher = closer to viewer.")
    boardForwardZ: number = 5.0;

    @input @hint("Inline-reserved height (cm) for the floating-boards row. Renders as a translucent card so boards have a visual home.")
    boardCardHeight: number = 6.5;

    @input @hint("Vertical padding (cm) above the MORE row's VIVID button. Only takes effect when MORE is expanded.")
    moreRowGap: number = 3.5;

    @input @hint("Distance (cm) from board top edge up to the title block center. Smaller = title sits closer to the boards.")
    titleAboveBoards: number = 1.8;

    @input @hint("Scale multiplier for focused board")
    focusScale: number = 1.25;

    @input @hint("Scale multiplier for unfocused boards when one is focused")
    bgScale: number = 0.80;

    @input @hint("Lerp speed for scale animation")
    animSpeed: number = 5.0;

    // ---- Normalization ----
    @input @hint("Target max XY size (cm) all boards are scaled to fit (longest dimension). 0 = no normalization.")
    normalizeWidth: number = 5;

    // ---- Outline ----
    @input @allowUndefined
    @hint("Material for selection outline rectangle (bright solid color)")
    outlineMaterial: Material;

    @input @allowUndefined
    @hint("Glass material for the selection sphere (e.g. a basic UIKit/PBR glass). Used as-is — no color tinting.")
    sphereMaterial: Material;

    @input @hint("Gap between board and selection sphere (cm)")
    outlinePadding: number = 1.0;

    @input @hint("Selection sphere radius (cm)")
    outlineThickness: number = 0.3;

    // ---- Detail panel ----
    @input @allowUndefined
    @hint("Prefab for the detail panel (UIKit Frame + CircuitDetailPanel)")
    detailPanelPrefab: ObjectPrefab;

    @input @allowUndefined
    @hint("Material using ConnectorShader.js (ConnectorTube.ss_graph) for the tube between panels")
    connectorMaterial: Material;

    @input @hint("Gap between main panel bottom and detail panel top (cm)")
    detailGap: number = 3.0;

    @input @hint("How far the main panel slides up when detail opens (cm). 0 = panel stays put on board select.")
    slideUpAmount: number = 0.0;

    // ---- State ----
    private built: boolean = false;
    private frame: any = null;
    private items: PanelItem[] = [];
    private boards: BoardEntry[] = [];
    private boardBaseScales: vec3[] = [];
    private savedScales: vec3[] = [];
    // Local-space column slots relative to the panel SceneObject. World targets
    // are computed on demand by transforming through the panel's world matrix.
    private boardLocalTargets: vec3[] = [];
    // Homing animation: when RETURN is pressed, boards animate from their
    // current world pose to their column slot on the (currently positioned) panel.
    private homingActive: boolean = false;
    private homingT: number = 0;
    private homingDuration: number = 0.45;
    private homingFromPos: vec3[] = [];
    private homingFromRot: quat[] = [];
    private focusedIdx: number = -1;
    private time: number = 0;
    private fontCfg: TextMetricsConfig = new TextMetricsConfig();
    private boardBaseY: number = 15;
    private explodeOn: boolean = false;
    // Boards spawn at the normalized gallery size; LIFE SIZE button expands the
    // focused board to its real-world dimensions (1 KiCad mm → 1 mm visible).
    private lifeSizeOn: boolean = false;
    private knownBoardObjs: SceneObject[] = [];
    private boardRowObj: SceneObject | null = null;
    // UIKit ToggleGroup that owns radio behavior for the board buttons. We
    // register each CircuitButton with the group; tap-driven changes fire
    // onToggleSelected with the value (board index) we registered, which is
    // our single entry point for "user picked board N".
    private boardToggleGroup: any = null;
    private boardToggleHandlerWired: boolean = false;
    private rescanEnd: number = 10.0;
    private rescanTimer: number = 0;

    // Title block (positioned above board row, outside item flow)
    private titleBlockObj: SceneObject | null = null;

    // "More" collapsible section
    private moreOpen: boolean = false;
    private moreToggleBtn: SceneObject | null = null;
    private moreRowObj: SceneObject | null = null;
    private morePadObj: SceneObject | null = null;
    private moreVividBtn: SceneObject | null = null;

    // Boards "card" — a translucent backplate row that reserves inline space
    // for the floating 3D boards so reflow doesn't pack content behind them.
    private boardsCardObj: SceneObject | null = null;
    // Settings buttons that require an active focused board to do anything.
    // Held by reference so we can flip their UIKit `_inactive` flag and keep
    // their toggled visuals in sync with the panel's authoritative state.
    private explodeBtn: SceneObject | null = null;
    private lifeSizeBtn: SceneObject | null = null;
    private returnBtn: SceneObject | null = null;

    // Voice search has been removed for Lens Explorer publishability —
    // on-device speech-to-text sits in the experimental API set, which
    // blocks public submission. The implementation is preserved at
    // CircuitBoards/disabled-scripts/voice-search/ for future re-enable.

    // ---- Detail panel state ----
    private detailObj: SceneObject | null = null;
    private detailScript: any = null;
    private connObj: SceneObject | null = null;
    private connPass: any = null;
    private connClipT: number = 0;
    private connGrowing: boolean = false;
    private connRetracting: boolean = false;
    private panelBaseLocalY: number = 0;
    private panelCurrentLocalY: number = 0;
    private panelTargetLocalY: number = 0;
    private detailHeight: number = 14;  // matches CircuitDetailPanel default
    private boardButtons: SceneObject[] = [];

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.build());
        this.createEvent("UpdateEvent").bind((e: UpdateEvent) => this.tick(getDeltaTime()));
    }

    private build(): void {
        if (this.built) return;
        this.built = true;

        var root = this.sceneObject;

        // Find UIKit Frame component
        var comps = root.getComponents("Component.ScriptComponent") as any[];
        for (var i = 0; i < comps.length; i++) {
            var sc = comps[i] as any;
            if (sc.innerSize !== undefined && sc.onScalingUpdate !== undefined) {
                this.frame = sc;
                break;
            }
        }

        if (this.frame) {
            // Safe boolean settings — no scaleFrame() triggered
            this.frame.autoShowHide = false;
            this.frame.autoScaleContent = false;
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
                    self.snapBoardsToColumns();
                }
            });

            // Defer innerSize — Frame.initialize() must run first or scaleFrame() throws
            // (roundedRectangle is null until initialize runs at OnStartEvent)
            var sizeEvt = this.createEvent("DelayedCallbackEvent");
            sizeEvt.bind(function() {
                if (self.frame) self.frame.innerSize = new vec2(self.panelWidth, self.panelHeight);
            });
            (sizeEvt as any).reset(0);
        }

        // Font metrics
        var fontName = "";
        if (this.font) { try { fontName = (this.font as any).name || ""; } catch (e) {} }
        this.fontCfg = TextLayout.configForFont(fontName);

        // Discover and reparent KiCadBoard children
        this.discoverBoards(root);

        // Colors — theme palette. Spectacles renders black as transparent and
        // grey reads near-transparent on the additive display, so we use vivid
        // theme hues (jade-green, bright-sky, ghost-white) only.
        var dim   = new vec4(0.004, 0.729, 0.937, 0.85); // bright-sky, dim alpha

        // Title lives in a fixed block ABOVE the boards — repositionTitleBlock
        // places it at boardBaseY + boardSize/2 + 3.5 so it floats just above
        // the floating PCBs. Decoupling from the reflow stack means it never
        // overlaps with boards regardless of boardGap.
        this.addTitleBlock(root);

        // Build items (panel-internal stack)
        this.addBoardsCard(root);   // reserves vertical space + draws backplate
        this.addBoardRow(root);
        this.addDivider(root);
        this.addText(root, "subtitle", "SETTINGS", 22, dim);
        this.addSettingsRow(root);  // EXPLODE | LIFE SIZE | RETURN | MORE
        this.addMorePad(root);      // extra spacer (hidden with more row)
        this.addMoreRow(root);      // hidden by default; toggled by MORE button
        this.addSpacer(root);

        this.reflowAll();
        this.snapBoardsToColumns();

        // Capture base Y for slide animation
        var initPos = root.getTransform().getLocalPosition();
        this.panelBaseLocalY = initPos.y;
        this.panelCurrentLocalY = initPos.y;
        this.panelTargetLocalY = initPos.y;

        // Default selection: focus slot 0 so a board is always active. Boards
        // may still be discovering asynchronously — applyDefaultFocus is idempotent
        // and rescanBoards re-asserts the selection once buttons exist.
        this.applyDefaultFocus();

        print("[CircuitPanel] Built — " + this.boards.length + " boards");
    }

    private applyDefaultFocus(): void {
        if (this.focusedIdx >= 0) return;       // user already chose
        if (this.boards.length === 0) return;   // wait for discovery
        // Drive the first board's CircuitButton through the proper Toggleable
        // API. The ToggleGroup, registered to listen on onFinished, treats
        // this as a programmatic change (explicit=false) — so it won't echo
        // back through onToggleSelected and we won't recurse.
        var firstBtn = this.boardButtons.length > 0 ? this.findCircuitButton(this.boardButtons[0]) as any : null;
        if (firstBtn && typeof firstBtn.toggle === "function") {
            try { firstBtn.toggle(true); } catch (e) {}
        } else if (firstBtn && firstBtn.isOn !== undefined) {
            try { firstBtn.isOn = true; } catch (e) {}
        }
        // The group will untoggle any others. Now run the rest of the focus
        // pipeline through selectBoard so refreshFromState gets called once.
        this.selectBoard(0);
    }

    // ---- Board discovery ----

    private discoverBoards(root: SceneObject): void {
        var parent = this.boardParent;
        if (!parent) { print("[CircuitPanel] boardParent not set"); return; }

        for (var i = 0; i < parent.getChildrenCount(); i++) {
            var child = parent.getChild(i);
            if (child === root) continue;

            var scripts = child.getComponents("Component.ScriptComponent") as any[];
            var kb: any = null;
            for (var si = 0; si < scripts.length; si++) {
                if (scripts[si] && scripts[si].boardSlug !== undefined) {
                    kb = scripts[si];
                    break;
                }
            }
            if (!kb) continue;

            this.knownBoardObjs.push(child);

            // Boards stay in boardParent — they do NOT follow the panel when it
            // slides. RETURN snaps/animates them back to their column slot on
            // the panel via homeBoardsToColumns().

            // Normalize so the longest XY dimension fits normalizeWidth (cm).
            // Falls back to life-size if extents aren't reported yet — the rebuild
            // path picks up corrected extents on the next discovery pass.
            var bs = child.getTransform().getLocalScale();
            var bhw: number = (kb.getBoardHalfWidth) ? kb.getBoardHalfWidth() : 0;
            var bhh: number = (kb.getBoardHalfHeight) ? kb.getBoardHalfHeight() : 0;
            var bhMax: number = Math.max(bhw, bhh);
            if (this.normalizeWidth > 0 && bhMax > 0.1) {
                var ns: number = (this.normalizeWidth * 0.5) / bhMax;
                bs = new vec3(ns, ns, ns);
            } else {
                var ls: number = 0.1 / (kb.scaleFactor || 1.0);
                bs = new vec3(ls, ls, ls);
            }
            child.getTransform().setLocalScale(bs);
            this.boardBaseScales.push(bs);
            this.savedScales.push(bs);

            // Build selection outline (child of board, hidden initially)
            var outObj = this.buildOutlineRect(child, kb);

            this.boards.push({
                obj: child,
                kb: kb,
                currentScale: 1.0,
                targetScale: 1.0,
                outlineObj: outObj,
                prevSlug: kb.boardSlug || "",
            });
        }
    }

    private rescanBoards(): boolean {
        var parent = this.boardParent;
        if (!parent) return false;
        var root = this.sceneObject;
        var found = false;

        for (var i = 0; i < parent.getChildrenCount(); i++) {
            var child = parent.getChild(i);
            if (child === root) continue;

            // Skip already-discovered objects
            var known = false;
            for (var k = 0; k < this.knownBoardObjs.length; k++) {
                if (this.knownBoardObjs[k] === child) { known = true; break; }
            }
            if (known) continue;

            // Check for KiCadBoard script that now has boardSlug set
            var scripts = child.getComponents("Component.ScriptComponent") as any[];
            var kb: any = null;
            for (var si = 0; si < scripts.length; si++) {
                if (scripts[si] && scripts[si].boardSlug !== undefined) {
                    kb = scripts[si]; break;
                }
            }
            if (!kb) continue;

            this.knownBoardObjs.push(child);
            // Boards stay in boardParent (do not follow panel). See discoverBoards comment.

            var bs = child.getTransform().getLocalScale();
            var bhw2: number = (kb.getBoardHalfWidth) ? kb.getBoardHalfWidth() : 0;
            var bhh2: number = (kb.getBoardHalfHeight) ? kb.getBoardHalfHeight() : 0;
            var bhMax2: number = Math.max(bhw2, bhh2);
            if (this.normalizeWidth > 0 && bhMax2 > 0.1) {
                var ns2: number = (this.normalizeWidth * 0.5) / bhMax2;
                bs = new vec3(ns2, ns2, ns2);
            } else {
                var ls2: number = 0.1 / (kb.scaleFactor || 1.0);
                bs = new vec3(ls2, ls2, ls2);
            }
            child.getTransform().setLocalScale(bs);
            this.boardBaseScales.push(bs);
            this.savedScales.push(bs);

            var outObj2 = this.buildOutlineRect(child, kb);

            this.boards.push({
                obj: child, kb: kb,
                currentScale: 1.0, targetScale: 1.0,
                outlineObj: outObj2,
                prevSlug: kb.boardSlug || "",
            });
            found = true;
            print("[CircuitPanel] Late-discovered: " + kb.boardSlug);
        }
        return found;
    }

    // ---- Layout item builders ----

    private addTitleBlock(parent: SceneObject): void {
        var block = global.scene.createSceneObject("CP_titleBlock");
        block.setParent(parent);
        this.titleBlockObj = block;

        var cream = new vec4(0.984, 0.984, 1.000, 1.00); // ghost-white
        this.makeBlockText(block, "CP_title", "PRINTED CIRCUIT BOARDS", 64, cream, 0);
    }

    private makeBlockText(parent: SceneObject, name: string, text: string,
                          fontSize: number, color: vec4, y: number): void {
        var obj = global.scene.createSceneObject(name);
        obj.setParent(parent);
        obj.getTransform().setLocalPosition(new vec3(0, y, Z_TEXT));
        var tc = obj.createComponent("Component.Text") as any;
        tc.horizontalAlignment = HorizontalAlignment.Center;
        tc.verticalAlignment = VerticalAlignment.Center;
        try { tc.textFill.color = color; } catch (e) { try { tc.textColor = color; } catch (e2) {} }
        tc.size = fontSize;
        tc.text = text;
        if (this.font) tc.font = this.font;
    }

    private addText(parent: SceneObject, kind: ItemKind, text: string, fontSize: number, color: vec4): void {
        var obj = global.scene.createSceneObject("CP_" + text.replace(/ /g, "_").slice(0, 12));
        obj.setParent(parent);
        var tc = obj.createComponent("Component.Text") as any;
        tc.horizontalAlignment = HorizontalAlignment.Center;
        tc.verticalAlignment = VerticalAlignment.Center;
        try { tc.textFill.color = color; } catch (e) { try { tc.textColor = color; } catch (e2) {} }
        tc.size = fontSize;
        if (this.font) tc.font = this.font;
        this.items.push({ kind, obj, tc, text, fontSize, color, height: 0 });
    }

    private addDivider(parent: SceneObject): void {
        var obj = global.scene.createSceneObject("CP_divider");
        obj.setParent(parent);
        var tc = obj.createComponent("Component.Text") as any;
        tc.horizontalAlignment = HorizontalAlignment.Center;
        tc.verticalAlignment = VerticalAlignment.Center;
        var divColor = new vec4(0.004, 0.729, 0.937, 0.55); // bright-sky, faint
        try { tc.textFill.color = divColor; } catch (e) { try { tc.textColor = divColor; } catch (e2) {} }
        tc.size = 20;
        if (this.font) tc.font = this.font;
        this.items.push({ kind: "divider", obj, tc, text: "─", fontSize: 20,
            color: divColor, height: 0 });
    }

    // Reserves inline vertical space for the floating 3D boards so reflow
    // pushes the buttons below the boards instead of behind them. Invisible
    // (no mesh/material) — purely a layout placeholder.
    private addBoardsCard(parent: SceneObject): void {
        var obj = global.scene.createSceneObject("CP_boardsReserve");
        obj.setParent(parent);
        this.boardsCardObj = obj;

        this.items.push({ kind: "row", obj, tc: null, text: "", fontSize: 0,
            color: new vec4(0,0,0,0), height: this.boardCardHeight });
    }

    private addBoardRow(parent: SceneObject): void {
        var rowObj = global.scene.createSceneObject("CP_boardRow");
        rowObj.setParent(parent);
        this.boardRowObj = rowObj;

        // Attach UIKit ToggleGroup. It owns the radio invariant ("at most one
        // toggleable on at a time, and at least one if allowAllTogglesOff is
        // false"), and fires onToggleSelected once user-driven toggles settle.
        this.boardToggleGroup = rowObj.createComponent(ToggleGroup.getTypeName()) as any;
        try { this.boardToggleGroup.allowAllTogglesOff = false; } catch (e) {}

        this.rebuildBoardRowButtons();

        this.items.push({ kind: "row", obj: rowObj, tc: null, text: "", fontSize: 0,
            color: new vec4(0,0,0,0), height: 3.0 });
    }

    private rebuildBoardRowButtons(): void {
        var rowObj = this.boardRowObj;
        if (!rowObj || !this.buttonPrefab) return;

        // Additive only: rescanBoards never removes boards, and destroying
        // UIKit-wrapped SceneObjects mid-tick crashes inside RoundedRectangle's
        // destroy chain. Update labels on existing buttons, then append for any
        // newly discovered boards.
        var self = this;
        for (var i = 0; i < this.boardButtons.length && i < this.boards.length; i++) {
            var existingLabel = getBoardButtonLabel(this.boards[i].kb.boardSlug || "");
            this.applyButtonLabel(this.boardButtons[i], existingLabel);
        }

        for (var i = this.boardButtons.length; i < this.boards.length; i++) {
            var label = getBoardButtonLabel(this.boards[i].kb.boardSlug || "");
            var btnObj = this.buttonPrefab.instantiate(rowObj);
            btnObj.enabled = true;
            btnObj.name = "BoardBtn_" + i;
            this.applyButtonLabel(btnObj, label);

            // Register the CircuitButton script (a Toggleable) with the group.
            // The group owns the visual + isOn radio state; we don't write isOn
            // anywhere else for board buttons.
            var btnScript = this.findCircuitButton(btnObj);
            if (btnScript && this.boardToggleGroup &&
                typeof this.boardToggleGroup.registerToggleable === "function") {
                try {
                    this.boardToggleGroup.registerToggleable(btnScript, i);
                } catch (e) {}
            }
            this.boardButtons.push(btnObj);
        }

        // Wire the single onToggleSelected listener once. The group fires it
        // with { toggleable, value: idx } whenever the user explicitly picks a
        // toggle — that's our entry point to focus the matching board.
        if (!this.boardToggleHandlerWired && this.boardToggleGroup &&
            this.boardToggleGroup.onToggleSelected &&
            this.boardToggleGroup.onToggleSelected.add) {
            this.boardToggleGroup.onToggleSelected.add(function(args: any) {
                var idx = (args && typeof args.value === "number") ? args.value : -1;
                if (idx >= 0) self.selectBoard(idx);
            });
            this.boardToggleHandlerWired = true;
        }

        // Group's configureToggles + reset will surface the default-focused
        // button automatically (allowAllTogglesOff=false picks index 0 if no
        // toggle came up `on`). Re-pull state into our scalars.
        this.applyDefaultFocus();
        this.refreshFromState();
    }

    // Drive UIKit's `inactive` flag on settings/more buttons based on whether
    private addSettingsRow(parent: SceneObject): void {
        var rowObj = global.scene.createSceneObject("CP_settingsRow");
        rowObj.setParent(parent);

        var self = this;
        var defs = [
            { label: "EXPLODE",   fn: function() { self.toggleExplode(); } },
            { label: "LIFE SIZE", fn: function() { self.toggleLifeSize(); } },
            { label: "RETURN",    fn: function() { self.returnToRest(); } },
            { label: "▾ MORE",    fn: function() { self.toggleMore(); }, isMoreToggle: true },
        ];

        if (this.buttonPrefab) {
            for (var i = 0; i < defs.length; i++) {
                (function(def: any) {
                    var btnObj = self.buttonPrefab.instantiate(rowObj);
                    btnObj.enabled = true;
                    btnObj.name = "SettingsBtn_" + def.label.replace(/ /g, "_");
                    self.applyButtonLabel(btnObj, def.label);
                    self.wireButtonAction(btnObj, def.fn);
                    if (def.isMoreToggle) self.moreToggleBtn = btnObj;
                    if (def.label === "EXPLODE") self.explodeBtn = btnObj;
                    if (def.label === "LIFE SIZE") self.lifeSizeBtn = btnObj;
                    if (def.label === "RETURN") self.returnBtn = btnObj;

                    // EXPLODE and LIFE SIZE have on/off internal state; their
                    // border should reflect that. RETURN/MORE are momentary.
                    if (def.label === "EXPLODE" || def.label === "LIFE SIZE") {
                        var t = self.findToggleable(btnObj);
                        if (t) {
                            try { t.setIsToggleable(true); } catch (e) {}
                            if (t.onInitialized && t.onInitialized.add) {
                                t.onInitialized.add(function() { self.refreshFromState(); });
                            }
                        }
                    }
                })(defs[i]);
            }
        }

        // Primary settings actions.
        this.items.push({ kind: "row", obj: rowObj, tc: null, text: "", fontSize: 0,
            color: new vec4(0,0,0,0), height: 3.0 });

        // Initial paint: action buttons are inactive until a board is focused.
        this.refreshFromState();
    }

    // Empty row used purely as vertical padding above the more row. Toggled
    // visible together with the more row so the gap only appears when more
    // is expanded — otherwise wasted space at the bottom of the panel.
    private addMorePad(parent: SceneObject): void {
        var padObj = global.scene.createSceneObject("CP_morePad");
        padObj.setParent(parent);
        padObj.enabled = false;
        this.morePadObj = padObj;
        this.items.push({ kind: "row", obj: padObj, tc: null, text: "", fontSize: 0,
            color: new vec4(0,0,0,0), height: this.moreRowGap });
    }

    // Three extra controls. Hidden by default — reflowAll skips disabled rows.
    private addMoreRow(parent: SceneObject): void {
        var rowObj = global.scene.createSceneObject("CP_moreRow");
        rowObj.setParent(parent);
        rowObj.enabled = false; // collapsed at startup
        this.moreRowObj = rowObj;

        if (!this.buttonPrefab) {
            this.items.push({ kind: "row", obj: rowObj, tc: null, text: "", fontSize: 0,
                color: new vec4(0,0,0,0), height: 2.6 });
            return;
        }

        var self = this;

        // VIVID — toggles between the vivid and realistic palette.
        // Default state must match the actual focused board's renderMode (set
        // to "vivid" in the scene), and the FSM transition has to fire so the
        // border lights up correctly. refreshFromState handles both, called
        // immediately AND on onInitialized in case the FSM is not yet ready.
        var vividBtn = this.buttonPrefab.instantiate(rowObj);
        vividBtn.enabled = true;
        vividBtn.name = "MoreBtn_VIVID";
        this.applyButtonLabel(vividBtn, "VIVID"); // overridden by refreshFromState
        var vividToggle = this.findToggleable(vividBtn);
        if (vividToggle) {
            try { vividToggle.setIsToggleable(true); } catch (e) {}
            if (vividToggle.onInitialized && vividToggle.onInitialized.add) {
                vividToggle.onInitialized.add(function() { self.refreshFromState(); });
            }
        }
        this.wireButtonAction(vividBtn, function() { self.cycleRenderMode(); });
        this.moreVividBtn = vividBtn;
        this.refreshFromState();

        // FLOW (signal flow toggle) and REPLAY (growth replay) were removed:
        // the active KiCadBoardShader / KiCadTraceShader graphs do not render
        // signal flow, and replayGrowth has no observable effect on the
        // current shaders. Re-add when the shader pipeline is reinstated.

        // Secondary auxiliary controls — shorter row so the hierarchy reads
        // visually (these are toggles that operate on the focused board).
        this.items.push({ kind: "row", obj: rowObj, tc: null, text: "", fontSize: 0,
            color: new vec4(0,0,0,0), height: 2.6 });
    }

    private toggleMore(): void {
        this.moreOpen = !this.moreOpen;
        if (this.moreRowObj) this.moreRowObj.enabled = this.moreOpen;
        if (this.morePadObj) this.morePadObj.enabled = this.moreOpen;
        if (this.moreToggleBtn) {
            this.applyButtonLabel(this.moreToggleBtn, this.moreOpen ? "▴ MORE" : "▾ MORE");
        }
        this.reflowAll();
    }

    private getActiveBoardKb(): any {
        var idx = this.focusedIdx >= 0 ? this.focusedIdx : 0;
        if (idx < 0 || idx >= this.boards.length) return null;
        return this.boards[idx].kb;
    }

    private cycleRenderMode(): void {
        var kb = this.getActiveBoardKb();
        if (!kb) return;
        kb.renderMode = (kb.renderMode === "vivid") ? "realistic" : "vivid";
        this.refreshFromState();
    }

    private addSpacer(parent: SceneObject): void {
        var obj = global.scene.createSceneObject("CP_spacer");
        obj.setParent(parent);
        this.items.push({ kind: "spacer", obj, tc: null, text: "", fontSize: 0,
            color: new vec4(0,0,0,0), height: 0 });
    }

    // ---- Reflow ----

    private reflowAll(): void {
        var contentW = this.panelWidth  - this.padding * 2;
        var contentH = this.panelHeight - this.padding * 2;
        if (contentW < 1) contentW = 1;

        var fixedH = 0, spacerCount = 0;

        for (var i = 0; i < this.items.length; i++) {
            var item = this.items[i];
            // Skip rows that have been hidden (e.g. collapsed "More" section).
            if (item.obj && (item.obj as any).enabled === false) {
                item.height = 0;
                continue;
            }
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
            var it = this.items[i];
            if (it.obj && (it.obj as any).enabled === false) continue; // hidden row contributes nothing
            var h = it.height;
            y -= h / 2;

            if (it.kind === "row") {
                this.layoutRow(it.obj, contentW, y);
            } else {
                it.obj.getTransform().setLocalPosition(new vec3(0, y, Z_TEXT));
            }

            y -= h / 2 + effectiveGap;
        }

        this.repositionTitleBlock();
    }

    private layoutRow(rowObj: SceneObject, contentW: number, centerY: number): void {
        var n = rowObj.getChildrenCount();
        if (n === 0) {
            // Empty row containers (e.g. boards-card backplate) still need
            // to be positioned at centerY so the row's own mesh visual lands
            // at the correct Y in panel-local space.
            rowObj.getTransform().setLocalPosition(new vec3(0, centerY, 0.5));
            return;
        }
        var colW = contentW / n;

        // Look up this row's height from its PanelItem so button size scales
        // with row hierarchy — primary rows are taller than secondary rows.
        var rowH = 4.5;
        for (var k = 0; k < this.items.length; k++) {
            if (this.items[k].obj === rowObj) { rowH = this.items[k].height; break; }
        }
        // Cap button width to one quarter of the panel so sparse rows
        // (e.g. a single-button MORE row) don't stretch full-width.
        var maxButtonW = (contentW / 4) * 0.92;
        var buttonW = Math.max(2.0, Math.min(colW * 0.92, maxButtonW));
        var buttonH = Math.max(1.6, rowH * 0.78);

        for (var i = 0; i < n; i++) {
            var child = rowObj.getChild(i);
            var x = -contentW / 2 + colW * i + colW / 2;
            child.getTransform().setLocalPosition(new vec3(x, centerY, Z_BTN));
            this.sizeButton(child, buttonW, buttonH);
        }
        rowObj.getTransform().setLocalPosition(new vec3(0, 0, 0));
    }

    // Walk a button SceneObject (prefab root + children) and force its UIKit
    // visual to (w, h). The visual.size setter cascades into RoundedRectangle
    // so the backplate, border and collider all resize. Re-fits the label
    // against the new inner width.
    private sizeButton(obj: SceneObject, w: number, h: number): void {
        var script = this.findCircuitButton(obj);
        if (!script) return;
        try { (script as any).size = new vec3(w, h, 1); } catch (e) {}
        try {
            if (typeof (script as any).setLabel === "function"
                && typeof (script as any).getLabel === "function") {
                (script as any).setLabel((script as any).getLabel());
            }
        } catch (e) {}
    }

    private findCircuitButton(obj: SceneObject): any {
        var scripts = obj.getComponents("Component.ScriptComponent") as any[];
        for (var i = 0; i < scripts.length; i++) {
            var sc = scripts[i] as any;
            // CircuitButton (and any UIKit RectangleButton-derived element)
            // exposes both setLabel/getLabel and a `size` property.
            if (sc && typeof sc.setLabel === "function" && sc.size !== undefined) {
                return sc;
            }
        }
        for (var ci = 0; ci < obj.getChildrenCount(); ci++) {
            var found = this.findCircuitButton(obj.getChild(ci));
            if (found) return found;
        }
        return null;
    }

    // ---- Board positioning above panel ----
    //
    // Boards lay out as a flat row above the panel, X-spread evenly across
    // the panel width. The focused board scales up (focusScale); the rest
    // scale down (bgScale). No idle motion.

    private snapBoardsToColumns(): void {
        this.computeBoardLocalTargets();
        if (this.boards.length === 0) {
            this.repositionTitleBlock();
            return;
        }
        // Instant snap: boards live outside the panel, so we drive their world
        // pose directly from the panel's world matrix × local column slot.
        var panelMat = this.sceneObject.getTransform().getWorldTransform();
        var panelRot = this.sceneObject.getTransform().getWorldRotation();
        for (var i = 0; i < this.boards.length; i++) {
            var b = this.boards[i];
            var worldPos = panelMat.multiplyPoint(this.boardLocalTargets[i]);
            b.obj.getTransform().setWorldPosition(worldPos);
            b.obj.getTransform().setWorldRotation(panelRot);
        }
        this.repositionTitleBlock();
    }

    // Snap a single board to its column slot at the panel's current world
    // transform. Called when a board is freshly activated so it appears next
    // to the (possibly-slid) panel instead of at a stale world position.
    private snapBoardToColumn(idx: number): void {
        if (idx < 0 || idx >= this.boards.length) return;
        if (this.boardLocalTargets.length !== this.boards.length) {
            this.computeBoardLocalTargets();
        }
        if (idx >= this.boardLocalTargets.length) return;
        var panelT = this.sceneObject.getTransform();
        var panelMat = panelT.getWorldTransform();
        var panelRot = panelT.getWorldRotation();
        var bt = this.boards[idx].obj.getTransform();
        bt.setWorldPosition(panelMat.multiplyPoint(this.boardLocalTargets[idx]));
        bt.setWorldRotation(panelRot);
    }

    // Recompute the panel-local column slot for each board. Stored as local
    // positions relative to the panel SceneObject and converted to world on use.
    private computeBoardLocalTargets(): void {
        this.boardBaseY = this.panelHeight / 2 - this.padding - this.boardCardHeight / 2;
        this.boardLocalTargets = [];
        if (this.boards.length === 0) return;
        var contentW = this.panelWidth - this.padding * 2;
        if (contentW < 1) contentW = 1;
        var n = this.boards.length;
        var colW = contentW / n;
        for (var i = 0; i < n; i++) {
            var x = -contentW / 2 + colW * i + colW / 2;
            this.boardLocalTargets.push(new vec3(x, this.boardBaseY, this.boardForwardZ));
        }
    }

    // Kick off an animated return to column slots. Each board starts from its
    // current world pose and lerps to the panel-local target sampled at animation
    // start (frozen so a sliding panel doesn't drag the targets out from under).
    private homeBoardsToColumns(): void {
        this.computeBoardLocalTargets();
        if (this.boards.length === 0) {
            this.repositionTitleBlock();
            return;
        }
        this.homingFromPos = [];
        this.homingFromRot = [];
        for (var i = 0; i < this.boards.length; i++) {
            var t = this.boards[i].obj.getTransform();
            this.homingFromPos.push(t.getWorldPosition());
            this.homingFromRot.push(t.getWorldRotation());
        }
        this.homingT = 0;
        this.homingActive = true;
        this.repositionTitleBlock();
    }

    private repositionTitleBlock(): void {
        if (!this.titleBlockObj) return;
        var boardSize = this.normalizeWidth > 0 ? this.normalizeWidth : 5;
        var titleY = this.boardBaseY + boardSize * 0.5 + this.titleAboveBoards;
        // Push the title forward to match the boards' Z plane so it clears the
        // panel's back face and doesn't z-fight with the title-block backplate.
        this.titleBlockObj.getTransform().setLocalPosition(new vec3(0, titleY, this.boardForwardZ));
    }

    // ---- Tick ----

    private tick(dt: number): void {
        if (!this.built) return;
        this.time += dt;

        // Keep scanning boardParent for late-arriving boards (async KiCadBoard.build())
        if (this.time < this.rescanEnd) {
            this.rescanTimer -= dt;
            if (this.rescanTimer <= 0) {
                this.rescanTimer = 0.5;
                if (this.rescanBoards()) {
                    this.rebuildBoardRowButtons();
                    this.reflowAll();
                    this.snapBoardsToColumns();
                    // Newly-discovered boards default to active+built; deactivate
                    // any that aren't the current focus so we don't blow memory.
                    this.deactivateNonFocused();
                    print("[CircuitPanel] Reflow — " + this.boards.length + " boards");
                }
            }
        }

        if (this.boards.length === 0) return;

        // Detect dynamic board loads (KiCadBoard.loadFromJson can swap a
        // board's content at runtime). Watch for boardSlug changes and
        // re-focus the changed slot. Voice-search-driven loads were the
        // historical caller; the loadFromJson API is preserved for future
        // re-enable but no UI currently triggers it.
        for (var ci = 0; ci < this.boards.length; ci++) {
            var cb = this.boards[ci];
            var curSlug = cb.kb.boardSlug || "";
            if (curSlug !== cb.prevSlug) {
                cb.prevSlug = curSlug;
                cb.outlineObj = null;
                if (ci < this.boardButtons.length) {
                    this.applyButtonLabel(this.boardButtons[ci],
                        getBoardButtonLabel(curSlug) || curSlug);
                }
                print("[CircuitPanel] Auto-focused slot " + ci + " on slug change -> " + curSlug);
            }
            if (curSlug && !cb.outlineObj) {
                var rebuilt = this.buildOutlineRect(cb.obj, cb.kb);
                if (rebuilt) {
                    cb.outlineObj = rebuilt;
                    if (this.focusedIdx !== ci) {
                        this.selectBoard(ci);
                    } else {
                        rebuilt.enabled = true;
                    }
                }
            }
        }

        for (var i = 0; i < this.boards.length; i++) {
            var b = this.boards[i];

            // Only apply scale during animated transitions (not every frame)
            var cur = b.currentScale;
            var tgt = b.targetScale;
            if (Math.abs(cur - tgt) > 0.001) {
                b.currentScale = cur + (tgt - cur) * Math.min(1, dt * this.animSpeed);
                var s = b.currentScale;
                var bs = this.boardBaseScales[i];
                b.obj.getTransform().setLocalScale(new vec3(bs.x * s, bs.y * s, bs.z * s));
            }
        }

        // Y-slide animation
        var yDiff = this.panelTargetLocalY - this.panelCurrentLocalY;
        if (Math.abs(yDiff) > 0.01) {
            this.panelCurrentLocalY += yDiff * Math.min(1.0, dt * this.animSpeed);
            var pos = this.sceneObject.getTransform().getLocalPosition();
            this.sceneObject.getTransform().setLocalPosition(
                new vec3(pos.x, this.panelCurrentLocalY, pos.z)
            );
        }

        // Boards homing back to their column slots after RETURN.
        if (this.homingActive) {
            this.homingT += dt;
            var ht = Math.min(1, this.homingT / this.homingDuration);
            // Smoothstep for a snappy-but-graceful land.
            var eased = ht * ht * (3 - 2 * ht);
            var panelMat = this.sceneObject.getTransform().getWorldTransform();
            var panelRot = this.sceneObject.getTransform().getWorldRotation();
            for (var hi = 0; hi < this.boards.length; hi++) {
                if (hi >= this.boardLocalTargets.length) continue;
                var bt = this.boards[hi].obj.getTransform();
                var fromP = this.homingFromPos[hi];
                var toP = panelMat.multiplyPoint(this.boardLocalTargets[hi]);
                bt.setWorldPosition(new vec3(
                    fromP.x + (toP.x - fromP.x) * eased,
                    fromP.y + (toP.y - fromP.y) * eased,
                    fromP.z + (toP.z - fromP.z) * eased,
                ));
                var fromR = this.homingFromRot[hi];
                bt.setWorldRotation(quat.slerp(fromR, panelRot, eased));
            }
            if (ht >= 1) {
                this.homingActive = false;
            }
        }

        // Connector tube animation
        if (this.connObj && this.connObj.enabled && this.connPass) {
            // Update endpoint world positions each frame (panel slides)
            var pWP = this.sceneObject.getTransform().getWorldPosition();
            var connA = new vec3(pWP.x, pWP.y - this.panelHeight * 0.5, pWP.z);

            var connB = new vec3(connA.x, connA.y - this.detailGap - this.detailHeight, connA.z);
            if (this.detailObj) {
                var dWP = this.detailObj.getTransform().getWorldPosition();
                connB = new vec3(dWP.x, dWP.y + this.detailHeight * 0.5, dWP.z);
            }

            // ConnectorShader.js uses scalar float uniforms, not vec3
            this.connPass.PointAx = connA.x;
            this.connPass.PointAy = connA.y;
            this.connPass.PointAz = connA.z;
            this.connPass.PointBx = connB.x;
            this.connPass.PointBy = connB.y;
            this.connPass.PointBz = connB.z;

            // ClipT growth
            if (this.connGrowing) {
                this.connClipT = Math.min(1.0, this.connClipT + dt * 2.0);
                this.connPass.ClipT = this.connClipT;
                if (this.connClipT >= 1.0) this.connGrowing = false;
            }
            // ClipT retraction
            else if (this.connRetracting) {
                this.connClipT = Math.max(0.0, this.connClipT - dt * 3.0);
                this.connPass.ClipT = this.connClipT;
                if (this.connClipT <= 0.0) {
                    this.connRetracting = false;
                    this.connObj.enabled = false;
                }
            }
        }
    }

    // ---- Focus / selection ----

    // Single focus entry. Mutates the truth (focusedIdx) and the board's
    // child SceneObjects (outline/detail panel), then runs refreshFromState
    // to push the new state out to every reactive UI element. Called from:
    //   - the ToggleGroup's onToggleSelected (user tap on a board button)
    //   - applyDefaultFocus / dynamic-load auto-focus (programmatic)
    private deactivateNonFocused(): void {
        for (var i = 0; i < this.boards.length; i++) {
            if (i === this.focusedIdx) continue;
            var kb = this.boards[i].kb as any;
            if (kb && typeof kb.deactivate === "function") {
                try { kb.deactivate(); } catch (e) {}
                this.boards[i].outlineObj = null;
            }
        }
    }

    private selectBoard(idx: number): void {
        if (idx < 0 || idx >= this.boards.length) return;
        if (this.focusedIdx === idx) {
            // Same-board re-click: make sure the board is alive and snapped to
            // its column slot. Without this the very first click on the
            // initially-focused button is a silent no-op even when the board
            // ended up at a stale world position, which surfaces as "click does
            // nothing — click another board, click back, now it appears".
            var sameKb = this.boards[idx].kb as any;
            if (sameKb && typeof sameKb.activate === "function") {
                try { sameKb.activate(); } catch (e) {}
            }
            this.snapBoardToColumn(idx);
            this.refreshFromState();
            return;
        }
        this.focusedIdx = idx;

        // Only the focused board renders and ticks. Others are deactivated
        // (geometry destroyed, SceneObject disabled) to keep CPU + memory low.
        // Reactivating triggers a chunked rebuild on demand.
        for (var bi = 0; bi < this.boards.length; bi++) {
            var kb = this.boards[bi].kb as any;
            if (!kb) continue;
            if (bi === idx) {
                if (typeof kb.activate === "function") {
                    try { kb.activate(); } catch (e) {}
                }
            } else {
                if (typeof kb.deactivate === "function") {
                    try { kb.deactivate(); } catch (e) {}
                    this.boards[bi].outlineObj = null;
                }
            }
        }

        // Snap the freshly-activated board to its column slot at the panel's
        // current world transform. Without this the board appears at whatever
        // world position it last had — which may be off-camera if the panel
        // slid (e.g. detail panel opened) since the last column snap.
        this.snapBoardToColumn(idx);

        for (var i = 0; i < this.boards.length; i++) {
            if (this.boards[i].outlineObj) this.boards[i].outlineObj.enabled = (i === idx);
        }
        this.showDetailPanel(idx);
        this.refreshFromState();
        print("[CircuitPanel] Focus -> " + (this.boards[idx].kb.boardSlug || idx));
    }

    // ---- Reactive state pump ----
    //
    // Single source of truth lives in:
    //   - this.focusedIdx                        (which board is selected)
    //   - this.boards[focused].kb.renderMode     (vivid | realistic)
    //   - this.boards[focused].kb.explodeAmount  (0..1)
    //   - this.lifeSizeOn                        (panel-level scale flag)
    //
    // refreshFromState reads the truth and writes it into every UI element.
    // Every mutator (toggleExplode, cycleRenderMode, selectBoard, …) ends
    // by calling refreshFromState — no element pulls or pushes on its own.
    private refreshFromState(): void {
        var hasFocus = this.focusedIdx >= 0;
        var kb = hasFocus ? this.boards[this.focusedIdx].kb : null;

        // Pull explode state from the board itself so the button visual
        // tracks the actual geometry — fixes case where kb.explodeAmount
        // is preset in the scene inspector but explodeOn defaulted to false.
        if (kb) this.explodeOn = (kb.explodeAmount || 0) > 0.5;

        // VIVID button — toggled state and label both follow renderMode.
        if (this.moreVividBtn) {
            var vividOn = !!(kb && kb.renderMode === "vivid");
            this.driveToggle(this.moreVividBtn, vividOn);
            this.applyButtonLabel(this.moreVividBtn, vividOn ? "VIVID" : "REALISTIC");
        }

        // EXPLODE / LIFE SIZE — mirror the panel's authoritative flags.
        if (this.explodeBtn)  this.driveToggle(this.explodeBtn,  this.explodeOn);
        if (this.lifeSizeBtn) this.driveToggle(this.lifeSizeBtn, this.lifeSizeOn);

        // Inactive flag on every action button when no board is focused.
        var inactiveBtns: (SceneObject | null)[] = [
            this.explodeBtn, this.lifeSizeBtn, this.returnBtn,
            this.moreToggleBtn, this.moreVividBtn,
        ];
        for (var bi = 0; bi < inactiveBtns.length; bi++) {
            var b = inactiveBtns[bi];
            if (!b) continue;
            var s = this.findCircuitButton(b);
            if (s && (s as any).inactive !== undefined) {
                try { (s as any).inactive = !hasFocus; } catch (e) {}
            }
        }

        // Board buttons: force the FSM state to match isOn. UIKit's
        // ToggleGroup untoggles siblings by writing `t.isOn = false`, but the
        // BaseButton setter only flips _isOn + the FSM's toggle flag — it
        // doesn't drive a state-name transition, so the previously-toggled
        // button keeps rendering in toggledDefault until the next interaction.
        // Forcing setState() here closes that gap.
        for (var bi = 0; bi < this.boardButtons.length; bi++) {
            var s = this.findCircuitButton(this.boardButtons[bi]) as any;
            if (!s) continue;
            var sn = s.stateName;
            var on = !!s.isOn;
            var inToggled = sn === "toggledDefault" || sn === "toggledHover" ||
                            sn === "toggledHovered" || sn === "toggledTriggered";
            if (on !== inToggled && typeof s.setState === "function") {
                try { s.setState(on ? "toggledDefault" : "default"); } catch (e) {}
            }
        }
    }

    // Drive a CircuitButton to on/off using the proper Toggleable API. This
    // routes through BaseButton.toggle → setOn(on, true) → updates _isOn AND
    // _interactableStateMachine.toggle, which is what actually swaps the
    // visual state to toggledDefault / default. `explicit=true` is harmless
    // for non-grouped buttons; for grouped board buttons we never call this.
    private driveToggle(btnObj: SceneObject, on: boolean): void {
        var s = this.findCircuitButton(btnObj) as any;
        if (!s) return;
        if (typeof s.toggle === "function" && s.isOn !== undefined) {
            if (s.isOn === on) return;
            try { s.toggle(on); return; } catch (e) {}
        }
        // Fallback for builds that don't expose toggle()
        try { s.isOn = on; } catch (e) {}
        try { if (typeof s.setState === "function") s.setState(on ? "toggledDefault" : "default"); } catch (e) {}
    }

    // ---- Detail panel spawning ----

    private showDetailPanel(idx: number): void {
        var kb = this.boards[idx].kb;

        // Dismiss any existing detail panel immediately
        if (this.detailObj) {
            this.detailObj.destroy();
            this.detailObj = null;
            this.detailScript = null;
        }

        // Slide main panel up
        this.panelTargetLocalY = this.panelBaseLocalY + this.slideUpAmount;

        var root = this.sceneObject;
        var detailY = -(this.panelHeight / 2 + this.detailGap + this.detailHeight / 2) - this.slideUpAmount;
        var usePrefab = !!this.detailPanelPrefab;

        if (usePrefab) {
            // Prefab path: scripts already initialized, showForBoard can be called immediately
            this.detailObj = this.detailPanelPrefab.instantiate(root);
            this.detailObj.name = "CircuitDetail";
            this.detailObj.getTransform().setLocalPosition(new vec3(0, detailY, 0));

            var scripts = this.detailObj.getComponents("Component.ScriptComponent") as any[];
            for (var i = 0; i < scripts.length; i++) {
                var sc = scripts[i] as any;
                if (sc && typeof sc.showForBoard === "function") { this.detailScript = sc; break; }
            }
            if (this.detailScript) {
                var self = this;
                this.detailScript.onClose = function() { self.onDetailClosed(); };
                this.detailScript.showForBoard(kb);
            }
        } else {
            // Dynamic path: create SceneObject and attach components in code.
            // CircuitDetailPanel first so its OnStartEvent fires before Frame's initialize(),
            // ensuring build() creates items before Frame sweeps them into content.
            this.detailObj = global.scene.createSceneObject("CircuitDetail");
            this.detailObj.setParent(root);
            this.detailObj.getTransform().setLocalPosition(new vec3(0, detailY, 0));

            var dp = this.detailObj.createComponent(CircuitDetailPanel.getTypeName()) as any;
            dp.buttonPrefab = this.buttonPrefab;
            dp.font = this.font;
            dp.panelWidth = 36;
            dp.panelHeight = this.detailHeight;
            this.detailScript = dp;

            // Frame second — initialize() sweeps the items build() creates into content
            this.detailObj.createComponent(CircuitFrame.getTypeName());

            var self = this;
            dp.onClose = function() { self.onDetailClosed(); };

            // Delay showForBoard until build() and Frame.initialize() have both run
            var capturedKb = kb;
            var capturedDp = dp;
            var showEvt = this.createEvent("DelayedCallbackEvent");
            showEvt.bind(function() { if (capturedDp) capturedDp.showForBoard(capturedKb); });
            (showEvt as any).reset(0.15);
        }

        // Build or reset connector tube
        this.buildConnector();
        this.connClipT = 0;
        this.connGrowing = true;
        this.connRetracting = false;
        if (this.connObj) this.connObj.enabled = true;
    }

    private hideDetailPanel(): void {
        // Slide main panel back
        this.panelTargetLocalY = this.panelBaseLocalY;

        // Retract connector
        this.connGrowing = false;
        this.connRetracting = true;

        // Dismiss detail panel (it animates out, fires onClose when done)
        if (this.detailScript && typeof this.detailScript.dismiss === "function") {
            (this.detailScript as any).dismiss();
        } else if (this.detailObj) {
            this.detailObj.destroy();
            this.detailObj = null;
            this.detailScript = null;
        }
    }

    private onDetailClosed(): void {
        if (this.detailObj) {
            this.detailObj.destroy();
            this.detailObj = null;
            this.detailScript = null;
        }
        if (this.connObj) this.connObj.enabled = false;
    }

    private buildConnector(): void {
        if (!this.connectorMaterial) return;

        // Reuse existing connector object or create one
        if (!this.connObj) {
            this.connObj = global.scene.createSceneObject("DetailConnector");
            this.connObj.setParent(this.sceneObject);
            this.connObj.getTransform().setLocalPosition(new vec3(0, 0, 0));

            // Build proper Manhattan-shader mesh via TubeMeshFactory
            // (texture0 = cross-section XY, texture1 = (t, isBody) — matches ConnectorShader.js)
            var mesh = buildTubeMesh(48, 8, 3);
            var mat = this.connectorMaterial.clone();
            var rmv = this.connObj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
            rmv.mesh = mesh;
            rmv.mainMaterial = mat;
            this.connPass = mat.mainPass;

            // Default tube appearance
            if (this.connPass) {
                this.connPass.TubeRadius  = 0.15;
                this.connPass.BendRadius  = 3.0;
                this.connPass.ClipT       = 0.0;
                // Exit downward from main panel bottom edge
                this.connPass.ExitDx = 0.0;
                this.connPass.ExitDy = -1.0;
                this.connPass.ExitDz = 0.0;
                // Vivid blue → cyan gradient
                this.connPass.ColorBase = new vec3(0.02, 0.06, 0.20);
                this.connPass.ColorTip  = new vec3(0.00, 0.50, 1.00);
                this.connPass.ColorGlow = new vec3(0.10, 0.90, 1.00);
            }
        }

        this.connObj.enabled = false;
    }

    // ---- Settings ----

    private toggleExplode(): void {
        if (this.focusedIdx < 0) return; // need an active board
        this.explodeOn = !this.explodeOn;
        var kb = this.boards[this.focusedIdx].kb;
        if (kb) kb.explodeAmount = this.explodeOn ? 1.0 : 0.0;
        this.refreshFromState();
    }

    private toggleLifeSize(): void {
        if (this.focusedIdx < 0) return; // need an active board
        var i = this.focusedIdx;
        this.lifeSizeOn = !this.lifeSizeOn;
        var kb = this.boards[i].kb;
        if (!kb) return;
        var so = this.boards[i].obj;
        if (this.lifeSizeOn) {
            // Expand to life-size (1 KiCad mm → 1 mm visible).
            // savedScales is left untouched so RETURN brings the board back to
            // the normalized gallery size set in discoverBoards.
            var sf = kb.scaleFactor || 1.0;
            var ls = 0.1 / sf;
            var lsV = new vec3(ls, ls, ls);
            so.getTransform().setLocalScale(lsV);
            this.boardBaseScales[i] = lsV;
        } else {
            // Restore the normalized gallery size.
            so.getTransform().setLocalScale(this.savedScales[i]);
            this.boardBaseScales[i] = this.savedScales[i];
        }
        this.refreshFromState();
    }

    private returnToRest(): void {
        this.explodeOn = false;
        this.lifeSizeOn = false;
        for (var i = 0; i < this.boards.length; i++) {
            this.boards[i].obj.getTransform().setLocalScale(this.savedScales[i]);
            this.boardBaseScales[i] = this.savedScales[i];
            var kb = this.boards[i].kb;
            if (kb) kb.explodeAmount = 0.0;
        }
        // Keep the current focus — RETURN moves the focused board back to the
        // frame, it does not switch boards. Refresh state in case any flags
        // changed (explode, lifeSize) so dependent UI mirrors the reset.
        this.refreshFromState();
        // Animated home: boards lerp from wherever the user dragged them back
        // to the column slot on the panel's current world transform.
        this.homeBoardsToColumns();
        this.hideDetailPanel();
    }

    // ---- Selection indicator (sphere below board) ----

    // Selection sphere removed. Kept the stub so callers and BoardEntry's
    // `outlineObj` field stay valid without any geometry being created.
    private buildOutlineRect(boardObj: SceneObject, kb: any): SceneObject | null {
        return null;
    }

    private appendUvSphere(mb: MeshBuilder, radius: number, lon: number, lat: number): void {
        var base = mb.getVerticesCount();
        for (var i = 0; i <= lat; i++) {
            var theta = i * Math.PI / lat;
            var sT = Math.sin(theta);
            var cT = Math.cos(theta);
            for (var j = 0; j <= lon; j++) {
                var phi = j * 2 * Math.PI / lon;
                var sP = Math.sin(phi);
                var cP = Math.cos(phi);
                var nx = sT * cP;
                var ny = cT;
                var nz = sT * sP;
                mb.appendVerticesInterleaved([
                    radius * nx, radius * ny, radius * nz,
                    nx, ny, nz,
                    j / lon, i / lat,
                ]);
            }
        }
        for (var ii = 0; ii < lat; ii++) {
            for (var jj = 0; jj < lon; jj++) {
                var first = base + ii * (lon + 1) + jj;
                var second = first + lon + 1;
                mb.appendIndices([first, second, first + 1, second, second + 1, first + 1]);
            }
        }
    }

    // ---- Helpers ----

    // Clone the outlineMaterial and override its baseColor uniform so each
    // indicator element can carry its own theme color without needing
    // separately scene-wired materials.
    private themedMaterial(color: vec4): Material | null {
        if (!this.outlineMaterial) return null;
        var m = this.outlineMaterial.clone();
        try { (m.mainPass as any)["baseColor"] = color; } catch (e) {}
        return m;
    }


    private applyButtonLabel(btnObj: SceneObject, label: string): void {
        // Search this object and children (prefab uses empty root + Content child)
        var found = this.findSetLabel(btnObj, label);
        if (!found) {
            var tc = this.findText(btnObj);
            if (tc) (tc as any).text = label;
        }
    }

    private findSetLabel(obj: SceneObject, label: string): boolean {
        var scripts = obj.getComponents("Component.ScriptComponent") as any[];
        for (var i = 0; i < scripts.length; i++) {
            var sc = scripts[i] as any;
            if (sc && typeof sc.setLabel === "function") {
                sc.setLabel(label);
                return true;
            }
        }
        for (var ci = 0; ci < obj.getChildrenCount(); ci++) {
            if (this.findSetLabel(obj.getChild(ci), label)) return true;
        }
        return false;
    }

    private findToggleable(obj: SceneObject): any {
        var scripts = obj.getComponents("Component.ScriptComponent") as any[];
        for (var si = 0; si < scripts.length; si++) {
            var sc = scripts[si] as any;
            if (sc && sc.setIsToggleable !== undefined) return sc;
        }
        for (var ci = 0; ci < obj.getChildrenCount(); ci++) {
            var found = this.findToggleable(obj.getChild(ci));
            if (found) return found;
        }
        return null;
    }

    private findInteractable(obj: SceneObject): any {
        var scripts = obj.getComponents("Component.ScriptComponent") as any[];
        for (var i = 0; i < scripts.length; i++) {
            var sc = scripts[i] as any;
            if (sc && sc.onTriggerStart !== undefined && sc.onHoverEnter !== undefined) {
                return sc;
            }
        }
        for (var i = 0; i < obj.getChildrenCount(); i++) {
            var found = this.findInteractable(obj.getChild(i));
            if (found) return found;
        }
        return null;
    }

    // Wire a click handler to a button, deferring if the Interactable
    // hasn't been created yet (Element.initialize runs on OnStart,
    // one frame after prefab instantiation).
    private wireButtonAction(btnObj: SceneObject, fn: Function): void {
        var interactable = this.findInteractable(btnObj);
        if (interactable) {
            interactable.onTriggerStart.add(fn);
            return;
        }
        // Interactable not ready — find the Element/Button script and wait
        var btn = this.findToggleable(btnObj);
        if (!btn) {
            // Fallback: search any script with onInitialized
            var scripts = btnObj.getComponents("Component.ScriptComponent") as any[];
            for (var si = 0; si < scripts.length; si++) {
                if (scripts[si] && scripts[si].onInitialized !== undefined) {
                    btn = scripts[si]; break;
                }
            }
        }
        if (btn && btn.onInitialized) {
            var self = this;
            btn.onInitialized.add(function() {
                var inter = self.findInteractable(btnObj);
                if (inter) inter.onTriggerStart.add(fn);
            });
        }
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
