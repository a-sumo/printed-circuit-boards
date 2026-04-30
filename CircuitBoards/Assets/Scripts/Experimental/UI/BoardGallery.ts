/**
 * BoardGallery.ts — Spatial gallery for all KiCad board SceneObjects.
 *
 * Positions child boards in a horizontal row on start.
 * Tap a board to focus it (scale up, others scale down).
 * Tap the focused board again to deselect (return to gallery).
 *
 * Each board SceneObject must have a KiCadBoard script component.
 * Boards are discovered as direct children of this SceneObject's parent,
 * or from the boardParent input if set.
 *
 * Wire a BoardPanel to each board by setting the panel input —
 * the gallery shows the panel for the focused board and hides others.
 */

import { outCubic } from '../../Common/Easing';
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";

interface BoardEntry {
    obj: SceneObject;
    basePos: vec3;
    baseScale: vec3;
    hitArea: SceneObject | null;
    panel: SceneObject | null;
}

@component
export class BoardGallery extends BaseScriptComponent {

    @input
    @hint("Parent SceneObject whose children are the board SceneObjects. Leave empty to use this object's parent.")
    boardParent: SceneObject;

    @input
    @hint("Horizontal spacing between boards in cm")
    boardSpacing: number = 40.0;

    @input
    @hint("Scale multiplier for focused board")
    focusScale: number = 1.3;

    @input
    @hint("Scale multiplier for unfocused boards when one is focused")
    backgroundScale: number = 0.75;

    @input
    @hint("Animation speed (higher = faster snap)")
    animSpeed: number = 6.0;

    @input
    @hint("Hit area half-size in cm (XY plane). Set to match your largest board.")
    hitHalfSize: number = 20.0;

    @input
    @hint("Hit area material — should be invisible on Spectacles (black = transparent)")
    @allowUndefined
    hitMaterial: Material;

