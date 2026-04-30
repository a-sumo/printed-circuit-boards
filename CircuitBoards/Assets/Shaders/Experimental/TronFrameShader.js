// TronFrameShader.js
// Straight tube rendering for TronFrame corner brackets.
// Each tube segment is a line from start to end, read from a data texture.
// Glow effect: hot white core fading to vivid red at the tube edge.
//
// Growth extrusion: Growth uniform (0-1) controls how much of each tube
// is visible. Vertices beyond the growth front collapse to the front
// position and fade out, creating an animated extrusion effect.
// Inspired by the Vector Fields tube integration pattern.
//
// Vertex encoding (from TronFrame.ts MeshBuilder):
//   texture0 = (localX, localY) unit circle cross-section
//   texture1 = (t, segmentIndex) parameter along tube + segment ID
//
// Data texture (frameTex, 4xN RGBA8, 16-bit fixed-point [-256,256]):
//   Row = segmentIndex
//   Pixel 0: start.x (RG), start.y (BA)
//   Pixel 1: start.z (RG), end.x (BA)
//   Pixel 2: end.y (RG), end.z (BA)
//   Pixel 3: segGrowth (RG), unused (BA)

input_texture_2d frameTex;
input_float TubeRadius;
input_float NumSegments;
input_float Growth;

output_vec3 transformedPosition;
output_vec4 vertexColor;

// Decode 16-bit fixed-point from two [0,1] channels. Range [-256, 256].
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

    float localX = uv0.x;
    float localY = uv0.y;
    float rawT = uv1.x;
    float segIdx = floor(uv1.y + 0.5);

    // Sample segment data from data texture
    float texV = (segIdx + 0.5) / max(NumSegments, 1.0);
    float texW = 4.0;
    vec2 d0 = decodePair(frameTex.sampleLod(vec2(0.5 / texW, texV), 0.0));
    vec2 d1 = decodePair(frameTex.sampleLod(vec2(1.5 / texW, texV), 0.0));
    vec2 d2 = decodePair(frameTex.sampleLod(vec2(2.5 / texW, texV), 0.0));
    vec2 d3 = decodePair(frameTex.sampleLod(vec2(3.5 / texW, texV), 0.0));

    // Per-segment growth from pixel 3 (RG), combined with global Growth
    float segGrowth = clamp(d3.x, 0.0, 1.0);
    float growth = min(clamp(Growth, 0.0, 1.0), segGrowth);
    float t = min(rawT, growth);
    float frontFade = 1.0 - smoothstep(growth - 0.1, growth, rawT);

    vec3 startPos = vec3(d0.x, d0.y, d1.x);
    vec3 endPos = vec3(d1.y, d2.x, d2.y);

    // Segment direction and length
    vec3 delta = endPos - startPos;
    float segLen = length(delta + vec3(0.0001));

    // Tangent (safe normalize)
    vec3 tang = delta / segLen;

    // Position along tube centerline
    vec3 pos = mix(startPos, endPos, t);

    // Build cross-section frame (Frenet-like, twist-free)
    vec3 up = vec3(0.0, 1.0, 0.0);
    up = mix(up, vec3(1.0, 0.0, 0.0), step(0.99, abs(dot(tang, up))));
    vec3 frameN = normalize(cross(up, tang));
    vec3 frameB = normalize(cross(tang, frameN));

    // Tube radius: degenerate segments collapse, cap centers collapse
    float capFactor = step(0.001, abs(localX) + abs(localY));
    float segVisible = step(0.01, segLen);
    float r = TubeRadius * capFactor * segVisible + 0.0001;

    vec3 offset = (localX * frameN + localY * frameB) * r;
    vec3 finalPos = pos + offset;

    // Back-face darkening: compare tube outward normal against camera direction
    mat4 worldMat = system.getMatrixWorld();
    vec3 outDir = localX * frameN + localY * frameB;
    vec3 worldPos = (worldMat * vec4(finalPos, 1.0)).xyz;
    vec3 worldNorm = normalize((worldMat * vec4(outDir, 0.0)).xyz + vec3(0.0001));
    vec3 toCamera = normalize(system.getCameraPosition() - worldPos);
    float facing = smoothstep(-0.05, 0.15, dot(worldNorm, toCamera));

    // Glow color: hot core -> vivid red edge
    float edgeFactor = sqrt(localX * localX + localY * localY) * capFactor;

    // Core: bright near-white with warm tint
    vec3 coreColor = vec3(1.0, 0.88, 0.8);
    // Edge: vivid red
    vec3 edgeColor = vec3(1.0, 0.15, 0.08);

    vec3 color = mix(coreColor, edgeColor, edgeFactor * edgeFactor);

    // Subtle brightness variation along tube length (energy flow feel)
    float pulse = 0.92 + 0.08 * sin(t * 6.2832 * 2.0);
    color *= pulse;

    // Tip fade: slight dimming near the free end of each arm
    float tipFade = smoothstep(0.0, 0.15, 1.0 - t);
    color *= 0.7 + 0.3 * tipFade;

    // Darken back faces, hide degenerate segments, apply growth fade
    color *= facing * segVisible;
    float alpha = frontFade * segVisible;

    transformedPosition = finalPos;
    vertexColor = vec4(color, alpha);
}
