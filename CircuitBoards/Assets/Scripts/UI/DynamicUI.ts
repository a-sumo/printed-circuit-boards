// DynamicUI.ts
// DEPRECATED: Use CircuitPanel.ts for the main board selection UI.
// Dynamic settings panel for Circuit Board Explorer.
// Instantiates UIKit toggle buttons and sliders at runtime,
// wires callbacks to a single KiCadBoard instance.
// Board switching uses switchBoard() which destroys and rebuilds geometry.

import { getAllDisplayNames, getAllSlugs } from '../Board/BoardCatalog';

@component
export class DynamicUI extends BaseScriptComponent {

    @input
    @hint("LabelledToggle prefab from UIKit")
    togglePrefab: ObjectPrefab;

    @input
    @hint("SliderWithLabel prefab")
    sliderPrefab: ObjectPrefab;

    @input
    @hint("Container for board selector toggles (needs ToggleGroup ScriptComponent)")
    boardSelectorContainer: SceneObject;

    @input
    @hint("Container for render mode toggles (needs ToggleGroup ScriptComponent)")
    renderModeContainer: SceneObject;

    @input
    @hint("Container for view control toggles (needs ToggleGroup ScriptComponent)")
    viewControlsContainer: SceneObject;

    @input
    @hint("Container for sliders")
    sliderContainer: SceneObject;

    @input
    @hint("KiCadBoard ScriptComponent to control")
    kiCadBoard: ScriptComponent;

    @input
    @hint("Horizontal spacing between toggles in cm")
    toggleSpacing: number = 9.0;

    @input
    @hint("Horizontal spacing between sliders in cm")
    sliderSpacing: number = 14.0;

    private boardSelectorToggles: SceneObject[] = [];
    private renderModeToggles: SceneObject[] = [];
    private viewControlToggles: SceneObject[] = [];
    private boardCallbackAdded: boolean = false;
    private renderCallbackAdded: boolean = false;

    private currentSlug: string = "arduino-nano";
    private currentRealistic: boolean = false;

