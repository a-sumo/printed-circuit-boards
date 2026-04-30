// CircuitShader.js
// General-purpose 4-waypoint tube router with fillet arcs.
//
// The TS component computes 4 waypoints per connection (W0..W3) that
// encode the full route: start, exit-end, approach-start, end.
// This shader just follows the waypoints with smooth fillet arcs at
// the two corners (W1 and W2).
//
// 5 segments: W0->W1 (straight), arc at W1, W1->W2 (straight),
//             arc at W2, W2->W3 (straight)
//
// Turn angles and arc planes are computed from the waypoint geometry,
// so any arrangement of exit/entry directions works (Manhattan, diagonal,
// L-bend, S-curve, etc).
//
// Zone-based growth extrusion (inspired by Vector Fields pattern):
//   Exit A  [0, b1]       : horizontal stub from panel A, grows forward
//   Bridge  [b1, b4]      : diagonal/curve connecting exits, grows forward
//   Exit B  [b4, totalLen] : horizontal stub from panel B, grows backward
//   Each zone has independent growth (0-1) from the data texture.
//   Global Growth uniform acts as master ceiling on all zones.
//
// Vertex encoding (from CircuitConnector.ts):
//   texture0 = (localX, localY) unit circle cross-section
//   texture1 = (t, connectionIndex) parameter + ID
//   texture2 = (isTube, colorSeed) 1=body / 0=cap, hue seed
//
// Data texture (connTex, 8xN RGBA8, 16-bit fixed-point [-256,256]):
//   Row = connectionIndex. Each row stores 4 waypoints + growth:
//   Pixel 0: W0.x (RG), W0.y (BA)
//   Pixel 1: W0.z (RG), W1.x (BA)
//   Pixel 2: W1.y (RG), W1.z (BA)
//   Pixel 3: W2.x (RG), W2.y (BA)
//   Pixel 4: W2.z (RG), W3.x (BA)
//   Pixel 5: W3.y (RG), W3.z (BA)
//   Pixel 6: exitGrowth (RG), bridgeGrowth (BA)

input_texture_2d connTex;
input_float TubeRadius;
input_float BendRadius;
input_float NumConnections;
input_float Growth;

output_vec3 transformedPosition;
output_vec4 vertexColor;

float decode16(float hi, float lo) {
    float v = hi * 255.0 * 256.0 + lo * 255.0;
    return v / 65535.0 * 512.0 - 256.0;
}

vec2 decodePair(vec4 px) {
    return vec2(decode16(px.r, px.g), decode16(px.b, px.a));
}

