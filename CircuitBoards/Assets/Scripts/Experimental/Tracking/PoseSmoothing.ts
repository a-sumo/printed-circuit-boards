// PoseSmoothing.ts
// Streaming pose smoothing primitives for the plane-from-motion tracker.
//
// Why online (not offline) smoothing:
//   The Python reference does a batch median + Gaussian over all frames at
//   once. On Spectacles we don't have the whole sequence — each frame has
//   to commit a pose before the next one arrives. So we use the One-Euro
//   filter (Casiez, Roussel & Vogel 2012) which adapts its cutoff to the
//   signal's derivative: still poses get heavy smoothing, fast moves track
//   lag-free.
//
// Why quaternions (not Rodrigues vectors):
//   rvec has a sign-flip discontinuity: rot(θ, n) == rot(-θ, -n), so a
//   single sign flip looks like a 2π jump to a per-element low-pass. We
//   convert to a unit quaternion, enforce hemisphere continuity (dot with
//   previous ≥ 0), and apply the filter to the four components. See
//   docs/PLANE-FROM-MOTION-TRACKING.md "Smooth in quaternion space".
//
// Exports:
//   rotToQuat, quatToRot, quatNormalize, quatDot, quatHemisphere
//   OneEuroFilter         — scalar One-Euro
//   OneEuroPoseFilter    — SE(3) version: 3 translation channels + 4 quat
//                          components with hemisphere enforcement
//   ConstVelExtrapolator — linear extrapolation through dropouts (fed from
//                          the last two accepted poses)

import { Mat } from "./MatrixMath";

// 4-element unit quaternion [w, x, y, z].
export type Quat = Float64Array;

// Convert a 3x3 rotation matrix to a unit quaternion via Shepperd's method
// (picks the largest of 1 + tr, 1 + 2R00 - tr, etc. for numerical stability).
export function rotToQuat(R: Mat): Quat {
    var tr = R[0] + R[4] + R[8];
    var q = new Float64Array(4);
    if (tr > 0) {
        var s = Math.sqrt(tr + 1.0) * 2; // s = 4*w
        q[0] = 0.25 * s;
        q[1] = (R[7] - R[5]) / s;
        q[2] = (R[2] - R[6]) / s;
        q[3] = (R[3] - R[1]) / s;
    } else if (R[0] > R[4] && R[0] > R[8]) {
        var s1 = Math.sqrt(1.0 + R[0] - R[4] - R[8]) * 2; // s = 4*x
        q[0] = (R[7] - R[5]) / s1;
        q[1] = 0.25 * s1;
        q[2] = (R[1] + R[3]) / s1;
        q[3] = (R[2] + R[6]) / s1;
    } else if (R[4] > R[8]) {
        var s2 = Math.sqrt(1.0 + R[4] - R[0] - R[8]) * 2; // s = 4*y
        q[0] = (R[2] - R[6]) / s2;
        q[1] = (R[1] + R[3]) / s2;
        q[2] = 0.25 * s2;
        q[3] = (R[5] + R[7]) / s2;
    } else {
        var s3 = Math.sqrt(1.0 + R[8] - R[0] - R[4]) * 2; // s = 4*z
        q[0] = (R[3] - R[1]) / s3;
        q[1] = (R[2] + R[6]) / s3;
        q[2] = (R[5] + R[7]) / s3;
        q[3] = 0.25 * s3;
    }
    return q;
}

// Convert a unit quaternion to a 3x3 rotation matrix.
export function quatToRot(q: Quat): Mat {
    var w = q[0], x = q[1], y = q[2], z = q[3];
    var R = new Float64Array(9);
    R[0] = 1 - 2*(y*y + z*z);
    R[1] = 2*(x*y - z*w);
    R[2] = 2*(x*z + y*w);
    R[3] = 2*(x*y + z*w);
    R[4] = 1 - 2*(x*x + z*z);
    R[5] = 2*(y*z - x*w);
    R[6] = 2*(x*z - y*w);
    R[7] = 2*(y*z + x*w);
    R[8] = 1 - 2*(x*x + y*y);
    return R;
}

