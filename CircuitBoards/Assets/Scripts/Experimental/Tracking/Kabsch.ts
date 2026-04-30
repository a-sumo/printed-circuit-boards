// Kabsch.ts
// Optimal 3D rigid alignment between two corresponding point clouds.
//
// Given N pairs (src[i], dst[i]) of 3D points, find the rotation R and
// translation t that minimise sum_i || R · src[i] + t - dst[i] ||^2.
//
// Standard Kabsch / Umeyama derivation:
//   centroid_src = mean(src),  centroid_dst = mean(dst)
//   H = sum_i (src[i] - cs) ⊗ (dst[i] - cd)^T            // 3×3
//   SVD: H = U · Σ · V^T
//   d  = sign(det(V · U^T))                              // ±1, fixes reflection
//   R  = V · diag(1, 1, d) · U^T
//   t  = cd - R · cs
//
// The ONLY tricky bit is the SVD when the source point cloud is planar
// (every point has the same z in some local frame — universal for our use
// case since the board is flat). One singular value goes to zero and the
// matching U column has to be reconstructed via cross product of the other
// two. The polar-decomposition helper in MatrixMath has a hole for this
// case (it multiplies a zero column by a clamped 1/√ε and gets zero), so
// Kabsch.ts ships its own svd3 here instead.
//
// Returns null when:
//   - n < 3 (rigid pose underdetermined),
//   - all source points coincide (rotation ambiguous),
//   - the alignment can't be solved at all (returned R has NaN).

import { Mat, eig3sym, det3 } from "./MatrixMath";

export interface RigidAlignment {
    R: Mat;            // 3×3 row-major rotation
    t: Float64Array;   // 3-vector translation
    residual: number;  // RMS distance between R·src+t and dst (input units)
}

// 3×3 SVD via the eigendecomposition of M^T M.
// Returns { U, S, V } such that M ≈ U · diag(S) · V^T, with U, V row-major
// and orthonormal-columned and S sorted descending. The rank-2 case (one
// zero singular value, the planar point cloud) gets the missing U column
// filled in via cross product. Rank-1 (collinear) gets two filled in.
function svd3(M: Float64Array): { U: Float64Array; S: Float64Array; V: Float64Array } {
    // M^T M (3×3, symmetric, positive semidefinite)
    var MTM = new Float64Array(9);
    for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
            var s = 0;
            for (var k = 0; k < 3; k++) {
                s += M[k * 3 + i] * M[k * 3 + j];
            }
            MTM[i * 3 + j] = s;
        }
    }
    var eig = eig3sym(MTM);  // values descending, vectors as columns

    var V = new Float64Array(9);
    for (var d = 0; d < 3; d++) {
        V[0 * 3 + d] = eig.vectors[0 * 3 + d];
        V[1 * 3 + d] = eig.vectors[1 * 3 + d];
        V[2 * 3 + d] = eig.vectors[2 * 3 + d];
    }

    // For each right singular vector V[:,d], the corresponding singular value
    // σ_d = ||M · V[:,d]||, and U[:,d] = (M · V[:,d]) / σ_d. We compute σ
    // this way (rather than as sqrt of the eig.values) because the eigvalue
    // sqrt loses precision for near-zero values: a rank-deficient MTM with
    // floating-point noise λ ~ ε·λ_max produces σ = √(ε·λ_max) ~ √ε · σ_max,
    // which is non-zero but much larger than the actual norm of M·V[:,d].
    // Dividing the (zero) image by that bogus σ throws away the rank-2
    // signal entirely.
    var U = new Float64Array(9);
    var S = new Float64Array(3);
    var sigmaScratch = new Float64Array(3);
    for (var d = 0; d < 3; d++) {
        var vx = V[0 * 3 + d], vy = V[1 * 3 + d], vz = V[2 * 3 + d];
        var ux = M[0] * vx + M[1] * vy + M[2] * vz;
        var uy = M[3] * vx + M[4] * vy + M[5] * vz;
        var uz = M[6] * vx + M[7] * vy + M[8] * vz;
        var sigma = Math.sqrt(ux * ux + uy * uy + uz * uz);
        sigmaScratch[d] = sigma;
        U[0 * 3 + d] = ux;  // un-normalised; we divide below once we know sigma_max
        U[1 * 3 + d] = uy;
        U[2 * 3 + d] = uz;
    }

    // Decide rank from a RELATIVE threshold against the largest σ. Anything
    // below σ_max · 1e-12 is definitely floating-point noise.
    var sigmaMax = sigmaScratch[0];
    if (sigmaScratch[1] > sigmaMax) sigmaMax = sigmaScratch[1];
    if (sigmaScratch[2] > sigmaMax) sigmaMax = sigmaScratch[2];
    var sigmaTol = sigmaMax * 1e-12;
    if (sigmaTol < 1e-20) sigmaTol = 1e-20;

    var rank = 0;
    for (var d = 0; d < 3; d++) {
        if (sigmaScratch[d] > sigmaTol) {
            S[d] = sigmaScratch[d];
            var inv = 1.0 / sigmaScratch[d];
            U[0 * 3 + d] *= inv;
            U[1 * 3 + d] *= inv;
            U[2 * 3 + d] *= inv;
            rank++;
        } else {
            S[d] = 0;
            U[0 * 3 + d] = 0;
            U[1 * 3 + d] = 0;
            U[2 * 3 + d] = 0;
        }
    }

    if (rank === 2) {
        // Planar point cloud — fill U[:,2] = U[:,0] × U[:,1]. Sign doesn't
        // matter; the d = sign(det(V U^T)) correction in Kabsch will fix it.
        var a0 = U[0], a1 = U[3], a2 = U[6];
        var b0 = U[1], b1 = U[4], b2 = U[7];
        U[2] = a1 * b2 - a2 * b1;
        U[5] = a2 * b0 - a0 * b2;
        U[8] = a0 * b1 - a1 * b0;
    } else if (rank === 1) {
        // Collinear points. Build any orthonormal frame around U[:,0].
        var a0 = U[0], a1 = U[3], a2 = U[6];
        var bx = 0, by = 0, bz = 0;
        if (Math.abs(a0) < 0.9) bx = 1;
        else by = 1;
        var dot = a0 * bx + a1 * by + a2 * bz;
        bx -= dot * a0; by -= dot * a1; bz -= dot * a2;
        var bn = Math.sqrt(bx * bx + by * by + bz * bz);
        if (bn < 1e-12) return { U: U, S: S, V: V };  // shouldn't reach
        bx /= bn; by /= bn; bz /= bn;
        U[1] = bx; U[4] = by; U[7] = bz;
        U[2] = a1 * bz - a2 * by;
        U[5] = a2 * bx - a0 * bz;
        U[8] = a0 * by - a1 * bx;
    }

    return { U: U, S: S, V: V };
}

