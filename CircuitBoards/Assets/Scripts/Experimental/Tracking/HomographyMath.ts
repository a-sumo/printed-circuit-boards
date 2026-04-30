// HomographyMath.ts
// Planar homography estimation and decomposition, pure TypeScript.
//   homographyDLT     — N-point DLT with Hartley normalization
//   ransacHomography  — 4-point RANSAC with inlier mask
//   decomposeHomography — Malis & Vargas / Faugeras-Lustman style decomposition
//                         into up to 4 (R, t, n) candidates, filtered by
//                         cheirality (plane in front of camera).
//
// No Lens Studio types. Can run in plain Node for unit tests.
// Uses MatrixMath primitives.

import {
    Mat,
    matMul, matT, matInv3, det3,
    eig3sym,
    solveLinear,
} from "./MatrixMath";

// Flat Float64Array of length 2N (row-major, [x0,y0,x1,y1,...]).
export type Pts2 = Float64Array;

// Normalize a point set in-place style: return the scaled copy plus the 3x3
// similarity transform T such that (T * [p; 1])_xy = normalized point.
// Hartley & Zisserman: centroid at origin, mean distance sqrt(2).
function normalizePts(pts: Pts2, n: number): { out: Pts2; T: Mat } {
    var cx = 0, cy = 0;
    for (var i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; }
    cx /= n; cy /= n;
    var dmean = 0;
    for (var i2 = 0; i2 < n; i2++) {
        var dx = pts[i2 * 2] - cx;
        var dy = pts[i2 * 2 + 1] - cy;
        dmean += Math.sqrt(dx * dx + dy * dy);
    }
    dmean /= n;
    var s = (dmean > 1e-12) ? (Math.SQRT2 / dmean) : 1.0;
    var out = new Float64Array(n * 2);
    for (var i3 = 0; i3 < n; i3++) {
        out[i3 * 2]     = (pts[i3 * 2]     - cx) * s;
        out[i3 * 2 + 1] = (pts[i3 * 2 + 1] - cy) * s;
    }
    var T = new Float64Array(9);
    T[0] = s; T[1] = 0; T[2] = -s * cx;
    T[3] = 0; T[4] = s; T[5] = -s * cy;
    T[6] = 0; T[7] = 0; T[8] = 1;
    return { out: out, T: T };
}

