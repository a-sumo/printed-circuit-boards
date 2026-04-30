// TronFrame.ts
// Procedural corner bracket frame around a target plane.
// 4 corners x 3 orthogonal arms = 12 geo-tube segments in a single mesh.
// Short arms = corner accent brackets (Tron HUD style).
// Full-length arms = wireframe bounding cage.
//
// Setup in Lens Studio:
//   1. Create a Graph Material
//   2. Add a Code node, set source to TronFrameShader.js
//   3. Add a Texture 2D Object Parameter named "frameTex", wire to code node input
//   4. Wire transformedPosition -> Vertex Position output
//   5. Wire vertexColor -> Fragment Color output
//   6. Attach this script to a SceneObject, assign material + target panel
//   7. Adjust arm lengths in Inspector

@component
export class TronFrame extends BaseScriptComponent {

    @input
    @hint("Material with TronFrameShader.js code node + frameTex texture parameter")
    material: Material;

    @input
    @hint("Target plane/panel SceneObject to wrap corners around")
    target: SceneObject;

    @input
    @widget(new SliderWidget(0, 1, 0.05))
    @hint("How far horizontal arms extend (0 = none, 0.5 = half edge, 1 = full edge)")
    armX: number = 0.2;

    @input
    @widget(new SliderWidget(0, 1, 0.05))
    @hint("How far vertical arms extend (0 = none, 0.5 = half edge, 1 = full edge)")
    armY: number = 0.2;

    @input
    @widget(new SliderWidget(0, 1, 0.05))
    @hint("Depth arm as fraction of average edge length (0 = flat, 1 = cube-like)")
    armZ: number = 0.15;

    @input
    @widget(new SliderWidget(0.01, 0.3, 0.01))
    @hint("Tube cross-section radius in cm")
    tubeRadius: number = 0.05;

    @input
    @widget(new SliderWidget(0.0, 5.0, 0.1))
    @hint("Offset from panel surface along normal (cm). Prevents z-fighting.")
    surfaceOffset: number = 0.1;

    @input
    @widget(new SliderWidget(8, 32, 4))
    @hint("Segments along each tube's length")
    lengthSegments: number = 12;

    @input
    @widget(new SliderWidget(3, 12, 1))
    @hint("Segments around tube circumference")
    radialSegments: number = 6;

    @input
    @widget(new SliderWidget(0.0, 1.0, 0.01))
    @hint("Extrusion growth (0 = hidden, 1 = fully visible). Animate for extrusion effect.")
    growth: number = 1.0;

    private static readonly MAX_SEGMENTS = 16;
    private static readonly TEX_WIDTH = 4;
    private static readonly NUM_ARMS = 12;

    private mainPass: Pass;
    private meshVisual: RenderMeshVisual;
    private texProvider: ProceduralTextureProvider;
    private pixels: Uint8Array;
    private initialized: boolean = false;
    private debugDone: boolean = false;

    // Per-segment growth values (0-1). Index = segIdx (0..11).
    // Layout: 4 corners x 3 arms (X, Y, Z per corner).
    // Segments: [BL-X, BL-Y, BL-Z, BR-X, BR-Y, BR-Z, TR-X, TR-Y, TR-Z, TL-X, TL-Y, TL-Z]
    private segGrowth: number[] = new Array(TronFrame.NUM_ARMS).fill(1.0);

    // Cached from target mesh AABB
    private aabbMin: vec3 = vec3.zero();
    private aabbMax: vec3 = vec3.zero();
    private edgeW: number = 0;
    private edgeH: number = 0;

    onAwake(): void {
        this.buildMesh();
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    private ensureInit(): boolean {
        if (this.initialized) return true;
        if (!this.material || !this.target) return false;

        this.mainPass = this.material.mainPass;
        this.meshVisual.mainMaterial = this.material;
        this.createDataTexture();

        // Read target mesh AABB
        const rmv = this.target.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
        if (rmv && rmv.mesh) {
            this.aabbMin = rmv.mesh.aabbMin;
            this.aabbMax = rmv.mesh.aabbMax;
        } else {
            // Fallback: unit quad
            this.aabbMin = new vec3(-0.5, -0.5, 0);
            this.aabbMax = new vec3(0.5, 0.5, 0);
        }
        this.edgeW = this.aabbMax.x - this.aabbMin.x;
        this.edgeH = this.aabbMax.y - this.aabbMin.y;

        this.initialized = true;
        print("TronFrame: initialized, target=" + this.target.name +
              " aabb=(" + this.aabbMin.x.toFixed(2) + "," + this.aabbMin.y.toFixed(2) + ")-(" +
              this.aabbMax.x.toFixed(2) + "," + this.aabbMax.y.toFixed(2) + ")" +
              " edge=" + this.edgeW.toFixed(2) + "x" + this.edgeH.toFixed(2) +
              " arms=" + this.armX + "," + this.armY + "," + this.armZ);
        return true;
    }

    // ---- Mesh building ----

    private buildMesh(): void {
        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 }, // cross-section (localX, localY)
            { name: "texture1", components: 2 }, // (t, segmentIndex)
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;

        for (let si = 0; si < TronFrame.NUM_ARMS; si++) {
            this.appendTube(mb, si);
        }

        mb.updateMesh();

        this.meshVisual = this.sceneObject.createComponent("Component.RenderMeshVisual");
        this.meshVisual.mesh = mb.getMesh();
        if (this.material) {
            this.meshVisual.mainMaterial = this.material;
        }

        const vertsPerTube = (this.lengthSegments + 1) * this.radialSegments + 2;
        print("TronFrame: mesh built, " + (vertsPerTube * TronFrame.NUM_ARMS) + " vertices, " +
              TronFrame.NUM_ARMS + " tube segments");
    }

