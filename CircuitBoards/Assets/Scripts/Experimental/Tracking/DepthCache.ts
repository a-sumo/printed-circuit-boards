// DepthCache.ts
// Timestamp-matched color + depth frame pairs for ML-driven 3D anchoring.
// Ported from Snap's "Depth Cache" sample with LensifyTS adaptations.
//
// Captures color frames at ~30Hz and depth frames at ~5Hz, pairs each depth
// frame with the closest color frame, and lets callers freeze the latest
// pair under an ID so they can query the world position of any pixel on
// that color frame later.
//
// Typical usage from a feature-tracker component:
//
//   var id  = depthCache.saveDepthFrame();
//   var img = depthCache.getCamImageWithID(id);
//   // run an ML model on `img`, get back keypoints in pixel coords
//   for (var i = 0; i < kps.length; i++) {
//       var w = depthCache.getWorldPositionWithID(kps[i], id);
//       // ...feed to pose solver
//   }
//   depthCache.disposeDepthFrame(id);
//
// Why we go through the cache instead of reading depth directly: the depth
// stream and the color stream tick at different rates and have different
// intrinsics (depth is a cropped + downscaled version of the left color
// frame), so any "look up the 3D position of pixel (x,y) on the color frame
// I just gave the ML model" needs the matched pair, not the latest depth
// alone.

class ColorCameraFrame {
    public imageFrame: Texture;
    public colorTimestampSeconds: number;
    constructor(imageFrame: Texture, colorTimestamp: number) {
        this.imageFrame = imageFrame;
        this.colorTimestampSeconds = colorTimestamp;
    }
}

class DepthColorPair {
    public colorCameraFrame: ColorCameraFrame;
    public depthFrameData: Float32Array;
    public depthDeviceCamera: DeviceCamera;
    public depthTimestampSeconds: number;
    public depthCameraPose: mat4;
    constructor(
        colorCameraFrame: ColorCameraFrame,
        depthFrameData: Float32Array,
        depthDeviceCamera: DeviceCamera,
        depthTimestampSeconds: number,
        depthCameraPose: mat4
    ) {
        this.colorCameraFrame = colorCameraFrame;
        this.depthFrameData = depthFrameData;
        this.depthDeviceCamera = depthDeviceCamera;
        this.depthTimestampSeconds = depthTimestampSeconds;
        this.depthCameraPose = depthCameraPose;
    }
}

@component
export class DepthCache extends BaseScriptComponent {
    private camModule: any = require("LensStudio:CameraModule");
    private colorDeviceCamera: DeviceCamera;
    private depthModule: any = require("LensStudio:DepthModule");
    private depthFrameSession: any = null;
    private isEditor: boolean = global.deviceInfoSystem.isEditor();
    private camTexture: Texture;
    private camFrameHistory: ColorCameraFrame[] = [];

    private latestCameraDepthPair: DepthColorPair | null = null;
    private cachedDepthFrames: Map<number, DepthColorPair> = new Map<number, DepthColorPair>();

    onAwake(): void {
        // DepthFrameSession must be created from OnStartEvent, not onAwake.
        this.createEvent("OnStartEvent").bind(() => this.onStart());
    }

    private onStart(): void {
        this.startCameraUpdates();
        this.startDepthUpdate();
    }

    // Freeze the most recent color/depth pair under a unique ID so callers
    // can keep querying it after the live latestCameraDepthPair has moved on.
    saveDepthFrame(): number {
        var id = Date.now();
        if (this.latestCameraDepthPair !== null) {
            this.cachedDepthFrames.set(id, this.latestCameraDepthPair);
        }
        return id;
    }

    getCamImageWithID(depthFrameID: number): Texture | null {
        var pair = this.cachedDepthFrames.get(depthFrameID);
        if (pair) return pair.colorCameraFrame.imageFrame;
        return null;
    }

    // Returns the world-space (tracking-origin) position of `pixelPos` on the
    // color frame associated with `depthFrameID`, or null if the pixel falls
    // outside the depth frame or has no valid depth sample nearby.
    getWorldPositionWithID(pixelPos: vec2, depthFrameID: number): vec3 | null {
        var pair = this.cachedDepthFrames.get(depthFrameID);
        if (!pair) {
            print("[DepthCache] invalid depth frame ID: " + depthFrameID);
            return null;
        }

        // Remap color-frame pixel → depth-frame pixel via 3D camera space,
        // because the depth frame is a cropped + downscaled version of the
        // left color frame with its own intrinsics.
        var normColor = pixelPos.div(this.colorDeviceCamera.resolution);
        var camSpacePt = this.colorDeviceCamera.unproject(normColor, 100.0);
        var normDepth = pair.depthDeviceCamera.project(camSpacePt);
        if (!this.isNormalizedPointInImage(normDepth)) {
            return null;
        }

        var pxDepth = normDepth.mult(pair.depthDeviceCamera.resolution);
        var depthVal = this.getMedianDepth(
            pair.depthFrameData,
            pair.depthDeviceCamera.resolution.x,
            pair.depthDeviceCamera.resolution.y,
            Math.floor(pxDepth.x),
            Math.floor(pxDepth.y),
            1
        );
        if (depthVal === null) return null;

        var devRefPt = pair.depthDeviceCamera.unproject(normDepth, depthVal);
        return pair.depthCameraPose.multiplyPoint(devRefPt);
    }

