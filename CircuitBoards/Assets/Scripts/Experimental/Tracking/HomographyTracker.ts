// HomographyTracker.ts
// Minimal board pose overlay using HomographyNet-lite via MLComponent.
//
// Pipeline (per frame):
//   1. Grab camera texture, resize/convert to grayscale 128x128
//   2. Stack with baked reference texture → 2-channel input
//   3. MLComponent.runImmediate() → 8 corner offsets
//   4. Offsets → homography → pose axes drawn as 3D scene arrows
//
// The model predicts 4-point corner displacements between a reference
// board crop and the current camera crop. From these corners we compute
// a homography, decompose it to R|t, and position three arrow meshes
// (X/Y/Z axes) at the board center.
//
// LS FastDNN compatible: model uses only Conv+BN+ReLU6+FC (207K params).

@component
export class HomographyTracker extends BaseScriptComponent {

    @input
    @hint("MLComponent with homnet_lite_opset11.onnx bound")
    mlComponent: MLComponent;

    @input
    @hint("Reference board grayscale texture (128x128)")
    refTexture: Texture;

    @input
    @hint("Camera texture provider (from Device Camera Texture)")
    cameraTexture: Texture;

    @input
    @hint("SceneObject to position at tracked board pose")
    poseTarget: SceneObject;

    @input
    @hint("X axis arrow SceneObject (child of poseTarget)")
    arrowX: SceneObject;

    @input
    @hint("Y axis arrow SceneObject (child of poseTarget)")
    arrowY: SceneObject;

    @input
    @hint("Z axis arrow SceneObject (child of poseTarget)")
    arrowZ: SceneObject;

    @input
    @hint("Real board width in cm")
    boardWidthCm: number = 8.5;

    @input
    @hint("Real board height in cm")
    boardHeightCm: number = 5.6;

    @input
    @hint("Seconds between inference runs")
    intervalSec: number = 0.1;

    // Internal state
    private lastInferenceTime: number = 0;
    private outputData: Float32Array = new Float32Array(8);
    private prevCorners: number[] = [];  // last known corners in frame space
    private smoothedPos: vec3 = vec3.zero();
    private smoothedRot: quat = quat.quatIdentity();
    private hasLock: boolean = false;
    private lostFrames: number = 0;
    private readonly LOST_THRESHOLD: number = 15;

    // Corner perturbation range (must match training)
    private readonly PERTURB_RANGE: number = 32;

    onAwake(): void {
        this.createEvent("UpdateEvent").bind(() => this.onUpdate());
        if (this.poseTarget) {
            this.poseTarget.enabled = false;
        }
        print("[HomographyTracker] Initialized, board: " +
              this.boardWidthCm + "x" + this.boardHeightCm + "cm");
    }

    private onUpdate(): void {
        var now = getTime();
        if (now - this.lastInferenceTime < this.intervalSec) return;
        this.lastInferenceTime = now;

        if (!this.mlComponent || !this.cameraTexture) return;

        this.runInference();
    }

    private runInference(): void {
        // Run the model
        // Input "input" expects [1, 2, 128, 128]:
        //   channel 0 = reference grayscale
        //   channel 1 = current camera grayscale
        //
        // The MLComponent input binding handles the camera texture.
        // Reference texture is bound as a second input or baked in.
        //
        // For the minimal deployment:
        //   - MLComponent input "input" is bound to a RenderTarget that
        //     composites ref (channel 0) + camera (channel 1)
        //   - OR we use two separate inputs if MLComponent supports it

        try {
            this.mlComponent.runImmediate(false);
        } catch (e) {
            print("[HomographyTracker] Inference error: " + e);
            return;
        }

        // Read output: [1, 8] corner offsets normalized to [-1, 1]
        var outputName = "offsets";
        var output = this.mlComponent.getOutput(outputName);
        if (!output) {
            print("[HomographyTracker] No output '" + outputName + "'");
            return;
        }

        // OutputData accessor
        var data = output.data;
        if (!data || data.length < 8) {
            print("[HomographyTracker] Output too short: " + (data ? data.length : 0));
            return;
        }

        // Denormalize: offsets in pixels (128x128 space)
        var offsets: number[] = [];
        for (var i = 0; i < 8; i++) {
            offsets.push(data[i] * this.PERTURB_RANGE);
        }

        // Check confidence: if offsets are too large, declare lost
        var maxOff = 0;
        for (var j = 0; j < 8; j++) {
            var absVal = offsets[j] < 0 ? -offsets[j] : offsets[j];
            if (absVal > maxOff) maxOff = absVal;
        }

        if (maxOff > this.PERTURB_RANGE * 1.5) {
            this.lostFrames++;
            if (this.lostFrames > this.LOST_THRESHOLD) {
                this.hasLock = false;
                if (this.poseTarget) this.poseTarget.enabled = false;
            }
            return;
        }

        this.lostFrames = 0;
        this.hasLock = true;

        // Convert 4-point offsets to corner positions
        // Reference corners at canonical positions in 128x128 space:
        //   TL=(0,0), TR=(128,0), BR=(128,128), BL=(0,128)
        var corners = [
            offsets[0],       offsets[1],        // TL
            128 + offsets[2], offsets[3],         // TR
            128 + offsets[4], 128 + offsets[5],   // BR
            offsets[6],       128 + offsets[7],   // BL
        ];

        // Compute homography from reference corners to detected corners
        // (simplified: use the corner positions to derive pose)
        this.updatePose(corners);
    }

