// PlaneTracker.ts
// Main orchestrator for the plane-from-motion 6DOF tracker (see
// docs/PLANE-FROM-MOTION-TRACKING.md). Consumes tracked 2D points and emits
// a smoothed (R, t) pose per frame.
//
// The class is framework-neutral — it doesn't import any Lens Studio types,
// so it can be unit-tested in plain Node. A thin LS component elsewhere is
// responsible for wiring camera intrinsics, sparse LK tracks, and pushing
// the resulting pose onto a SceneObject transform.
//
// Usage:
//     var tracker = new PlaneTracker(K);
//     // Stage 1: plane from two frames with parallax.
//     var plane = PlaneTracker.planeFromMotion(
//         pts2d_frameA, pts2d_frameB, visibleMask, K);
//     // Stage 2: build board frame and back-project tracked points.
//     tracker.initBoard(
//         plane.normal, plane.origin, seedPose,
//         tracks_frame0, visibleMask);
//     // Stage 3: per-frame.
//     for each frame:
//         var pose = tracker.update(pts2dThisFrame, visibleThisFrame, time);
//         // apply pose to your scene object

import {
    Mat, eye, matMul, matT, matInv3,
} from "./MatrixMath";
import {
    homographyDLT,
    ransacHomography,
    decomposeHomography,
    HDecomp,
    Pts2,
} from "./HomographyMath";
import {
    solvePlanarPoseIPPE,
    rotationGeodesic,
    Pts3,
    PlanarPose,
} from "./IppeSolver";
import {
    OneEuroPoseFilter,
    ConstVelExtrapolator,
} from "./PoseSmoothing";

// --- Configuration ---
export interface PlaneTrackerConfig {
    minInliers: number;       // minimum inliers to accept a frame
    ransacThreshold: number;  // RANSAC reprojection threshold in pixels
    ransacIters: number;      // RANSAC iterations
    maxJumpDeg: number;       // geodesic distance jump rejection (deg)
    maxJumpMm: number;        // translation jump rejection (mm, if using mm)
    oneEuroMinCutoff: number; // One-Euro filter cutoff at zero velocity
    oneEuroBeta: number;      // One-Euro speed coefficient
}

export function defaultConfig(): PlaneTrackerConfig {
    return {
        minInliers: 10,
        ransacThreshold: 3.0,
        ransacIters: 500,
        maxJumpDeg: 25,
        maxJumpMm: 60,
        oneEuroMinCutoff: 1.5,
        oneEuroBeta: 0.007,
    };
}

// --- Output of stage 1 (plane from motion) ---
export interface PlaneEstimate {
    normal: Float64Array; // 3-vector, unit, plane normal in camera frame
    R: Mat;               // rotation from the homography decomposition
    t: Float64Array;      // translation from the homography decomposition
}

// Per-frame result returned by update().
export interface FrameResult {
    ok: boolean;          // true if pose was accepted
    R: Mat | null;
    t: Float64Array | null;
    numInliers: number;
    branch: number;       // which IPPE branch was picked (0 or 1)
    extrapolated: boolean; // true if const-vel extrapolated through dropout
}

export class PlaneTracker {
    private K: Mat;
    private cfg: PlaneTrackerConfig;

    // Set by initBoard.
    private pts3dBoard: Pts3 | null = null; // [N*3] board-frame coords, Z=0
    private N: number = 0;

    // State.
    private lastR: Mat | null = null;
    private lastT: Float64Array | null = null;
    private smoother: OneEuroPoseFilter;
    private extrap: ConstVelExtrapolator;

    constructor(K: Mat, cfg: PlaneTrackerConfig | null = null) {
        this.K = K;
        this.cfg = cfg !== null ? cfg : defaultConfig();
        this.smoother = new OneEuroPoseFilter(
            this.cfg.oneEuroMinCutoff, this.cfg.oneEuroBeta);
        this.extrap = new ConstVelExtrapolator();
    }

