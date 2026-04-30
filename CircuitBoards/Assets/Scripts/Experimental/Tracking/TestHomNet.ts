// TestHomNet.ts
// Minimal test: verify HomographyNet-lite ONNX runs in LS FastDNN.
//
// Setup:
//   1. Import homnet_lite_rgb.onnx via File > Import Asset
//   2. Add an MLComponent to any SceneObject
//   3. Bind the imported ML asset to the MLComponent
//   4. Configure input "input" with Shape 128x128, bind any texture
//   5. Configure output "offsets" with Shape 8x1x1
//   6. Attach this script, wire mlComponent
//   7. Hit Play — check Logger for "[HomNet]" messages
//
// If the model runs, you'll see offset values printed.
// If it freezes (like XFeat did), LS will hang on runImmediate.

@component
export class TestHomNet extends BaseScriptComponent {

    @input
    @hint("MLComponent with homnet_lite_rgb.onnx bound")
    mlComponent: MLComponent;

    private frameCount: number = 0;
    private hasRun: boolean = false;

    onAwake(): void {
        print("[HomNet] TestHomNet initialized");
        if (!this.mlComponent) {
            print("[HomNet] ERROR: mlComponent not bound");
            return;
        }
        this.createEvent("UpdateEvent").bind(() => this.onUpdate());
    }

    private onUpdate(): void {
        this.frameCount++;

        // Wait a few frames for textures to initialize
        if (this.frameCount < 5) return;
        if (this.hasRun) return;

        this.hasRun = true;
        print("[HomNet] Running inference...");

        var t0 = getTime();
        try {
            this.mlComponent.runImmediate(false);
        } catch (e) {
            print("[HomNet] ERROR: runImmediate failed: " + e);
            return;
        }
        var dt = (getTime() - t0) * 1000;
        print("[HomNet] Inference OK in " + dt.toFixed(1) + "ms");

        // Read output
        var output = this.mlComponent.getOutput("offsets");
        if (!output) {
            print("[HomNet] WARNING: no output 'offsets'");
            // Try without name
            return;
        }

        var data = output.data;
        if (!data) {
            print("[HomNet] WARNING: output.data is null");
            return;
        }

        var vals: string[] = [];
        for (var i = 0; i < Math.min(data.length, 8); i++) {
            vals.push(data[i].toFixed(4));
        }
        print("[HomNet] Output (" + data.length + " values): [" + vals.join(", ") + "]");
        print("[HomNet] TEST PASSED - model runs in FastDNN");
    }
}
