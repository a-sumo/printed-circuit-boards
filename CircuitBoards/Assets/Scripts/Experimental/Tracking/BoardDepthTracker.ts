// BoardDepthTracker.ts
// Live 6DOF board tracking from the Spectacles depth sensor.
//
// Reads the Snap depth frame (~5Hz, sync Float32Array), samples a uniform
// grid of pixels inside an image-space ROI, unprojects each sample to 3D
// world space via the depth-camera intrinsics + tracking origin pose, runs
// a tiny RANSAC plane fit on the resulting 3D point cloud, and anchors the
// host KiCadBoard SceneObject to the recovered plane.
//
// Why depth-only and not optical flow:
//   The Snap CameraTextureProvider exposes color frames as GPU Textures
//   with no CPU pixel-readback path (verified across CropCameraTexture,
//   CompositeCameraTexture, and the SnapML Spatialization samples). Optical
//   flow on color would require either an MLComponent ONNX model or a
//   shader-graph render-to-texture round-trip with no readback. The depth
//   sensor sidesteps this entirely by giving us 3D points directly.
//   PlaneTracker.ts (the validated 6DOF feature-track tracker) becomes a
//   v2 enhancement once we have a per-frame color feature source.
//
// What this does NOT do:
//   - 30Hz pose interpolation between depth frames (UpdateEvent smoothing
//     fakes it for v0 — current pose lerps toward latest depth target).
//   - Yaw constrained to a board edge (uses world-up projected onto the
//     plane as a stable reference axis; the board can yaw freely on its
//     plane without an additional constraint).
//   - Selecting which surface in the scene IS the board (RANSAC over a
//     center-of-screen ROI; whatever's in front of the user gets fit).
//
// Setup:
//   1. Create an empty SceneObject under "Camera Object" (or anywhere).
//   2. Attach BoardDepthTracker to it.
//   3. Set kiCadBoard to the KiCadBoard ScriptComponent you want to anchor.
//   4. Hit Play, point the headset at a flat board ~30-50 cm in front.
//   5. Watch the LS Logger for [BDT] lines if debugLogging is on.

@component
export class BoardDepthTracker extends BaseScriptComponent {

    @input
    @hint("KiCadBoard ScriptComponent to anchor to the depth-recovered plane")
    kiCadBoard: ScriptComponent;

    @input
    @hint("Depth sampling grid resolution (gridSize × gridSize samples per frame)")
    gridSize: number = 12;

    @input
    @hint("ROI half-size in depth-frame pixels (samples within ±this of frame center)")
    roiHalfSizePx: number = 60;

    @input
    @hint("RANSAC plane inlier threshold in cm")
    planeThresholdCm: number = 0.8;

    @input
    @hint("Minimum inliers to accept a plane fit")
    minInliers: number = 30;

    @input
    @hint("Minimum depth in cm (samples closer than this are skipped)")
    minDepthCm: number = 10;

    @input
    @hint("Maximum depth in cm (samples farther than this are skipped)")
    maxDepthCm: number = 200;

    @input
    @hint("Pose smoothing alpha (0=instant, 1=frozen). Applied per UpdateEvent.")
    smoothingAlpha: number = 0.2;

    @input
    @hint("Print per-second stats to the LS Logger")
    debugLogging: boolean = true;

    private depthModule: any = require("LensStudio:DepthModule");
    private session: any = null;
    private depthRegistration: any = null;

    private kb: any = null;
    private boardObj: SceneObject | null = null;

    // Latest depth-derived pose target (world space, cm).
    private targetValid: boolean = false;
    private targetOx: number = 0;
    private targetOy: number = 0;
    private targetOz: number = 0;
    private targetNx: number = 0;
    private targetNy: number = 1;
    private targetNz: number = 0;

    // Currently applied (smoothed) pose.
    private curValid: boolean = false;
    private curOx: number = 0;
    private curOy: number = 0;
    private curOz: number = 0;
    private curNx: number = 0;
    private curNy: number = 1;
    private curNz: number = 0;

    // Reusable scratch buffer for unprojected 3D world points (xyz triples).
    private worldPts: Float64Array = new Float64Array(512 * 3);

