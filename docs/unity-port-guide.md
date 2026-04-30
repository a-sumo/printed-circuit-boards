# How to Implement This in Unity

This guide translates the full KiCad-to-3D pipeline from Lens Studio (TypeScript, MeshBuilder, shader graph Code Nodes) to Unity (C#, Mesh API, ShaderLab/HLSL). The architecture maps cleanly because both engines use the same core concepts: procedural mesh generation, data textures, and custom shaders.

## 1. Project Structure

```
Assets/
  KiCad/
    Scripts/
      KiCadConverter.cs        // Offline: .kicad_pcb -> ScriptableObject
      KiCadBoard.cs            // Runtime: builds meshes from board data
      KiCadBoardData.cs        // ScriptableObject holding parsed board JSON
    Shaders/
      KiCadTraceShader.shader  // Trace rendering (growth, flow, vivid/realistic)
      KiCadBoardShader.shader  // Board substrate (reveal, PBR inference)
    Materials/
      KiCadTrace.mat
      KiCadBoard.mat
    Editor/
      KiCadImporter.cs         // AssetPostprocessor for .kicad_pcb drag-and-drop
```

## 2. Converter: Node.js to C# ScriptableObject

The S-expression parser and extractor run as an Editor script. Two options:

### Option A: Keep Node.js converter, import JSON

Use our `kicad-to-json.mjs` converter as-is. In Unity Editor, run it via `System.Diagnostics.Process`:

```csharp
// Editor/KiCadImporter.cs
[MenuItem("KiCad/Import PCB")]
static void ImportPCB() {
    string pcbPath = EditorUtility.OpenFilePanel("Select .kicad_pcb", "", "kicad_pcb");
    var proc = new Process();
    proc.StartInfo.FileName = "node";
    proc.StartInfo.Arguments = $"converters/kicad-to-json-cli.mjs \"{pcbPath}\"";
    proc.StartInfo.RedirectStandardOutput = true;
    proc.Start();
    string json = proc.StandardOutput.ReadToEnd();
    proc.WaitForExit();

    var board = ScriptableObject.CreateInstance<KiCadBoardData>();
    board.ParseFromJson(json);
    AssetDatabase.CreateAsset(board, "Assets/KiCad/Boards/MyBoard.asset");
}
```

### Option B: Port the S-expression parser to C#

The parser is ~100 lines. Port `tokenize()` and `parse()` directly:

```csharp
// KiCadSExprParser.cs
public static List<object> Parse(string input) {
    var tokens = Tokenize(input);
    int pos = 0;
    return ReadExpr(tokens, ref pos);
}

static List<string> Tokenize(string input) {
    var tokens = new List<string>();
    int i = 0;
    while (i < input.Length) {
        char ch = input[i];
        if (ch == '(' || ch == ')') { tokens.Add(ch.ToString()); i++; }
        else if (ch == '"') {
            var sb = new StringBuilder();
            i++;
            while (i < input.Length && input[i] != '"') {
                if (input[i] == '\\' && i + 1 < input.Length) { sb.Append(input[++i]); }
                else { sb.Append(input[i]); }
                i++;
            }
            i++; // closing quote
            tokens.Add(sb.ToString());
        }
        else if (char.IsWhiteSpace(ch)) { i++; }
        else {
            var sb = new StringBuilder();
            while (i < input.Length && "() \t\n\r".IndexOf(input[i]) < 0) {
                sb.Append(input[i]); i++;
            }
            tokens.Add(sb.ToString());
        }
    }
    return tokens;
}
```

The extraction functions (`extractSegments`, `extractZones`, etc.) map 1:1 from JS to C#. Use `List<>` instead of JS arrays, `Dictionary<>` instead of Maps.

For zone triangulation, use **LibTessDotNet** (NuGet) or Unity's built-in `UnityEngine.Rendering.Universal.LibTessDotNet` in URP, or the **Earcut.Net** port.

### ScriptableObject Data Format

```csharp
[CreateAssetMenu]
public class KiCadBoardData : ScriptableObject {
    public int version = 2;

    [System.Serializable]
    public struct Segment {
        public int id;
        public Vector2 start, end;
        public float width;
        public string layer;
        public int net;
    }

    [System.Serializable]
    public struct Arc {
        public int id;
        public Vector2 start, mid, end, center;
        public float radius, startAngle, endAngle, width;
        public string layer;
        public int net;
    }

    [System.Serializable]
    public struct ZoneFill {
        public string layer;
        public Vector2[] points;
        public int[] triangles; // pre-triangulated
        public int net;
    }

    [System.Serializable]
    public struct Via {
        public Vector2 pos;
        public float size, drill;
        public int net;
        public string[] layers;
    }

    public Vector2[] outline;
    public float thickness = 1.6f;
    public Segment[] segments;
    public Arc[] arcs;
    public Via[] vias;
    public ZoneFill[] zoneFills;
    // Serialize nets via parallel arrays since Dictionary isn't serializable
    public int[] netIds;
    public string[] netNames;
    public int[][] segmentOrder; // per layer
}
```

## 3. Mesh Generation: MeshBuilder to Unity Mesh API

The Lens Studio `MeshBuilder` maps directly to Unity's `Mesh` class. Key differences:

| Lens Studio | Unity |
|------------|-------|
| `mb.appendVerticesInterleaved([x,y,z, nx,ny,nz, u0,v0, u1,v1])` | Separate `vertices[]`, `normals[]`, `uv[]`, `uv2[]` arrays |
| `mb.appendIndices([a,b,c])` | `mesh.SetTriangles(int[])` |
| `mb.updateMesh(); mb.getMesh()` | `mesh.SetVertices(); mesh.SetNormals(); mesh.SetUVs(); mesh.SetTriangles(); mesh.RecalculateBounds()` |
| `MeshTopology.Triangles` | `MeshTopology.Triangles` (same) |
| `MeshIndexType.UInt16` | `mesh.indexFormat = IndexFormat.UInt16` (or UInt32 for >65K verts) |

### Per-Segment Round Cap Mesh (exact translation)

```csharp
// KiCadBoard.cs
void BuildSegmentsV2(KiCadBoardData board) {
    const int CAP_SEGS = 6;

    // Precompute cap angle table
    float[] capCos = new float[CAP_SEGS + 1];
    float[] capSin = new float[CAP_SEGS + 1];
    for (int i = 0; i <= CAP_SEGS; i++) {
        float angle = Mathf.PI * i / CAP_SEGS;
        capCos[i] = Mathf.Cos(angle);
        capSin[i] = Mathf.Sin(angle);
    }

    // Group segments by layer
    var segsByLayer = new Dictionary<string, List<KiCadBoardData.Segment>>();
    foreach (var seg in board.segments) {
        if (!segsByLayer.ContainsKey(seg.layer))
            segsByLayer[seg.layer] = new List<KiCadBoardData.Segment>();
        segsByLayer[seg.layer].Add(seg);
    }

    foreach (var kvp in segsByLayer) {
        string layer = kvp.Key;
        var items = kvp.Value;
        float z = GetLayerZ(layer, board.thickness);
        float nz = layer == "F.Cu" ? 1f : -1f;

        var verts = new List<Vector3>();
        var normals = new List<Vector3>();
        var uv0 = new List<Vector2>();   // (t, segIdx)
        var uv1 = new List<Vector2>();   // (crossSection, 0)
        var indices = new List<int>();

        for (int ti = 0; ti < items.Count; ti++) {
            var seg = items[ti];
            Vector2 a = ToWorldXY(seg.start); // KiCad mm -> Unity world
            Vector2 b = ToWorldXY(seg.end);
            float hw = seg.width * 0.5f * scaleFactor;

            Vector2 d = (b - a).normalized;
            Vector2 perp = new Vector2(-d.y, d.x);

            int base0 = verts.Count;
            Vector3 norm = new Vector3(0, 0, nz);

            // Body: 4 verts
            AddVert(a + perp * hw, z, norm, 0, ti, 1, verts, normals, uv0, uv1);
            AddVert(a - perp * hw, z, norm, 0, ti, -1, verts, normals, uv0, uv1);
            AddVert(b + perp * hw, z, norm, 1, ti, 1, verts, normals, uv0, uv1);
            AddVert(b - perp * hw, z, norm, 1, ti, -1, verts, normals, uv0, uv1);
            indices.AddRange(new[] { base0, base0+1, base0+3, base0, base0+3, base0+2 });

            // Start cap (semicircle facing backward)
            int capBase = verts.Count;
            AddVert(a, z, norm, 0, ti, 0, verts, normals, uv0, uv1); // center
            for (int ci = 0; ci <= CAP_SEGS; ci++) {
                float rx = perp.x * capCos[ci] - (-d.x) * capSin[ci];
                float ry = perp.y * capCos[ci] - (-d.y) * capSin[ci];
                float cross = ci <= CAP_SEGS/2
                    ? 1f - 2f * ci / CAP_SEGS
                    : -1f + 2f * (ci - CAP_SEGS/2f) / (CAP_SEGS/2f);
                AddVert(a + new Vector2(rx, ry) * hw, z, norm, 0, ti, cross,
                        verts, normals, uv0, uv1);
            }
            for (int ci = 0; ci < CAP_SEGS; ci++)
                indices.AddRange(new[] { capBase, capBase+1+ci, capBase+2+ci });

            // End cap (semicircle facing forward)
            int capBase2 = verts.Count;
            AddVert(b, z, norm, 1, ti, 0, verts, normals, uv0, uv1);
            for (int ci = 0; ci <= CAP_SEGS; ci++) {
                float rx = perp.x * capCos[ci] - d.x * capSin[ci];
                float ry = perp.y * capCos[ci] - d.y * capSin[ci];
                float cross = ci <= CAP_SEGS/2
                    ? 1f - 2f * ci / CAP_SEGS
                    : -1f + 2f * (ci - CAP_SEGS/2f) / (CAP_SEGS/2f);
                AddVert(b + new Vector2(rx, ry) * hw, z, norm, 1, ti, cross,
                        verts, normals, uv0, uv1);
            }
            for (int ci = 0; ci < CAP_SEGS; ci++)
                indices.AddRange(new[] { capBase2, capBase2+1+ci, capBase2+2+ci });
        }

        var mesh = new Mesh();
        mesh.indexFormat = verts.Count > 65535
            ? IndexFormat.UInt32 : IndexFormat.UInt16;
        mesh.SetVertices(verts);
        mesh.SetNormals(normals);
        mesh.SetUVs(0, uv0);
        mesh.SetUVs(1, uv1);
        mesh.SetTriangles(indices, 0);
        mesh.RecalculateBounds();

        var go = new GameObject($"Traces_{layer}");
        go.transform.SetParent(transform);
        var mf = go.AddComponent<MeshFilter>();
        mf.mesh = mesh;
        var mr = go.AddComponent<MeshRenderer>();
        mr.material = CreateTraceMaterial(layer, items.Count);
    }
}

void AddVert(Vector2 xy, float z, Vector3 norm, float t, int idx,
             float cross, List<Vector3> v, List<Vector3> n,
             List<Vector2> u0, List<Vector2> u1) {
    v.Add(new Vector3(xy.x, xy.y, z));
    n.Add(norm);
    u0.Add(new Vector2(t, idx));
    u1.Add(new Vector2(cross, 0));
}
```

## 4. Data Texture: ProceduralTextureProvider to Texture2D

Lens Studio uses `ProceduralTextureProvider.createWithFormat(2, 4096, RGBA8Unorm)` with `setPixels()` for partial updates. Unity equivalent:

```csharp
// Per-layer data texture (2x4096 RGBA8)
Texture2D CreateDataTexture(int maxTraces) {
    var tex = new Texture2D(2, maxTraces, TextureFormat.RGBA32, false);
    tex.filterMode = FilterMode.Point; // no interpolation
    tex.wrapMode = TextureWrapMode.Clamp;
    return tex;
}

// 16-bit encode (same algorithm as JS)
void Encode16(byte[] pixels, int offset, float value) {
    int v = Mathf.RoundToInt(Mathf.Clamp01(value) * 65535f);
    pixels[offset] = (byte)((v >> 8) & 0xFF);
    pixels[offset + 1] = (byte)(v & 0xFF);
}

// Write growth + hue per trace row
void WriteTraceData(Texture2D tex, byte[] pixels, int traceIdx,
                    float growth, float hue) {
    int row = traceIdx * 4; // 4 bytes per row in column 0
    Encode16(pixels, row, growth);
    Encode16(pixels, row + 2, hue);
}

// Partial upload (dirty range only)
void FlushDirtyRows(Texture2D tex, byte[] pixels, int minRow, int maxRow) {
    // Unity doesn't have partial upload for Texture2D.
    // Options:
    //   1. tex.SetPixelData(pixels) + tex.Apply() -- full upload, simple
    //   2. Use ComputeBuffer + StructuredBuffer in shader -- GPU-side, fast
    //   3. Use Texture2D.SetPixels32 on dirty range + Apply(false)
    tex.SetPixelData(pixels, 0);
    tex.Apply(false); // false = don't recalculate mipmaps
}
```

**Better approach for Unity**: Use a `ComputeBuffer` or `GraphicsBuffer` instead of a texture. Upload growth/hue as a `StructuredBuffer<float4>` and sample it in the shader via `StructuredBuffer`. This avoids texture upload overhead entirely:

```csharp
ComputeBuffer traceDataBuffer = new ComputeBuffer(maxTraces, sizeof(float) * 4);
// Each float4: (growth, hue, arcLen, cumOffset)
Vector4[] traceData = new Vector4[maxTraces];
traceData[idx] = new Vector4(growth, hue, 0, 0);
traceDataBuffer.SetData(traceData);
material.SetBuffer("_TraceData", traceDataBuffer);
```

## 5. Shader: Code Node GLSL to ShaderLab HLSL

The Lens Studio Code Node vertex shader maps to a custom vertex/fragment shader in Unity. Key translation:

| Lens Studio (Code Node) | Unity (ShaderLab) |
|------------------------|-------------------|
| `input_texture_2d traceTex` | `sampler2D _TraceTex` or `StructuredBuffer<float4> _TraceData` |
| `input_float NumTraces` | `float _NumTraces` (material property) |
| `input_float flowTime` | `float _FlowTime` |
| `input_float realisticMode` | `float _RealisticMode` |
| `system.getSurfacePosition()` | `v.vertex` (in vertex), `i.worldPos` (in fragment) |
| `system.getSurfaceUVCoord0()` | `v.texcoord` / `i.uv0` |
| `traceTex.sampleLod(uv, 0.0)` | `tex2Dlod(_TraceTex, float4(uv, 0, 0))` |
| `output_vec4 vertexColor` | `o.color = float4(...)` (pass to fragment) |
| `transformedPosition = pos` | Standard vertex transform |

### Complete Trace Shader

```hlsl
Shader "KiCad/TraceShader" {
    Properties {
        _TraceTex ("Trace Data", 2D) = "white" {}
        _NumTraces ("Num Traces", Float) = 4096
        _FlowTime ("Flow Time", Float) = 0
        _FlowSpeed ("Flow Speed", Float) = 1.5
        _FlowIntensity ("Flow Intensity", Float) = 0.4
        _RealisticMode ("Realistic", Range(0,1)) = 0
    }

    SubShader {
        Tags { "RenderType"="Transparent" "Queue"="Transparent" }
        Blend One OneMinusSrcAlpha // premultiplied alpha

        Pass {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _TraceTex;
            float _NumTraces, _FlowTime, _FlowSpeed, _FlowIntensity, _RealisticMode;

            struct appdata {
                float4 vertex : POSITION;
                float3 normal : NORMAL;
                float2 uv0 : TEXCOORD0;  // (t, traceIdx)
                float2 uv1 : TEXCOORD1;  // (crossSection, 0)
            };

            struct v2f {
                float4 pos : SV_POSITION;
                float4 color : COLOR;
                float3 worldNormal : TEXCOORD2;
            };

            float decode16(float hi, float lo) {
                return (hi * 255.0 * 256.0 + lo * 255.0) / 65535.0;
            }

            float3 hsv2rgb(float h, float s, float v) {
                float3 c = saturate(abs(frac(float3(h, h+2.0/3.0, h+1.0/3.0))*6.0-3.0)-1.0);
                return v * lerp(1.0, c, s);
            }

            v2f vert(appdata v) {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.worldNormal = UnityObjectToWorldNormal(v.normal);

                float edgeCross = abs(v.uv1.x);
                float edgeAlpha = 1.0 - smoothstep(0.6, 1.0, edgeCross);

                float t = v.uv0.x;
                float traceIdx = floor(v.uv0.y + 0.5);
                float texV = (traceIdx + 0.5) / max(_NumTraces, 1.0);

                float4 tex0 = tex2Dlod(_TraceTex, float4(0.25, texV, 0, 0));
                float growth = decode16(tex0.r, tex0.g);
                float hue = decode16(tex0.b, tex0.a);

                float visible = step(t, growth + 0.001);
                float growthFade = smoothstep(0.0, 0.02, growth);
                float alpha = visible * growthFade * edgeAlpha;

                float isGrowing = 1.0 - step(0.99, growth);
                float r = saturate(_RealisticMode);

                float3 vividColor = hsv2rgb(hue, 0.9, 0.9);
                float warm = 0.03 * sin(hue * 6.28);
                float3 copperColor = float3(0.82+warm, 0.50+warm*0.5, 0.28);
                float3 color = lerp(vividColor, copperColor, r);

                // Tip glow + arrival pulse
                float tipGlow = (1.0 - smoothstep(growth-0.15, growth, t)) * isGrowing;
                float3 tipColor = lerp(float3(1,0.92,0.7), float3(0.98,0.78,0.55), r);
                color = lerp(color, tipColor, isGrowing*(1-tipGlow)*lerp(0.5,0.4,r));
                color += color * exp(-(growth-t)*15.0) * isGrowing * lerp(0.3,0.2,r);

                // Signal flow
                if (_FlowTime > 0.001 && growth > 0.98) {
                    float spd = max(_FlowSpeed, 0.1);
                    float phase = frac(t * 3.0 - _FlowTime * spd * 0.3);
                    float dist = abs(phase - 0.5) * 2.0;
                    float core = exp(-dist*dist*40.0);
                    float halo = exp(-dist*dist*8.0) * 0.3;
                    float bright = (core + halo) * max(_FlowIntensity, 0.1);
                    float3 flowCol = lerp(float3(0.35,0.65,1), float3(0.7,0.85,1), core);
                    color = lerp(color, flowCol, bright * 0.85);
                }

                color *= alpha;
                color = max(color, 0.04) * alpha; // additive display guard
                o.color = float4(color, alpha);
                return o;
            }

            float4 frag(v2f i) : SV_Target {
                return i.color;
            }
            ENDHLSL
        }
    }
}
```

**For URP/HDRP**: Use Shader Graph with a Custom Function node. Paste the vertex logic into the custom function. Wire `UV0`, `UV1`, and a `Texture2D` input. Output `BaseColor` and `Alpha`.

## 6. Animation System

Growth animation in Unity uses `Update()` instead of Lens Studio's `createEvent("UpdateEvent")`:

```csharp
void Update() {
    if (!animActive) return;

    animCursor += Time.deltaTime * segmentsPerSecond;
    var order = segmentOrder[currentLayer];

    for (int i = 0; i < order.Length; i++) {
        float g = i < Mathf.FloorToInt(animCursor) ? 1f
                : i == Mathf.FloorToInt(animCursor) ? animCursor % 1f
                : 0f;
        traceData[order[i]].x = g; // growth component
    }

    traceDataBuffer.SetData(traceData);

    // Advance flow timer
    if (signalFlowEnabled) {
        flowTimer += Time.deltaTime;
        traceMaterial.SetFloat("_FlowTime", flowTimer);
    }
}
```

## 7. Zone Rendering

Zones are simple: the converter already provides pre-triangulated vertex arrays. In Unity:

```csharp
void BuildZones(KiCadBoardData board) {
    foreach (var fill in board.zoneFills) {
        float z = GetLayerZ(fill.layer, board.thickness);
        var mesh = new Mesh();
        var verts = new Vector3[fill.points.Length];
        for (int i = 0; i < fill.points.Length; i++)
            verts[i] = new Vector3(
                (fill.points[i].x - cx) * scaleFactor,
                -(fill.points[i].y - cy) * scaleFactor,
                z * scaleFactor);
        mesh.vertices = verts;
        mesh.triangles = fill.triangles; // already computed by converter
        mesh.RecalculateNormals();
        mesh.RecalculateBounds();

        var go = new GameObject($"Zone_{fill.layer}_{fill.net}");
        go.transform.SetParent(transform);
        go.AddComponent<MeshFilter>().mesh = mesh;
        go.AddComponent<MeshRenderer>().material = boardMaterial;
    }
}
```

## 8. Explode View

Unity makes this simpler with `Transform`:

```csharp
void ApplyExplode(float progress) {
    float sp = explodeSpread * progress;
    // Board core stays at 0
    boardGroup.localPosition = Vector3.zero;
    // Copper layers
    foreach (var trace in traceGroups) {
        bool isBack = trace.name.Contains("B.Cu");
        trace.localPosition = new Vector3(0, 0, sp * (isBack ? -1 : 1));
    }
    // Solder masks
    topMask.localPosition = new Vector3(0, 0, sp * 2);
    botMask.localPosition = new Vector3(0, 0, sp * -2);
    // Silkscreen
    foreach (var label in labelGroups)
        label.localPosition = new Vector3(0, 0, sp * 3);
    // Zones follow copper
    foreach (var zone in zoneGroups) {
        bool isBack = zone.name.Contains("B.Cu");
        zone.localPosition = new Vector3(0, 0, sp * (isBack ? -1 : 1));
    }
}
```

## 9. Key Differences Summary

| Aspect | Lens Studio | Unity |
|--------|------------|-------|
| Mesh API | `MeshBuilder` (interleaved) | `Mesh` (separate arrays) |
| Texture upload | `ProceduralTextureProvider.setPixels()` (partial) | `Texture2D.Apply()` (full) or `ComputeBuffer` |
| Shader language | GLSL (Code Node) | HLSL (ShaderLab or Shader Graph) |
| Scene hierarchy | `SceneObject.createSceneObject()` | `new GameObject()` |
| Material clone | `material.clone()` | `new Material(material)` |
| Frame budget | `getTime()` + manual budget | `Time.realtimeSinceStartup` or Coroutines |
| Chunked build | UpdateEvent state machine | `IEnumerator` coroutine with `yield return null` |
| AR display | Additive (black=transparent) | Depends on platform (passthrough, additive) |
| Index format | UInt16 only (63K limit) | UInt16 or UInt32 (no limit) |
| Async | Not supported (frame-distributed) | Coroutines, async/await, Jobs |

## 10. Performance Notes for Unity

1. **Use `Mesh.SetVertices(NativeArray<>)`** instead of `Vector3[]` for zero-copy upload from Jobs.
2. **Use `GraphicsBuffer`** instead of `Texture2D` for per-trace data (faster random access in shader).
3. **Use `BatchRendererGroup`** or **GPU instancing** if you have many boards.
4. **Use Jobs + Burst** for mesh generation (the per-segment loop is embarrassingly parallel).
5. **UInt32 indices** let you skip the 63K vertex batching entirely.
6. **Coroutines** replace the manual frame-budget state machine for chunked builds:

```csharp
IEnumerator BuildSegmentsCoroutine() {
    int count = 0;
    foreach (var seg in segments) {
        BuildOneSegment(seg);
        if (++count % 50 == 0) yield return null; // yield every 50 segments
    }
    FinalizeAllMeshes();
}
```

## 11. Coordinate System Mapping

| KiCad | Lens Studio | Unity |
|-------|------------|-------|
| mm, Y-down | cm, Y-up | m (or cm), Y-up |
| Origin: top-left | Centered on board | Centered on board |
| Z: layer stack (mm) | Z: layer stack (cm) | Z or Y: layer stack |

Transform function:

```csharp
// KiCad mm -> Unity world (centered, Y-flipped, scaled)
Vector3 ToWorld(float kx, float ky, float kz) {
    return new Vector3(
        (kx - cx) * scaleFactor,
        -(ky - cy) * scaleFactor, // flip Y
        kz * scaleFactor
    );
}
```

Unity convention typically uses Y-up with Z-forward, so you may prefer mapping KiCad's Z-stack to Unity's Y axis instead. Adjust the explode view axis accordingly.

## 12. V2 JSON Format Reference

The converter outputs this structure (all fields available for Unity import):

```json
{
  "version": 2,
  "board": {
    "outline": [[x,y], ...],
    "thickness": 1.6,
    "layers": [{ "ordinal": 0, "name": "F.Cu", "type": "signal" }, ...],
    "setup": { "stackup": [...], "copperFinish": "..." },
    "titleBlock": { "title": "...", "rev": "...", "company": "...", "date": "..." }
  },
  "nets": { "0": "", "1": "GND", ... },
  "netClasses": [{ "name": "Default", "clearance": 0.2, "traceWidth": 0.25, ... }],
  "segments": [{ "id": 0, "start": [x,y], "end": [x,y], "width": 0.25, "layer": "F.Cu", "net": 1 }],
  "arcs": [{ "id": 100, "start": [x,y], "mid": [x,y], "end": [x,y], "width": 0.25, "layer": "F.Cu", "net": 1, "center": [cx,cy], "radius": r, "startAngle": a0, "endAngle": a1 }],
  "vias": [{ "pos": [x,y], "size": 0.8, "drill": 0.4, "net": 1, "layers": ["F.Cu","B.Cu"] }],
  "footprints": [{ "name": "R_0402", "ref": "R1", "value": "10k", "pos": [x,y], "rot": 0, "layer": "F.Cu", "pads": [...], "graphics": [...], "texts": [...], "models": [...] }],
  "zones": [{ "net": 1, "netName": "GND", "layer": "F.Cu", "outline": [...], "filledPolygons": [{ "layer": "F.Cu", "points": [[x,y],...], "triangles": [i0,i1,i2,...] }] }],
  "drawings": [{ "type": "line|circle|arc|rect|poly|text", "layer": "F.SilkS", "width": 0.12, ... }],
  "segmentOrder": { "F.Cu": [segId0, segId1, ...], "B.Cu": [...] },
  "simulation": { "elements": [...], "groundNets": [...] }
}
```