// `src` and `dst` are flat Float64Arrays of length n*3, row-major:
//   x0, y0, z0, x1, y1, z1, ...
// The two arrays must be in correspondence: src[i] pairs with dst[i].
export function solveRigidAlignment(
    src: Float64Array,
    dst: Float64Array,
    n: number
): RigidAlignment | null {
    if (n < 3) return null;

    // Centroids.
    var csx = 0, csy = 0, csz = 0;
    var cdx = 0, cdy = 0, cdz = 0;
    for (var i = 0; i < n; i++) {
        var k = i * 3;
        csx += src[k]; csy += src[k + 1]; csz += src[k + 2];
        cdx += dst[k]; cdy += dst[k + 1]; cdz += dst[k + 2];
    }
    var inv = 1.0 / n;
    csx *= inv; csy *= inv; csz *= inv;
    cdx *= inv; cdy *= inv; cdz *= inv;

    // H = sum_i (centered_src[i]) ⊗ (centered_dst[i])^T  — Kabsch convention.
    // H[a, b] += centered_src[i, a] * centered_dst[i, b]
    var H = new Float64Array(9);
    var srcSpread = 0;
    for (var i = 0; i < n; i++) {
        var k = i * 3;
        var sx = src[k]     - csx;
        var sy = src[k + 1] - csy;
        var sz = src[k + 2] - csz;
        var dx = dst[k]     - cdx;
        var dy = dst[k + 1] - cdy;
        var dz = dst[k + 2] - cdz;
        H[0] += sx * dx; H[1] += sx * dy; H[2] += sx * dz;
        H[3] += sy * dx; H[4] += sy * dy; H[5] += sy * dz;
        H[6] += sz * dx; H[7] += sz * dy; H[8] += sz * dz;
        srcSpread += sx * sx + sy * sy + sz * sz;
    }
    if (srcSpread < 1e-8) return null;  // source points all coincident

    var svd = svd3(H);
    var U = svd.U;
    var V = svd.V;

    // R = V · diag(1, 1, sign(det(V U^T))) · U^T.
    // Compute V U^T first to get the sign right.
    var VUt = new Float64Array(9);
    for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
            var s = 0;
            for (var k = 0; k < 3; k++) {
                s += V[i * 3 + k] * U[j * 3 + k];
            }
            VUt[i * 3 + j] = s;
        }
    }
    var d = det3(VUt);

    var R = new Float64Array(9);
    if (d >= 0) {
        R.set(VUt);
    } else {
        // Negate V's third column (equivalent to multiplying by diag(1,1,-1)
        // on the right) and recompute V U^T.
        var Vc = new Float64Array(V);
        Vc[2] = -Vc[2]; Vc[5] = -Vc[5]; Vc[8] = -Vc[8];
        for (var i = 0; i < 3; i++) {
            for (var j = 0; j < 3; j++) {
                var s = 0;
                for (var k = 0; k < 3; k++) {
                    s += Vc[i * 3 + k] * U[j * 3 + k];
                }
                R[i * 3 + j] = s;
            }
        }
    }

    // Reject NaN solutions (numerical blow-up — should never happen now but
    // cheap to check).
    if (!(R[0] === R[0])) return null;

    // t = centroid_dst - R · centroid_src
    var t = new Float64Array(3);
    t[0] = cdx - (R[0] * csx + R[1] * csy + R[2] * csz);
    t[1] = cdy - (R[3] * csx + R[4] * csy + R[5] * csz);
    t[2] = cdz - (R[6] * csx + R[7] * csy + R[8] * csz);

    // Residual (RMS distance between R·src + t and dst).
    var sumSq = 0;
    for (var i = 0; i < n; i++) {
        var k = i * 3;
        var px = R[0] * src[k] + R[1] * src[k + 1] + R[2] * src[k + 2] + t[0];
        var py = R[3] * src[k] + R[4] * src[k + 1] + R[5] * src[k + 2] + t[1];
        var pz = R[6] * src[k] + R[7] * src[k + 1] + R[8] * src[k + 2] + t[2];
        var ex = px - dst[k];
        var ey = py - dst[k + 1];
        var ez = pz - dst[k + 2];
        sumSq += ex * ex + ey * ey + ez * ez;
    }
    var residual = Math.sqrt(sumSq / n);

    return { R: R, t: t, residual: residual };
}

