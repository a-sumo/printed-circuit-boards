// StoryMode.ts
// Orchestrates a guided experience flow through the circuit board explorer.
// Drives KiCadBoard's public API through a state machine. Does not reimplement
// any features -- just sequences them into a narrative.
//
// Setup in LS Inspector:
//   1. Create StoryMode SceneObject alongside KiCadBoard
//   2. Attach this script, connect kiCadBoard + dynamicUI inputs
//   3. Set mode to "story", "demo", or "off"

@component
export class StoryMode extends BaseScriptComponent {
    @input
    @hint("KiCadBoard ScriptComponent to orchestrate")
    kiCadBoard: ScriptComponent;

    @input @allowUndefined
    @hint("DynamicUI ScriptComponent for panel visibility control")
    dynamicUI: ScriptComponent;

    @input
    @widget(new ComboBoxWidget([
        new ComboBoxItem("Off", "off"),
        new ComboBoxItem("Story", "story"),
        new ComboBoxItem("Demo", "demo"),
    ]))
    @hint("Off = disabled, Story = guided first-time flow, Demo = automated 2-min loop")
    mode: string = "off";

    @input @allowUndefined
    @hint("Font for hint text overlays")
    hintFont: Font;

    // State machine
    private stateIdx: number = 0;
    private stateElapsed: number = 0;
    private active: boolean = false;
    private entered: boolean = false;

    // Hint text overlay
    private hintObj: SceneObject | null = null;
    private hintTextComp: Text | null = null;

    // Lerp system
    private lerps: { prop: string, from: number, to: number, dur: number, t: number }[] = [];

