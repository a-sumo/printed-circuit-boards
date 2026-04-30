// IppeSolver.ts
// Closed-form planar PnP (Collins & Bartoli 2014, "Infinitesimal Plane-Based
// Pose Estimation"). Given N board points in the plane z=0 and their image
// projections, produces up to TWO (R, t) solutions — the characteristic
// two-fold ambiguity of planar targets (Schweighofer & Pinz 2006).
//
// The two branches are essential on the first frame (before any temporal
// context) and on frames where the previous pose is unreliable. Per-frame
// selection between the branches is the caller's responsibility.
//
// Algorithm:
//   1. Build the board→image homography H from correspondences (DLT).
//   2. Normalize by intrinsics: M = K^(-1) · H.
//   3. Zhang extraction gives a first "seed" rotation R_z from M.
//   4. The two IPPE branches are obtained by rotating R_z by ±θ around the
//      in-plane axis perpendicular to the projection of the optical axis
//      onto the board, where θ is determined by the homography's Jacobian.
//   5. For each branch, refine translation via linear LS with R held fixed.

import {
    Mat,
    matMul, matT, matInv3,
    nearestRotation3,
} from "./MatrixMath";
import {
    homographyDLT,
    Pts2,
} from "./HomographyMath";

// Flat 3D point buffer, [x0,y0,z0,x1,y1,z1,...]. For planar targets z=0.
export type Pts3 = Float64Array;

export interface PlanarPose {
    R: Mat;          // 3x3 rotation, row-major
    t: Float64Array; // 3x1 translation in camera frame (same units as input 3D)
    err: number;     // mean reprojection error (px)
}

// Project a 3D camera-frame point through K into pixels.
function projectPoint(K: Mat, R: Mat, t: Float64Array,
                      X: number, Y: number, Z: number): { u: number; v: number } {
    var xc = R[0]*X + R[1]*Y + R[2]*Z + t[0];
    var yc = R[3]*X + R[4]*Y + R[5]*Z + t[1];
    var zc = R[6]*X + R[7]*Y + R[8]*Z + t[2];
    if (Math.abs(zc) < 1e-12) zc = 1e-12;
    var u = (K[0]*xc + K[1]*yc + K[2]*zc) / zc;
    var v = (K[3]*xc + K[4]*yc + K[5]*zc) / zc;
    return { u: u, v: v };
}

// Mean reprojection error for a pose on (pts3d, pts2d).
function reprojErr(K: Mat, R: Mat, t: Float64Array,
                   pts3d: Pts3, pts2d: Pts2, n: number): number {
    var sum = 0;
    for (var i = 0; i < n; i++) {
        var p = projectPoint(K, R, t,
            pts3d[i*3], pts3d[i*3+1], pts3d[i*3+2]);
        var du = p.u - pts2d[i*2];
        var dv = p.v - pts2d[i*2+1];
        sum += Math.sqrt(du*du + dv*dv);
    }
    return sum / n;
}