// Weighted variant for use with RANSAC inliers or per-keypoint confidences.
// Set w[i] = 0 to exclude pair i entirely.
export function solveRigidAlignmentWeighted(
    src: Float64Array,
    dst: Float64Array,
    w: Float64Array | null,
    n: number
): RigidAlignment | null {
    if (w === null) return solveRigidAlignment(src, dst, n);
    if (n < 3) return null;

    var wsum = 0;
    var csx = 0, csy = 0, csz = 0;
    var cdx = 0, cdy = 0, cdz = 0;
    for (var i = 0; i < n; i++) {
        var wi = w[i];
        if (wi <= 0) continue;
        var k = i * 3;
        wsum += wi;
        csx += wi * src[k];     csy += wi * src[k + 1];     csz += wi * src[k + 2];
        cdx += wi * dst[k];     cdy += wi * dst[k + 1];     cdz += wi * dst[k + 2];
    }
    if (wsum < 1e-12) return null;
    var inv = 1.0 / wsum;
    csx *= inv; csy *= inv; csz *= inv;
    cdx *= inv; cdy *= inv; cdz *= inv;

    var H = new Float64Array(9);
    var srcSpread = 0;
    var effectiveN = 0;
    for (var i = 0; i < n; i++) {
        var wi = w[i];
        if (wi <= 0) continue;
        var k = i * 3;
        var sx = src[k]     - csx;
        var sy = src[k + 1] - csy;
        var sz = src[k + 2] - csz;
        var dx = dst[k]     - cdx;
        var dy = dst[k + 1] - cdy;
        var dz = dst[k + 2] - cdz;
        H[0] += wi * sx * dx; H[1] += wi * sx * dy; H[2] += wi * sx * dz;
        H[3] += wi * sy * dx; H[4] += wi * sy * dy; H[5] += wi * sy * dz;
        H[6] += wi * sz * dx; H[7] += wi * sz * dy; H[8] += wi * sz * dz;
        srcSpread += wi * (sx * sx + sy * sy + sz * sz);
        effectiveN++;
    }
    if (effectiveN < 3 || srcSpread < 1e-8) return null;

    var svd = svd3(H);
    var U = svd.U;
    var V = svd.V;

    var VUt = new Float64Array(9);
    for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
            var s = 0;
            for (var k = 0; k < 3; k++) {
                s += V[i * 3 + k] * U[j * 3 + k];
            }
            VUt[i * 3 + j] = s;
        }
    }
    var d = det3(VUt);

    var R = new Float64Array(9);
    if (d >= 0) {
        R.set(VUt);
    } else {
        var Vc = new Float64Array(V);
        Vc[2] = -Vc[2]; Vc[5] = -Vc[5]; Vc[8] = -Vc[8];
        for (var i = 0; i < 3; i++) {
            for (var j = 0; j < 3; j++) {
                var s = 0;
                for (var k = 0; k < 3; k++) {
                    s += Vc[i * 3 + k] * U[j * 3 + k];
                }
                R[i * 3 + j] = s;
            }
        }
    }
    if (!(R[0] === R[0])) return null;

    var t = new Float64Array(3);
    t[0] = cdx - (R[0] * csx + R[1] * csy + R[2] * csz);
    t[1] = cdy - (R[3] * csx + R[4] * csy + R[5] * csz);
    t[2] = cdz - (R[6] * csx + R[7] * csy + R[8] * csz);

    var sumSq = 0;
    var nResid = 0;
    for (var i = 0; i < n; i++) {
        if (w[i] <= 0) continue;
        var k = i * 3;
        var px = R[0] * src[k] + R[1] * src[k + 1] + R[2] * src[k + 2] + t[0];
        var py = R[3] * src[k] + R[4] * src[k + 1] + R[5] * src[k + 2] + t[1];
        var pz = R[6] * src[k] + R[7] * src[k + 1] + R[8] * src[k + 2] + t[2];
        var ex = px - dst[k];
        var ey = py - dst[k + 1];
        var ez = pz - dst[k + 2];
        sumSq += ex * ex + ey * ey + ez * ez;
        nResid++;
    }
    var residual = Math.sqrt(sumSq / nResid);

    return { R: R, t: t, residual: residual };
}
