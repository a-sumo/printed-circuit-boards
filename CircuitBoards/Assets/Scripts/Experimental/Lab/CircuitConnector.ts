// CircuitConnector.ts
// Waypoint-based circuit trace routing between two SceneObjects.
// All connections batched into one mesh. The TS computes 4 waypoints per
// connection (start, exit-end, approach-start, end) accounting for plane
// geometry, exit directions, and lane stagger. The shader (CircuitShader.js)
// just follows the waypoints with fillet arcs at the two turns.
//
// Exit directions are auto-detected from UV position: the nearest edge
// determines which direction the tube exits perpendicular to the plane.
//
// Setup in Lens Studio:
//   1. Create a Graph Material with CircuitShader.js code node
//   2. Add a Texture 2D Object Parameter named "connTex"
//   3. Wire transformedPosition -> Vertex Position, vertexColor -> Fragment Color
//   4. Attach this script, assign material + two target objects

@component
export class CircuitConnector extends BaseScriptComponent {

    @input
    @hint("Material with CircuitShader.js code node + connTex texture parameter")
    material: Material;

    @input
    @hint("Left/source panel")
    objectA: SceneObject;

    @input
    @hint("Right/target panel")
    objectB: SceneObject;

    @input
    @hint("UV points on mesh A: 'u,v|u,v|...' (0-1). Points on edge auto-detect exit dir.")
    pointsA: string = "1.0,0.8|1.0,0.5|1.0,0.2";

    @input
    @hint("UV points on mesh B: 'u,v|u,v|...'")
    pointsB: string = "0.0,0.8|0.0,0.5|0.0,0.2";

    @input
    @hint("Connection pairs: 'a-b|a-b|...' (indices into pointsA and pointsB)")
    pairs: string = "0-0|1-1|2-2";

    @input
    @hint("Width of mesh A in local units (cm)")
    widthA: number = 10;

    @input
    @hint("Height of mesh A in local units (cm)")
    heightA: number = 10;

    @input
    @hint("Width of mesh B in local units (cm)")
    widthB: number = 10;

    @input
    @hint("Height of mesh B in local units (cm)")
    heightB: number = 10;

    // ---- Runtime-safe params (change anytime, no mesh rebuild) ----

    @input
    @widget(new SliderWidget(0.01, 0.5, 0.01))
    @hint("Tube cross-section radius in cm")
    tubeRadius: number = 0.1;

    @input
    @widget(new SliderWidget(0.1, 10.0, 0.1))
    @hint("Corner fillet radius")
    bendRadius: number = 2.0;

    @input
    @widget(new SliderWidget(0.1, 5.0, 0.1))
    @hint("Depth spacing between lanes")
    laneSpacing: number = 0.5;

    @input
    @widget(new SliderWidget(0.0, 1.0, 0.05))
    @hint("How far tubes extend before turning (0 = auto, fraction of distance)")
    exitRatio: number = 0.0;

    @input
    @widget(new SliderWidget(0.0, 1.0, 0.01))
    @hint("Exit stub growth (horizontal arms from each panel)")
    exitGrowth: number = 1.0;

    @input
    @widget(new SliderWidget(0.0, 1.0, 0.01))
    @hint("Bridge growth (diagonal/curve connecting the exits)")
    bridgeGrowth: number = 1.0;

    // ---- Cold params (changing these requires rebuild via refresh()) ----

    @input
    @widget(new SliderWidget(16, 96, 4))
    @hint("Segments along each tube's length (rebuild required)")
    lengthSegments: number = 48;

    @input
    @widget(new SliderWidget(4, 16, 1))
    @hint("Segments around tube circumference (rebuild required)")
    radialSegments: number = 8;