// Solve for translation given a fixed rotation R via linear least squares.
// Each correspondence gives 2 equations in 3 unknowns; we stack them and
// solve the 3x3 normal equations (A^T A) t = A^T b.
function solveTranslationFixedR(
    K: Mat, R: Mat, pts3d: Pts3, pts2d: Pts2, n: number
): Float64Array {
    var fx = K[0], fy = K[4], cx = K[2], cy = K[5];
    var ATA = new Float64Array(9);
    var ATb = new Float64Array(3);

    for (var i = 0; i < n; i++) {
        var X = pts3d[i*3], Y = pts3d[i*3+1], Z = pts3d[i*3+2];
        var u = pts2d[i*2], v = pts2d[i*2+1];
        // Rotate the model point so the unknown is pure translation.
        var Xc = R[0]*X + R[1]*Y + R[2]*Z;
        var Yc = R[3]*X + R[4]*Y + R[5]*Z;
        var Zc = R[6]*X + R[7]*Y + R[8]*Z;
        // Pinhole equations:
        //   (fx·(Xc+tx) + cx·(Zc+tz)) / (Zc+tz) = u
        //   (fy·(Yc+ty) + cy·(Zc+tz)) / (Zc+tz) = v
        // Rearranged to linear form in (tx, ty, tz):
        //   fx·tx + (cx - u)·tz = (u - cx)·Zc - fx·Xc
        //   fy·ty + (cy - v)·tz = (v - cy)·Zc - fy·Yc
        var a1 = fx, a2 = 0.0, a3 = cx - u;
        var b1 = (u - cx) * Zc - fx * Xc;
        var c1 = 0.0, c2 = fy, c3 = cy - v;
        var d1 = (v - cy) * Zc - fy * Yc;

        // Accumulate A^T A and A^T b (two rows per correspondence).
        ATA[0] += a1*a1 + c1*c1;
        ATA[1] += a1*a2 + c1*c2;
        ATA[2] += a1*a3 + c1*c3;
        ATA[3] += a2*a1 + c2*c1;
        ATA[4] += a2*a2 + c2*c2;
        ATA[5] += a2*a3 + c2*c3;
        ATA[6] += a3*a1 + c3*c1;
        ATA[7] += a3*a2 + c3*c2;
        ATA[8] += a3*a3 + c3*c3;

        ATb[0] += a1*b1 + c1*d1;
        ATb[1] += a2*b1 + c2*d1;
        ATb[2] += a3*b1 + c3*d1;
    }

    // Cramer's rule on 3x3.
    var d00 = ATA[4]*ATA[8] - ATA[5]*ATA[7];
    var d01 = ATA[3]*ATA[8] - ATA[5]*ATA[6];
    var d02 = ATA[3]*ATA[7] - ATA[4]*ATA[6];
    var det = ATA[0]*d00 - ATA[1]*d01 + ATA[2]*d02;
    if (Math.abs(det) < 1e-18) {
        // Degenerate — fall back to zero translation (caller should detect
        // via reprojection error).
        return new Float64Array(3);
    }
    var invDet = 1.0 / det;
    var t = new Float64Array(3);
    // Inverse of ATA applied to ATb.
    var i00 =  d00 * invDet;
    var i01 = -(ATA[1]*ATA[8] - ATA[2]*ATA[7]) * invDet;
    var i02 =  (ATA[1]*ATA[5] - ATA[2]*ATA[4]) * invDet;
    var i10 = -d01 * invDet;
    var i11 =  (ATA[0]*ATA[8] - ATA[2]*ATA[6]) * invDet;
    var i12 = -(ATA[0]*ATA[5] - ATA[2]*ATA[3]) * invDet;
    var i20 =  d02 * invDet;
    var i21 = -(ATA[0]*ATA[7] - ATA[1]*ATA[6]) * invDet;
    var i22 =  (ATA[0]*ATA[4] - ATA[1]*ATA[3]) * invDet;
    t[0] = i00*ATb[0] + i01*ATb[1] + i02*ATb[2];
    t[1] = i10*ATb[0] + i11*ATb[1] + i12*ATb[2];
    t[2] = i20*ATb[0] + i21*ATb[1] + i22*ATb[2];
    return t;
}

// Rodrigues-style construction: rotation by `angle` around unit axis `a`.
function rotationFromAxisAngle(a: Float64Array, angle: number): Mat {
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    var C = 1 - c;
    var R = new Float64Array(9);
    R[0] = a[0]*a[0]*C + c;
    R[1] = a[0]*a[1]*C - a[2]*s;
    R[2] = a[0]*a[2]*C + a[1]*s;
    R[3] = a[1]*a[0]*C + a[2]*s;
    R[4] = a[1]*a[1]*C + c;
    R[5] = a[1]*a[2]*C - a[0]*s;
    R[6] = a[2]*a[0]*C - a[1]*s;
    R[7] = a[2]*a[1]*C + a[0]*s;
    R[8] = a[2]*a[2]*C + c;
    return R;
}