    // State definitions
    private stateCount: number = 0;

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => {
            if (this.mode === "off") return;
            this.active = true;
            this.stateIdx = 0;
            this.stateElapsed = 0;
            this.entered = false;

            if (this.mode === "story") {
                this.stateCount = 9;
            } else {
                this.stateCount = 8;
            }

            this.createEvent("UpdateEvent").bind(() => {
                if (!this.active) return;
                this.tick();
            });
        });
    }

    private tick(): void {
        var kb = this.kiCadBoard as any;
        if (!kb) return;
        var dt = getDeltaTime();

        // Enter state on first frame
        if (!this.entered) {
            this.entered = true;
            this.stateElapsed = 0;
            this.lerps = [];
            if (this.mode === "story") {
                this.enterStoryState(kb, this.stateIdx);
            } else {
                this.enterDemoState(kb, this.stateIdx);
            }
        }

        this.stateElapsed += dt;
        this.tickLerps(kb, dt);

        var advance = false;
        if (this.mode === "story") {
            advance = this.tickStoryState(kb, dt);
        } else {
            advance = this.tickDemoState(kb, dt);
        }

        if (advance) {
            if (this.mode === "story") {
                this.exitStoryState(kb, this.stateIdx);
            } else {
                this.exitDemoState(kb, this.stateIdx);
            }

            this.stateIdx++;
            if (this.mode === "demo" && this.stateIdx >= this.stateCount) {
                this.stateIdx = 0; // loop demo
            }
            if (this.stateIdx >= this.stateCount) {
                this.active = false;
                return;
            }
            this.entered = false;
        }
    }

    // =====================================================================
    // Story Mode States
    // INIT -> APPEARANCE -> SURFACE -> CLAP_HINT -> LAYERS -> GROWTH ->
    // SIGNAL_FLOW -> SCHEMATIC -> FREE_PLAY
    // =====================================================================

    private enterStoryState(kb: any, idx: number): void {
        print("[StoryMode] Enter story state " + idx);
        switch (idx) {
            case 0: // INIT
                kb.handDriven = true;
                kb.storyOverride = true;
                kb.renderMode = "vivid";
                kb.showLabels = false;
                kb.signalFlowMode = "off";
                kb.showSchematic = false;
                kb.explodeAmount = 0;
                if (kb.setAllGrowth) kb.setAllGrowth(0);
                if (kb.flushAllTraceGrowth) kb.flushAllTraceGrowth();
                this.setDynamicUIVisible(false);
                break;
            case 1: // APPEARANCE
                // Hand proximity drives reveal (already handDriven=true)
                break;
            case 2: // SURFACE
                kb.showLabels = true;
                break;
            case 3: // CLAP_HINT
                this.showHint("Snap to explore inside", new vec3(0, 0, 4));
                break;
            case 4: // LAYERS
                // Board is exploded, user explores
                break;
            case 5: // GROWTH
                kb.handDriven = false;
                kb.handRevealT = 1.0;
                // Ensure everything visible
                if (kb.applyVisibility) kb.applyVisibility();
                if (kb.replayGrowth) kb.replayGrowth();
                break;
            case 6: // SIGNAL_FLOW
                kb.signalFlowMode = "on";
                break;
            case 7: // SCHEMATIC
                kb.showSchematic = true;
                this.startLerp("morphAmount", 0, 0.5, 3.0);
                break;
            case 8: // FREE_PLAY
                kb.storyOverride = false;
                kb.handDriven = true;
                this.setDynamicUIVisible(true);
                this.syncDynamicUI();
                break;
        }
    }

    private tickStoryState(kb: any, dt: number): boolean {
        switch (this.stateIdx) {
            case 0: // INIT - wait for build to finish
                return kb.buildPhase === -1;
            case 1: // APPEARANCE - wait for hand reveal
                return kb.handRevealT > 0.8 || this.stateElapsed > 30;
            case 2: // SURFACE - dwell
                return this.stateElapsed > 12;
            case 3: // CLAP_HINT - wait for clap
                this.pulseHint(dt);
                if (kb.explodeAmount > 0.5) return true;
                if (this.stateElapsed > 30) {
                    // Auto-explode if no clap
                    kb.explodeAmount = 1.0;
                    return true;
                }
                return false;
            case 4: // LAYERS - wait for second clap or timeout
                if (kb.explodeAmount < 0.5) return true;
                return this.stateElapsed > 20;
            case 5: // GROWTH - wait for animation to finish
                return kb.animActive === false || this.stateElapsed > 20;
            case 6: // SIGNAL_FLOW - dwell
                return this.stateElapsed > 15;
            case 7: // SCHEMATIC - wait for lerp + dwell
                return !this.isLerping("morphAmount") && this.stateElapsed > 25;
            case 8: // FREE_PLAY - terminal
                return false;
        }
        return false;
    }

    private exitStoryState(kb: any, idx: number): void {
        switch (idx) {
            case 3: // CLAP_HINT
                this.hideHint();
                break;
            case 4: // LAYERS
                if (kb.explodeAmount > 0.5) {
                    this.startLerp("explodeAmount", kb.explodeAmount, 0, 1.0);
                }
                break;
            case 5: // GROWTH
                if (kb.setAllGrowth) kb.setAllGrowth(1.0);
                if (kb.flushAllTraceGrowth) kb.flushAllTraceGrowth();
                break;
            case 7: // SCHEMATIC
                kb.morphAmount = 0;
                kb.showSchematic = false;
                kb.signalFlowMode = "off";
                break;
        }
    }

    // =====================================================================
    // Demo Mode States
    // INIT -> REVEAL -> EXPLODE -> FLOW -> MORPH -> REALISTIC ->
    // BOARD_SWITCH -> FINAL -> (loop)
    // =====================================================================

    private enterDemoState(kb: any, idx: number): void {
        print("[StoryMode] Enter demo state " + idx);
        switch (idx) {
            case 0: // INIT
                kb.handDriven = false;
                kb.storyOverride = true;
                kb.renderMode = "vivid";
                kb.showLabels = true;
                kb.signalFlowMode = "off";
                kb.showSchematic = false;
                kb.explodeAmount = 0;
                kb.morphAmount = 0;
                if (kb.setAllGrowth) kb.setAllGrowth(0);
                if (kb.flushAllTraceGrowth) kb.flushAllTraceGrowth();
                this.setDynamicUIVisible(false);
                break;
            case 1: // REVEAL
                // Board reveal + growth
                kb.handRevealT = 1.0;
                if (kb.boardMatPass) kb.boardMatPass["boardTime"] = 1.0;
                if (kb.replayGrowth) kb.replayGrowth();
                break;
            case 2: // EXPLODE
                this.startLerp("explodeAmount", 0, 1, 1.5);
                break;
            case 3: // FLOW
                kb.signalFlowMode = "on";
                break;
            case 4: // MORPH
                this.startLerp("explodeAmount", 1, 0, 1.5);
                kb.showSchematic = true;
                this.startLerp("morphAmount", 0, 0.7, 3.0);
                break;
            case 5: // REALISTIC
                kb.showSchematic = false;
                kb.morphAmount = 0;
                kb.signalFlowMode = "off";
                if (kb.switchBoard) kb.switchBoard(kb.boardSlug, true);
                break;
            case 6: // BOARD_SWITCH
                if (kb.switchBoard) kb.switchBoard("rpi-cm4io", true);
                break;
            case 7: // FINAL
                if (kb.replayGrowth) kb.replayGrowth();
                break;
        }
    }

    private tickDemoState(kb: any, dt: number): boolean {
        switch (this.stateIdx) {
            case 0: // INIT - wait for build
                return kb.buildPhase === -1;
            case 1: // REVEAL - wait for growth to finish
                return (kb.animActive === false && this.stateElapsed > 2) || this.stateElapsed > 12;
            case 2: // EXPLODE - dwell
                return this.stateElapsed > 8;
            case 3: // FLOW - dwell
                return this.stateElapsed > 10;
            case 4: // MORPH - wait for lerps + dwell
                return !this.isLerping("explodeAmount") && !this.isLerping("morphAmount") && this.stateElapsed > 12;
            case 5: // REALISTIC - wait for build + dwell
                return kb.buildPhase === -1 && this.stateElapsed > 10;
            case 6: // BOARD_SWITCH - wait for build + dwell
                return kb.buildPhase === -1 && this.stateElapsed > 10;
            case 7: // FINAL - wait for growth + dwell
                return (kb.animActive === false && this.stateElapsed > 2) || this.stateElapsed > 5;
        }
        return false;
    }

    private exitDemoState(kb: any, idx: number): void {
        switch (idx) {
            case 4: // MORPH
                // Clean up before realistic switch
                break;
            case 7: // FINAL - reset for loop
                kb.renderMode = "vivid";
                kb.showSchematic = false;
                kb.morphAmount = 0;
                kb.signalFlowMode = "off";
                kb.explodeAmount = 0;
                if (kb.switchBoard) kb.switchBoard("arduino-nano", false);
                break;
        }
    }

    // =====================================================================
    // Public API: allow external abort
    // =====================================================================

    public stop(): void {
        if (!this.active) return;
        var kb = this.kiCadBoard as any;
        if (kb) {
            kb.storyOverride = false;
            kb.handDriven = true;
        }
        this.hideHint();
        this.setDynamicUIVisible(true);
        this.syncDynamicUI();
        this.active = false;
        print("[StoryMode] Stopped");
    }

    // =====================================================================
    // Lerp System
    // =====================================================================

    private startLerp(prop: string, from: number, to: number, dur: number): void {
        // Remove existing lerp on same prop
        var filtered: { prop: string, from: number, to: number, dur: number, t: number }[] = [];
        for (var i = 0; i < this.lerps.length; i++) {
            if (this.lerps[i].prop !== prop) filtered.push(this.lerps[i]);
        }
        filtered.push({ prop: prop, from: from, to: to, dur: dur, t: 0 });
        this.lerps = filtered;
    }

    private tickLerps(kb: any, dt: number): void {
        var alive: { prop: string, from: number, to: number, dur: number, t: number }[] = [];
        for (var i = 0; i < this.lerps.length; i++) {
            var l = this.lerps[i];
            l.t += dt;
            var p = Math.min(1, l.t / l.dur);
            // Ease-out cubic
            var ep = 1 - (1 - p) * (1 - p) * (1 - p);
            kb[l.prop] = l.from + (l.to - l.from) * ep;
            if (p < 1) alive.push(l);
        }
        this.lerps = alive;
    }

    private isLerping(prop: string): boolean {
        for (var i = 0; i < this.lerps.length; i++) {
            if (this.lerps[i].prop === prop) return true;
        }
        return false;
    }

    // =====================================================================
    // Hint Text
    // =====================================================================

    private showHint(text: string, offset: vec3): void {
        this.hideHint();
        var parent = this.kiCadBoard ? (this.kiCadBoard as any).sceneObject : this.sceneObject;
        var obj = global.scene.createSceneObject("__storyHint");
        obj.setParent(parent);
        var tc = obj.createComponent("Component.Text") as Text;
        tc.text = text;
        tc.size = 48;
        if (this.hintFont) tc.font = this.hintFont;
        tc.textFill.color = new vec4(0.91, 0.69, 0.063, 1.0); // gold
        tc.horizontalAlignment = HorizontalAlignment.Center;
        var t = obj.getTransform();
        t.setLocalPosition(offset);
        t.setLocalScale(new vec3(0.12, 0.12, 0.12));
        this.hintObj = obj;
        this.hintTextComp = tc;
    }

    private hideHint(): void {
        if (this.hintObj) {
            this.hintObj.destroy();
            this.hintObj = null;
            this.hintTextComp = null;
        }
    }

    private pulseHint(dt: number): void {
        if (!this.hintTextComp) return;
        var alpha = 0.5 + 0.5 * Math.sin(this.stateElapsed * 3.0);
        this.hintTextComp.textFill.color = new vec4(0.91, 0.69, 0.063, alpha);
    }

    // =====================================================================
    // DynamicUI helpers
    // =====================================================================

    private setDynamicUIVisible(visible: boolean): void {
        if (!this.dynamicUI) return;
        var ui = this.dynamicUI as any;
        if (ui.setVisible) {
            ui.setVisible(visible);
        } else {
            ui.sceneObject.enabled = visible;
        }
    }

    private syncDynamicUI(): void {
        if (!this.dynamicUI) return;
        var ui = this.dynamicUI as any;
        if (ui.syncFromBoard) ui.syncFromBoard();
    }
}
