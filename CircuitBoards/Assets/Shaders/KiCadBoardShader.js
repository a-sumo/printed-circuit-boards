// KiCadBoardShader.js
// Unified board substrate shader: blends between vivid (flat) and realistic (PBR).
// Identical logic to KiCadBoardShaderPBR.js so either shader graph can be used.
// realisticMode = 0: flat pass-through (metallic=0, roughness=1)
// realisticMode = 1: full PBR with material inference from vertex color
//
// Surface type inferred from vertex color (realistic palette, COL_*_R):
//   FR4 substrate: ~(0.60, 0.52, 0.32) tan/amber
//   FR4 edge:      ~(0.42, 0.364, 0.224) darker tan
//   Solder mask:   ~(0.10, 0.42, 0.18) green
//   HASL pads:     ~(0.85, 0.85, 0.80) silver
//   Via hole:      ~(0.12, 0.12, 0.14) dark
//   Silkscreen:    ~(0.95, 0.95, 0.90) white
//
// Vertex encoding:
//   position = pre-baked
//   normal   = surface normal
//   texture0 = (r, g) of vertex color
//   texture1 = (b, revealDist)
//
// Uniforms:
//   boardTime     - float, reveal animation progress
//   realisticMode - float 0-1, vivid to realistic blend

input_float boardTime;
input_float realisticMode;

output_vec3 transformedPosition;
output_vec4 vertexColor;

// Squared color distance
float colorDist(vec3 a, vec3 b) {
    vec3 d = a - b;
    return dot(d, d);
}

void main() {
    vec3 pos = system.getSurfacePosition();
    vec3 nrm = system.getSurfaceNormal();
    vec2 uv0 = system.getSurfaceUVCoord0();
    vec2 uv1 = system.getSurfaceUVCoord1();

    // Decode vertex color (RGB packed in texture coords)
    vec3 albedo = vec3(uv0.x, uv0.y, uv1.x);

    // Vivid defaults: flat unlit pass-through
    float metallic = 0.0;
    float roughness = 1.0;

    // PBR material inference, gated on realisticMode
    float r = clamp(realisticMode, 0.0, 1.0);
    if (r > 0.01) {
        float pbrMetallic = 0.0;
        float pbrRoughness = 0.8;
        vec3 pbrAlbedo = albedo;

        // Reference colors synced with KiCadBoard.ts COL_*_R
        vec3 colFR4     = vec3(0.60, 0.52, 0.32);
        vec3 colFR4dark = vec3(0.42, 0.364, 0.224);
        vec3 colMask    = vec3(0.10, 0.42, 0.18);
        vec3 colHASL    = vec3(0.85, 0.85, 0.80);
        vec3 colDrill   = vec3(0.12, 0.12, 0.14);
        vec3 colSilk    = vec3(0.95, 0.95, 0.90);

        float thresh = 0.04;

        if (colorDist(albedo, colHASL) < thresh) {
            // HASL pads/vias: tin-lead solder, lustrous metallic
            pbrMetallic = 0.95;
            pbrRoughness = 0.32;
            pbrAlbedo = vec3(0.76, 0.76, 0.72);
        } else if (colorDist(albedo, colSilk) < thresh) {
            // Silkscreen: matte white ink
            pbrRoughness = 0.88;
        } else if (colorDist(albedo, colDrill) < thresh) {
            // Via holes: dark epoxy fill
            pbrRoughness = 0.95;
        } else if (colorDist(albedo, colMask) < thresh) {
            // Solder mask: glossy polymer coating
            pbrRoughness = 0.35;
        } else if (colorDist(albedo, colFR4) < thresh || colorDist(albedo, colFR4dark) < thresh) {
            // FR4 substrate: woven fiberglass epoxy
            pbrRoughness = 0.78;
        } else if (albedo.r > 0.8 && albedo.g > 0.6 && albedo.b < 0.4) {
            // Gold ENIG pads
            pbrMetallic = 0.98;
            pbrRoughness = 0.18;
            pbrAlbedo = vec3(1.0, 0.77, 0.34);
        } else {
            // Default: dielectric
            float brightness = dot(albedo, vec3(0.299, 0.587, 0.114));
            if (brightness < 0.15) {
                pbrRoughness = 0.55;  // IC package epoxy
            } else {
                pbrRoughness = 0.80;  // FR4 edge or other
            }
        }

        // Spectacles additive display: ensure minimum brightness
        pbrAlbedo = max(pbrAlbedo, vec3(0.05));
        // Boost specular for additive display
        pbrRoughness *= 0.92;

        // Blend between vivid flat and PBR
        albedo = mix(albedo, pbrAlbedo, r);
        metallic = mix(0.0, pbrMetallic, r);
        roughness = mix(1.0, pbrRoughness, r);
    }

    transformedPosition = pos;
    vertexColor = vec4(albedo, 1.0);
}