    // Reusable mat3 for column-set → quat conversion.
    private rotMat: mat3 = new mat3();

    // Stats.
    private depthFramesSeen: number = 0;
    private depthFramesFit: number = 0;
    private lastInlierCount: number = 0;
    private lastSampleCount: number = 0;
    private lastLogTime: number = 0;

    onAwake(): void {
        // DepthFrameSession may NOT be created in onAwake per LS docs.
        this.createEvent("OnStartEvent").bind(() => this.start());
        this.createEvent("UpdateEvent").bind(() => this.tick());
        this.createEvent("OnDestroyEvent").bind(() => this.cleanup());
    }

    private start(): void {
        // Resolve KiCadBoard reference + host SceneObject.
        this.kb = this.kiCadBoard as any;
        if (this.kb && this.kb.sceneObject) {
            this.boardObj = this.kb.sceneObject;
        }
        if (this.boardObj === null) {
            print("[BDT] No KiCadBoard assigned — tracker idle");
            return;
        }

        try {
            this.session = this.depthModule.createDepthFrameSession();
            var self = this;
            this.depthRegistration = this.session.onNewFrame.add(function(frame: any) {
                self.onDepthFrame(frame);
            });
            this.session.start();
            print("[BDT] DepthFrameSession started — waiting for first frame");
        } catch (e) {
            print("[BDT] Failed to start DepthFrameSession: " + (e as any).message);
        }
    }

    private onDepthFrame(frame: any): void {
        this.depthFramesSeen++;

        var dev = frame.deviceCamera;
        var depthBuf: Float32Array = frame.depthFrame;
        var w = (dev.resolution.x as number) | 0;
        var h = (dev.resolution.y as number) | 0;
        if (w <= 0 || h <= 0) return;

        var cx = (w / 2) | 0;
        var cy = (h / 2) | 0;
        var halfX = this.roiHalfSizePx | 0;
        var halfY = this.roiHalfSizePx | 0;
        if (halfX > ((w / 2) | 0) - 1) halfX = ((w / 2) | 0) - 1;
        if (halfY > ((h / 2) | 0) - 1) halfY = ((h / 2) | 0) - 1;
        if (halfX < 1 || halfY < 1) return;

        var grid = this.gridSize > 1 ? (this.gridSize | 0) : 12;
        var stepX = (2 * halfX) / (grid - 1);
        var stepY = (2 * halfY) / (grid - 1);

        // Make sure scratch is big enough.
        var maxPts = grid * grid;
        if (this.worldPts.length < maxPts * 3) {
            this.worldPts = new Float64Array(maxPts * 3);
        }

        var worldFromDevRef: mat4 = frame.toWorldTrackingOriginFromDeviceRef;

        var minD = this.minDepthCm;
        var maxD = this.maxDepthCm;

        var count = 0;
        for (var gy = 0; gy < grid; gy++) {
            for (var gx = 0; gx < grid; gx++) {
                var px = ((cx - halfX) + gx * stepX) | 0;
                var py = ((cy - halfY) + gy * stepY) | 0;
                if (px < 0 || px >= w || py < 0 || py >= h) continue;

                var d = depthBuf[px + py * w];
                if (!(d > minD) || !(d < maxD)) continue;

                // Unproject to device-ref 3D, then transform to world.
                var nu = (px + 0.5) / w;
                var nv = (py + 0.5) / h;
                var p3d = dev.unproject(new vec2(nu, nv), d);
                var pw = worldFromDevRef.multiplyPoint(p3d);

                this.worldPts[count * 3]     = pw.x;
                this.worldPts[count * 3 + 1] = pw.y;
                this.worldPts[count * 3 + 2] = pw.z;
                count++;
            }
        }
        this.lastSampleCount = count;

        if (count < this.minInliers) {
            this.targetValid = false;
            this.maybeLog();
            return;
        }

        if (this.fitPlaneRansac(this.worldPts, count)) {
            this.depthFramesFit++;
        }
        this.maybeLog();
    }