    disposeDepthFrame(depthFrameID: number): void {
        if (this.cachedDepthFrames.has(depthFrameID)) {
            this.cachedDepthFrames.delete(depthFrameID);
        }
    }

    // Median-of-window depth sample. radius=1 → 3×3, radius=2 → 5×5, etc.
    // Median is robust to the occasional zero or hot pixel that the depth
    // sensor likes to emit on edges and reflective surfaces.
    private getMedianDepth(
        depthData: Float32Array,
        width: number,
        height: number,
        x: number,
        y: number,
        radius: number
    ): number | null {
        var xi = Math.round(x);
        var yi = Math.round(y);
        var samples: number[] = [];

        for (var dy = -radius; dy <= radius; dy++) {
            for (var dx = -radius; dx <= radius; dx++) {
                var nx = xi + dx;
                var ny = yi + dy;
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    var v = depthData[nx + ny * width];
                    if (v > 0) samples.push(v);
                }
            }
        }

        if (samples.length === 0) return null;
        samples.sort(function(a, b) { return a - b; });
        var mid = Math.floor(samples.length / 2);
        return (samples.length % 2 === 0)
            ? (samples[mid - 1] + samples[mid]) / 2
            : samples[mid];
    }

    private startCameraUpdates(): void {
        var camRequest = CameraModule.createCameraRequest();
        camRequest.cameraId = CameraModule.CameraId.Left_Color;
        this.camTexture = this.camModule.requestCamera(camRequest);
        var ctl = this.camTexture.control as CameraTextureProvider;
        ctl.onNewFrame.add((frame: CameraFrame) => {
            var f = new ColorCameraFrame(this.camTexture.copyFrame(), frame.timestampSeconds);
            this.camFrameHistory.push(f);
            // Keep ~half a second of frames. Cam runs ~30Hz, depth ~5Hz, and
            // the matched cam frame is usually 2–3 frames behind the depth.
            if (this.camFrameHistory.length > 5) {
                this.camFrameHistory.shift();
            }
        });
        this.colorDeviceCamera = global.deviceInfoSystem.getTrackingCameraForId(CameraModule.CameraId.Left_Color);
    }

    private startDepthUpdate(): void {
        // createDepthFrameSession() requires the Experimental API toggle in
        // Project Settings. If it's off we get a synchronous throw that would
        // otherwise halt the entire scene's script execution. Catch it so the
        // rest of the scene (incl. MLComponent inference for BoardFeatureTracker)
        // still runs — saveDepthFrame() already handles the null-pair case.
        try {
            this.depthFrameSession = this.depthModule.createDepthFrameSession();
        } catch (e) {
            print("[DepthCache] depth session unavailable — enable Experimental API in Project Settings. ("
                + (e as any).message + ")");
            return;
        }
        this.depthFrameSession.onNewFrame.add((depthFrameData: any) => {
            var closest = this.findClosestCameraFrame(depthFrameData);
            if (closest === null) return;
            var pose = mat4.fromColumns(
                depthFrameData.toWorldTrackingOriginFromDeviceRef.column0,
                depthFrameData.toWorldTrackingOriginFromDeviceRef.column1,
                depthFrameData.toWorldTrackingOriginFromDeviceRef.column2,
                depthFrameData.toWorldTrackingOriginFromDeviceRef.column3
            );
            this.latestCameraDepthPair = new DepthColorPair(
                closest,
                depthFrameData.depthFrame.slice(),
                depthFrameData.deviceCamera,
                depthFrameData.timestampSeconds,
                pose
            );
        });
        this.depthFrameSession.start();
    }

    private findClosestCameraFrame(depthFrame: any, maxOffset: number = 0.001): ColorCameraFrame | null {
        if (!this.camFrameHistory || this.camFrameHistory.length === 0) {
            return null;
        }
        var closest = this.camFrameHistory[0];
        var closestDelta = Math.abs(closest.colorTimestampSeconds - depthFrame.timestampSeconds);
        for (var i = 1; i < this.camFrameHistory.length; i++) {
            var c = this.camFrameHistory[i];
            var d = Math.abs(c.colorTimestampSeconds - depthFrame.timestampSeconds);
            if (d < closestDelta) {
                closest = c;
                closestDelta = d;
            }
        }
        if (closestDelta <= maxOffset) return closest;
        // Better stale than nothing — fall back to the most recent frame.
        return this.camFrameHistory[this.camFrameHistory.length - 1];
    }

    private isNormalizedPointInImage(p: vec2): boolean {
        return p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0;
    }
}