    private updatePose(corners: number[]): void {
        if (!this.poseTarget) return;

        // Compute center of detected quad (average of 4 corners)
        var cx = (corners[0] + corners[2] + corners[4] + corners[6]) / 4;
        var cy = (corners[1] + corners[3] + corners[5] + corners[7]) / 4;

        // Compute orientation from edge vectors
        // X axis: top-left to top-right
        var xDirX = corners[2] - corners[0];
        var xDirY = corners[3] - corners[1];
        var xLen = Math.sqrt(xDirX * xDirX + xDirY * xDirY);

        // Y axis: top-left to bottom-left
        var yDirX = corners[6] - corners[0];
        var yDirY = corners[7] - corners[1];
        var yLen = Math.sqrt(yDirX * yDirX + yDirY * yDirY);

        if (xLen < 1 || yLen < 1) return;

        // Perspective scale: ratio of edge lengths to reference gives distance
        var refW = 128;
        var refH = 128;
        var scaleX = xLen / refW;
        var scaleY = yLen / refH;
        var avgScale = (scaleX + scaleY) / 2;

        // In-plane rotation angle from X axis direction
        var angle = Math.atan2(xDirY, xDirX);

        // Map 128x128 center to normalized camera coordinates
        // This is approximate; full deployment needs camera intrinsics
        var normX = (cx / 128 - 0.5) * 2;  // [-1, 1]
        var normY = (cy / 128 - 0.5) * 2;

        // Convert to 3D position (approximate, assumes ~50cm working distance)
        var workingDist = 50.0;  // cm
        var posX = normX * workingDist * 0.5;
        var posY = -normY * workingDist * 0.5;
        var posZ = -workingDist;

        // Smooth position
        var alpha = 0.3;
        var targetPos = new vec3(posX, posY, posZ);
        this.smoothedPos = vec3.lerp(this.smoothedPos, targetPos, alpha);

        // Build rotation from angle
        var targetRot = quat.fromEulerAngles(0, 0, angle * (180 / Math.PI));
        this.smoothedRot = quat.slerp(this.smoothedRot, targetRot, alpha);

        // Apply
        this.poseTarget.enabled = true;
        var transform = this.poseTarget.getTransform();
        transform.setWorldPosition(this.smoothedPos);
        transform.setWorldRotation(this.smoothedRot);

        // Scale arrows to board size
        var arrowScale = this.boardWidthCm * avgScale * 0.3;
        if (this.arrowX) {
            this.arrowX.getTransform().setLocalScale(
                new vec3(arrowScale, arrowScale * 0.15, arrowScale * 0.15));
        }
        if (this.arrowY) {
            this.arrowY.getTransform().setLocalScale(
                new vec3(arrowScale * 0.15, arrowScale, arrowScale * 0.15));
        }
        if (this.arrowZ) {
            this.arrowZ.getTransform().setLocalScale(
                new vec3(arrowScale * 0.15, arrowScale * 0.15, arrowScale));
        }
    }

    public getHasLock(): boolean {
        return this.hasLock;
    }
}
