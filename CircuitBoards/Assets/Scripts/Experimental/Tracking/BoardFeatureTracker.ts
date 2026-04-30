// BoardFeatureTracker.ts
// Live 6DOF board tracking driven by an XFeat backbone running through
// MLComponent, depth lifting via DepthCache, and rigid alignment via Kabsch.
//
// Pipeline (per inference tick, ~10Hz):
//   1. depthCache.saveDepthFrame()  → frozen color texture + matched depth
//   2. bind that texture to mlComponent.getInput("image")
//   3. mlComponent.runImmediate(false)
//   4. read descriptor_map [1,64,60,80] and heatmap [1,1,60,80]
//   5. cell-resolution NMS top-K on the heatmap → camera keypoints
//   6. sample + L2-normalize the 64-dim descriptor at each accepted cell
//   7. match camera descriptors against the baked template (cosine sim,
//      Lowe's ratio test, optional mutual nearest neighbour gate)
//   8. for each match, map the cell back to a cam-frame pixel and ask
//      DepthCache for the world-space 3D point
//   9. RANSAC + Kabsch on (board_local_xyz, world_xyz) pairs
//  10. lerp the host KiCadBoard SceneObject toward the recovered pose
//
// The template is produced offline by tools/bake-board-template.mjs and
// shipped as boards/templates/<slug>.js. It contains:
//   - K * 64 L2-normalized descriptors
//   - K * 3 board-local positions in cm (z = 0)
//   - K reliability scores (0..1)
//   - the netW/netH/mode the bake used
//
// IMPORTANT: the template is baked in `stretch` mode by default. The LS
// MLComponent here is expected to bind the camera texture directly into
// the model input without aspect correction (default behavior). Both ends
// see the same anisotropic squish, so descriptors stay comparable. If the
// template was baked in `fit` mode, the runtime would also need to letterbox
// the camera frame the same way before binding — that path isn't wired yet.

import { solveRigidAlignmentWeighted } from "./Kabsch";

@component
export class BoardFeatureTracker extends BaseScriptComponent {

    @input
    @hint("KiCadBoard ScriptComponent to anchor to the recovered pose")
    kiCadBoard: ScriptComponent;

    @input
    @hint("MLComponent with the xfeat_backbone_simplified.onnx asset bound")
    mlComponent: MLComponent;

    @input
    @hint("DepthCache ScriptComponent (provides matched color/depth pairs)")
    depthCache: ScriptComponent;

    @input
    @hint("Board slug — must match a baked template in boards/templates/")
    boardSlug: string = "xiao-servo";

    // ---- Inference cadence ------------------------------------------------

    @input
    @hint("Minimum seconds between inference runs (10Hz default)")
    inferenceIntervalSec: number = 0.1;

    // ---- NMS / matching ---------------------------------------------------

    @input
    @hint("Top-K camera keypoints to retain per frame")
    topKCamera: number = 256;

    @input
    @hint("Cell-radius NMS for camera keypoints (Chebyshev distance)")
    nmsRadius: number = 2;

    @input
    @hint("Drop heatmap cells below this reliability before NMS")
    minReliability: number = 0.05;

    @input
    @hint("Lowe's ratio test threshold (lower = stricter)")
    loweRatio: number = 0.85;

    @input
    @hint("Minimum descriptor cosine similarity to keep a candidate match")
    minCosine: number = 0.7;

    // ---- RANSAC + Kabsch --------------------------------------------------

    @input
    @hint("Minimum descriptor matches to attempt a pose solve")
    minMatches: number = 12;

    @input
    @hint("RANSAC iterations for pose hypothesis")
    ransacIters: number = 64;

    @input
    @hint("RANSAC iterations to run per UpdateEvent tick (budgeted)")
    ransacItersPerTick: number = 16;

    @input
    @hint("RANSAC inlier threshold in cm")
    ransacInlierCm: number = 1.0;

    @input
    @hint("Minimum RANSAC inliers to accept a pose")
    ransacMinInliers: number = 8;

    @input
    @hint("Max template keypoints scanned per match (cap the O(nT*nC) loop)")
    maxTemplateKpts: number = 192;

    // ---- Pose smoothing ---------------------------------------------------

    @input
    @hint("Per-frame pose lerp alpha (0=instant, 1=frozen)")
    smoothingAlpha: number = 0.3;

    @input
    @hint("Print per-second stats to the LS Logger")
    debugLogging: boolean = true;

    @input
    @hint("Optional Text component for an on-screen HUD (leave empty to disable)")
    @allowUndefined
    overlayText: Text;

    // -----------------------------------------------------------------------
    // Internal state — see start()/runFrame()/applyPose() below.
    // -----------------------------------------------------------------------

    private kb: any = null;
    private boardObj: SceneObject | null = null;
    private depthCacheRef: any = null;

    // Template (parsed from boards/templates/<slug>.js).
    private template: any = null;
    private tDesc: Float32Array | null = null;     // K_t * 64
    private tBoardXYZ: Float32Array | null = null; // K_t * 3 (cm, board-local)
    private tCount: number = 0;
    private tNetW: number = 640;
    private tNetH: number = 480;
    private tStride: number = 8;
    private tFeatW: number = 80;
    private tFeatH: number = 60;
    private tDescDim: number = 64;
    private tMode: string = "stretch";