    // Data texture: 8 pixels wide, MAX_CONNECTIONS rows.
    // Each row = 4 waypoints (W0..W3), packed as 16-bit fixed-point:
    //   Pixel 0: W0.x (RG), W0.y (BA)
    //   Pixel 1: W0.z (RG), W1.x (BA)
    //   Pixel 2: W1.y (RG), W1.z (BA)
    //   Pixel 3: W2.x (RG), W2.y (BA)
    //   Pixel 4: W2.z (RG), W3.x (BA)
    //   Pixel 5: W3.y (RG), W3.z (BA)
    //   Pixel 6: exitGrowth (RG), bridgeGrowth (BA)
    //   Pixel 7: unused

    private static readonly MAX_CONNECTIONS = 16;
    private static readonly TEX_WIDTH = 8;

    private mainPass: Pass;
    private meshVisual: RenderMeshVisual;
    private connTexProvider: ProceduralTextureProvider;
    private connPixels: Uint8Array;

    private ptsA: number[][] = [];
    private ptsB: number[][] = [];
    private connPairs: number[][] = [];
    private numConns: number = 0;

    // Per-connection zone growth values (0-1). Index = connection index.
    private connExitGrowth: number[] = new Array(CircuitConnector.MAX_CONNECTIONS).fill(1.0);
    private connBridgeGrowth: number[] = new Array(CircuitConnector.MAX_CONNECTIONS).fill(1.0);

    onAwake(): void {
        this.parseInputs();
        this.buildMesh();
        this.createDataTexture();
        if (this.material) {
            this.mainPass = this.material.mainPass;
        }
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    // ---- Parsing ----

    private parseInputs(): void {
        this.ptsA = this.parsePoints(this.pointsA);
        this.ptsB = this.parsePoints(this.pointsB);
        this.connPairs = this.parsePairs(this.pairs);
        this.numConns = Math.min(this.connPairs.length, CircuitConnector.MAX_CONNECTIONS);
        this.connPairs = this.connPairs.slice(0, this.numConns);
        print("CircuitConnector: " + this.numConns + " connections");
    }

    private parsePoints(str: string): number[][] {
        if (!str || str.trim() === "") return [];
        return str.split("|").map(p => {
            const parts = p.split(",").map(Number);
            return [parts[0] || 0, parts[1] || 0];
        });
    }

    private parsePairs(str: string): number[][] {
        if (!str || str.trim() === "") return [];
        return str.split("|").map(p => {
            const parts = p.split("-").map(Number);
            return [parts[0] || 0, parts[1] || 0];
        });
    }

    // ---- Geometry helpers ----

    private uvToLocal(u: number, v: number, w: number, h: number): vec3 {
        return new vec3((u - 0.5) * w, (v - 0.5) * h, 0);
    }

    // Auto-detect exit direction from UV position.
    // Finds the nearest edge and returns a local-space unit direction
    // pointing outward perpendicular to that edge.
    private detectExitDir(u: number, v: number): vec3 {
        const dLeft = u;
        const dRight = 1.0 - u;
        const dBottom = v;
        const dTop = 1.0 - v;
        const minDist = Math.min(dLeft, dRight, dBottom, dTop);

        if (minDist === dRight) return new vec3(1, 0, 0);
        if (minDist === dLeft)  return new vec3(-1, 0, 0);
        if (minDist === dTop)   return new vec3(0, 1, 0);
        return new vec3(0, -1, 0);
    }

    // ---- Mesh ----

    private buildMesh(): void {
        const mb = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
            { name: "texture1", components: 2 },
            { name: "texture2", components: 2 },
        ]);
        mb.topology = MeshTopology.Triangles;
        mb.indexType = MeshIndexType.UInt16;

        const segs = this.lengthSegments;
        const circ = this.radialSegments;

        for (let ci = 0; ci < this.numConns; ci++) {
            const colorSeed = this.numConns > 1 ? ci / (this.numConns - 1) : 0.5;
            this.appendTube(mb, ci, colorSeed, segs, circ);
        }

        mb.updateMesh();