    // ---- State ----
    private boards: BoardEntry[] = [];
    private focusedIdx: number = -1;
    private targetScales: number[] = [];
    private currentScales: number[] = [];
    private time: number = 0;
    private built: boolean = false;

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.build());
        this.createEvent("UpdateEvent").bind((e: UpdateEvent) => this.tick(getDeltaTime()));
    }

    private build(): void {
        if (this.built) return;
        this.built = true;

        var parent = this.boardParent || this.sceneObject.getParent();
        if (!parent) { print("[BoardGallery] No parent found"); return; }

        var count = parent.getChildrenCount();
        var boardObjs: SceneObject[] = [];
        for (var i = 0; i < count; i++) {
            var child = parent.getChild(i);
            // A board has a KiCadBoard script
            var scripts = child.getComponents("Component.ScriptComponent") as any[];
            for (var si = 0; si < scripts.length; si++) {
                if (scripts[si] && scripts[si].boardSlug !== undefined) {
                    boardObjs.push(child);
                    break;
                }
            }
        }

        if (boardObjs.length === 0) {
            print("[BoardGallery] No KiCadBoard children found under " + parent.name);
            return;
        }

        var n = boardObjs.length;
        var totalWidth = (n - 1) * this.boardSpacing;
        var startX = -totalWidth / 2;

        for (var i = 0; i < n; i++) {
            var obj = boardObjs[i];
            var pos = new vec3(startX + i * this.boardSpacing, 0, 0);
            obj.getTransform().setLocalPosition(pos);

            var baseScale = obj.getTransform().getLocalScale();

            var entry: BoardEntry = {
                obj: obj,
                basePos: pos,
                baseScale: baseScale,
                hitArea: this.buildHitArea(obj, i),
                panel: this.findPanel(obj),
            };
            this.boards.push(entry);
            this.targetScales.push(1.0);
            this.currentScales.push(1.0);
        }

        // Hide all panels initially
        for (var i = 0; i < this.boards.length; i++) {
            if (this.boards[i].panel) this.boards[i].panel.enabled = false;
        }

        print("[BoardGallery] Discovered " + this.boards.length + " boards");
    }

    private buildHitArea(parent: SceneObject, idx: number): SceneObject {
        var obj = global.scene.createSceneObject("__hit_" + idx);
        obj.setParent(parent);
        obj.getTransform().setLocalPosition(new vec3(0, 0, 0));

        // Flat quad covering the board area
        var mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal",   components: 3 },
            { name: "texture0", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;
        var h = this.hitHalfSize;
        mb.appendVerticesInterleaved([
            -h, -h, 0,  0, 0, 1,  0, 0,
             h, -h, 0,  0, 0, 1,  1, 0,
             h,  h, 0,  0, 0, 1,  1, 1,
            -h,  h, 0,  0, 0, 1,  0, 1,
        ]);
        mb.appendIndices([0, 1, 2, 0, 2, 3]);
        mb.updateMesh();

        var rmv = obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        rmv.mesh = mb.getMesh();
        if (this.hitMaterial) {
            rmv.mainMaterial = this.hitMaterial;
        } else {
            // No material = invisible on Spectacles additive (black quads = transparent)
        }

        // Interactable for tap
        var sik = obj.createComponent(Interactable.getTypeName()) as Interactable;
        if (sik) {
            var self = this;
            var capturedIdx = idx;
            sik.onTriggerStart.add(function() {
                self.onBoardTapped(capturedIdx);
            });
        }

        return obj;
    }

    private findPanel(boardObj: SceneObject): SceneObject | null {
        // Look for a child named "Panel" or with a BoardPanel script
        for (var i = 0; i < boardObj.getChildrenCount(); i++) {
            var child = boardObj.getChild(i);
            if (child.name.toLowerCase().indexOf("panel") >= 0) return child;
            var scripts = child.getComponents("Component.ScriptComponent") as any[];
            for (var si = 0; si < scripts.length; si++) {
                if (scripts[si] && scripts[si].showForBoard !== undefined) return child;
            }
        }
        return null;
    }

    public onBoardTapped(idx: number): void {
        if (this.focusedIdx === idx) {
            // Tap focused board → deselect
            this.setFocus(-1);
        } else {
            this.setFocus(idx);
        }
    }

    public setFocus(idx: number): void {
        this.focusedIdx = idx;

        for (var i = 0; i < this.boards.length; i++) {
            if (idx < 0) {
                // Gallery mode: all equal
                this.targetScales[i] = 1.0;
            } else if (i === idx) {
                this.targetScales[i] = this.focusScale;
            } else {
                this.targetScales[i] = this.backgroundScale;
            }

            // Toggle panel
            if (this.boards[i].panel) {
                this.boards[i].panel.enabled = (i === idx);
            }
        }

        print("[BoardGallery] Focus: " + (idx < 0 ? "none" : this.boards[idx].obj.name));
    }

    private tick(dt: number): void {
        if (!this.built || this.boards.length === 0) return;
        this.time += dt;

        for (var i = 0; i < this.boards.length; i++) {
            var cur = this.currentScales[i];
            var tgt = this.targetScales[i];
            if (Math.abs(cur - tgt) < 0.001) {
                this.currentScales[i] = tgt;
            } else {
                // Exponential lerp toward target
                this.currentScales[i] = cur + (tgt - cur) * Math.min(1, dt * this.animSpeed);
            }

            var s = this.currentScales[i];
            var bs = this.boards[i].baseScale;
            this.boards[i].obj.getTransform().setLocalScale(
                new vec3(bs.x * s, bs.y * s, bs.z * s)
            );
        }
    }

    /** Called by external code (e.g. BoardPanel close button) to deselect. */
    public deselect(): void {
        this.setFocus(-1);
    }

    /** Return the currently focused board index, or -1. */
    public getFocusedIndex(): number {
        return this.focusedIdx;
    }
}