void main() {
    vec2 uv0 = system.getSurfaceUVCoord0();
    vec2 uv1 = system.getSurfaceUVCoord1();
    vec2 uv2 = system.getSurfaceUVCoord2();

    float localX = uv0.x;
    float localY = uv0.y;
    float rawT = uv1.x;
    float connIdx = floor(uv1.y + 0.5);
    float isTube = uv2.x;
    float colorSeed = uv2.y;
    float tubeR = TubeRadius;

    if (isTube < 0.5) {
        localX = 0.0;
        localY = 0.0;
        tubeR = 0.001;
    }

    // Read 4 waypoints + per-connection growth from data texture
    float texV = (connIdx + 0.5) / max(NumConnections, 1.0);
    float texW = 8.0;
    vec2 p0 = decodePair(connTex.sampleLod(vec2(0.5 / texW, texV), 0.0));
    vec2 p1 = decodePair(connTex.sampleLod(vec2(1.5 / texW, texV), 0.0));
    vec2 p2 = decodePair(connTex.sampleLod(vec2(2.5 / texW, texV), 0.0));
    vec2 p3 = decodePair(connTex.sampleLod(vec2(3.5 / texW, texV), 0.0));
    vec2 p4 = decodePair(connTex.sampleLod(vec2(4.5 / texW, texV), 0.0));
    vec2 p5 = decodePair(connTex.sampleLod(vec2(5.5 / texW, texV), 0.0));
    vec2 p6 = decodePair(connTex.sampleLod(vec2(6.5 / texW, texV), 0.0));

    // Per-connection zone growth from pixel 6, clamped by global Growth
    float masterGrowth = clamp(Growth, 0.0, 1.0);
    float exitGrow = min(clamp(p6.x, 0.0, 1.0), masterGrowth);
    float bridgeGrow = min(clamp(p6.y, 0.0, 1.0), masterGrowth);

    vec3 W0 = vec3(p0.x, p0.y, p1.x);
    vec3 W1 = vec3(p1.y, p2.x, p2.y);
    vec3 W2 = vec3(p3.x, p3.y, p4.x);
    vec3 W3 = vec3(p4.y, p5.x, p5.y);

    // Segment directions and lengths
    vec3 seg01 = W1 - W0;
    vec3 seg12 = W2 - W1;
    vec3 seg23 = W3 - W2;
    float len01 = length(seg01);
    float len12 = length(seg12);
    float len23 = length(seg23);
    vec3 d01 = (len01 > 0.001) ? seg01 / len01 : vec3(1.0, 0.0, 0.0);
    vec3 d12 = (len12 > 0.001) ? seg12 / len12 : d01;
    vec3 d23 = (len23 > 0.001) ? seg23 / len23 : d12;

    // Turn angles at W1 and W2
    float cosA1 = clamp(dot(d01, d12), -1.0, 1.0);
    float cosA2 = clamp(dot(d12, d23), -1.0, 1.0);
    float alpha1 = acos(cosA1);
    float alpha2 = acos(cosA2);

    // Inward normals at each turn
    vec3 raw_n1 = d12 - d01 * cosA1;
    float rn1 = length(raw_n1);
    vec3 n1 = (rn1 > 0.001) ? raw_n1 / rn1 : vec3(0.0, 1.0, 0.0);

    vec3 raw_n2 = d23 - d12 * cosA2;
    float rn2 = length(raw_n2);
    vec3 n2 = (rn2 > 0.001) ? raw_n2 / rn2 : vec3(0.0, 1.0, 0.0);

    // Fillet geometry
    float safeA1 = max(alpha1, 0.01);
    float safeA2 = max(alpha2, 0.01);
    float tanH1 = tan(min(safeA1 * 0.5, 1.5));
    float tanH2 = tan(min(safeA2 * 0.5, 1.5));

    float maxR1 = BendRadius;
    if (tanH1 > 0.001) {
        maxR1 = min(maxR1, len01 * 0.45 / tanH1);
        maxR1 = min(maxR1, len12 * 0.45 / tanH1);
    }
    float r1 = max(maxR1, 0.01);

    float maxR2 = BendRadius;
    if (tanH2 > 0.001) {
        maxR2 = min(maxR2, len12 * 0.45 / tanH2);
        maxR2 = min(maxR2, len23 * 0.45 / tanH2);
    }
    float r2 = max(maxR2, 0.01);

    float ft1 = r1 * tanH1;
    float ft2 = r2 * tanH2;

    // 5 segment lengths
    float S1 = max(len01 - ft1, 0.0);
    float A1 = safeA1 * r1;
    float S2 = max(len12 - ft1 - ft2, 0.0);
    float A2 = safeA2 * r2;
    float S3 = max(len23 - ft2, 0.0);
    float totalLen = S1 + A1 + S2 + A2 + S3;
    totalLen = max(totalLen, 0.001);

    float b1 = S1;
    float b2 = b1 + A1;
    float b3 = b2 + S2;
    float b4 = b3 + A2;

    // ---- Zone-based growth clamping ----
    // Exit A  [0, b1]       grows forward from W0
    // Bridge  [b1, b4]      grows forward from W1
    // Exit B  [b4, totalLen] grows backward from W3
    float rawDist = rawT * totalLen;
    float bridgeLen = max(b4 - b1, 0.001);
    float fadeWidth = totalLen * 0.06;

    // Growth fronts in dist space
    float exitA_front = exitGrow * S1;
    float bridge_front = b1 + bridgeGrow * bridgeLen;
    float exitB_back = totalLen - exitGrow * S3;

    float dist;
    float frontFade;

    if (rawDist <= b1) {
        // Exit A: forward growth from W0
        dist = min(rawDist, exitA_front);
        frontFade = 1.0 - smoothstep(exitA_front - fadeWidth, exitA_front, rawDist);
    } else if (rawDist <= b4) {
        // Bridge: forward growth from exit A end
        dist = min(rawDist, bridge_front);
        frontFade = 1.0 - smoothstep(bridge_front - fadeWidth, bridge_front, rawDist);
    } else {
        // Exit B: backward growth from W3
        dist = max(rawDist, exitB_back);
        frontFade = smoothstep(exitB_back, exitB_back + fadeWidth, rawDist);
    }

    // Arc centers
    vec3 arcEntry1 = W0 + d01 * S1;
    vec3 center1 = arcEntry1 + n1 * r1;
    vec3 postFillet1 = center1 - n1 * cos(safeA1) * r1 + d01 * sin(safeA1) * r1;
    vec3 arcEntry2 = postFillet1 + d12 * S2;
    vec3 center2 = arcEntry2 + n2 * r2;
    vec3 postFillet2 = center2 - n2 * cos(safeA2) * r2 + d12 * sin(safeA2) * r2;

    vec3 pos;
    vec3 tang;

    if (dist <= b1) {
        pos = W0 + d01 * dist;
        tang = d01;

    } else if (dist <= b2) {
        float s = (dist - b1) / max(A1, 0.001);
        float theta = s * safeA1;
        pos = center1 - cos(theta) * n1 * r1 + sin(theta) * d01 * r1;
        tang = normalize(sin(theta) * n1 + cos(theta) * d01);

    } else if (dist <= b3) {
        float s = dist - b2;
        pos = postFillet1 + d12 * s;
        tang = d12;

    } else if (dist <= b4) {
        float s = (dist - b3) / max(A2, 0.001);
        float theta = s * safeA2;
        pos = center2 - cos(theta) * n2 * r2 + sin(theta) * d12 * r2;
        tang = normalize(sin(theta) * n2 + cos(theta) * d12);

    } else {
        float s = dist - b4;
        pos = postFillet2 + d23 * s;
        tang = d23;
    }

    // Cross-section frame (twist-free)
    vec3 refUp = cross(d01, d23);
    float rul = length(refUp);
    if (rul < 0.001) {
        refUp = cross(d01, d12);
        rul = length(refUp);
    }
    if (rul < 0.001) {
        refUp = cross(d01, vec3(0.0, 0.0, 1.0));
        rul = length(refUp);
    }
    if (rul < 0.001) {
        refUp = cross(d01, vec3(0.0, 1.0, 0.0));
        rul = length(refUp);
    }
    if (rul > 0.001) {
        refUp = refUp / rul;
    } else {
        refUp = vec3(0.0, 1.0, 0.0);
    }

    vec3 frameNormal = normalize(cross(refUp, tang));
    vec3 frameBinormal = normalize(cross(tang, frameNormal));

    vec3 offset = (localX * frameNormal + localY * frameBinormal) * tubeR;
    vec3 finalPos = pos + offset;

    // Per-connection color: vivid red palette
    float hue = colorSeed;
    vec3 colStart = mix(vec3(0.88, 0.12, 0.08), vec3(1.0, 0.2, 0.1), hue);
    vec3 colEnd = mix(vec3(1.0, 0.18, 0.1), vec3(1.0, 0.35, 0.15), hue);
    float colorT = dist / totalLen;
    vec3 color = mix(colStart, colEnd, colorT);

    transformedPosition = finalPos;
    vertexColor = vec4(color, frontFade);
}