export function quatNormalize(q: Quat): Quat {
    var n = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
    if (n < 1e-12) { q[0] = 1; q[1] = 0; q[2] = 0; q[3] = 0; return q; }
    var inv = 1.0 / n;
    q[0] *= inv; q[1] *= inv; q[2] *= inv; q[3] *= inv;
    return q;
}

export function quatDot(a: Quat, b: Quat): number {
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
}

// Force q into the same hemisphere as ref (negate if their dot product is
// negative). This is free because q and -q represent the same rotation,
// and it's what makes per-component filtering coherent.
export function quatHemisphere(q: Quat, ref: Quat): void {
    if (quatDot(q, ref) < 0) {
        q[0] = -q[0]; q[1] = -q[1]; q[2] = -q[2]; q[3] = -q[3];
    }
}

// Scalar One-Euro filter (Casiez et al. 2012).
//
// alpha(cutoff) = 1 / (1 + tau/dt), tau = 1 / (2π · cutoff)
// cutoff(dx)    = minCutoff + beta · |dx|
//
// Still signals → low cutoff → heavy smoothing.
// Fast signals → high cutoff → low-lag tracking.
export class OneEuroFilter {
    private minCutoff: number;
    private beta: number;
    private dCutoff: number;
    private xPrev: number = 0;
    private dxPrev: number = 0;
    private tPrev: number = -1;
    private inited: boolean = false;

    constructor(minCutoff: number, beta: number, dCutoff: number) {
        this.minCutoff = minCutoff;
        this.beta = beta;
        this.dCutoff = dCutoff;
    }

    // t is a timestamp in seconds.
    public filter(x: number, t: number): number {
        if (!this.inited) {
            this.xPrev = x;
            this.dxPrev = 0;
            this.tPrev = t;
            this.inited = true;
            return x;
        }
        var dt = t - this.tPrev;
        if (dt < 1e-6) dt = 1e-6;

        var dx = (x - this.xPrev) / dt;
        var aD = OneEuroFilter.alpha(this.dCutoff, dt);
        var dxHat = aD * dx + (1 - aD) * this.dxPrev;

        var cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
        var a = OneEuroFilter.alpha(cutoff, dt);
        var xHat = a * x + (1 - a) * this.xPrev;

        this.xPrev = xHat;
        this.dxPrev = dxHat;
        this.tPrev = t;
        return xHat;
    }

    public reset(): void {
        this.inited = false;
    }

    private static alpha(cutoff: number, dt: number): number {
        var tau = 1.0 / (2 * Math.PI * cutoff);
        return 1.0 / (1.0 + tau / dt);
    }
}

// Full SE(3) One-Euro filter: 3 translation channels + 4 quaternion
// components with hemisphere continuity. Each channel has its own One-Euro
// state, so rotation and translation smooth independently.
export class OneEuroPoseFilter {
    private tx: OneEuroFilter;
    private ty: OneEuroFilter;
    private tz: OneEuroFilter;
    private qw: OneEuroFilter;
    private qx: OneEuroFilter;
    private qy: OneEuroFilter;
    private qz: OneEuroFilter;
    private lastQ: Quat | null = null;

    constructor(minCutoff: number = 1.5, beta: number = 0.007, dCutoff: number = 1.0) {
        this.tx = new OneEuroFilter(minCutoff, beta, dCutoff);
        this.ty = new OneEuroFilter(minCutoff, beta, dCutoff);
        this.tz = new OneEuroFilter(minCutoff, beta, dCutoff);
        this.qw = new OneEuroFilter(minCutoff, beta, dCutoff);
        this.qx = new OneEuroFilter(minCutoff, beta, dCutoff);
        this.qy = new OneEuroFilter(minCutoff, beta, dCutoff);
        this.qz = new OneEuroFilter(minCutoff, beta, dCutoff);
    }