    private explodeOn: boolean = false;
    private signalFlowOn: boolean = false;
    private lifeSizeOn: boolean = false;
    private savedLocalScale: vec3 = new vec3(1, 1, 1);
    private initializing: boolean = true;

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => {
            this.initializing = true;
            var kb = this.kiCadBoard as any;
            if (kb) {
                this.currentSlug = kb.boardSlug || "arduino-nano";
                this.currentRealistic = (kb.renderMode === "realistic");
                var so = kb.sceneObject;
                if (so) this.savedLocalScale = so.getTransform().getLocalScale();
            }

            this.buildBoardSelector();
            this.buildRenderModeSelector();
            this.buildViewControls();
            this.buildSliders();
            this.initializing = false;
            print("[DynamicUI] Panel built");
        });
    }

    // ------------------------------------------------------------------
    // Board Selector
    // ------------------------------------------------------------------
    private buildBoardSelector(): void {
        var boards: string[] = getAllDisplayNames();
        var slugs: string[] = getAllSlugs();

        var toggleGroupScript = this.findToggleGroupComponent(this.boardSelectorContainer);

        if (toggleGroupScript && !this.boardCallbackAdded) {
            toggleGroupScript.firstOnToggle = 0;
            toggleGroupScript.onToggleSelected.add((args: any) => {
                if (this.initializing) return;
                var index = args.value;
                if (index !== undefined && index >= 0 && index < slugs.length) {
                    var newSlug = slugs[index];
                    if (newSlug === this.currentSlug) return;
                    this.currentSlug = newSlug;
                    print("[DynamicUI] Board selected: " + newSlug);
                    var kb = this.kiCadBoard as any;
                    if (kb && kb.switchBoard) {
                        kb.switchBoard(newSlug, this.currentRealistic);
                    }
                    this.explodeOn = false;
                    this.signalFlowOn = false;
                }
            });
            this.boardCallbackAdded = true;
        }

        var initialIdx = 0;
        for (var si = 0; si < slugs.length; si++) {
            if (slugs[si] === this.currentSlug) { initialIdx = si; break; }
        }
        if (toggleGroupScript) {
            toggleGroupScript.firstOnToggle = initialIdx;
        }

        for (var i = 0; i < boards.length; i++) {
            var toggleObj = this.createToggleInContainer(
                this.togglePrefab, this.boardSelectorContainer, boards[i], i, boards.length
            );
            this.boardSelectorToggles.push(toggleObj);
            var toggleScript = this.findToggleComponent(toggleObj);
            if (toggleScript && toggleGroupScript) {
                toggleGroupScript.registerToggleable(toggleScript, i);
            }
        }

        if (toggleGroupScript && toggleGroupScript.resetToggleGroup) {
            toggleGroupScript.resetToggleGroup();
        }
    }

    // ------------------------------------------------------------------
    // Render Mode: Vivid | Realistic
    // ------------------------------------------------------------------
    private buildRenderModeSelector(): void {
        var modes: string[] = ["Vivid", "Realistic"];
        var toggleGroupScript = this.findToggleGroupComponent(this.renderModeContainer);

        if (toggleGroupScript && !this.renderCallbackAdded) {
            toggleGroupScript.firstOnToggle = 0;
            toggleGroupScript.onToggleSelected.add((args: any) => {
                if (this.initializing) return;
                var index = args.value;
                if (index !== undefined) {
                    var isRealistic = (index === 1);
                    if (isRealistic === this.currentRealistic) return;
                    this.currentRealistic = isRealistic;
                    print("[DynamicUI] Render mode: " + (isRealistic ? "Realistic" : "Vivid"));
                    var kb = this.kiCadBoard as any;
                    if (kb) {
                        kb.renderMode = isRealistic ? "realistic" : "vivid";
                    }
                }
            });
            this.renderCallbackAdded = true;
        }

        var kb = this.kiCadBoard as any;
        var currentRealistic = (kb && kb.renderMode === "realistic") ? 1 : 0;
        if (toggleGroupScript) {
            toggleGroupScript.firstOnToggle = currentRealistic;
        }

        for (var i = 0; i < modes.length; i++) {
            var toggleObj = this.createToggleInContainer(
                this.togglePrefab, this.renderModeContainer, modes[i], i, modes.length
            );
            this.renderModeToggles.push(toggleObj);
            var toggleScript = this.findToggleComponent(toggleObj);
            if (toggleScript && toggleGroupScript) {
                toggleGroupScript.registerToggleable(toggleScript, i);
            }
        }

        if (toggleGroupScript && toggleGroupScript.resetToggleGroup) {
            toggleGroupScript.resetToggleGroup();
        }
    }

    // ------------------------------------------------------------------
    // View Controls
    // ------------------------------------------------------------------
    private buildViewControls(): void {
        var controls: string[] = ["Explode", "Signal Flow", "Play Growth", "Life Size"];
        for (var i = 0; i < controls.length; i++) {
            var toggleObj = this.createToggleInContainer(
                this.togglePrefab, this.viewControlsContainer, controls[i], i, controls.length
            );
            this.viewControlToggles.push(toggleObj);
            var toggleScript = this.findToggleComponent(toggleObj);
            if (toggleScript) this.wireViewToggle(toggleScript, i);
        }
    }

    private wireViewToggle(toggleScript: any, index: number): void {
        var self = this;
        var handler = function() {
            var kb = self.kiCadBoard as any;
            if (!kb) return;

            if (index === 0) {
                self.explodeOn = !self.explodeOn;
                kb.explodeAmount = self.explodeOn ? 1.0 : 0.0;
                self.updateToggleLabel(self.viewControlToggles[0], self.explodeOn ? "Collapse" : "Explode");
            } else if (index === 1) {
                self.signalFlowOn = !self.signalFlowOn;
                kb.signalFlowMode = self.signalFlowOn ? "on" : "off";
                self.updateToggleLabel(self.viewControlToggles[1], self.signalFlowOn ? "Flow Off" : "Signal Flow");
            } else if (index === 2) {
                if (kb.replayGrowth) kb.replayGrowth();
            } else if (index === 3) {
                self.lifeSizeOn = !self.lifeSizeOn;
                var so = kb.sceneObject;
                if (so) {
                    if (self.lifeSizeOn) {
                        self.savedLocalScale = so.getTransform().getLocalScale();
                        // scaleFactor=1 means 1mm→1cm. Life size = 0.1× scale (1mm→1mm real).
                        var sf = (kb.scaleFactor || 1.0);
                        var ls = 0.1 / sf;
                        so.getTransform().setLocalScale(new vec3(ls, ls, ls));
                    } else {
                        so.getTransform().setLocalScale(self.savedLocalScale);
                    }
                }
                self.updateToggleLabel(self.viewControlToggles[3], self.lifeSizeOn ? "Miniature" : "Life Size");
            }
        };

        if (toggleScript.onSwitchToggle) toggleScript.onSwitchToggle.add(handler);
        else if (toggleScript.onFinished) toggleScript.onFinished.add(handler);
    }

    // ------------------------------------------------------------------
    // Sliders
    // ------------------------------------------------------------------
    private buildSliders(): void {
        if (!this.sliderContainer || !this.sliderPrefab) return;

        var kb = this.kiCadBoard as any;
        var sliders: { label: string, initial: number, min: number, max: number, prop: string }[] = [
            { label: "Explode Spread", initial: 10, min: 1, max: 50, prop: "explodeSpread" },
            { label: "Flow Speed", initial: 1.5, min: 0.5, max: 5.0, prop: "flowSpeed" },
            { label: "Flow Intensity", initial: 0.4, min: 0.1, max: 1.0, prop: "flowIntensity" },
        ];

        for (var i = 0; i < sliders.length; i++) {
            var cfg = sliders[i];
            var sliderObj = this.sliderPrefab.instantiate(this.sliderContainer);
            sliderObj.name = "Slider_" + cfg.label.replace(/ /g, "_");

            var totalWidth = (sliders.length - 1) * this.sliderSpacing;
            var startOffset = -totalWidth / 2;
            var localPos = sliderObj.getTransform().getLocalPosition();
            sliderObj.getTransform().setLocalPosition(new vec3(
                startOffset + (i * this.sliderSpacing), localPos.y, localPos.z
            ));

            this.setToggleLabel(sliderObj, cfg.label);

            var sliderScript = this.findSliderComponent(sliderObj);
            if (sliderScript) {
                var currentVal = (kb && kb[cfg.prop] !== undefined) ? kb[cfg.prop] : cfg.initial;
                var norm = (currentVal - cfg.min) / (cfg.max - cfg.min);
                try { sliderScript.currentValue = Math.max(0, Math.min(1, norm)); } catch (e) {}

                (function(sldr: any, prop: string, mn: number, mx: number, kbRef: any) {
                    var handler = function(value: number) {
                        if (kbRef) kbRef[prop] = mn + value * (mx - mn);
                    };
                    if (sldr.onValueUpdate) sldr.onValueUpdate.add(handler);
                    else if (sldr.onValueChange) sldr.onValueChange.add(handler);
                })(sliderScript, cfg.prop, cfg.min, cfg.max, kb);
            }
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private createToggleInContainer(
        prefab: ObjectPrefab, container: SceneObject, label: string,
        index: number, totalCount: number
    ): SceneObject {
        var toggleObj = prefab.instantiate(container);
        toggleObj.name = "Toggle_" + label.replace(/ /g, "_");
        var totalWidth = (totalCount - 1) * this.toggleSpacing;
        var startOffset = -totalWidth / 2;
        var localPos = toggleObj.getTransform().getLocalPosition();
        toggleObj.getTransform().setLocalPosition(new vec3(
            startOffset + (index * this.toggleSpacing), localPos.y, localPos.z
        ));
        this.setToggleLabel(toggleObj, label);
        return toggleObj;
    }

    private updateToggleLabel(toggleObj: SceneObject, label: string): void {
        if (!toggleObj) return;
        this.setToggleLabel(toggleObj, label);
    }

    private setToggleLabel(toggleObj: SceneObject, label: string): void {
        var labelObj = this.findChildByName(toggleObj, "Label");
        if (labelObj) {
            var textComp = this.findTextComponent(labelObj);
            if (textComp) { textComp.text = label; return; }
        }
        var textComp = this.findTextComponent(toggleObj);
        if (textComp) textComp.text = label;
    }

    private findToggleGroupComponent(obj: SceneObject): any {
        var scripts = obj.getComponents("Component.ScriptComponent");
        for (var i = 0; i < scripts.length; i++) {
            var script = scripts[i] as any;
            if (script.registerToggleable !== undefined) return script;
        }
        return null;
    }

    private findToggleComponent(obj: SceneObject): any {
        var scripts = obj.getComponents("Component.ScriptComponent");
        for (var i = 0; i < scripts.length; i++) {
            var script = scripts[i] as any;
            if (script.isOn !== undefined && script.onFinished !== undefined) return script;
        }
        for (var i = 0; i < obj.getChildrenCount(); i++) {
            var found = this.findToggleComponent(obj.getChild(i));
            if (found) return found;
        }
        return null;
    }

    private findSliderComponent(obj: SceneObject): any {
        var scripts = obj.getComponents("Component.ScriptComponent");
        for (var i = 0; i < scripts.length; i++) {
            var script = scripts[i] as any;
            if (script.currentValue !== undefined && (script.onValueUpdate || script.onValueChange)) return script;
        }
        for (var i = 0; i < obj.getChildrenCount(); i++) {
            var found = this.findSliderComponent(obj.getChild(i));
            if (found) return found;
        }
        return null;
    }

    private findTextComponent(obj: SceneObject): Text {
        var textComp = obj.getComponent("Component.Text");
        if (textComp) return textComp as Text;
        for (var i = 0; i < obj.getChildrenCount(); i++) {
            var found = this.findTextComponent(obj.getChild(i));
            if (found) return found;
        }
        return null as unknown as Text;
    }

    private findChildByName(parent: SceneObject, name: string): SceneObject {
        for (var i = 0; i < parent.getChildrenCount(); i++) {
            var child = parent.getChild(i);
            if (child.name === name) return child;
            var found = this.findChildByName(child, name);
            if (found) return found;
        }
        return null as unknown as SceneObject;
    }
}
