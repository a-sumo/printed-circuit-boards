// KiCadTraceShader.js
// Unified trace shader: blends between vivid (flat HSV) and realistic (PBR copper).
// realisticMode = 0: vivid per-net HSV rainbow, metallic=0, roughness=1
// realisticMode = 1: PBR copper with metallic sheen + signal flow dots
//
// Vertex encoding:
//   position = ribbon surface vertex
//   normal   = outward surface normal
//   texture0 = (t, traceIdx) where t is parametric [0,1] along polyline
//   texture1 = (crossSection, 0) where crossSection = +1 left edge, -1 right edge, 0 center
//
// Data texture (traceTex, 2xN RGBA8):
//   Column 0 (sampled at x=0.25): R,G = growth (16-bit [0,1]), B,A = hue (16-bit [0,1])
//   Column 1 (sampled at x=0.75): R,G = arcLen (16-bit, *200 cm), B,A = cumOffset (16-bit, *200 cm)
//
// Uniforms:
//   traceTex  - Texture 2D Object Parameter
//   NumTraces - float, total trace count for texture lookup
//   flowTime  - float, drives signal-flow traveling wave (0 = off)
//   realisticMode - float 0-1, vivid to realistic blend

input_texture_2d traceTex;
input_float NumTraces;
input_float flowTime;
input_float realisticMode;
input_float flowSpeed;
input_float flowIntensity;

output_vec3 transformedPosition;
output_vec4 vertexColor;

float decode16(float hi, float lo) {
    return (hi * 255.0 * 256.0 + lo * 255.0) / 65535.0;
}

vec3 hsv2rgb(float h, float s, float v) {
    vec3 c = clamp(abs(fract(vec3(h, h + 2.0 / 3.0, h + 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    return v * mix(vec3(1.0), c, s);
}

void main() {
    vec3 pos = system.getSurfacePosition();
    vec3 nrm = system.getSurfaceNormal();
    vec2 uv0 = system.getSurfaceUVCoord0();

    // Edge cross-section: UV1.x = +1 left edge, -1 right edge, 0 center
    float edgeCross = abs(system.getSurfaceUVCoord1().x);
    float edgeAlpha = 1.0 - smoothstep(0.6, 1.0, edgeCross);

    float t = uv0.x;
    float traceIdx = floor(uv0.y + 0.5);
    float texV = (traceIdx + 0.5) / max(NumTraces, 1.0);

    // Column 0: growth + hue
    vec4 tex0 = traceTex.sampleLod(vec2(0.25, texV), 0.0);
    float growth = decode16(tex0.r, tex0.g);
    float hue = decode16(tex0.b, tex0.a);

    // Column 1: arc length + cumulative offset (for length-independent flow)
    vec4 tex1 = traceTex.sampleLod(vec2(0.75, texV), 0.0);
    float arcLen = decode16(tex1.r, tex1.g) * 200.0;
    float cumOffset = decode16(tex1.b, tex1.a) * 200.0;

    // Growth clipping
    float visible = step(t, growth + 0.001);
    float growthFade = smoothstep(0.0, 0.02, growth);
    float alpha = visible * growthFade * edgeAlpha;

    // Tip glow at growth front (only during active growth, not at rest)
    float isGrowing = 1.0 - step(0.99, growth);
    float tipGlow = (1.0 - smoothstep(growth - 0.15, growth, t)) * isGrowing;

    // Blend factor
    float r = clamp(realisticMode, 0.0, 1.0);

    // --- Vivid color (per-net HSV rainbow) ---
    vec3 vividColor = hsv2rgb(hue, 0.9, 0.9);

    // --- Realistic color (copper) ---
    float warm = 0.03 * sin(hue * 6.28);
    vec3 copperColor = vec3(0.82 + warm, 0.50 + warm * 0.5, 0.28);

    // Blended base color
    vec3 color = mix(vividColor, copperColor, r);

    // Tip highlight (blended between vivid warm-white and copper bright)
    vec3 vividTip = vec3(1.0, 0.92, 0.7);
    vec3 copperTip = vec3(0.98, 0.78, 0.55);
    vec3 tipColor = mix(vividTip, copperTip, r);
    float tipFactor = isGrowing * (1.0 - tipGlow);
    float tipStrength = mix(0.5, 0.4, r);
    color = mix(color, tipColor, tipFactor * tipStrength);

    // Arrival pulse only during active growth
    float tipPulse = exp(-(growth - t) * 15.0) * isGrowing;
    float pulseStrength = mix(0.3, 0.2, r);
    color += color * tipPulse * pulseStrength;

    // Signal flow: glowing blue particle traveling along trace
    float emissiveFlow = 0.0;
    if (flowTime > 0.001 && growth > 0.98) {
        float spd = max(flowSpeed, 0.1);

        // Particle position along trace (wraps via fract)
        float numParticles = 3.0;
        float phase = fract(t * numParticles - flowTime * spd * 0.3);
        float dist = abs(phase - 0.5) * 2.0;

        // Tight Gaussian core + soft halo
        float core = exp(-dist * dist * 40.0);
        float halo = exp(-dist * dist * 8.0) * 0.3;
        float bright = (core + halo) * max(flowIntensity, 0.1);

        // Blue-white particle color (same for vivid and realistic)
        vec3 particleColor = vec3(0.35, 0.65, 1.0);
        vec3 hotCenter = vec3(0.7, 0.85, 1.0);
        vec3 flowColor = mix(particleColor, hotCenter, core);

        color = mix(color, flowColor, bright * 0.85);
        emissiveFlow = bright * 0.7;
    }

    color *= alpha;

    // PBR parameters: lerp between flat and copper
    float metallic = mix(0.0, 0.90, r);
    float roughness = mix(1.0, 0.30 + 0.05 * sin(t * 31.4), r);

    // Reduce metallic at flow points for emissive look (PBR path)
    if (emissiveFlow > 0.01) {
        metallic = mix(metallic, 0.04, emissiveFlow);
        roughness = mix(roughness, 0.95, emissiveFlow);
    }

    // Spectacles additive display: ensure minimum brightness
    color = max(color, vec3(0.04)) * alpha;

    transformedPosition = pos;
    vertexColor = vec4(color, alpha);
}