    // Filter an input pose, returns the smoothed (R, t). `time` is seconds.
    public filter(R: Mat, t: Float64Array, time: number): { R: Mat; t: Float64Array } {
        var q = rotToQuat(R);
        if (this.lastQ !== null) {
            quatHemisphere(q, this.lastQ);
        }

        var txOut = this.tx.filter(t[0], time);
        var tyOut = this.ty.filter(t[1], time);
        var tzOut = this.tz.filter(t[2], time);
        var qwOut = this.qw.filter(q[0], time);
        var qxOut = this.qx.filter(q[1], time);
        var qyOut = this.qy.filter(q[2], time);
        var qzOut = this.qz.filter(q[3], time);

        var qOut = new Float64Array([qwOut, qxOut, qyOut, qzOut]);
        quatNormalize(qOut);
        this.lastQ = qOut;

        return {
            R: quatToRot(qOut),
            t: new Float64Array([txOut, tyOut, tzOut]),
        };
    }

    public reset(): void {
        this.tx.reset(); this.ty.reset(); this.tz.reset();
        this.qw.reset(); this.qx.reset(); this.qy.reset(); this.qz.reset();
        this.lastQ = null;
    }
}

// Constant-velocity extrapolator fed from the last two accepted poses.
// When the current frame drops below the inlier threshold, the tracker
// calls predict(dt) to get a forward-extrapolated pose instead of freezing,
// which visibly reduces stutter through dropouts.
export class ConstVelExtrapolator {
    private prevPrevR: Mat | null = null;
    private prevPrevT: Float64Array | null = null;
    private prevPrevTime: number = 0;
    private prevR: Mat | null = null;
    private prevT: Float64Array | null = null;
    private prevTime: number = 0;

    public push(R: Mat, t: Float64Array, time: number): void {
        this.prevPrevR = this.prevR;
        this.prevPrevT = this.prevT;
        this.prevPrevTime = this.prevTime;
        this.prevR = new Float64Array(R);
        this.prevT = new Float64Array(t);
        this.prevTime = time;
    }

    public hasHistory(): boolean {
        return this.prevR !== null && this.prevPrevR !== null;
    }

    // Predict pose at `time` via linear extrapolation of the last two good
    // frames. For rotation, use slerp with factor > 1 (i.e., extrapolation
    // beyond the pair). For translation, plain linear extrapolation.
    public predict(time: number): { R: Mat; t: Float64Array } | null {
        if (!this.hasHistory()) return null;
        var dtHist = this.prevTime - this.prevPrevTime;
        if (dtHist < 1e-6) return { R: this.prevR!, t: this.prevT! };
        var alpha = (time - this.prevPrevTime) / dtHist;

        // Translation extrapolation.
        var tOut = new Float64Array(3);
        for (var i = 0; i < 3; i++) {
            tOut[i] = this.prevPrevT![i] + alpha * (this.prevT![i] - this.prevPrevT![i]);
        }

        // Rotation extrapolation via quaternion slerp (alpha can exceed 1).
        var qA = rotToQuat(this.prevPrevR!);
        var qB = rotToQuat(this.prevR!);
        quatHemisphere(qB, qA);
        var qOut = slerp(qA, qB, alpha);
        return { R: quatToRot(qOut), t: tOut };
    }
}

// Spherical linear interpolation between two unit quaternions. `t` is not
// clamped to [0, 1] — callers can use t > 1 for extrapolation.
export function slerp(a: Quat, b: Quat, t: number): Quat {
    var dot = quatDot(a, b);
    var bCopy = new Float64Array(b);
    if (dot < 0) {
        bCopy[0] = -bCopy[0]; bCopy[1] = -bCopy[1];
        bCopy[2] = -bCopy[2]; bCopy[3] = -bCopy[3];
        dot = -dot;
    }
    var out = new Float64Array(4);
    if (dot > 0.9995) {
        // Fall back to linear interpolation + normalize for near-identical
        // quaternions (avoids numerical issues in acos).
        for (var i = 0; i < 4; i++) {
            out[i] = a[i] + t * (bCopy[i] - a[i]);
        }
        quatNormalize(out);
        return out;
    }
    var theta0 = Math.acos(dot);
    var theta  = theta0 * t;
    var sinT0  = Math.sin(theta0);
    var sinT   = Math.sin(theta);
    var wA = Math.cos(theta) - dot * sinT / sinT0;
    var wB = sinT / sinT0;
    for (var j = 0; j < 4; j++) {
        out[j] = wA * a[j] + wB * bCopy[j];
    }
    quatNormalize(out);
    return out;
}