// Build the homography that maps src → dst from n >= 4 point correspondences.
// Uses the fix-h22=1 trick: each pair gives 2 rows in an 8-column linear
// system, total 2n rows. For n=4 it's 8x8 and square; for n>4 we solve the
// normal equations A^T A · h = A^T b, which is 8x8 and still uses our Gauss
// solver. The input points are Hartley-normalized first for conditioning.
export function homographyDLT(src: Pts2, dst: Pts2, n: number): Mat {
    if (n < 4) throw new Error("homographyDLT: need >= 4 points");

    var sN = normalizePts(src, n);
    var dN = normalizePts(dst, n);
    var sp = sN.out;
    var dp = dN.out;

    // For n=4 we solve 8 equations exactly; for n>4 use normal equations.
    var A: Float64Array;
    var b: Float64Array;

    if (n === 4) {
        A = new Float64Array(8 * 8);
        b = new Float64Array(8);
        for (var i = 0; i < 4; i++) {
            var x = sp[i * 2], y = sp[i * 2 + 1];
            var u = dp[i * 2], v = dp[i * 2 + 1];
            var r0 = i * 2;
            A[r0 * 8 + 0] = x;  A[r0 * 8 + 1] = y;  A[r0 * 8 + 2] = 1;
            A[r0 * 8 + 3] = 0;  A[r0 * 8 + 4] = 0;  A[r0 * 8 + 5] = 0;
            A[r0 * 8 + 6] = -u * x; A[r0 * 8 + 7] = -u * y;
            b[r0] = u;
            var r1 = i * 2 + 1;
            A[r1 * 8 + 0] = 0;  A[r1 * 8 + 1] = 0;  A[r1 * 8 + 2] = 0;
            A[r1 * 8 + 3] = x;  A[r1 * 8 + 4] = y;  A[r1 * 8 + 5] = 1;
            A[r1 * 8 + 6] = -v * x; A[r1 * 8 + 7] = -v * y;
            b[r1] = v;
        }
    } else {
        // Build 2n x 8 system M, then normal equations A = M^T M, b = M^T rhs.
        var M = new Float64Array(2 * n * 8);
        var rhs = new Float64Array(2 * n);
        for (var j = 0; j < n; j++) {
            var x2 = sp[j * 2], y2 = sp[j * 2 + 1];
            var u2 = dp[j * 2], v2 = dp[j * 2 + 1];
            var rr0 = j * 2;
            M[rr0 * 8 + 0] = x2;  M[rr0 * 8 + 1] = y2;  M[rr0 * 8 + 2] = 1;
            M[rr0 * 8 + 6] = -u2 * x2; M[rr0 * 8 + 7] = -u2 * y2;
            rhs[rr0] = u2;
            var rr1 = j * 2 + 1;
            M[rr1 * 8 + 3] = x2;  M[rr1 * 8 + 4] = y2;  M[rr1 * 8 + 5] = 1;
            M[rr1 * 8 + 6] = -v2 * x2; M[rr1 * 8 + 7] = -v2 * y2;
            rhs[rr1] = v2;
        }
        // A = M^T M  (8x8)
        A = new Float64Array(64);
        for (var a = 0; a < 8; a++) {
            for (var c = 0; c < 8; c++) {
                var acc = 0;
                for (var k = 0; k < 2 * n; k++) acc += M[k * 8 + a] * M[k * 8 + c];
                A[a * 8 + c] = acc;
            }
        }
        // b = M^T rhs
        b = new Float64Array(8);
        for (var aa = 0; aa < 8; aa++) {
            var acc2 = 0;
            for (var kk = 0; kk < 2 * n; kk++) acc2 += M[kk * 8 + aa] * rhs[kk];
            b[aa] = acc2;
        }
    }

    var h = solveLinear(A, b, 8);

    // Un-normalize: H = T_dst^(-1) * H_norm * T_src
    var Hnorm = new Float64Array(9);
    Hnorm[0] = h[0]; Hnorm[1] = h[1]; Hnorm[2] = h[2];
    Hnorm[3] = h[3]; Hnorm[4] = h[4]; Hnorm[5] = h[5];
    Hnorm[6] = h[6]; Hnorm[7] = h[7]; Hnorm[8] = 1;

    var TdstInv = matInv3(dN.T);
    var HA = matMul(TdstInv, 3, 3, Hnorm, 3, 3);
    var H = matMul(HA, 3, 3, sN.T, 3, 3);

    // Scale so H[8] = 1 for consistency (handle degenerate case gracefully).
    if (Math.abs(H[8]) > 1e-12) {
        var inv = 1.0 / H[8];
        for (var m2 = 0; m2 < 9; m2++) H[m2] *= inv;
    }
    return H;
}

// Apply homography to a single 2D point: y = H * [x; 1] / z.
export function applyH(H: Mat, x: number, y: number): { u: number; v: number } {
    var u = H[0] * x + H[1] * y + H[2];
    var v = H[3] * x + H[4] * y + H[5];
    var w = H[6] * x + H[7] * y + H[8];
    if (Math.abs(w) < 1e-12) w = 1e-12;
    return { u: u / w, v: v / w };
}

// Symmetric transfer error (squared) between src[i] and dst[i] under H.
function transferErrSq(H: Mat, Hinv: Mat, sx: number, sy: number, dx: number, dy: number): number {
    var f = applyH(H, sx, sy);
    var b = applyH(Hinv, dx, dy);
    var e1x = f.u - dx, e1y = f.v - dy;
    var e2x = b.u - sx, e2y = b.v - sy;
    return e1x * e1x + e1y * e1y + e2x * e2x + e2y * e2y;
}

