// BoardTracker.ts
// Bridges MarkerTrackingComponent with KiCadBoard.
// When the camera detects a physical circuit board (via its top-view image marker),
// the 3D visualization snaps to the real board's position and scale.
//
// Setup:
//   1. Import a top-view photo of the board as an Image Marker Asset in LS
//   2. Add a SceneObject with MarkerTrackingComponent, assign the marker
//   3. Attach BoardTracker to the SAME SceneObject (or a parent)
//   4. Set kiCadBoard to the KiCadBoard script instance to control
//   5. Set markerHeightCm to the board's real-world height in cm

@component
export class BoardTracker extends BaseScriptComponent {

    @input
    @hint("MarkerTrackingComponent on this or a child object")
    markerTracking: Component;

    @input
    @hint("KiCadBoard script to anchor to the marker")
    kiCadBoard: ScriptComponent;

    @input
    @hint("Real-world board height in cm (used by LS marker tracking for scale)")
    markerHeightCm: number = 4.4;

    @input
    @hint("Keep board visible after marker is lost (floats in last known position)")
    persistOnLost: boolean = true;

    @input
    @hint("Offset above the board surface (cm)")
    hoverOffset: number = 0.5;

    // State
    private tracker: any = null;
    private kb: any = null;
    private boardObj: SceneObject | null = null;
    private originalParent: SceneObject | null = null;
    private originalLocalPos: vec3 = vec3.zero();
    private originalLocalScale: vec3 = vec3.one();
    private isAnchored: boolean = false;
    private wasTracking: boolean = false;

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.init());
        this.createEvent("UpdateEvent").bind(() => this.tick());
    }

    private init(): void {
        // Find MarkerTrackingComponent
        this.tracker = this.markerTracking as any;
        if (!this.tracker) {
            // Try to find on this object
            var comps = this.sceneObject.getComponents("Component.ScriptComponent") as any[];
            for (var i = 0; i < comps.length; i++) {
                var sc = comps[i] as any;
                if (sc && sc.marker !== undefined && sc.isTracking !== undefined) {
                    this.tracker = sc;
                    break;
                }
            }
        }
        // Also check for native MarkerTrackingComponent
        if (!this.tracker) {
            var mt = this.sceneObject.getComponent("Component.MarkerTrackingComponent") as any;
            if (mt) this.tracker = mt;
        }

        if (!this.tracker) {
            print("[BoardTracker] No MarkerTrackingComponent found");
            return;
        }

        // Get KiCadBoard reference
        this.kb = this.kiCadBoard as any;
        if (this.kb) {
            this.boardObj = this.kb.sceneObject;
        }

        if (!this.boardObj) {
            print("[BoardTracker] No KiCadBoard assigned");
            return;
        }

        // Save original transform for restore
        this.originalParent = this.boardObj.getParent();
        this.originalLocalPos = this.boardObj.getTransform().getLocalPosition();
        this.originalLocalScale = this.boardObj.getTransform().getLocalScale();

        // Wire marker events
        var self = this;
        if (this.tracker.onMarkerFound !== undefined) {
            this.tracker.onMarkerFound = function() { self.onFound(); };
        }
        if (this.tracker.onMarkerLost !== undefined) {
            this.tracker.onMarkerLost = function() { self.onLost(); };
        }

        // Disable autoEnableWhenTracking since we manage visibility ourselves
        if (this.tracker.autoEnableWhenTracking !== undefined) {
            this.tracker.autoEnableWhenTracking = false;
        }

        print("[BoardTracker] Initialized, marker height: " + this.markerHeightCm + "cm");
    }

    private onFound(): void {
        if (!this.boardObj || !this.kb) return;
        print("[BoardTracker] Marker found");

        // Reparent board under the marker-tracked SceneObject
        this.boardObj.setParent(this.sceneObject);

        // Compute scale: marker tracking gives us a coordinate space where
        // the marker fits within the tracked object's local space.
        // We need to scale the board so its KiCad dimensions match the real-world marker size.
        var bhw = this.kb.getBoardHalfWidth ? this.kb.getBoardHalfWidth() : 0;
        var bhh = this.kb.getBoardHalfHeight ? this.kb.getBoardHalfHeight() : 0;

        if (bhw > 0.01 && bhh > 0.01) {
            // Board half-extents are in LS cm (already scaled by scaleFactor).
            // Marker tracking space: marker image maps to a rectangle whose height = markerHeightCm.
            // The board visualization needs to fit exactly on top of the real board.
            // LS marker tracking normalizes to marker height, so scale = realHeight / vizHeight.
            var vizHeight = bhh * 2; // full height in LS cm
            var realHeight = this.markerHeightCm;
            var s = realHeight / vizHeight;
            this.boardObj.getTransform().setLocalScale(new vec3(s, s, s));
        }

        // Position: center on marker, slightly above surface
        this.boardObj.getTransform().setLocalPosition(new vec3(0, 0, this.hoverOffset));
        // Rotation: board lies flat (KiCadBoard renders in XY plane, marker tracking is also XY)
        this.boardObj.getTransform().setLocalRotation(quat.quatIdentity());

        this.isAnchored = true;
        this.boardObj.enabled = true;
    }

    private onLost(): void {
        if (!this.boardObj) return;
        print("[BoardTracker] Marker lost");

        if (this.persistOnLost) {
            // Keep floating in last known world position
            // (already parented under marker object which holds last pose)
        } else {
            // Return to original parent and position
            this.detach();
        }
    }

    private tick(): void {
        if (!this.tracker) return;

        // Poll-based tracking check (backup for platforms without events)
        var tracking = false;
        try { tracking = this.tracker.isTracking(); } catch (e) {}

        if (tracking && !this.wasTracking) {
            this.onFound();
        } else if (!tracking && this.wasTracking) {
            this.onLost();
        }
        this.wasTracking = tracking;
    }

    // Restore board to its original scene position
    public detach(): void {
        if (!this.boardObj) return;
        if (this.originalParent) {
            this.boardObj.setParent(this.originalParent);
        }
        this.boardObj.getTransform().setLocalPosition(this.originalLocalPos);
        this.boardObj.getTransform().setLocalScale(this.originalLocalScale);
        this.isAnchored = false;
    }

    public getIsAnchored(): boolean {
        return this.isAnchored;
    }
}
