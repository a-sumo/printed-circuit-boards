// PlaneTrackerTest.ts
// Replays the IMG_1173.MOV CT3 tracks through the TS PlaneTracker inside
// the Lens Studio runtime, then prints stats to the LS Logger. Used to
// validate that the LensifyTS-compiled tracker matches the browser baseline
// from web-demo/screenshot-video.mjs and the node baseline from
// tools/tests/replay-img-1173.ts.
//
// Replay is distributed across UpdateEvents (framesPerTick fixture frames
// per LS tick) so we never trip LS' "InternalError: interrupted" watchdog
// on the scripting thread, while keeping per-frame print() calls minimal
// so the run finishes inside the ls_run log-capture window.
//
// Per-frame stats are stashed in instance fields and the *complete* run
// summary (including all sample-frame Δrot/Δt readings) is emitted as a
// single multi-line print() the moment the replay completes — and then
// re-emitted on every subsequent UpdateEvent so the latest result is
// always sitting in the log buffer no matter when ls_logs samples it.
//
// Usage:
//   1. Drop this script onto any SceneObject (e.g. an empty under Camera).
//   2. Hit Play.
//   3. Open the Logger and look for [PT] DONE.

import { PlaneTracker } from "./PlaneTracker";
import { Mat } from "./MatrixMath";

// LS-style require: paths resolve from the Assets root.
// NOTE: Connectors/test-tracks/img-1173.js was deleted from the tree.
// Re-supply test-track fixtures under Scripts/Experimental/Tracking/test-tracks/
// before running this harness.
var DATA: any = { framesAll: [], frames: [] };

// Frames the browser screenshot harness samples — we record their per-frame
// Δrot/Δt so the LS run is byte-for-byte comparable to the browser baseline.
var SAMPLE_FRAMES: number[] = [0, 30, 90, 150, 210, 261];

@component
export class PlaneTrackerTest extends BaseScriptComponent {

    @input
    @hint("Frames to process per LS update tick. Lower = safer, slower.")
    framesPerTick: number = 30;

    @input
    @hint("Stop replay on the first dropout / extrap so the log is short")
    stopOnDropout: boolean = false;