    private appendTube(mb: MeshBuilder, segIdx: number): void {
        const segs = this.lengthSegments;
        const circ = this.radialSegments;
        const base = mb.getVerticesCount();

        // Tube body: (segs+1) rings x circ vertices
        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            for (let j = 0; j < circ; j++) {
                const theta = (j / circ) * Math.PI * 2;
                mb.appendVerticesInterleaved([
                    0, 0, 0,                          // position (shader computes)
                    0, 0, 0,                          // normal (shader computes)
                    Math.cos(theta), Math.sin(theta), // texture0: cross-section
                    t, segIdx,                        // texture1: t along tube, segment ID
                ]);
            }
        }

        // Connect adjacent rings with triangles
        for (let i = 0; i < segs; i++) {
            for (let j = 0; j < circ; j++) {
                const a = base + i * circ + j;
                const b = base + i * circ + (j + 1) % circ;
                const c = base + (i + 1) * circ + j;
                const d = base + (i + 1) * circ + (j + 1) % circ;
                mb.appendIndices([a, b, c, b, d, c]);
            }
        }

        // Start cap (t=0)
        const startCap = mb.getVerticesCount();
        mb.appendVerticesInterleaved([
            0, 0, 0, 0, 0, 0,
            0, 0,       // cross-section center
            0, segIdx,  // t=0
        ]);
        for (let j = 0; j < circ; j++) {
            mb.appendIndices([startCap, base + (j + 1) % circ, base + j]);
        }

