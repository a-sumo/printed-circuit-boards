// MarkerTest.ts
// Simple test harness for marker tracking.
// On device: uses MarkerTrackingComponent events to show/hide content.
// In editor: fakes tracking by placing content at the SimulatedBoard position.

@component
export class MarkerTest extends BaseScriptComponent {

    @input
    @hint("The SceneObject with MarkerTrackingComponent (e.g. Marker_Cube_PUT_UNDER_MAIN_CAM)")
    markerObject: SceneObject;

    @input
    @hint("Content to show when marker is found (e.g. TrackingTestCube)")
    content: SceneObject;

    @input
    @hint("SimulatedBoard quad for editor fallback positioning")
    @allowUndefined
    simulatedBoard: SceneObject;

    private tracker: any = null;
    private isEditor: boolean = false;
    private tracking: boolean = false;
    private editorPlaced: boolean = false;

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.init());
        this.createEvent("UpdateEvent").bind(() => this.tick());
    }

    private init(): void {
        this.isEditor = global.deviceInfoSystem.isEditor();

        // Find MarkerTrackingComponent
        if (this.markerObject) {
            var comps = this.markerObject.getComponents("Component.ScriptComponent") as any[];
            for (var i = 0; i < comps.length; i++) {
                var sc = comps[i] as any;
                if (sc && sc.isTracking !== undefined && sc.marker !== undefined) {
                    this.tracker = sc;
                    break;
                }
            }
            // Try native component
            if (!this.tracker) {
                try {
                    var mt = this.markerObject.getComponent("Component.MarkerTrackingComponent") as any;
                    if (mt) this.tracker = mt;
                } catch (e) {}
            }
        }

        if (this.content) {
            this.content.enabled = false;
        }

        if (this.tracker) {
            var self = this;
            this.tracker.onMarkerFound = function() {
                print("[MarkerTest] Marker FOUND");
                self.tracking = true;
                if (self.content) self.content.enabled = true;
            };
            this.tracker.onMarkerLost = function() {
                print("[MarkerTest] Marker LOST");
                self.tracking = false;
            };
            // Disable auto-enable so we control it
            this.tracker.autoEnableWhenTracking = false;
            print("[MarkerTest] Wired to MarkerTrackingComponent");
        } else {
            print("[MarkerTest] No tracker found, using editor fallback");
        }

        // Editor fallback: place content at the simulated board after a short delay
        if (this.isEditor && this.simulatedBoard && this.content) {
            var self2 = this;
            var delay = this.createEvent("DelayedCallbackEvent");
            delay.bind(function() {
                self2.placeAtSimulatedBoard();
            });
            (delay as any).reset(1.0);
        }
    }

    private placeAtSimulatedBoard(): void {
        if (!this.simulatedBoard || !this.content || this.editorPlaced) return;
        this.editorPlaced = true;

        // Get world position of the simulated board
        var boardWorldPos = this.simulatedBoard.getTransform().getWorldPosition();
        var boardWorldRot = this.simulatedBoard.getTransform().getWorldRotation();

        // Place content at the board's world position, offset slightly above
        this.content.getTransform().setWorldPosition(
            new vec3(boardWorldPos.x, boardWorldPos.y, boardWorldPos.z)
        );
        this.content.getTransform().setWorldRotation(boardWorldRot);
        this.content.enabled = true;
        print("[MarkerTest] Editor fallback: placed content at SimulatedBoard");
    }

    private tick(): void {
        // On device: poll tracking status as backup
        if (!this.isEditor && this.tracker) {
            var isNowTracking = false;
            try { isNowTracking = this.tracker.isTracking(); } catch (e) {}

            if (isNowTracking && !this.tracking) {
                this.tracking = true;
                if (this.content) this.content.enabled = true;
                print("[MarkerTest] Tracking started (poll)");
            }
        }
    }
}