    // --- Stage 1: plane from motion. Static helper. ---
    //
    // Given matched points in two frames with substantial parallax, run
    // RANSAC homography, decompose via Malis & Vargas, and pick the
    // cheirality-consistent normal closest to the optical axis. Returns
    // null if no solution survives.
    //
    // ptsA, ptsB: flat Pts2 arrays of the same length n (correspondences).
    // K: 3x3 intrinsics.
    public static planeFromMotion(
        ptsA: Pts2, ptsB: Pts2, n: number, K: Mat
    ): PlaneEstimate | null {
        if (n < 8) return null;
        var rr = ransacHomography(ptsA, ptsB, n, 4.0, 500);
        if (rr.numInliers < 8) return null;

        var cands = decomposeHomography(rr.H, K);
        if (cands.length === 0) return null;

        // Of the cheirality-surviving candidates, pick the one whose normal
        // is closest to [0, 0, -1] (plane facing the camera).
        var best = -1;
        var bestDot = -Infinity;
        for (var i = 0; i < cands.length; i++) {
            var nz = -cands[i].n[2]; // cos angle to [0, 0, -1]
            if (nz > bestDot) { bestDot = nz; best = i; }
        }
        if (best < 0) return null;
        var sol = cands[best];
        return {
            normal: sol.n,
            R: sol.R,
            t: sol.t,
        };
    }

    // --- Stage 2: build the board frame. ---
    //
    // Given:
    //   planeNormal: plane normal in camera frame (from planeFromMotion)
    //   planeOrigin: any point on the plane in camera frame (3-vector),
    //                typically a point back-projected from the centroid of
    //                the first frame's tracked features.
    //   inPlaneDir : a 3-vector giving the desired +X axis direction in
    //                camera frame. Will be projected onto the plane and
    //                orthonormalized. Often the R matrix's first column
    //                from the homography decomposition is a good choice.
    //   pts2d0     : tracked 2D points in frame 0 (shape [N*2])
    //   visible    : per-point visibility mask (Uint8Array)
    //   N          : number of tracks
    //
    // Builds the board→camera rigid transform (R0, t0) and back-projects
    // every visible frame-0 point through the plane, yielding N 3D board
    // coordinates (stored internally). The Z coordinate is 0 by
    // construction.
    public initBoard(
        planeNormal: Float64Array,
        planeOrigin: Float64Array,
        inPlaneDir: Float64Array,
        pts2d0: Pts2,
        visible: Uint8Array,
        N: number
    ): void {
        // Normalize the plane normal and make sure it faces the camera
        // (n · [0, 0, -1] > 0, i.e. n_z < 0).
        var nz = new Float64Array(3);
        nz[0] = planeNormal[0]; nz[1] = planeNormal[1]; nz[2] = planeNormal[2];
        var nl = Math.sqrt(nz[0]*nz[0] + nz[1]*nz[1] + nz[2]*nz[2]);
        if (nl < 1e-9) throw new Error("initBoard: zero normal");
        nz[0] /= nl; nz[1] /= nl; nz[2] /= nl;
        if (nz[2] > 0) { nz[0] = -nz[0]; nz[1] = -nz[1]; nz[2] = -nz[2]; }

        // Project inPlaneDir onto the plane perpendicular to nz.
        var dpx = inPlaneDir[0], dpy = inPlaneDir[1], dpz = inPlaneDir[2];
        var dot = dpx*nz[0] + dpy*nz[1] + dpz*nz[2];
        var xAx = new Float64Array(3);
        xAx[0] = dpx - dot*nz[0];
        xAx[1] = dpy - dot*nz[1];
        xAx[2] = dpz - dot*nz[2];
        var xl = Math.sqrt(xAx[0]*xAx[0] + xAx[1]*xAx[1] + xAx[2]*xAx[2]);
        if (xl < 1e-6) {
            // Fallback: pick any in-plane direction.
            if (Math.abs(nz[0]) < 0.9) {
                xAx[0] = 1 - nz[0]*nz[0]; xAx[1] = -nz[0]*nz[1]; xAx[2] = -nz[0]*nz[2];
            } else {
                xAx[0] = -nz[1]*nz[0]; xAx[1] = 1 - nz[1]*nz[1]; xAx[2] = -nz[1]*nz[2];
            }
            xl = Math.sqrt(xAx[0]*xAx[0] + xAx[1]*xAx[1] + xAx[2]*xAx[2]);
        }
        xAx[0] /= xl; xAx[1] /= xl; xAx[2] /= xl;

        // Y = Z × X (so {X, Y, Z} is a right-handed basis).
        var yAx = new Float64Array(3);
        yAx[0] = nz[1]*xAx[2] - nz[2]*xAx[1];
        yAx[1] = nz[2]*xAx[0] - nz[0]*xAx[2];
        yAx[2] = nz[0]*xAx[1] - nz[1]*xAx[0];

        // Board → camera rotation: columns are {X, Y, Z} in camera frame.
        var R0 = new Float64Array(9);
        R0[0] = xAx[0]; R0[1] = yAx[0]; R0[2] = nz[0];
        R0[3] = xAx[1]; R0[4] = yAx[1]; R0[5] = nz[1];
        R0[6] = xAx[2]; R0[7] = yAx[2]; R0[8] = nz[2];

        // Board → camera translation: the origin of the board frame lies
        // at planeOrigin in camera coordinates.
        var t0 = new Float64Array(3);
        t0[0] = planeOrigin[0]; t0[1] = planeOrigin[1]; t0[2] = planeOrigin[2];

        // Back-project every visible frame-0 feature onto the plane and
        // express it in board-frame coordinates. A pixel (u, v) maps to a
        // camera-frame ray direction d = K^(-1) · [u, v, 1]. The ray from
        // the camera origin intersects the plane at depth s where:
        //     (s · d − planeOrigin) · nz = 0
        //     s = (planeOrigin · nz) / (d · nz)
        var Kinv = matInv3(this.K);
        var boardPts: number[] = [];

        for (var i = 0; i < N; i++) {
            if (!visible[i]) {
                boardPts.push(0, 0, 0); // placeholder for dropped track
                continue;
            }
            var u = pts2d0[i*2], v = pts2d0[i*2 + 1];
            var dx = Kinv[0]*u + Kinv[1]*v + Kinv[2];
            var dy = Kinv[3]*u + Kinv[4]*v + Kinv[5];
            var dz = Kinv[6]*u + Kinv[7]*v + Kinv[8];
            var dDotN = dx*nz[0] + dy*nz[1] + dz*nz[2];
            if (Math.abs(dDotN) < 1e-9) {
                boardPts.push(0, 0, 0);
                continue;
            }
            var pDotN = planeOrigin[0]*nz[0] + planeOrigin[1]*nz[1] + planeOrigin[2]*nz[2];
            var s = pDotN / dDotN;
            var Xcam = s*dx, Ycam = s*dy, Zcam = s*dz;
            // Express in board frame: P_board = R0^T · (P_cam − t0).
            var px = Xcam - t0[0], py = Ycam - t0[1], pz = Zcam - t0[2];
            var bx = R0[0]*px + R0[3]*py + R0[6]*pz;
            var by = R0[1]*px + R0[4]*py + R0[7]*pz;
            // bz should be ~0 by construction; we zero it explicitly.
            boardPts.push(bx, by, 0);
        }

        this.pts3dBoard = new Float64Array(boardPts);
        this.N = N;
        this.lastR = R0;
        this.lastT = t0;
        this.extrap.push(R0, t0, 0);
        this.smoother.reset();
    }

