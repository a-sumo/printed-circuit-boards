// FresnelShader.js
// Pure fresnel glow with directional sweep reveal.
// Code Node for Lens Studio Graph Material.
//
// Setup in Lens Studio:
//   1. Create a Graph Material with a Code Node, set source to FresnelShader.js
//   2. Wire transformedPosition -> Vertex Position
//   3. Wire vertexColor -> Fragment Color (use Multiply with base)
//   4. Set material: Blend Mode = PremultipliedAlphaAuto, Two-Sided = true
//   5. Attach to mesh RenderMeshVisual, assign from AssemblyAnim.ts
//
// Driven from AssemblyAnim.ts per frame:
//   pass.params     = vec3(fresnelPower, opacity, meshReveal)
//   pass.spineDir   = vec3 (link spine direction, normalized)
//   pass.bboxCenter = vec3 (link bbox center, object space)
//   pass.spineParams = vec3(minProj, projRange, maxRadial)

input_vec3 params;
input_vec3 spineDir;
input_vec3 bboxCenter;
input_vec3 spineParams;

output_vec3 transformedPosition;
output_vec4 vertexColor;

void main() {
    vec3 pos = system.getSurfacePositionObjectSpace();
    vec3 norm = system.getSurfaceNormalObjectSpace();

    float fresnelPower = params.x;
    float opacity = params.y;
    float meshReveal = params.z;
    float minProj = spineParams.x;
    float projRange = spineParams.y;
    float maxRadial = spineParams.z;

    vec3 sd = normalize(spineDir + vec3(0.0001));

    // Spine-aligned ordering for directional reveal
    vec3 toVert = pos - bboxCenter;
    float proj = dot(toVert, sd);
    vec3 radialVec = toVert - sd * proj;
    float normProj = projRange > 0.0001 ? (proj - minProj) / projRange : 0.0;
    float normRadial = maxRadial > 0.0001 ? length(radialVec) / maxRadial : 0.0;
    float maskOrder = normProj * 0.7 + normRadial * 0.3;

    // Fresnel via world-space normal vs camera direction
    vec3 worldPos = (system.getMatrixWorld() * vec4(pos, 1.0)).xyz;
    vec3 worldNorm = normalize((system.getMatrixWorld() * vec4(norm, 0.0)).xyz);
    vec3 viewDir = normalize(system.getCameraPosition() - worldPos);
    float fresnel = pow(1.0 - abs(dot(viewDir, worldNorm)), max(fresnelPower, 0.5));

    // Directional sweep mask
    float mask = smoothstep(meshReveal - 0.15, meshReveal + 0.05, maskOrder);

    float alpha = fresnel * opacity * mask;
    vec3 color = vec3(0.878, 0.282, 0.125);

    transformedPosition = pos;
    vertexColor = vec4(color, alpha);
}