    // ML state.
    private mlReady: boolean = false;
    private inputName: string = "image";
    private outDescName: string = "descriptor_map";
    private outHeatName: string = "heatmap";
    // Time (seconds) after which we give up waiting for MLComponent to load
    // and print a one-shot diagnostic. 0 = not armed.
    private mlLoadDeadline: number = 0;
    private mlLoadLogged: boolean = false;

    // Camera resolution (set on first cam frame).
    private camW: number = 0;
    private camH: number = 0;

    // Per-frame scratch for camera keypoints + descriptors.
    private camKpCellX: Int32Array;
    private camKpCellY: Int32Array;
    private camKpScore: Float32Array;
    private camKpDesc: Float32Array;  // topKCamera * 64
    private camKpCount: number = 0;

    // Per-frame scratch for matches.
    private matchTIdx: Int32Array;
    private matchCIdx: Int32Array;
    private matchScore: Float32Array;
    private matchCount: number = 0;

    // Reusable Kabsch input buffers.
    private srcXYZ: Float64Array;  // template (board-local cm)
    private dstXYZ: Float64Array;  // world (cm)
    private weights: Float64Array;

    // Hoisted scratch for extractCameraKeypoints — allocated once in start(),
    // sized to nCells (featW*featH). Keeping these as instance members
    // eliminates ~20KB/frame of GC pressure that was freezing the editor.
    private extCandIdx: Int32Array;
    private extCandScore: Float32Array;
    private extPairs: Float64Array;     // nCells * 2
    private extSuppressed: Uint8Array;

    // Hoisted RANSAC scratch. s3/d3 are fixed 9-element mini pair buffers,
    // masks are sized to topKCamera (matchCount upper bound).
    private ransacS3: Float64Array = new Float64Array(9);
    private ransacD3: Float64Array = new Float64Array(9);
    private ransacBestMask: Uint8Array;
    private ransacTmpMask: Uint8Array;

    // Staged pipeline: one stage per UpdateEvent tick so a single inference
    // never blocks the scripting thread long enough to trip LS's
    // InternalError: interrupted watchdog.
    //   0 IDLE  — waiting for next inferenceIntervalSec
    //   1 INFER — runImmediate + output capture
    //   2 EXTRACT — NMS + descriptor sampling
    //   3 MATCH   — cosine/Lowe matching against template
    //   4 LIFT    — pixel→world via DepthCache
    //   5 RANSAC  — budgeted ransacItersPerTick per tick
    //   6 REFIT   — weighted Kabsch on best inlier set
    private stage: number = 0;
    private stageDcId: number = -1;
    private stageGoodN: number = 0;
    private stageHeat: Float32Array | null = null;
    private stageDesc: Float32Array | null = null;
    private stageRansacDone: number = 0;
    private stageBestInliers: number = 0;

    // Latest accepted pose target (set by RANSAC).
    private targetValid: boolean = false;
    private targetR: Float64Array = new Float64Array(9);
    private targetT: Float64Array = new Float64Array(3);

    // Currently applied (smoothed) pose. Stored as quat + vec3 to avoid
    // re-orthogonalising every tick.
    private curValid: boolean = false;
    private curRot: quat = quat.quatIdentity();
    private curPos: vec3 = vec3.zero();