        this.meshVisual = this.sceneObject.createComponent("Component.RenderMeshVisual");
        this.meshVisual.mesh = mb.getMesh();
        if (this.material) {
            this.meshVisual.mainMaterial = this.material;
        }

        const vertsPerTube = (segs + 1) * circ + 2;
        print("CircuitConnector: " + (vertsPerTube * this.numConns) + " vertices");
    }

    private appendTube(mb: MeshBuilder, connIdx: number, colorSeed: number, segs: number, circ: number): void {
        const base = mb.getVerticesCount();

        for (let i = 0; i <= segs; i++) {
            const t = i / segs;
            for (let j = 0; j < circ; j++) {
                const theta = (j / circ) * Math.PI * 2;
                mb.appendVerticesInterleaved([
                    0, 0, 0,  0, 0, 0,
                    Math.cos(theta), Math.sin(theta),
                    t, connIdx,
                    1.0, colorSeed,
                ]);
            }
        }

        for (let i = 0; i < segs; i++) {
            for (let j = 0; j < circ; j++) {
                const a = base + i * circ + j;
                const b = base + i * circ + (j + 1) % circ;
                const c = base + (i + 1) * circ + j;
                const d = base + (i + 1) * circ + (j + 1) % circ;
                mb.appendIndices([a, b, c, b, d, c]);
            }
        }

        const startCap = mb.getVerticesCount();
        mb.appendVerticesInterleaved([0,0,0, 0,0,0, 0,0, 0,connIdx, 0,colorSeed]);
        for (let j = 0; j < circ; j++) {
            mb.appendIndices([startCap, base + (j + 1) % circ, base + j]);
        }

        const endCap = mb.getVerticesCount();
        mb.appendVerticesInterleaved([0,0,0, 0,0,0, 0,0, 1,connIdx, 0,colorSeed]);
        const lastRing = base + segs * circ;
        for (let j = 0; j < circ; j++) {
            mb.appendIndices([endCap, lastRing + j, lastRing + (j + 1) % circ]);
        }
    }

    // ---- Data texture ----

    private createDataTexture(): void {
        const texW = CircuitConnector.TEX_WIDTH;
        const texH = CircuitConnector.MAX_CONNECTIONS;
        const tex = ProceduralTextureProvider.createWithFormat(texW, texH, TextureFormat.RGBA8Unorm);
        this.connTexProvider = tex.control as ProceduralTextureProvider;
        this.connPixels = new Uint8Array(texW * texH * 4);

        if (this.material) {
            this.material.mainPass["connTex"] = tex;
        }
    }

    private encode16(offset: number, value: number): void {
        const RANGE = 256.0;
        let n = (value + RANGE) / (2.0 * RANGE);
        if (n < 0) n = 0;
        if (n > 1) n = 1;
        const v = Math.round(n * 65535);
        this.connPixels[offset]     = (v >> 8) & 0xFF;
        this.connPixels[offset + 1] = v & 0xFF;
    }

    // Write 4 waypoints + per-connection zone growth into the data texture
    private writeWaypoints(connIdx: number, W0: vec3, W1: vec3, W2: vec3, W3: vec3, exitGrowth: number, bridgeGrowth: number): void {
        const row = connIdx * CircuitConnector.TEX_WIDTH * 4;
        // Pixel 0: W0.x, W0.y
        this.encode16(row + 0, W0.x);
        this.encode16(row + 2, W0.y);
        // Pixel 1: W0.z, W1.x
        this.encode16(row + 4, W0.z);
        this.encode16(row + 6, W1.x);
        // Pixel 2: W1.y, W1.z
        this.encode16(row + 8, W1.y);
        this.encode16(row + 10, W1.z);
        // Pixel 3: W2.x, W2.y
        this.encode16(row + 12, W2.x);
        this.encode16(row + 14, W2.y);
        // Pixel 4: W2.z, W3.x
        this.encode16(row + 16, W2.z);
        this.encode16(row + 18, W3.x);
        // Pixel 5: W3.y, W3.z
        this.encode16(row + 20, W3.y);
        this.encode16(row + 22, W3.z);
        // Pixel 6: exitGrowth (RG), bridgeGrowth (BA)
        this.encode16(row + 24, exitGrowth);
        this.encode16(row + 26, bridgeGrowth);
    }

    // ---- Frame update ----

    private onUpdate(): void {
        if (!this.mainPass || !this.objectA || !this.objectB) return;

        const invWorld = this.sceneObject.getTransform().getInvertedWorldTransform();
        const xfA = this.objectA.getTransform().getWorldTransform();
        const xfB = this.objectB.getTransform().getWorldTransform();

        // Pre-compute local-space positions and exit directions for all points
        const posA: vec3[] = [];
        const exitA: vec3[] = [];
        for (const pt of this.ptsA) {
            const worldPos = xfA.multiplyPoint(this.uvToLocal(pt[0], pt[1], this.widthA, this.heightA));
            posA.push(invWorld.multiplyPoint(worldPos));
            const localDir = this.detectExitDir(pt[0], pt[1]);
            const worldDir = xfA.multiplyDirection(localDir);
            const len = worldDir.length;
            const normDir = len > 0.001 ? worldDir.uniformScale(1 / len) : new vec3(1, 0, 0);
            exitA.push(invWorld.multiplyDirection(normDir).normalize());
        }

        const posB: vec3[] = [];
        const exitB: vec3[] = [];
        for (const pt of this.ptsB) {
            const worldPos = xfB.multiplyPoint(this.uvToLocal(pt[0], pt[1], this.widthB, this.heightB));
            posB.push(invWorld.multiplyPoint(worldPos));
            const localDir = this.detectExitDir(pt[0], pt[1]);
            const worldDir = xfB.multiplyDirection(localDir);
            const len = worldDir.length;
            const normDir = len > 0.001 ? worldDir.uniformScale(1 / len) : new vec3(-1, 0, 0);
            exitB.push(invWorld.multiplyDirection(normDir).normalize());
        }

        // Global sorting axis (perpendicular to the line between mesh centers)
        const centerA = invWorld.multiplyPoint(this.objectA.getTransform().getWorldPosition());
        const centerB = invWorld.multiplyPoint(this.objectB.getTransform().getWorldPosition());
        const mainAxis = centerB.sub(centerA);
        const mainLen = mainAxis.length;
        const mainDir = mainLen > 0.001 ? mainAxis.uniformScale(1 / mainLen) : new vec3(1, 0, 0);

        let sortAxis = new vec3(0, 1, 0);
        if (Math.abs(mainDir.dot(sortAxis)) > 0.9) sortAxis = new vec3(0, 0, 1);
        sortAxis = sortAxis.sub(mainDir.uniformScale(sortAxis.dot(mainDir)));
        const sLen = sortAxis.length;
        if (sLen > 0.001) sortAxis = sortAxis.uniformScale(1 / sLen);

        // Global lane shift direction (perpendicular to both mainDir and sortAxis)
        let laneDir = mainDir.cross(sortAxis);
        const lLen = laneDir.length;
        if (lLen > 0.001) laneDir = laneDir.uniformScale(1 / lLen);
        else laneDir = new vec3(0, 0, 1);

        // Sort connections by barycenter position along sortAxis
        const sorted: { ci: number; key: number }[] = [];
        for (let i = 0; i < this.numConns; i++) {
            const pair = this.connPairs[i];
            const pA = posA[pair[0]];
            const pB = posB[pair[1]];
            sorted.push({ ci: i, key: (pA.dot(sortAxis) + pB.dot(sortAxis)) * 0.5 });
        }
        sorted.sort((a, b) => a.key - b.key);

        // Compute waypoints for each connection
        const halfSpan = (this.numConns - 1) * 0.5;

        for (let lane = 0; lane < this.numConns; lane++) {
            const ci = sorted[lane].ci;
            const pair = this.connPairs[ci];

            const pA = posA[pair[0]];
            const dA = exitA[pair[0]];
            const pB = posB[pair[1]];
            const dB = exitB[pair[1]];

            // Distance between endpoints
            const dist = pA.sub(pB).length;

            // Exit length: how far tubes extend before turning
            const ratio = this.exitRatio > 0.001 ? this.exitRatio : 0.3;
            const exitLen = dist * ratio;

            // 4 waypoints
            const W0 = pA;
            let W1 = pA.add(dA.uniformScale(exitLen));
            let W2 = pB.add(dB.uniformScale(exitLen));
            const W3 = pB;

            // Apply lane offset: shift the middle waypoints along laneDir
            const laneOffset = (lane - halfSpan) * this.laneSpacing;
            if (Math.abs(laneOffset) > 0.001) {
                const shift = laneDir.uniformScale(laneOffset);
                W1 = W1.add(shift);
                W2 = W2.add(shift);
            }

            const eg = Math.min(this.exitGrowth, this.connExitGrowth[ci]);
            const bg = Math.min(this.bridgeGrowth, this.connBridgeGrowth[ci]);
            this.writeWaypoints(ci, W0, W1, W2, W3, eg, bg);
        }

        this.connTexProvider.setPixels(
            0, 0,
            CircuitConnector.TEX_WIDTH,
            CircuitConnector.MAX_CONNECTIONS,
            this.connPixels
        );

        this.mainPass.TubeRadius = this.tubeRadius;
        this.mainPass.BendRadius = this.bendRadius;
        this.mainPass.NumConnections = CircuitConnector.MAX_CONNECTIONS;
        this.mainPass.Growth = Math.max(this.exitGrowth, this.bridgeGrowth);
    }

    // ---- Public API ----

    // Rebuild mesh (only needed after changing lengthSegments, radialSegments,
    // or connection topology). Runtime params like tubeRadius, bendRadius,
    // laneSpacing, exitRatio, growth take effect immediately without this.
    public refresh(): void {
        if (this.meshVisual) {
            this.meshVisual.destroy();
        }
        this.parseInputs();
        this.buildMesh();
    }

    // Set exit stub growth for a single connection.
    public setConnectionExitGrowth(connIdx: number, value: number): void {
        if (connIdx >= 0 && connIdx < CircuitConnector.MAX_CONNECTIONS) {
            this.connExitGrowth[connIdx] = Math.max(0, Math.min(1, value));
        }
    }

    // Set bridge growth for a single connection.
    public setConnectionBridgeGrowth(connIdx: number, value: number): void {
        if (connIdx >= 0 && connIdx < CircuitConnector.MAX_CONNECTIONS) {
            this.connBridgeGrowth[connIdx] = Math.max(0, Math.min(1, value));
        }
    }

    // Set both zones for a single connection.
    public setConnectionGrowth(connIdx: number, exit: number, bridge: number): void {
        this.setConnectionExitGrowth(connIdx, exit);
        this.setConnectionBridgeGrowth(connIdx, bridge);
    }

    // Set all connections' exit growth at once.
    public setAllExitGrowth(value: number): void {
        const v = Math.max(0, Math.min(1, value));
        for (let i = 0; i < CircuitConnector.MAX_CONNECTIONS; i++) this.connExitGrowth[i] = v;
    }

    // Set all connections' bridge growth at once.
    public setAllBridgeGrowth(value: number): void {
        const v = Math.max(0, Math.min(1, value));
        for (let i = 0; i < CircuitConnector.MAX_CONNECTIONS; i++) this.connBridgeGrowth[i] = v;
    }

    // Set both zones for all connections.
    public setAllGrowth(exit: number, bridge: number): void {
        this.setAllExitGrowth(exit);
        this.setAllBridgeGrowth(bridge);
    }
}