        // End cap (t=1)
        const endCap = mb.getVerticesCount();
        mb.appendVerticesInterleaved([
            0, 0, 0, 0, 0, 0,
            0, 0,       // cross-section center
            1, segIdx,  // t=1
        ]);
        const lastRing = base + segs * circ;
        for (let j = 0; j < circ; j++) {
            mb.appendIndices([endCap, lastRing + j, lastRing + (j + 1) % circ]);
        }
    }

    // ---- Data texture ----

    private createDataTexture(): void {
        const texW = TronFrame.TEX_WIDTH;
        const texH = TronFrame.MAX_SEGMENTS;
        const tex = ProceduralTextureProvider.createWithFormat(texW, texH, TextureFormat.RGBA8Unorm);
        this.texProvider = tex.control as ProceduralTextureProvider;
        this.pixels = new Uint8Array(texW * texH * 4);

        if (this.material) {
            this.material.mainPass["frameTex"] = tex;
        }
    }

    private encode16(offset: number, value: number): void {
        const RANGE = 256.0;
        let n = (value + RANGE) / (2.0 * RANGE);
        if (n < 0) n = 0;
        if (n > 1) n = 1;
        const v = Math.round(n * 65535);
        this.pixels[offset] = (v >> 8) & 0xFF;
        this.pixels[offset + 1] = v & 0xFF;
    }

    private writeSegment(segIdx: number, start: vec3, end: vec3, segGrowth: number): void {
        const row = segIdx * TronFrame.TEX_WIDTH * 4;
        this.encode16(row + 0, start.x);
        this.encode16(row + 2, start.y);
        this.encode16(row + 4, start.z);
        this.encode16(row + 6, end.x);
        this.encode16(row + 8, end.y);
        this.encode16(row + 10, end.z);
        // Pixel 3: per-segment growth (RG = 16-bit, range [-256,256], we use 0-1 mapped in)
        this.encode16(row + 12, segGrowth);
    }

    // ---- Frame update ----

    private onUpdate(): void {
        if (!this.ensureInit()) return;

        const invWorld = this.sceneObject.getTransform().getInvertedWorldTransform();
        const targetWorld = this.target.getTransform().getWorldTransform();

        const bMin = this.aabbMin;
        const bMax = this.aabbMax;
        const off = this.surfaceOffset;

        // Absolute arm lengths from fractions
        const lenX = this.armX * this.edgeW;
        const lenY = this.armY * this.edgeH;
        const avgEdge = (this.edgeW + this.edgeH) * 0.5;
        const lenZ = this.armZ * avgEdge;

        // 4 corners from mesh AABB, offset along +Z
        // Corner order: BL, BR, TR, TL
        const corners: vec3[] = [
            new vec3(bMin.x, bMin.y, bMax.z + off),
            new vec3(bMax.x, bMin.y, bMax.z + off),
            new vec3(bMax.x, bMax.y, bMax.z + off),
            new vec3(bMin.x, bMax.y, bMax.z + off),
        ];

        // Arm directions per corner (inward along edges + backward in depth)
        const armDirs: vec3[][] = [
            [new vec3( 1, 0, 0), new vec3(0,  1, 0), new vec3(0, 0, -1)],
            [new vec3(-1, 0, 0), new vec3(0,  1, 0), new vec3(0, 0, -1)],
            [new vec3(-1, 0, 0), new vec3(0, -1, 0), new vec3(0, 0, -1)],
            [new vec3( 1, 0, 0), new vec3(0, -1, 0), new vec3(0, 0, -1)],
        ];

        const armLens = [lenX, lenY, lenZ];

        let segIdx = 0;
        let debugOnce = !this.debugDone;
        for (let ci = 0; ci < 4; ci++) {
            for (let ai = 0; ai < 3; ai++) {
                const len = armLens[ai];

                if (len < 0.001) {
                    this.writeSegment(segIdx, vec3.zero(), vec3.zero(), 0);
                    segIdx++;
                    continue;
                }

                const cornerLocal = corners[ci];
                const endLocal = cornerLocal.add(armDirs[ci][ai].uniformScale(len));

                const cornerWorld = targetWorld.multiplyPoint(cornerLocal);
                const endWorld = targetWorld.multiplyPoint(endLocal);

                let startSelf = invWorld.multiplyPoint(cornerWorld);
                const endSelf = invWorld.multiplyPoint(endWorld);

                // Extend tube past corner by tubeRadius in rendering space
                const armDir = endSelf.sub(startSelf);
                const armLen = armDir.length;
                if (armLen > 0.001) {
                    startSelf = startSelf.sub(armDir.uniformScale(this.tubeRadius / armLen));
                }

                if (debugOnce && ci === 0) {
                    print("TronFrame seg" + segIdx + " c" + ci + "a" + ai +
                          " start=(" + startSelf.x.toFixed(2) + "," + startSelf.y.toFixed(2) + "," + startSelf.z.toFixed(2) + ")" +
                          " end=(" + endSelf.x.toFixed(2) + "," + endSelf.y.toFixed(2) + "," + endSelf.z.toFixed(2) + ")");
                }

                const g = Math.min(this.growth, this.segGrowth[segIdx]);
                this.writeSegment(segIdx, startSelf, endSelf, g);
                segIdx++;
            }
        }
        this.debugDone = true;

        this.texProvider.setPixels(
            0, 0,
            TronFrame.TEX_WIDTH,
            TronFrame.MAX_SEGMENTS,
            this.pixels
        );

        this.mainPass.TubeRadius = this.tubeRadius;
        this.mainPass.NumSegments = TronFrame.MAX_SEGMENTS;
        this.mainPass.Growth = this.growth;
    }

    // ---- Public API: per-segment growth ----

    // Set growth for a single segment (0-11).
    // Segment layout: 4 corners x 3 arms (X, Y, Z).
    // [0-2] BL corner, [3-5] BR, [6-8] TR, [9-11] TL.
    public setSegmentGrowth(segIdx: number, value: number): void {
        if (segIdx >= 0 && segIdx < TronFrame.NUM_ARMS) {
            this.segGrowth[segIdx] = Math.max(0, Math.min(1, value));
        }
    }

    // Set growth for all 3 arms of a corner (0=BL, 1=BR, 2=TR, 3=TL).
    public setCornerGrowth(corner: number, value: number): void {
        const base = corner * 3;
        const v = Math.max(0, Math.min(1, value));
        for (let i = 0; i < 3; i++) this.segGrowth[base + i] = v;
    }

    // Set growth for all segments at once.
    public setAllGrowth(value: number): void {
        const v = Math.max(0, Math.min(1, value));
        for (let i = 0; i < TronFrame.NUM_ARMS; i++) this.segGrowth[i] = v;
    }

    // Get per-segment growth array (copy).
    public getSegmentGrowths(): number[] {
        return this.segGrowth.slice();
    }
}
