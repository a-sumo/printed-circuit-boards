// ElectronicsLabShader.js
// Flat unlit shader for electronics lab components.
// Colors baked into vertex UV coords (same as KiCadBoardShader).
// Supports per-component simulation data via data texture.
//
// Vertex encoding (from ElectronicsLab.ts / CircuitSim.ts):
//   position = baked world-space vertex
//   normal = face normal
//   texture0 = (R, G) color packed into UV
//   texture1 = (B, componentTag) where:
//     componentTag 0.0       = inert geometry (breadboard, leads, housing)
//     componentTag 0.0-0.49  = inert
//     componentTag 0.5-0.99  = LED (emissive from EmissivePulse uniform)
//     componentTag >= 1.0    = sim-driven component index (floor(tag) = simRow)
//
// Sim data texture (simTex, 1xN RGBA8):
//   Row = component sim index
//   R = brightness / emissive [0,255] -> [0,1]
//   G = heat glow [0,255] -> [0,1]
//   B = growth [0,255] -> [0,1]
//   A = reserved

input_float EmissivePulse;
input_texture_2d simTex;
input_float SimTexHeight;
input_float GlobalGrowth;

output_vec3 transformedPosition;
output_vec4 vertexColor;

void main() {
    vec3 pos = system.getSurfacePosition();
    vec2 uv0 = system.getSurfaceUVCoord0();
    vec2 uv1 = system.getSurfaceUVCoord1();

    vec3 color = vec3(uv0.x, uv0.y, uv1.x);
    float tag = uv1.y;

    // Legacy LED emissive (tag 0.5-0.99): per-material EmissivePulse uniform
    float isLed = step(0.5, tag) * (1.0 - step(1.0, tag));
    float glow = isLed * EmissivePulse * 0.5;
    color = color + vec3(glow);

    // Sim-driven components (tag >= 1.0): read from data texture
    float isSim = step(1.0, tag);
    if (isSim > 0.5 && SimTexHeight > 0.5) {
        float simRow = floor(tag);
        float texV = (simRow - 1.0 + 0.5) / max(SimTexHeight, 1.0);
        vec4 simData = simTex.sampleLod(vec2(0.5, texV), 0.0);

        float brightness = simData.r;
        float heat = simData.g;
        float growth = simData.b;

        // LED brightness: additive emissive boost
        color = color + vec3(brightness * 0.6);

        // Heat glow: warm orange overlay proportional to power dissipation
        vec3 heatColor = vec3(1.0, 0.4, 0.1);
        color = mix(color, color + heatColor * 0.3, heat);

        // Growth: scale toward component center (vertex shrinks to origin when growth=0)
        float g = max(growth, GlobalGrowth);
        pos = pos * g;
    }

    // Global growth (for non-sim components like breadboard materialization)
    if (isSim < 0.5 && GlobalGrowth < 0.99) {
        pos = pos * max(GlobalGrowth, 0.0);
    }

    // Ensure minimum brightness for Spectacles (black = transparent)
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    color = max(color, vec3(0.05));

    transformedPosition = pos;
    vertexColor = vec4(color, 1.0);
}