    private tracker: PlaneTracker | null = null;
    private N: number = 0;
    private nextFrame: number = 0;
    private maxRotErr: number = 0;
    private maxTErr: number = 0;
    private drops: number = 0;
    private solveSum: number = 0;
    private solveCnt: number = 0;
    private done: boolean = false;
    private summaryLine: string = "";
    // sampleResults[i] = "f=NN Δrot=X.XX° Δt=Y.Ymm inliers=Z/N branch=B"
    private sampleResults: string[] = [];

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.start());
    }

    private start(): void {
        try {
            this.initRun();
        } catch (e) {
            print("[PT] FATAL init: " + (e as any).message);
            return;
        }
        // Drive the replay from UpdateEvent so each tick yields back to LS
        // and we never trip the long-running-script watchdog.
        var updateBinding = this.createEvent("UpdateEvent");
        updateBinding.bind(() => this.tick());
    }

    private initRun(): void {
        var data = DATA;
        this.N = data.nPoints as number;
        // Pre-fill sampleResults with placeholders so we can print partial
        // progress before the run finishes.
        for (var s = 0; s < SAMPLE_FRAMES.length; s++) {
            this.sampleResults.push("f=" + SAMPLE_FRAMES[s] + " (pending)");
        }
        print("[PT] starting — frames=" + data.frames.length
            + " N=" + this.N + " W=" + data.W + " H=" + data.H
            + " framesPerTick=" + this.framesPerTick);

        var K = new Float64Array(data.K);
        this.tracker = new PlaneTracker(K);

        // Seed the board frame from the python pipeline's frozen seed pose.
        // Mirrors exactly what video.html does in the browser.
        var f0 = data.frames[0];
        var pts0 = new Float64Array(f0.pts);
        var vis0 = new Uint8Array(f0.vis);
        this.tracker.initBoard(
            new Float64Array(data.seed.planeNormal),
            new Float64Array(data.seed.planeOrigin),
            new Float64Array(data.seed.inPlaneDir),
            pts0, vis0, this.N);

        this.nextFrame = 0;
    }

    private tick(): void {
        if (this.tracker === null) return;
        // Once the run is done we keep re-emitting the summary every tick
        // so ls_logs is guaranteed to find it no matter when it samples.
        // IMPORTANT: LS logger truncates multi-line print() calls at the
        // first '\n', so we emit each line as its own print() call.
        if (this.done) {
            print(this.summaryLine);
            for (var sr = 0; sr < this.sampleResults.length; sr++) {
                print("[PT]   " + this.sampleResults[sr]);
            }
            return;
        }
        try {
            this.tickInner();
        } catch (e) {
            print("[PT] FATAL tick: " + (e as any).message);
            this.done = true;
        }
    }

    private tickInner(): void {
        var data = DATA;
        var n = data.frames.length;
        var budget = this.framesPerTick > 0 ? this.framesPerTick : 1;

        for (var b = 0; b < budget && this.nextFrame < n; b++) {
            var fr = data.frames[this.nextFrame];
            this.nextFrame++;

            var pts = new Float64Array(fr.pts);
            var vis = new Uint8Array(fr.vis);

            var t0 = getTime();
            var res = (this.tracker as PlaneTracker).update(pts, vis, fr.t);
            var dtMs = (getTime() - t0) * 1000.0;
            this.solveSum += dtMs;
            this.solveCnt++;

            if (!res.ok) this.drops++;

            var rotErr = -1;
            var tErr = -1;
            if (res.R !== null && fr.pyR) {
                rotErr = rotGeoDeg(res.R, fr.pyR);
                if (rotErr > this.maxRotErr) this.maxRotErr = rotErr;
            }
            if (res.t !== null && fr.pyT) {
                tErr = vec3Dist(res.t, fr.pyT);
                if (tErr > this.maxTErr) this.maxTErr = tErr;
            }

            // Stash sample-frame results in our cache. We'll dump them all
            // at once in the final summary instead of printing per-frame
            // (each print() call stalls the scripting thread ~300ms which
            // would push the run well past the ls_run capture window).
            for (var s = 0; s < SAMPLE_FRAMES.length; s++) {
                if (fr.f === SAMPLE_FRAMES[s]) {
                    this.sampleResults[s] = "f=" + pad(fr.f, 4)
                        + " Δrot=" + rotErr.toFixed(2) + "°"
                        + " Δt=" + tErr.toFixed(1) + "mm"
                        + " inliers=" + pad(res.numInliers, 3) + "/" + this.N
                        + " branch=" + res.branch
                        + (res.extrapolated ? " [extrap]" : "");
                    break;
                }
            }

            if (this.stopOnDropout && !res.ok) {
                this.finish();
                return;
            }
        }

        if (this.nextFrame >= n) this.finish();
    }

    private finish(): void {
        if (this.done) return;
        this.done = true;
        var avgMs = this.solveCnt > 0 ? (this.solveSum / this.solveCnt) : 0;
        this.summaryLine = "[PT] DONE — frames=" + this.solveCnt
            + " drops=" + this.drops
            + " maxΔrot=" + this.maxRotErr.toFixed(2) + "°"
            + " maxΔt=" + this.maxTErr.toFixed(1) + "mm"
            + " avg solve=" + avgMs.toFixed(2) + "ms";
        print(this.summaryLine);
        // Emit each sample line as its own print() call — LS logger
        // truncates multi-line prints at the first '\n'.
        for (var s = 0; s < this.sampleResults.length; s++) {
            print("[PT]   " + this.sampleResults[s]);
        }
    }
}

// --- tiny helpers (kept local so this file is self-contained) ---

// Geodesic rotation distance in degrees between two row-major 3x3 matrices.
function rotGeoDeg(A: Mat, B: number[] | Float64Array): number {
    // tr(A^T B) = sum_ij A_ji B_ji
    var s = 0;
    for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
            s += (A as any)[j*3 + i] * (B as any)[j*3 + i];
        }
    }
    var c = (s - 1) / 2;
    if (c > 1) c = 1;
    if (c < -1) c = -1;
    return Math.acos(c) * 180 / Math.PI;
}

function vec3Dist(a: Float64Array, b: number[] | Float64Array): number {
    var dx = a[0] - (b as any)[0];
    var dy = a[1] - (b as any)[1];
    var dz = a[2] - (b as any)[2];
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

function pad(n: number, w: number): string {
    var s = String(n);
    while (s.length < w) s = " " + s;
    return s;
}