// RANSAC 4-point homography estimation.
// Returns the best H plus a boolean inlier mask. src and dst are flat Pts2.
// threshold is the max symmetric transfer error in pixels (we compare to its square).
//
// Sampling uses a seeded xorshift32 PRNG (NOT Math.random()) so the sample
// sequence is bit-identical across JS engines — V8 (browser/node) and the
// Lens Studio runtime previously diverged on the same input because their
// Math.random() PRNGs differ, which made RANSAC pick different 4-samples
// and converge to different homographies once inlier ratios got sparse.
// The seed is a cheap data hash so different frames still get different
// sequences within a single tracker run.
export function ransacHomography(
    src: Pts2, dst: Pts2, n: number,
    threshold: number, iters: number
): { H: Mat; inliers: Uint8Array; numInliers: number } {
    if (n < 4) throw new Error("ransacHomography: need >= 4 points");

    var bestCount = -1;
    var bestInliers = new Uint8Array(n);
    var bestH: Mat | null = null;
    var threshSq = threshold * threshold * 2; // symmetric error ≈ 2 * one-way

    var sample4 = new Float64Array(8);
    var dstSample4 = new Float64Array(8);
    var idxs = [0, 0, 0, 0];

    // Seed xorshift32 from a tiny data hash. Bitwise ops force int32 in JS,
    // so this is byte-for-byte identical in V8 and the LS runtime.
    var rng = (n * 2654435761) | 0;
    rng = (rng ^ ((src[0] * 1000) | 0)) | 0;
    rng = (rng ^ ((src[1] * 1000) | 0)) | 0;
    rng = (rng ^ ((dst[0] * 1000) | 0)) | 0;
    rng = (rng ^ ((dst[1] * 1000) | 0)) | 0;
    rng = (rng ^ ((src[(n - 1) * 2]     * 1000) | 0)) | 0;
    rng = (rng ^ ((src[(n - 1) * 2 + 1] * 1000) | 0)) | 0;
    rng = (rng ^ ((dst[(n - 1) * 2]     * 1000) | 0)) | 0;
    rng = (rng ^ ((dst[(n - 1) * 2 + 1] * 1000) | 0)) | 0;
    if (rng === 0) rng = 1; // xorshift dies on 0

    for (var it = 0; it < iters; it++) {
        // Pick 4 distinct indices via xorshift32 → uint32 → mod n.
        rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
        idxs[0] = (rng >>> 0) % n;
        do { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
             idxs[1] = (rng >>> 0) % n;
        } while (idxs[1] === idxs[0]);
        do { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
             idxs[2] = (rng >>> 0) % n;
        } while (idxs[2] === idxs[0] || idxs[2] === idxs[1]);
        do { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
             idxs[3] = (rng >>> 0) % n;
        } while (idxs[3] === idxs[0] || idxs[3] === idxs[1] || idxs[3] === idxs[2]);
        for (var p = 0; p < 4; p++) {
            sample4[p * 2]     = src[idxs[p] * 2];
            sample4[p * 2 + 1] = src[idxs[p] * 2 + 1];
            dstSample4[p * 2]     = dst[idxs[p] * 2];
            dstSample4[p * 2 + 1] = dst[idxs[p] * 2 + 1];
        }

        var H: Mat;
        try {
            H = homographyDLT(sample4, dstSample4, 4);
        } catch (e) {
            continue;
        }
        var Hinv: Mat;
        try {
            Hinv = matInv3(H);
        } catch (e2) {
            continue;
        }

        // Count inliers.
        var count = 0;
        for (var i = 0; i < n; i++) {
            var e = transferErrSq(H, Hinv, src[i * 2], src[i * 2 + 1],
                                           dst[i * 2], dst[i * 2 + 1]);
            if (e < threshSq) count++;
        }
        if (count > bestCount) {
            bestCount = count;
            bestH = H;
            for (var ii = 0; ii < n; ii++) {
                var ee = transferErrSq(H, Hinv, src[ii * 2], src[ii * 2 + 1],
                                               dst[ii * 2], dst[ii * 2 + 1]);
                bestInliers[ii] = (ee < threshSq) ? 1 : 0;
            }
        }
    }

    // Refit on all inliers for a tighter final H.
    if (bestH !== null && bestCount >= 8) {
        var kept = 0;
        for (var a = 0; a < n; a++) if (bestInliers[a]) kept++;
        var srcIn = new Float64Array(kept * 2);
        var dstIn = new Float64Array(kept * 2);
        var w = 0;
        for (var a2 = 0; a2 < n; a2++) {
            if (bestInliers[a2]) {
                srcIn[w * 2] = src[a2 * 2]; srcIn[w * 2 + 1] = src[a2 * 2 + 1];
                dstIn[w * 2] = dst[a2 * 2]; dstIn[w * 2 + 1] = dst[a2 * 2 + 1];
                w++;
            }
        }
        try {
            bestH = homographyDLT(srcIn, dstIn, kept);
        } catch (e3) {
            // Keep the previous bestH if refit fails.
        }
    }

    if (bestH === null) throw new Error("ransacHomography: no valid model");
    return { H: bestH, inliers: bestInliers, numInliers: bestCount };
}