// Zhang-style extraction: one rotation from M = K^(-1) · H, where H is the
// board→image homography. Handles sign flip so depth is positive.
function zhangExtract(M: Mat): { R: Mat; t: Float64Array } {
    var m1x = M[0], m1y = M[3], m1z = M[6];
    var m2x = M[1], m2y = M[4], m2z = M[7];
    var m3x = M[2], m3y = M[5], m3z = M[8];

    var n1 = Math.sqrt(m1x*m1x + m1y*m1y + m1z*m1z);
    var n2 = Math.sqrt(m2x*m2x + m2y*m2y + m2z*m2z);
    var lam = (n1 + n2) * 0.5;
    if (lam < 1e-9) throw new Error("zhangExtract: degenerate scale");
    var il = 1.0 / lam;

    var r1x = m1x*il, r1y = m1y*il, r1z = m1z*il;
    var r2x = m2x*il, r2y = m2y*il, r2z = m2z*il;
    var tx  = m3x*il, ty  = m3y*il, tz  = m3z*il;

    // Gram-Schmidt r1, r2.
    var s = Math.sqrt(r1x*r1x + r1y*r1y + r1z*r1z);
    r1x /= s; r1y /= s; r1z /= s;
    var dot = r1x*r2x + r1y*r2y + r1z*r2z;
    r2x -= dot*r1x; r2y -= dot*r1y; r2z -= dot*r1z;
    var s2 = Math.sqrt(r2x*r2x + r2y*r2y + r2z*r2z);
    if (s2 < 1e-9) throw new Error("zhangExtract: r1 || r2");
    r2x /= s2; r2y /= s2; r2z /= s2;

    var r3x = r1y*r2z - r1z*r2y;
    var r3y = r1z*r2x - r1x*r2z;
    var r3z = r1x*r2y - r1y*r2x;

    // If depth is negative, negate r1, r2, t. r3 is unchanged (cross of
    // two negated vectors), so det(R) stays +1.
    if (tz < 0) {
        r1x = -r1x; r1y = -r1y; r1z = -r1z;
        r2x = -r2x; r2y = -r2y; r2z = -r2z;
        tx  = -tx;  ty  = -ty;  tz  = -tz;
    }

    var R = new Float64Array(9);
    R[0] = r1x; R[1] = r2x; R[2] = r3x;
    R[3] = r1y; R[4] = r2y; R[5] = r3y;
    R[6] = r1z; R[7] = r2z; R[8] = r3z;

    // Project to nearest SO(3) to clean up residual non-orthogonality from
    // the Gram-Schmidt step under noise.
    R = nearestRotation3(R);

    var t = new Float64Array([tx, ty, tz]);
    return { R: R, t: t };
}