    // Fit a plane to N world-space 3D points via 3-point RANSAC + centroid
    // refit. Stashes the result in this.target* and returns true on success.
    private fitPlaneRansac(pts: Float64Array, n: number): boolean {
        var bestInliers = 0;
        var bestNx = 0;
        var bestNy = 1;
        var bestNz = 0;
        var bestD = 0;
        var thresh = this.planeThresholdCm;

        // 48 RANSAC seeds is plenty for 100-200 points with ~70% inliers.
        // ~10000 distance evaluations per depth frame, trivial at 5Hz.
        var iters = 48;
        for (var it = 0; it < iters; it++) {
            var i0 = (Math.random() * n) | 0;
            var i1 = (Math.random() * n) | 0;
            var i2 = (Math.random() * n) | 0;
            if (i0 === i1 || i1 === i2 || i0 === i2) continue;

            var p0x = pts[i0 * 3];
            var p0y = pts[i0 * 3 + 1];
            var p0z = pts[i0 * 3 + 2];
            var p1x = pts[i1 * 3];
            var p1y = pts[i1 * 3 + 1];
            var p1z = pts[i1 * 3 + 2];
            var p2x = pts[i2 * 3];
            var p2y = pts[i2 * 3 + 1];
            var p2z = pts[i2 * 3 + 2];

            var ax = p1x - p0x;
            var ay = p1y - p0y;
            var az = p1z - p0z;
            var bx = p2x - p0x;
            var by = p2y - p0y;
            var bz = p2z - p0z;

            var nx = ay * bz - az * by;
            var ny = az * bx - ax * bz;
            var nz = ax * by - ay * bx;
            var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nlen < 1e-5) continue;
            nx = nx / nlen;
            ny = ny / nlen;
            nz = nz / nlen;

            var d = -(nx * p0x + ny * p0y + nz * p0z);

            var ins = 0;
            for (var k = 0; k < n; k++) {
                var dist = nx * pts[k * 3] + ny * pts[k * 3 + 1] + nz * pts[k * 3 + 2] + d;
                if (dist < 0) dist = -dist;
                if (dist < thresh) ins++;
            }

            if (ins > bestInliers) {
                bestInliers = ins;
                bestNx = nx;
                bestNy = ny;
                bestNz = nz;
                bestD = d;
            }
        }

        this.lastInlierCount = bestInliers;
        if (bestInliers < this.minInliers) {
            this.targetValid = false;
            return false;
        }

        // Refit origin to centroid of inliers (the normal stays from RANSAC;
        // we don't have SVD here so a covariance refit isn't worth the code).
        var cx = 0;
        var cy = 0;
        var cz = 0;
        var c = 0;
        for (var k2 = 0; k2 < n; k2++) {
            var dist2 = bestNx * pts[k2 * 3] + bestNy * pts[k2 * 3 + 1] + bestNz * pts[k2 * 3 + 2] + bestD;
            if (dist2 < 0) dist2 = -dist2;
            if (dist2 < thresh) {
                cx += pts[k2 * 3];
                cy += pts[k2 * 3 + 1];
                cz += pts[k2 * 3 + 2];
                c++;
            }
        }
        if (c > 0) {
            cx = cx / c;
            cy = cy / c;
            cz = cz / c;
        }

        // Sign convention: flip the normal so it points generally toward the
        // user. We don't have the camera position handy here, but the camera
        // sits at the world tracking origin's reference frame, and a plane
        // visible to it must have a centroid with depth (z-component in
        // device-ref) > 0 from the camera. After the world transform that
        // sign disappears, so we use a different heuristic: if the normal
        // points the same direction as the centroid (away from origin), we
        // flip it. This isn't perfect but it's stable across frames.
        var dotOC = bestNx * cx + bestNy * cy + bestNz * cz;
        if (dotOC > 0) {
            bestNx = -bestNx;
            bestNy = -bestNy;
            bestNz = -bestNz;
        }