// Homography decomposition candidate: H = R + t * n^T (with the metric
// plane distance absorbed into t, as is standard when H is normalized).
export interface HDecomp {
    R: Mat;         // 3x3 rotation
    t: Float64Array; // 3x1 translation (up to plane depth scale)
    n: Float64Array; // 3x1 unit normal in camera frame
}

// Malis & Vargas (2007) / Faugeras-Lustman (1988) style decomposition
// via the eigendecomposition of H^T · H.
//
// Input H is the pixel-space homography (H = K · (R + t n^T / d) · K^(-1)).
// We first normalize to Hn = K^(-1) · H · K, scale so the middle singular
// value is 1, then extract up to 4 (R, t, n) candidates. Cheirality
// filtering (n_z < 0, i.e. the plane's front face points toward the camera
// origin in OpenCV convention) is applied at the end.
export function decomposeHomography(H: Mat, K: Mat): HDecomp[] {
    // Normalize H by camera intrinsics.
    var Kinv = matInv3(K);
    var KinvH = matMul(Kinv, 3, 3, H, 3, 3);
    var Hn = matMul(KinvH, 3, 3, K, 3, 3);

    // S = Hn^T · Hn (symmetric).
    var S = new Float64Array(9);
    for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
            var acc = 0;
            for (var k = 0; k < 3; k++) acc += Hn[k * 3 + i] * Hn[k * 3 + j];
            S[i * 3 + j] = acc;
        }
    }
    var eig = eig3sym(S);
    var s1sq = eig.values[0];
    var s2sq = eig.values[1];
    var s3sq = eig.values[2];
    if (s2sq < 1e-12) return [];

    // Scale so middle singular value = 1.
    var s2 = Math.sqrt(s2sq);
    var inv2 = 1.0 / s2;
    for (var m = 0; m < 9; m++) Hn[m] *= inv2;
    var s1 = Math.sqrt(s1sq) * inv2;
    var s3 = Math.sqrt(s3sq) * inv2;

    // Flip sign if det(Hn) < 0 (projective ambiguity of H).
    if (det3(Hn) < 0) {
        for (var m2 = 0; m2 < 9; m2++) Hn[m2] = -Hn[m2];
    }

    // Right singular vectors of Hn = eigenvectors of Hn^T Hn.
    // eig.vectors is row-major; column k is the k-th eigenvector.
    var v1 = new Float64Array([eig.vectors[0], eig.vectors[3], eig.vectors[6]]);
    var v2 = new Float64Array([eig.vectors[1], eig.vectors[4], eig.vectors[7]]);
    var v3 = new Float64Array([eig.vectors[2], eig.vectors[5], eig.vectors[8]]);

    var denom = s1 * s1 - s3 * s3;
    if (Math.abs(denom) < 1e-10) {
        // Pure rotation (s1 ≈ s3 ≈ 1). Normal is undefined; return Hn as R.
        return [{
            R: new Float64Array(Hn),
            t: new Float64Array(3),
            n: new Float64Array([0, 0, -1]),
        }];
    }

    var a1 = Math.sqrt(Math.max(0, 1 - s3 * s3));
    var a3 = Math.sqrt(Math.max(0, s1 * s1 - 1));
    var sd = Math.sqrt(denom);
    var c1 = a1 / sd;
    var c3 = a3 / sd;

    // Two base directions in the v1–v3 plane (u_a, u_b).
    var ua = new Float64Array(3);
    var ub = new Float64Array(3);
    for (var d = 0; d < 3; d++) {
        ua[d] = c1 * v1[d] + c3 * v3[d];
        ub[d] = c1 * v1[d] - c3 * v3[d];
    }

    // Helper: for basis U = [v2 | u | v2 × u] and W = [Hn·v2 | Hn·u | (Hn·v2) × (Hn·u)],
    // the rotation is R = W · U^T and the normal is v2 × u.
    function buildCandidate(u: Float64Array): HDecomp {
        var v2xu = new Float64Array(3);
        v2xu[0] = v2[1] * u[2] - v2[2] * u[1];
        v2xu[1] = v2[2] * u[0] - v2[0] * u[2];
        v2xu[2] = v2[0] * u[1] - v2[1] * u[0];

        var U = new Float64Array(9);
        for (var r = 0; r < 3; r++) {
            U[r * 3 + 0] = v2[r];
            U[r * 3 + 1] = u[r];
            U[r * 3 + 2] = v2xu[r];
        }

        var Hv2 = new Float64Array(3);
        var Hu  = new Float64Array(3);
        for (var r2 = 0; r2 < 3; r2++) {
            Hv2[r2] = Hn[r2 * 3] * v2[0] + Hn[r2 * 3 + 1] * v2[1] + Hn[r2 * 3 + 2] * v2[2];
            Hu[r2]  = Hn[r2 * 3] * u[0]  + Hn[r2 * 3 + 1] * u[1]  + Hn[r2 * 3 + 2] * u[2];
        }
        var HvxHu = new Float64Array(3);
        HvxHu[0] = Hv2[1] * Hu[2] - Hv2[2] * Hu[1];
        HvxHu[1] = Hv2[2] * Hu[0] - Hv2[0] * Hu[2];
        HvxHu[2] = Hv2[0] * Hu[1] - Hv2[1] * Hu[0];

        var W = new Float64Array(9);
        for (var r3 = 0; r3 < 3; r3++) {
            W[r3 * 3 + 0] = Hv2[r3];
            W[r3 * 3 + 1] = Hu[r3];
            W[r3 * 3 + 2] = HvxHu[r3];
        }

        var Ut = matT(U, 3, 3);
        var R = matMul(W, 3, 3, Ut, 3, 3);

        var n = v2xu; // already unit (v2 and u are unit & orthogonal in the plane)

        // t / d = (Hn − R) · n
        var Hminus = new Float64Array(9);
        for (var mm = 0; mm < 9; mm++) Hminus[mm] = Hn[mm] - R[mm];
        var t = new Float64Array(3);
        for (var r4 = 0; r4 < 3; r4++) {
            t[r4] = Hminus[r4 * 3] * n[0] + Hminus[r4 * 3 + 1] * n[1] + Hminus[r4 * 3 + 2] * n[2];
        }

        return { R: R, t: t, n: new Float64Array(n) };
    }

    var cands: HDecomp[] = [];
    var Ca = buildCandidate(ua);
    var Cb = buildCandidate(ub);
    cands.push(Ca);
    // Normal-sign flip: R stays, n → -n, t → -t.
    cands.push({
        R: Ca.R,
        t: new Float64Array([-Ca.t[0], -Ca.t[1], -Ca.t[2]]),
        n: new Float64Array([-Ca.n[0], -Ca.n[1], -Ca.n[2]]),
    });
    cands.push(Cb);
    cands.push({
        R: Cb.R,
        t: new Float64Array([-Cb.t[0], -Cb.t[1], -Cb.t[2]]),
        n: new Float64Array([-Cb.n[0], -Cb.n[1], -Cb.n[2]]),
    });

    // Cheirality: keep normals with n_z < 0 (plane faces the camera in
    // OpenCV's +Z-forward convention). This prunes 4 → at most 2.
    var kept: HDecomp[] = [];
    for (var ci = 0; ci < cands.length; ci++) {
        if (cands[ci].n[2] < 0) kept.push(cands[ci]);
    }
    return kept;
}