// Solve planar PnP given model points at Z=0, returning both IPPE branches
// (where distinguishable). Caller picks between them by previous-pose
// distance or other side-information.
//
// pts3d: flat [X0,Y0,Z0,X1,Y1,Z1,...], Z should be ~0 for planar targets.
// pts2d: flat [u0,v0,u1,v1,...] pixel coordinates.
// n: number of points.
// K: 3x3 intrinsics matrix, row-major.
export function solvePlanarPoseIPPE(
    pts3d: Pts3, pts2d: Pts2, n: number, K: Mat
): PlanarPose[] {
    if (n < 4) throw new Error("solvePlanarPoseIPPE: need >= 4 points");

    // Flatten model to 2D for homography (z assumed 0).
    var board2d = new Float64Array(n * 2);
    for (var i = 0; i < n; i++) {
        board2d[i*2]     = pts3d[i*3];
        board2d[i*2 + 1] = pts3d[i*3 + 1];
    }

    var H = homographyDLT(board2d, pts2d, n);
    var Kinv = matInv3(K);
    var M = matMul(Kinv, 3, 3, H, 3, 3);

    // --- Branch A: Zhang extraction ---
    var seed = zhangExtract(M);
    var RA = seed.R;
    var tA_seed = seed.t;

    // --- Branch B: the "flip" around the in-plane axis perpendicular to the
    // projection of the optical axis onto the board plane. ---
    //
    // Normal of the board in camera frame = 3rd column of RA.
    // Optical axis in camera frame = [0, 0, 1].
    // Projection of optical axis onto the board plane (perpendicular to n):
    //     ez_proj = e_z - (e_z · n) · n
    // In-plane flip axis = n × ez_proj (normalized).
    // The flip angle θ satisfies: sin(θ/2) = ||ez_proj||, which is the
    // distance between the two IPPE branches in rotation space.
    var nx = RA[2], ny = RA[5], nz = RA[8];
    var ezDotN = nz; // e_z · n = n_z
    var ezPx = -ezDotN * nx;
    var ezPy = -ezDotN * ny;
    var ezPz = 1 - ezDotN * nz;
    var ezPlen = Math.sqrt(ezPx*ezPx + ezPy*ezPy + ezPz*ezPz);

    var poses: PlanarPose[] = [];

    // Always emit branch A.
    var tA = solveTranslationFixedR(K, RA, pts3d, pts2d, n);
    var errA = reprojErr(K, RA, tA, pts3d, pts2d, n);
    poses.push({ R: RA, t: tA, err: errA });

    // Emit branch B only if there's a meaningful in-plane component of the
    // optical axis (if the board is seen exactly face-on, the two branches
    // coincide and we skip).
    if (ezPlen > 1e-3) {
        // Flip axis = n × ez_proj, in camera frame.
        var faxCam = new Float64Array(3);
        faxCam[0] = ny * ezPz - nz * ezPy;
        faxCam[1] = nz * ezPx - nx * ezPz;
        faxCam[2] = nx * ezPy - ny * ezPx;
        var fl = Math.sqrt(faxCam[0]*faxCam[0] + faxCam[1]*faxCam[1] + faxCam[2]*faxCam[2]);
        if (fl > 1e-9) {
            faxCam[0] /= fl; faxCam[1] /= fl; faxCam[2] /= fl;

            // Rotate the flip axis into the BOARD frame: axis_board = R^T · axis_cam.
            var faxBoard = new Float64Array(3);
            faxBoard[0] = RA[0]*faxCam[0] + RA[3]*faxCam[1] + RA[6]*faxCam[2];
            faxBoard[1] = RA[1]*faxCam[0] + RA[4]*faxCam[1] + RA[7]*faxCam[2];
            faxBoard[2] = RA[2]*faxCam[0] + RA[5]*faxCam[1] + RA[8]*faxCam[2];
            // Should have a near-zero z component (in-plane axis).

            // Flip angle: 2 * asin(||ez_proj||) is the characteristic IPPE
            // ambiguity span. In camera-tilt terms, this is twice the tilt
            // angle of the board off the optical axis.
            var tilt = Math.asin(Math.min(1, ezPlen));
            var theta = 2 * tilt;

            var Rflip = rotationFromAxisAngle(faxBoard, theta);
            // Branch B rotation: rotate R_A about the in-board-plane axis.
            // R_B = R_A · R_flip means: first apply R_flip in board frame,
            // then R_A into camera frame.
            var RB = matMul(RA, 3, 3, Rflip, 3, 3);
            RB = nearestRotation3(RB);

            var tB = solveTranslationFixedR(K, RB, pts3d, pts2d, n);
            var errB = reprojErr(K, RB, tB, pts3d, pts2d, n);
            // Only keep if B is meaningfully distinct from A.
            var geoDist = rotationGeodesic(RA, RB);
            if (geoDist > 0.02) {  // ~1.1 degrees
                poses.push({ R: RB, t: tB, err: errB });
            }
        }
    }

    return poses;
}

// Geodesic distance between two rotations (radians).
// arccos((tr(R1^T · R2) - 1) / 2)
export function rotationGeodesic(R1: Mat, R2: Mat): number {
    var R1t = matT(R1, 3, 3);
    var D = matMul(R1t, 3, 3, R2, 3, 3);
    var tr = D[0] + D[4] + D[8];
    var c = (tr - 1) * 0.5;
    if (c > 1) c = 1;
    else if (c < -1) c = -1;
    return Math.acos(c);
}