    // Stats.
    private framesRun: number = 0;
    private framesFit: number = 0;
    private lastInferMs: number = 0;
    private lastCamKps: number = 0;
    private lastMatches: number = 0;
    private lastInliers: number = 0;
    // Best cosine seen this frame across ALL template kpts (not just those
    // that survived the Lowe/threshold gate). Tells us whether matches=5
    // means "great descriptors but stingy gate" or "descriptors are weak".
    private lastBestCos: number = 0;
    // Number of template kpts whose top-cam cosine beat minCosine but were
    // then rejected by Lowe's ratio. Pair with lastBestCos to tune.
    private lastLoweReject: number = 0;
    private lastTickTime: number = 0;
    private lastLogTime: number = 0;

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => this.start());
        this.createEvent("UpdateEvent").bind(() => this.tick());
    }

    private start(): void {
        // ---- Resolve KiCadBoard host SceneObject -------------------------
        this.kb = this.kiCadBoard as any;
        if (this.kb && this.kb.sceneObject) {
            this.boardObj = this.kb.sceneObject;
        }
        if (this.boardObj === null) {
            print("[BFT] No KiCadBoard assigned — tracker idle");
            return;
        }

        // ---- DepthCache ---------------------------------------------------
        this.depthCacheRef = this.depthCache as any;
        if (this.depthCacheRef === null) {
            print("[BFT] No DepthCache assigned — tracker idle");
            return;
        }

        // ---- Load baked template -----------------------------------------
        if (!this.loadTemplate(this.boardSlug)) return;

        // ---- Allocate scratch buffers ------------------------------------
        var k = this.topKCamera;
        this.camKpCellX = new Int32Array(k);
        this.camKpCellY = new Int32Array(k);
        this.camKpScore = new Float32Array(k);
        this.camKpDesc = new Float32Array(k * this.tDescDim);

        var maxMatches = k;
        this.matchTIdx = new Int32Array(maxMatches);
        this.matchCIdx = new Int32Array(maxMatches);
        this.matchScore = new Float32Array(maxMatches);

        this.srcXYZ = new Float64Array(maxMatches * 3);
        this.dstXYZ = new Float64Array(maxMatches * 3);
        this.weights = new Float64Array(maxMatches);

        // Hoisted extract scratch — sized to the full heatmap cell grid so
        // extractCameraKeypoints never allocates inside the hot path.
        var nCells = this.tFeatW * this.tFeatH;
        this.extCandIdx = new Int32Array(nCells);
        this.extCandScore = new Float32Array(nCells);
        this.extPairs = new Float64Array(nCells * 2);
        this.extSuppressed = new Uint8Array(nCells);

        // Hoisted RANSAC masks — sized to max match count.
        this.ransacBestMask = new Uint8Array(maxMatches);
        this.ransacTmpMask = new Uint8Array(maxMatches);

        // ---- Wait for MLComponent to load --------------------------------
        if (this.mlComponent === null || this.mlComponent === undefined) {
            print("[BFT] No MLComponent assigned — tracker idle");
            return;
        }
        var self = this;
        // MLComponent.state is MachineLearning.ModelState — `Idle` means
        // "model is built and ready to run" (NOT a "no work" sense). If we
        // already see Idle on Start, fire onMlLoaded immediately; otherwise
        // bind onLoadingFinished and wait for the async load to finish.
        try {
            var stateNow: any = -1;
            try { stateNow = (this.mlComponent as any).state; } catch (e) {}
            print("[BFT] MLComponent initial state = " + stateNow
                + " (Idle=" + MachineLearning.ModelState.Idle + " means ready)");
            if (stateNow === MachineLearning.ModelState.Idle) {
                this.onMlLoaded();
            } else {
                this.mlComponent.onLoadingFinished = function() { self.onMlLoaded(); };
                // If the model never loads (e.g. no .onnx bound to the
                // MLComponent.Model field in the inspector), the callback
                // never fires and the tracker stays idle forever. Heartbeat
                // the state once a second until it goes Idle or 10s elapse.
                this.mlLoadDeadline = getTime() + 10;
            }
        } catch (e) {
            print("[BFT] MLComponent setup failed: " + (e as any).message);
        }
    }

    private loadTemplate(slug: string): boolean {
        try {
            // LensifyTS resolves require() paths statically. The template
            // module is auto-generated by tools/bake-board-template.mjs and
            // committed under boards/templates/<slug>.js — listing the slugs
            // here keeps the require strings static at compile time.
            var mod: any = null;
            if (slug === "xiao-servo") {
                mod = require("./boards/templates/xiao-servo.js");
            }
            if (mod === null) {
                print("[BFT] Unknown board slug for template: " + slug);
                return false;
            }
            this.template = mod.template;
        } catch (e) {
            print("[BFT] Failed to load template " + slug + ": " + (e as any).message);
            return false;
        }

        var t = this.template;
        this.tCount = t.K | 0;
        this.tDescDim = t.descDim | 0;
        this.tNetW = t.netW | 0;
        this.tNetH = t.netH | 0;
        this.tStride = t.stride | 0;
        this.tFeatW = (this.tNetW / this.tStride) | 0;
        this.tFeatH = (this.tNetH / this.tStride) | 0;
        this.tMode = t.mode || "stretch";

        // Repack descriptors + board-local positions into typed arrays for
        // fast access in the matcher hot loop.
        this.tDesc = new Float32Array(this.tCount * this.tDescDim);
        for (var i = 0; i < this.tCount * this.tDescDim; i++) {
            this.tDesc[i] = t.descriptors[i];
        }
        this.tBoardXYZ = new Float32Array(this.tCount * 3);
        for (var i = 0; i < this.tCount * 3; i++) {
            this.tBoardXYZ[i] = t.boardXYZ[i];
        }
        print("[BFT] Loaded template " + slug
            + " — " + this.tCount + " kpts, mode=" + this.tMode
            + ", net=" + this.tNetW + "x" + this.tNetH);
        return true;
    }

    private onMlLoaded(): void {
        // Sanity-check input/output names so we error visibly if the bound
        // ONNX is the wrong one. Also pin the descriptor_map output layout to
        // NCHW so the matcher hot loop's `c * H*W + h*W + w` indexing matches
        // the actual byte order LS hands back. Lens Studio defaults to NHWC,
        // which would silently scramble all 64 descriptor channels.
        try {
            var inputs = this.mlComponent.getInputs();
            var outputs = this.mlComponent.getOutputs();
            var inNames: string[] = [];
            for (var i = 0; i < inputs.length; i++) inNames.push(inputs[i].name);
            var outNames: string[] = [];
            for (var i = 0; i < outputs.length; i++) outNames.push(outputs[i].name);
            print("[BFT] ML loaded — inputs=[" + inNames.join(",") + "] outputs=[" + outNames.join(",") + "]");
            // Lock in the names if the model uses non-default ones.
            if (inNames.indexOf("image") < 0 && inNames.length > 0) this.inputName = inNames[0];
            if (outNames.indexOf("descriptor_map") < 0) {
                for (var i = 0; i < outNames.length; i++) {
                    if (outNames[i].indexOf("desc") >= 0) { this.outDescName = outNames[i]; break; }
                }
            }
            if (outNames.indexOf("heatmap") < 0) {
                for (var i = 0; i < outNames.length; i++) {
                    if (outNames[i].indexOf("heat") >= 0) { this.outHeatName = outNames[i]; break; }
                }
            }
            // Force NCHW on the descriptor output so the matcher hot loop's
            // indexing is correct. Heatmap is [1,1,60,80] so NCHW vs NHWC is
            // a no-op for it, but we set it anyway for symmetry.
            try {
                var descOut: any = this.mlComponent.getOutput(this.outDescName);
                descOut.dataLayout = MachineLearning.DataLayout.NCHW;
                var heatOut: any = this.mlComponent.getOutput(this.outHeatName);
                heatOut.dataLayout = MachineLearning.DataLayout.NCHW;
            } catch (e) {
                print("[BFT] couldn't set NCHW on outputs: " + (e as any).message);
            }
        } catch (e) {
            print("[BFT] ML inspect failed: " + (e as any).message);
        }
        this.mlReady = true;
    }

    private tick(): void {
        var now = getTime();
        // One-shot diagnostic: if MLComponent never reached Idle after the
        // deadline set in start(), the user almost certainly forgot to bind
        // a .onnx asset to the MLComponent.Model field. Log it once and
        // stop arming — we don't want to spam every frame.
        if (!this.mlReady && this.mlLoadDeadline > 0 && !this.mlLoadLogged
            && now > this.mlLoadDeadline) {
            var stateDbg: any = -1;
            try { stateDbg = (this.mlComponent as any).state; } catch (e) {}
            print("[BFT] MLComponent never reached Idle (state=" + stateDbg
                + ") — check that xfeat_backbone_simplified.onnx is bound "
                + "to MLComponent.Model in the inspector");
            this.mlLoadLogged = true;
        }
        if (this.mlReady && this.template !== null) {
            this.advanceStage(now);
        }
        this.applyPose();
        this.updateOverlay();
        this.maybeLog();
    }

    // -----------------------------------------------------------------------
    // HUD overlay — writes the same stats as maybeLog into an optional Text
    // component. Wire a Screen Text in the scene to the overlayText input and
    // the stats will render in the headset view on device. Safe no-op when
    // overlayText isn't assigned.
    // -----------------------------------------------------------------------
    private updateOverlay(): void {
        var t: any = this.overlayText;
        if (t === null || t === undefined) return;
        var line1 = "XFEAT runs=" + this.framesRun
            + "  infer=" + this.lastInferMs.toFixed(0) + "ms"
            + "  stage=" + this.stage;
        var line2 = "kps=" + this.lastCamKps
            + "  match=" + this.lastMatches
            + "  loweRej=" + this.lastLoweReject
            + "  inliers=" + this.lastInliers;
        var line3 = "bestCos=" + this.lastBestCos.toFixed(2)
            + "  fit=" + this.framesFit;
        var line4 = this.targetValid
            ? ("pose=" + this.targetT[0].toFixed(1)
               + "," + this.targetT[1].toFixed(1)
               + "," + this.targetT[2].toFixed(1) + " cm")
            : "no-pose";
        t.text = line1 + "\n" + line2 + "\n" + line3 + "\n" + line4;
    }

    // -----------------------------------------------------------------------
    // Staged pipeline advance — at most one stage per UpdateEvent tick. Keeps
    // every tick's script budget small enough that LS won't fire the
    // long-running-script watchdog and freeze the editor.
    // -----------------------------------------------------------------------
    private advanceStage(now: number): void {
        // Whole dispatch is wrapped in try/catch so a throw anywhere in the
        // pipeline can't permanently wedge the stage machine. Without this
        // an exception in (e.g.) extract or match would leave stage stuck
        // on 2/3 forever, the IDLE branch would never fire again, and
        // framesRun would freeze at whatever count it hit on the way up.
        try {
            if (this.stage === 0) {
                // IDLE — wait for the next inference interval, then kick off
                // stage 1 on the SAME tick (the inference runImmediate() is
                // the single biggest per-frame cost but there's nothing we
                // can split it into, so we pay it in full here).
                if (now - this.lastTickTime < this.inferenceIntervalSec) return;
                this.lastTickTime = now;
                if (!this.stageInfer()) { this.resetStage(); return; }
                this.stage = 2;
                return;
            }
            if (this.stage === 2) {
                this.stageExtract();
                if (this.camKpCount < this.minMatches) { this.resetStage(); return; }
                this.stage = 3;
                return;
            }
            if (this.stage === 3) {
                this.stageMatch();
                if (this.matchCount < this.minMatches) { this.resetStage(); return; }
                this.stage = 4;
                return;
            }
            if (this.stage === 4) {
                this.stageLift();
                if (this.stageGoodN < this.ransacMinInliers) { this.resetStage(); return; }
                // Reset RANSAC accumulator state for this pass.
                this.stageRansacDone = 0;
                this.stageBestInliers = 0;
                this.stage = 5;
                return;
            }
            if (this.stage === 5) {
                this.stageRansacChunk();
                if (this.stageRansacDone >= this.ransacIters) {
                    this.stage = 6;
                }
                return;
            }
            if (this.stage === 6) {
                this.stageRefit();
                this.resetStage();
                return;
            }
        } catch (e) {
            print("[BFT] stage " + this.stage + " threw: " + (e as any).message);
            this.resetStage();
        }
    }

    private resetStage(): void {
        if (this.stageDcId >= 0 && this.depthCacheRef !== null) {
            try { this.depthCacheRef.disposeDepthFrame(this.stageDcId); } catch (e) {}
            this.stageDcId = -1;
        }
        this.stageHeat = null;
        this.stageDesc = null;
        this.stage = 0;
    }

    // -----------------------------------------------------------------------
    // Stage 1 — INFER: freeze depth pair, bind texture, runImmediate,
    // capture output buffers. Returns false if anything fails so the stage
    // machine can reset.
    // -----------------------------------------------------------------------
    private stageInfer(): boolean {
        this.framesRun++;

        // No state guard here — MLComponent.state can bounce through
        // Running/Queued transitions after a previous runImmediate() even
        // once the model itself is fully built, and if Auto Run is enabled
        // on the inspector LS will be firing inference on its own in
        // parallel. mlReady (set from onLoadingFinished) is the honest
        // "model is built, safe to call" gate; rely on it alone.

        // Freeze a color/depth pair under a unique id. The id lives on
        // stageDcId across the rest of the pipeline and is disposed by
        // resetStage().
        var dcId = this.depthCacheRef.saveDepthFrame();
        var camTex: Texture | null = this.depthCacheRef.getCamImageWithID(dcId);
        if (camTex === null) {
            try { this.depthCacheRef.disposeDepthFrame(dcId); } catch (e) {}
            return false;
        }
        this.stageDcId = dcId;

        // First-frame setup: latch the cam resolution for cell→pixel mapping.
        if (this.camW === 0 || this.camH === 0) {
            try {
                this.camW = (camTex as any).getWidth();
                this.camH = (camTex as any).getHeight();
            } catch (e) {}
            if (this.camW <= 0 || this.camH <= 0) {
                // Fall back to colorDeviceCamera resolution from DepthCache.
                try {
                    var dev: any = (this.depthCacheRef as any).colorDeviceCamera;
                    if (dev && dev.resolution) {
                        this.camW = dev.resolution.x | 0;
                        this.camH = dev.resolution.y | 0;
                    }
                } catch (e2) {}
            }
            if (this.camW <= 0 || this.camH <= 0) return false;
            print("[BFT] Camera resolution latched: " + this.camW + "x" + this.camH);
        }

        // Bind the texture to the model and run inference synchronously.
        // runImmediate(true) waits for GPU completion so the output buffers
        // we read below are guaranteed to contain the current frame's
        // results. Passing false here is a silent footgun: the call returns
        // in ~0ms with stale/empty data and the pipeline stalls forever.
        //
        // Timing note: LS's getTime() does not advance inside a blocking
        // native call, which is why we were seeing infer=0.0ms even while
        // runImmediate(true) was holding the scripting thread for seconds.
        // Use Date.now() here — it's wall-clock and ticks regardless.
        var t0Ms = Date.now();
        try {
            (this.mlComponent.getInput(this.inputName) as any).texture = camTex;
            this.mlComponent.runImmediate(true);
        } catch (e) {
            print("[BFT] inference failed: " + (e as any).message);
            return false;
        }
        this.lastInferMs = Date.now() - t0Ms;

        // Capture output buffers. Stash on stage state so stage 2 (extract)
        // can consume them on the next tick.
        var heatOut: any = null, descOut: any = null;
        try {
            heatOut = this.mlComponent.getOutput(this.outHeatName);
            descOut = this.mlComponent.getOutput(this.outDescName);
        } catch (e) {
            print("[BFT] output read failed: " + (e as any).message);
            return false;
        }
        var heatData: Float32Array = heatOut.data;
        var descData: Float32Array = descOut.data;
        if (heatData === null || descData === null) {
            if (this.framesRun <= 1) print("[BFT] ML output buffers are null");
            return false;
        }
        if (heatData.length === 0 || descData.length === 0) {
            // Length 0 usually means runImmediate ran async and the GPU
            // hasn't produced output yet. Log once and bail — the next tick
            // will try again. If this shows up repeatedly, the waitOnGpu
            // flag isn't doing what we expect.
            if (this.framesRun <= 1) {
                print("[BFT] ML output buffers empty (heat=" + heatData.length
                    + " desc=" + descData.length + ")");
            }
            return false;
        }
        // Once-per-run diagnostic: dump the actual output tensor stats on a
        // handful of early frames so we can tell the difference between
        // "runImmediate is a no-op" and "runImmediate ran fine but the
        // model is producing near-zero reliability". Fires at frames 1, 50,
        // and 200 so we sample both cold and warm states without spamming.
        if (this.framesRun === 1 || this.framesRun === 50 || this.framesRun === 200) {
            var heatMax = -1e9;
            var heatMin = 1e9;
            var heatAbsSum = 0;
            var hn = heatData.length;
            for (var hi = 0; hi < hn; hi++) {
                var hv = heatData[hi];
                if (hv > heatMax) heatMax = hv;
                if (hv < heatMin) heatMin = hv;
                heatAbsSum += hv < 0 ? -hv : hv;
            }
            var descAbsSum = 0;
            var dn = descData.length;
            for (var di = 0; di < dn; di++) {
                var dv = descData[di];
                descAbsSum += dv < 0 ? -dv : dv;
            }
            var txW = -1, txH = -1;
            try { txW = (camTex as any).getWidth(); } catch (e) {}
            try { txH = (camTex as any).getHeight(); } catch (e) {}
            print("[BFT] diag run=" + this.framesRun
                + " tex=" + txW + "x" + txH
                + " inferMs=" + (Date.now() - t0Ms)
                + " heat[n=" + hn + " min=" + heatMin.toFixed(4)
                + " max=" + heatMax.toFixed(4)
                + " mean|·|=" + (heatAbsSum / Math.max(1, hn)).toFixed(4) + "]"
                + " desc[n=" + dn
                + " mean|·|=" + (descAbsSum / Math.max(1, dn)).toFixed(4) + "]");
        }
        this.stageHeat = heatData;
        this.stageDesc = descData;
        return true;
    }

    // -----------------------------------------------------------------------
    // Stage 2 — EXTRACT: NMS top-K on the heatmap + sample descriptors.
    // -----------------------------------------------------------------------
    private stageExtract(): void {
        var heat = this.stageHeat;
        var desc = this.stageDesc;
        if (heat === null || desc === null) {
            this.camKpCount = 0;
            return;
        }
        this.extractCameraKeypoints(heat, desc);
        this.lastCamKps = this.camKpCount;
    }

    // -----------------------------------------------------------------------
    // Stage 3 — MATCH: cosine + Lowe's ratio over the capped template.
    // -----------------------------------------------------------------------
    private stageMatch(): void {
        this.matchAgainstTemplate();
        this.lastMatches = this.matchCount;
    }

    // -----------------------------------------------------------------------
    // Stage 4 — LIFT: for each match, map the cam cell back to a pixel and
    // ask DepthCache for the world-space XYZ. Fills srcXYZ/dstXYZ/weights
    // and stashes the number of valid pairs in stageGoodN.
    // -----------------------------------------------------------------------
    private stageLift(): void {
        var goodN = 0;
        var dcId = this.stageDcId;
        for (var i = 0; i < this.matchCount; i++) {
            var ti = this.matchTIdx[i];
            var ci = this.matchCIdx[i];
            var cellX = this.camKpCellX[ci];
            var cellY = this.camKpCellY[ci];
            // Cell center → cam-frame pixel (stretch mode: each cell covers
            // camW/featW horizontally and camH/featH vertically).
            var camPxX = (cellX + 0.5) * this.camW / this.tFeatW;
            var camPxY = (cellY + 0.5) * this.camH / this.tFeatH;
            var world = this.depthCacheRef.getWorldPositionWithID(
                new vec2(camPxX, camPxY), dcId);
            if (world === null) continue;

            this.srcXYZ[goodN * 3]     = this.tBoardXYZ![ti * 3];
            this.srcXYZ[goodN * 3 + 1] = this.tBoardXYZ![ti * 3 + 1];
            this.srcXYZ[goodN * 3 + 2] = this.tBoardXYZ![ti * 3 + 2];
            this.dstXYZ[goodN * 3]     = world.x;
            this.dstXYZ[goodN * 3 + 1] = world.y;
            this.dstXYZ[goodN * 3 + 2] = world.z;
            this.weights[goodN] = this.matchScore[i];  // cosine sim weights inliers
            goodN++;
        }
        this.stageGoodN = goodN;
    }

    // -----------------------------------------------------------------------
    // Stage 6 — REFIT: weighted Kabsch on the best inlier set from RANSAC.
    // Updates targetR/targetT and bumps framesFit on success.
    // -----------------------------------------------------------------------
    private stageRefit(): void {
        var n = this.stageGoodN;
        this.lastInliers = this.stageBestInliers;
        if (this.stageBestInliers < this.ransacMinInliers) return;
        for (var p = 0; p < n; p++) {
            this.weights[p] = this.ransacBestMask[p] ? this.matchScore[p] : 0;
        }
        var refit = solveRigidAlignmentWeighted(this.srcXYZ, this.dstXYZ, this.weights, n);
        if (refit === null) return;

        for (var k = 0; k < 9; k++) this.targetR[k] = refit.R[k];
        this.targetT[0] = refit.t[0];
        this.targetT[1] = refit.t[1];
        this.targetT[2] = refit.t[2];
        this.framesFit++;
        this.targetValid = true;
    }

    // -----------------------------------------------------------------------
    // Keypoint extraction: cell-resolution NMS top-K on the heatmap. All
    // scratch buffers are hoisted to instance fields so this function never
    // allocates on the hot path (was the main GC stall in the old pipeline).
    // -----------------------------------------------------------------------
    private extractCameraKeypoints(heatData: Float32Array, descData: Float32Array): void {
        var fw = this.tFeatW;
        var fh = this.tFeatH;
        var nCells = fw * fh;

        // Pull all cells above MIN_RELIABILITY into a flat scoring array, then
        // partial-sort to get the top candidates.
        var candIdx = this.extCandIdx;
        var candScore = this.extCandScore;
        var nCands = 0;
        var minRel = this.minReliability;
        for (var i = 0; i < nCells; i++) {
            var s = heatData[i];
            if (s >= minRel) {
                candIdx[nCands] = i;
                candScore[nCands] = s;
                nCands++;
            }
        }
        if (nCands === 0) { this.camKpCount = 0; return; }

        // Sort descending by score. Paired array (score, idx) then partial
        // selection to the top-K.
        var pairs = this.extPairs;
        for (var i = 0; i < nCands; i++) {
            pairs[i * 2]     = candScore[i];
            pairs[i * 2 + 1] = candIdx[i];
        }
        // Bubble out a top-K via partial selection.
        var kCap = this.topKCamera;
        if (kCap > nCands) kCap = nCands;
        for (var sel = 0; sel < kCap; sel++) {
            var bestI = sel;
            var bestS = pairs[sel * 2];
            for (var j = sel + 1; j < nCands; j++) {
                var sj = pairs[j * 2];
                if (sj > bestS) { bestS = sj; bestI = j; }
            }
            if (bestI !== sel) {
                var ts = pairs[sel * 2];
                var ti = pairs[sel * 2 + 1];
                pairs[sel * 2]     = pairs[bestI * 2];
                pairs[sel * 2 + 1] = pairs[bestI * 2 + 1];
                pairs[bestI * 2]     = ts;
                pairs[bestI * 2 + 1] = ti;
            }
        }

        // Cell-radius NMS over the sorted top. Reuse hoisted suppressed
        // buffer — clear only the cells we touch.
        var suppressed = this.extSuppressed;
        for (var i = 0; i < nCells; i++) suppressed[i] = 0;
        var nmsR = this.nmsRadius;
        var accepted = 0;
        var descDim = this.tDescDim;
        for (var s = 0; s < kCap; s++) {
            if (accepted >= this.topKCamera) break;
            var idx = pairs[s * 2 + 1] | 0;
            if (suppressed[idx]) continue;
            var cy = (idx / fw) | 0;
            var cx = idx - cy * fw;
            this.camKpCellX[accepted] = cx;
            this.camKpCellY[accepted] = cy;
            this.camKpScore[accepted] = pairs[s * 2];

            // Sample + L2-normalize the 64-dim descriptor at this cell.
            // Layout: descData[c * fh * fw + cy * fw + cx]
            var ssq = 0;
            for (var c = 0; c < descDim; c++) {
                var v = descData[c * fh * fw + cy * fw + cx];
                this.camKpDesc[accepted * descDim + c] = v;
                ssq += v * v;
            }
            if (ssq > 1e-12) {
                var inv = 1.0 / Math.sqrt(ssq);
                for (var c = 0; c < descDim; c++) {
                    this.camKpDesc[accepted * descDim + c] *= inv;
                }
            }

            // Suppress neighbours.
            for (var dy = -nmsR; dy <= nmsR; dy++) {
                var ny = cy + dy;
                if (ny < 0 || ny >= fh) continue;
                for (var dx = -nmsR; dx <= nmsR; dx++) {
                    var nx = cx + dx;
                    if (nx < 0 || nx >= fw) continue;
                    suppressed[ny * fw + nx] = 1;
                }
            }
            accepted++;
        }
        this.camKpCount = accepted;
    }

    // -----------------------------------------------------------------------
    // Descriptor matching: for each TEMPLATE keypoint, scan all camera
    // keypoints, find the top-2 by cosine similarity, apply Lowe's ratio test
    // and the absolute minCosine threshold. Both descriptor sets are
    // L2-normalized so cosine similarity is just the dot product.
    //
    // tCount is capped by maxTemplateKpts so the O(nT*nC*dim) inner loop
    // stays bounded. With tCount=557, nC=256, dim=64 the uncapped cost is
    // ~9M multiply-adds per inference — enough to stall one UpdateEvent tick
    // on its own. Templates are baked roughly in reliability order, so
    // taking the first maxTemplateKpts still uses the strongest descriptors.
    // -----------------------------------------------------------------------
    private matchAgainstTemplate(): void {
        var nT = this.tCount;
        if (this.maxTemplateKpts > 0 && nT > this.maxTemplateKpts) {
            nT = this.maxTemplateKpts;
        }
        var nC = this.camKpCount;
        var dim = this.tDescDim;
        var tD = this.tDesc!;
        var cD = this.camKpDesc;
        var loweSq = this.loweRatio;
        var minCos = this.minCosine;

        var nm = 0;
        var globalBest = -1.0;  // best cosine seen across all template kpts
        var loweRejects = 0;    // beat minCos but killed by Lowe
        for (var ti = 0; ti < nT; ti++) {
            var tBase = ti * dim;
            var best = -1.0;
            var second = -1.0;
            var bestCi = -1;
            for (var ci = 0; ci < nC; ci++) {
                var cBase = ci * dim;
                var dot = 0;
                for (var k = 0; k < dim; k++) {
                    dot += tD[tBase + k] * cD[cBase + k];
                }
                if (dot > best) {
                    second = best;
                    best = dot;
                    bestCi = ci;
                } else if (dot > second) {
                    second = dot;
                }
            }
            if (best > globalBest) globalBest = best;
            if (bestCi < 0) continue;
            if (best < minCos) continue;
            // Lowe's ratio: best should be clearly above second-best. We use
            // (1 - best) < loweRatio * (1 - second) form so that best=1 always
            // passes regardless of second, which is more forgiving on
            // unique-feature templates.
            if (second > 0 && (1.0 - best) > loweSq * (1.0 - second)) {
                loweRejects++;
                continue;
            }

            this.matchTIdx[nm] = ti;
            this.matchCIdx[nm] = bestCi;
            this.matchScore[nm] = best;
            nm++;
        }
        this.matchCount = nm;
        this.lastBestCos = globalBest;
        this.lastLoweReject = loweRejects;
    }

    // -----------------------------------------------------------------------
    // RANSAC over (board_xyz, world_xyz) pairs, BUDGETED across ticks. Each
    // call runs up to ransacItersPerTick iterations, appending to the
    // accumulated best-inlier mask stored on stage state. Advances
    // stageRansacDone; stops when stageRansacDone >= ransacIters.
    //
    // Each iteration draws 3 correspondences, runs Kabsch on those, and
    // counts inliers within ransacInlierCm. Best hypothesis is then refit
    // on its inliers via the weighted Kabsch — that refit lives in
    // stageRefit() so this function never touches targetR/targetT.
    // -----------------------------------------------------------------------
    private stageRansacChunk(): void {
        var n = this.stageGoodN;
        var total = this.ransacIters;
        var budget = this.ransacItersPerTick > 0 ? this.ransacItersPerTick : total;
        var remaining = total - this.stageRansacDone;
        if (budget > remaining) budget = remaining;

        var thrSq = this.ransacInlierCm * this.ransacInlierCm;
        var s3 = this.ransacS3;
        var d3 = this.ransacD3;
        var bestMask = this.ransacBestMask;
        var tmpMask = this.ransacTmpMask;
        // First chunk of this RANSAC pass: wipe the previous pass's best mask
        // so stale inliers from a different frame's solve don't survive.
        if (this.stageRansacDone === 0) {
            for (var p0 = 0; p0 < n; p0++) bestMask[p0] = 0;
        }

        for (var it = 0; it < budget; it++) {
            var i0 = (Math.random() * n) | 0;
            var i1 = (Math.random() * n) | 0;
            var i2 = (Math.random() * n) | 0;
            if (i0 === i1 || i1 === i2 || i0 === i2) continue;

            for (var k = 0; k < 3; k++) {
                s3[k]     = this.srcXYZ[i0 * 3 + k];
                s3[3 + k] = this.srcXYZ[i1 * 3 + k];
                s3[6 + k] = this.srcXYZ[i2 * 3 + k];
                d3[k]     = this.dstXYZ[i0 * 3 + k];
                d3[3 + k] = this.dstXYZ[i1 * 3 + k];
                d3[6 + k] = this.dstXYZ[i2 * 3 + k];
            }
            var fit = solveRigidAlignmentWeighted(s3, d3, null, 3);
            if (fit === null) continue;

            // Count inliers.
            var R = fit.R, t = fit.t;
            var ins = 0;
            for (var p = 0; p < n; p++) {
                var sx = this.srcXYZ[p * 3];
                var sy = this.srcXYZ[p * 3 + 1];
                var sz = this.srcXYZ[p * 3 + 2];
                var px = R[0] * sx + R[1] * sy + R[2] * sz + t[0];
                var py = R[3] * sx + R[4] * sy + R[5] * sz + t[1];
                var pz = R[6] * sx + R[7] * sy + R[8] * sz + t[2];
                var ex = px - this.dstXYZ[p * 3];
                var ey = py - this.dstXYZ[p * 3 + 1];
                var ez = pz - this.dstXYZ[p * 3 + 2];
                var d2 = ex * ex + ey * ey + ez * ez;
                if (d2 < thrSq) {
                    tmpMask[p] = 1;
                    ins++;
                } else {
                    tmpMask[p] = 0;
                }
            }
            if (ins > this.stageBestInliers) {
                this.stageBestInliers = ins;
                for (var q = 0; q < n; q++) bestMask[q] = tmpMask[q];
            }
        }
        this.stageRansacDone += budget;
    }

    // -----------------------------------------------------------------------
    // Pose application: lerp the current rendered pose toward the latest
    // accepted target. Decoupled from runFrame so the visual feedback ticks
    // at the UpdateEvent rate (~30Hz) even though inference runs at 10Hz.
    // -----------------------------------------------------------------------
    private applyPose(): void {
        if (!this.targetValid) return;
        if (this.boardObj === null) return;

        // Convert R (row-major Float64Array) → mat3 → quat.
        var R = this.targetR;
        var rotMat = new mat3();
        rotMat.column0 = new vec3(R[0], R[3], R[6]);
        rotMat.column1 = new vec3(R[1], R[4], R[7]);
        rotMat.column2 = new vec3(R[2], R[5], R[8]);
        var targetQuat = quat.fromRotationMat(rotMat);
        var targetPos = new vec3(this.targetT[0], this.targetT[1], this.targetT[2]);

        var a = this.smoothingAlpha;
        if (a < 0) a = 0;
        if (a > 1) a = 1;

        if (!this.curValid) {
            this.curRot = targetQuat;
            this.curPos = targetPos;
            this.curValid = true;
        } else {
            this.curRot = quat.slerp(this.curRot, targetQuat, a);
            this.curPos = vec3.lerp(this.curPos, targetPos, a);
        }

        var t = this.boardObj.getTransform();
        t.setWorldPosition(this.curPos);
        t.setWorldRotation(this.curRot);
    }

    private maybeLog(): void {
        if (!this.debugLogging) return;
        var now = getTime();
        if (now - this.lastLogTime < 1.0) return;
        this.lastLogTime = now;
        print("[BFT] runs=" + this.framesRun
            + " fit=" + this.framesFit
            + " infer=" + this.lastInferMs.toFixed(0) + "ms"
            + " camKps=" + this.lastCamKps
            + " matches=" + this.lastMatches
            + " bestCos=" + this.lastBestCos.toFixed(2)
            + " loweRej=" + this.lastLoweReject
            + " inliers=" + this.lastInliers
            + " stage=" + this.stage
            + (this.targetValid
                ? " t=(" + this.targetT[0].toFixed(1)
                  + "," + this.targetT[1].toFixed(1)
                  + "," + this.targetT[2].toFixed(1) + ")"
                : " no-pose"));
    }
}
