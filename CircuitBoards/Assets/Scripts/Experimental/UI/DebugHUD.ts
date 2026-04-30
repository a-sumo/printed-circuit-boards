// DebugHUD.ts
// Live hand keypoint logger. Wire telemetryText to a child Text in the scene.

import { SIK } from "SpectaclesInteractionKit.lspkg/SIK";

@component
export class DebugHUD extends BaseScriptComponent {
    @input @allowUndefined
    @hint("Text component for telemetry display (child of this SceneObject)")
    telemetryText: Text;

    private rightHand: any = null;
    private leftHand: any = null;
    private frameCount: number = 0;
    private initDone: boolean = false;

    onAwake(): void {
        this.createEvent("OnStartEvent").bind(() => {
            this.initHands();
        });

        this.createEvent("UpdateEvent").bind(() => {
            this.tick();
        });
    }

    private initHands(): void {
        try {
            this.rightHand = SIK.HandInputData.getHand("right");
            this.leftHand = SIK.HandInputData.getHand("left");
            this.initDone = true;
            print("[DebugHUD] Hands acquired: R=" + !!this.rightHand + " L=" + !!this.leftHand);
        } catch (e) {
            print("[DebugHUD] Hand init failed: " + e);
            if (this.telemetryText) {
                this.telemetryText.text = "Hand init failed: " + e;
            }
        }
    }

    private tick(): void {
        if (!this.telemetryText) return;
        this.frameCount++;
        if (this.frameCount % 5 !== 0) return;

        if (!this.initDone) {
            this.telemetryText.text = "Waiting for SIK init...";
            return;
        }

        var lines: string[] = [];
        lines.push("f:" + this.frameCount);

        this.logHand(lines, "R", this.rightHand);
        this.logHand(lines, "L", this.leftHand);

        this.telemetryText.text = lines.join("\n");
    }

    private logHand(lines: string[], label: string, hand: any): void {
        if (!hand) {
            lines.push(label + ": null");
            return;
        }

        var tracked = false;
        try { tracked = hand.isTracked(); } catch {}

        if (!tracked) {
            lines.push(label + ": not tracked");
            return;
        }

        lines.push(label + ": TRACKED");

        // Key joints via optional chaining
        var thumbTip = hand.thumbTip;
        var indexTip = hand.indexTip;
        var middleTip = hand.middleTip;
        var ringTip = hand.ringTip;
        var pinkyTip = hand.pinkyTip;
        var wrist = hand.wrist;

        var joints: any[][] = [
            ["wrist", wrist],
            ["thumb", thumbTip],
            ["index", indexTip],
            ["mid", middleTip],
            ["ring", ringTip],
            ["pinky", pinkyTip],
        ];

        for (var ji = 0; ji < joints.length; ji++) {
            var name = joints[ji][0] as string;
            var joint = joints[ji][1] as any;
            if (!joint) {
                lines.push("  " + name + ": null");
                continue;
            }
            var pos = joint.position;
            if (!pos) {
                lines.push("  " + name + ": no pos");
                continue;
            }
            lines.push("  " + name + ": " + pos.x.toFixed(1) + "," + pos.y.toFixed(1) + "," + pos.z.toFixed(1));
        }
    }
}
