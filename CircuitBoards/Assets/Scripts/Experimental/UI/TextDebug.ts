// TextDebug.ts - Debug: spawn 26 text elements (A-Z) in a row.
// Attach to any SceneObject. Tests if Component.Text renders in LS.

@component
export class TextDebug extends BaseScriptComponent {

    @input
    labelFont: Font;

    @input
    @widget(new SliderWidget(1, 20, 1))
    spacing: number = 5;

    @input
    @widget(new SliderWidget(1, 50, 1))
    textSize: number = 8;

    onAwake(): void {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const cols = 13; // 2 rows of 13
        let created = 0;

        for (let i = 0; i < alphabet.length; i++) {
            const letter = alphabet[i];
            const col = i % cols;
            const row = Math.floor(i / cols);

            const obj = global.scene.createSceneObject("__dbg_" + letter);
            obj.setParent(this.sceneObject);
            obj.layer = this.sceneObject.layer;
            obj.getTransform().setLocalPosition(
                new vec3(col * this.spacing, -row * this.spacing, 0)
            );

            try {
                const text = obj.createComponent("Component.Text") as Text;
                text.depthTest = false;
                text.renderOrder = 200;

                if (this.labelFont) {
                    (text as any).font = this.labelFont;
                }
                text.size = this.textSize;
                text.horizontalAlignment = HorizontalAlignment.Center;
                text.verticalAlignment = VerticalAlignment.Center;
                text.textFill.color = new vec4(0.94, 0.94, 0.91, 1.0);

                const outline = text.outlineSettings;
                outline.enabled = true;
                outline.size = 0.2;
                outline.fill.color = new vec4(0, 0, 0, 1);

                text.text = letter;
                created++;
            } catch (e: any) {
                print("[TextDebug] Failed at " + letter + " (#" + i + "): " + e.message);
                break;
            }
        }

        print("[TextDebug] Created " + created + "/26 text elements");
    }
}