        this.targetNx = bestNx;
        this.targetNy = bestNy;
        this.targetNz = bestNz;
        this.targetOx = cx;
        this.targetOy = cy;
        this.targetOz = cz;
        this.targetValid = true;
        return true;
    }

    private tick(): void {
        if (!this.targetValid) return;
        if (this.boardObj === null) return;

        var a = this.smoothingAlpha;
        if (a < 0) a = 0;
        if (a > 1) a = 1;

        if (!this.curValid) {
            // First valid target — snap.
            this.curOx = this.targetOx;
            this.curOy = this.targetOy;
            this.curOz = this.targetOz;
            this.curNx = this.targetNx;
            this.curNy = this.targetNy;
            this.curNz = this.targetNz;
            this.curValid = true;
        } else {
            this.curOx = this.curOx * (1 - a) + this.targetOx * a;
            this.curOy = this.curOy * (1 - a) + this.targetOy * a;
            this.curOz = this.curOz * (1 - a) + this.targetOz * a;
            this.curNx = this.curNx * (1 - a) + this.targetNx * a;
            this.curNy = this.curNy * (1 - a) + this.targetNy * a;
            this.curNz = this.curNz * (1 - a) + this.targetNz * a;
            var nl = Math.sqrt(this.curNx * this.curNx + this.curNy * this.curNy + this.curNz * this.curNz);
            if (nl > 1e-6) {
                this.curNx = this.curNx / nl;
                this.curNy = this.curNy / nl;
                this.curNz = this.curNz / nl;
            }
        }

        // Build orthonormal basis: (right, up, normal).
        // KiCadBoard renders in its local XY plane with +Z as the surface
        // normal, so we want world basis vectors set as columns of the rot
        // matrix in (X, Y, Z) order = (right, up, normal).
        var nx = this.curNx;
        var ny = this.curNy;
        var nz = this.curNz;

        // up axis: world-up projected onto plane, then normalized.
        var upx = 0;
        var upy = 1;
        var upz = 0;
        var dotN = nx * upx + ny * upy + nz * upz;
        var px = upx - nx * dotN;
        var py = upy - ny * dotN;
        var pz = upz - nz * dotN;
        var pl = Math.sqrt(px * px + py * py + pz * pz);
        if (pl < 0.05) {
            // Plane normal is nearly parallel to world-up — fall back to world Z.
            var fx = 0;
            var fy = 0;
            var fz = 1;
            var dotN2 = nx * fx + ny * fy + nz * fz;
            px = fx - nx * dotN2;
            py = fy - ny * dotN2;
            pz = fz - nz * dotN2;
            pl = Math.sqrt(px * px + py * py + pz * pz);
            if (pl < 1e-5) return;
        }
        px = px / pl;
        py = py / pl;
        pz = pz / pl;

        // right = up × normal
        var rx = py * nz - pz * ny;
        var ry = pz * nx - px * nz;
        var rz = px * ny - py * nx;

        this.rotMat.column0 = new vec3(rx, ry, rz);
        this.rotMat.column1 = new vec3(px, py, pz);
        this.rotMat.column2 = new vec3(nx, ny, nz);
        var rotation = quat.fromRotationMat(this.rotMat);

        var t = this.boardObj.getTransform();
        t.setWorldPosition(new vec3(this.curOx, this.curOy, this.curOz));
        t.setWorldRotation(rotation);
    }

    private maybeLog(): void {
        if (!this.debugLogging) return;
        var now = getTime();
        if (now - this.lastLogTime < 1.0) return;
        this.lastLogTime = now;
        print("[BDT] depthFrames=" + this.depthFramesSeen
            + " fit=" + this.depthFramesFit
            + " samples=" + this.lastSampleCount
            + " inliers=" + this.lastInlierCount
            + " n=(" + this.targetNx.toFixed(2)
            + "," + this.targetNy.toFixed(2)
            + "," + this.targetNz.toFixed(2) + ")"
            + " o=(" + this.targetOx.toFixed(1)
            + "," + this.targetOy.toFixed(1)
            + "," + this.targetOz.toFixed(1) + ")");
    }

    private cleanup(): void {
        if (this.session !== null && this.depthRegistration !== null) {
            try { this.session.onNewFrame.remove(this.depthRegistration); } catch (e) {}
        }
        if (this.session !== null) {
            try { this.session.stop(); } catch (e) {}
        }
    }
}