    // Expose current board coordinates (for debugging / visualization).
    public getBoardPoints(): Pts3 | null { return this.pts3dBoard; }

    // Constant-velocity extrapolation through dropouts. Preserves visual
    // continuity when a single frame loses enough tracks. Defined ahead of
    // update() so LensifyTS doesn't trip on a forward private-method ref.
    private handleDropout(time: number): FrameResult {
        var pred = this.extrap.predict(time);
        if (pred === null) {
            return {
                ok: false, R: null, t: null,
                numInliers: 0, branch: -1, extrapolated: false,
            };
        }
        // Don't update lastR/lastT from extrapolated pose — next real
        // observation should compare against the last ACCEPTED pose so
        // jump rejection stays well-conditioned.
        var smoothed = this.smoother.filter(pred.R, pred.t, time);
        return {
            ok: true,
            R: smoothed.R,
            t: smoothed.t,
            numInliers: 0,
            branch: -1,
            extrapolated: true,
        };
    }

    // --- Stage 3: per-frame pose. ---
    //
    // pts2d:   tracked 2D points this frame [N*2]
    // visible: per-point visibility mask, Uint8Array of length N
    // time:    timestamp in seconds (for One-Euro smoothing)
    //
    // Steps:
    //   1. Gather visible (3D_board, 2D_image) pairs.
    //   2. RANSAC homography to kick out per-frame outliers.
    //   3. solvePlanarPoseIPPE on the inliers, getting up to 2 branches.
    //   4. Pick the branch closest to the previous pose by geodesic
    //      rotation distance (Schweighofer & Pinz tiebreak #3).
    //   5. Jump rejection: if the chosen pose is more than maxJumpDeg /
    //      maxJumpMm away from last accepted, mark as rejected and
    //      extrapolate.
    //   6. Feed accepted poses through the One-Euro filter.
    public update(pts2d: Pts2, visible: Uint8Array, time: number): FrameResult {
        if (this.pts3dBoard === null) {
            throw new Error("PlaneTracker: call initBoard() first");
        }
        var N = this.N;
        // Count visible.
        var nVis = 0;
        for (var i = 0; i < N; i++) if (visible[i]) nVis++;
        if (nVis < this.cfg.minInliers) {
            return this.handleDropout(time);
        }

        // Pack visible points into contiguous buffers.
        var p3 = new Float64Array(nVis * 3);
        var p2 = new Float64Array(nVis * 2);
        var src2 = new Float64Array(nVis * 2);
        var k = 0;
        for (var j = 0; j < N; j++) {
            if (!visible[j]) continue;
            p3[k*3]     = this.pts3dBoard[j*3];
            p3[k*3 + 1] = this.pts3dBoard[j*3 + 1];
            p3[k*3 + 2] = 0;
            p2[k*2]     = pts2d[j*2];
            p2[k*2 + 1] = pts2d[j*2 + 1];
            // Board (x, y) as src for RANSAC homography.
            src2[k*2]     = this.pts3dBoard[j*3];
            src2[k*2 + 1] = this.pts3dBoard[j*3 + 1];
            k++;
        }

        // RANSAC homography between board (x_mm, y_mm) and image (u, v).
        var rr: { H: Mat; inliers: Uint8Array; numInliers: number };
        try {
            rr = ransacHomography(
                src2, p2, nVis,
                this.cfg.ransacThreshold, this.cfg.ransacIters);
        } catch (e) {
            return this.handleDropout(time);
        }
        if (rr.numInliers < this.cfg.minInliers) {
            return this.handleDropout(time);
        }

        // Tighten to inliers.
        var ni = rr.numInliers;
        var p3i = new Float64Array(ni * 3);
        var p2i = new Float64Array(ni * 2);
        var w = 0;
        for (var ii = 0; ii < nVis; ii++) {
            if (rr.inliers[ii]) {
                p3i[w*3]     = p3[ii*3];
                p3i[w*3 + 1] = p3[ii*3 + 1];
                p3i[w*3 + 2] = 0;
                p2i[w*2]     = p2[ii*2];
                p2i[w*2 + 1] = p2[ii*2 + 1];
                w++;
            }
        }

        // IPPE two-branch solve.
        var cands: PlanarPose[];
        try {
            cands = solvePlanarPoseIPPE(p3i, p2i, ni, this.K);
        } catch (e2) {
            return this.handleDropout(time);
        }
        if (cands.length === 0) return this.handleDropout(time);

        // Branch selection: previous-pose distance, tie-break by reproj err.
        var bestIdx = 0;
        if (cands.length > 1 && this.lastR !== null) {
            var bestScore = Infinity;
            for (var c = 0; c < cands.length; c++) {
                var gd = rotationGeodesic(this.lastR, cands[c].R);
                // Round to 1-degree bins so reprojection err is the
                // tie-breaker for near-equal rotations.
                var gdDeg = gd * 180 / Math.PI;
                var score = Math.round(gdDeg) * 1000 + cands[c].err;
                if (score < bestScore) { bestScore = score; bestIdx = c; }
            }
        } else if (cands.length > 1) {
            // No previous pose: pick lowest reprojection error.
            var lowest = cands[0].err;
            for (var cc = 1; cc < cands.length; cc++) {
                if (cands[cc].err < lowest) { lowest = cands[cc].err; bestIdx = cc; }
            }
        }
        var picked = cands[bestIdx];

        // Jump rejection.
        if (this.lastR !== null && this.lastT !== null) {
            var rotDeg = rotationGeodesic(this.lastR, picked.R) * 180 / Math.PI;
            var dx = picked.t[0] - this.lastT[0];
            var dy = picked.t[1] - this.lastT[1];
            var dz = picked.t[2] - this.lastT[2];
            var tDist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (rotDeg > this.cfg.maxJumpDeg || tDist > this.cfg.maxJumpMm) {
                return this.handleDropout(time);
            }
        }

        // Accept and smooth.
        this.lastR = picked.R;
        this.lastT = picked.t;
        this.extrap.push(picked.R, picked.t, time);

        var smoothed = this.smoother.filter(picked.R, picked.t, time);
        return {
            ok: true,
            R: smoothed.R,
            t: smoothed.t,
            numInliers: ni,
            branch: bestIdx,
            extrapolated: false,
        };
    }

    public getLastPose(): { R: Mat | null; t: Float64Array | null } {
        return { R: this.lastR, t: this.lastT };
    }
}
