// ConnectorShader.js — Manhattan-routed tube with fillet-arc corners
//
// Deforms a parametric tube mesh (from TubeMeshFactory)
// along a 5-segment Manhattan path between two 3D anchor points.
//
// ROUTING
//
//   Z-shape (dx >= 0):  A ──exit──→ ⌒ ──perp──→ ⌒ ──exit──→ B
//   U-shape (dx <  0):  A ──exit──→ ⌒ ──perp──→ ⌒ ←─exit── B
//
//   The Z/U transition is smoothed via smoothstep near dx=0 to prevent
//   sudden shape reversals when panels cross over.
//
// EXIT DIRECTION
//
//   When ExitDx/Dy/Dz is non-zero, the shader uses it as the exit
//   direction from PointA (the outward normal of the docking edge).
//   This guarantees the tube exits perpendicular to its docking edge,
//   never parallel. When zero, falls back to auto-detection from delta.
//
// BLENDING
//
//   When perpendicular displacement is small relative to the primary
//   axis (perpRatio < 0.25), the route smoothly degrades from Manhattan
//   to a straight line. This avoids degenerate Z-shapes with tiny
//   perpendicular segments.
//
// VERTEX ENCODING (from TubeMeshFactory)
//
//   texture0 = (localX, localY) — unit-circle cross-section coords
//   texture1 = (t, isBody) — t: parametric position [0,1] along path
//                             isBody: 1 for body, 0<x<1 for cap, 0 for apex
//
// UNIFORMS
//
//   PointAx/Ay/Az  — start anchor (connector-local space)
//   PointBx/By/Bz  — end anchor (connector-local space)
//   TubeRadius      — cross-section radius
//   BendRadius      — fillet-arc radius at corners
//   ClipT           — parametric clip [0,1] for growth animation
//   ExitDx/Dy/Dz   — explicit exit direction at PointA (0 = auto-detect)
//   ColorBase       — tube color at t=0 (start)
//   ColorTip        — tube color at t=1 (end)
//   ColorGlow       — frontier glow color at growth edge

input_float PointAx;
input_float PointAy;
input_float PointAz;
input_float PointBx;
input_float PointBy;
input_float PointBz;
input_float TubeRadius;
input_float BendRadius;
input_float ClipT;
input_float ExitDx;
input_float ExitDy;
input_float ExitDz;
input_color3 ColorBase;
input_color3 ColorTip;
input_color3 ColorGlow;

output_vec3 transformedPosition;
output_vec4 vertexColor;

void main() {
    vec2 inUV0 = system.getSurfaceUVCoord0();
    vec2 inUV1 = system.getSurfaceUVCoord1();

    float localX = inUV0.x;
    float localY = inUV0.y;
    float t = inUV1.x;
    float isBody = inUV1.y;
    float tubeR = TubeRadius;

    vec3 PointA = vec3(PointAx, PointAy, PointAz);
    vec3 PointB = vec3(PointBx, PointBy, PointBz);

    float capScale = isBody;
    localX *= capScale;
    localY *= capScale;

    vec3 delta = PointB - PointA;

    // Exit direction: use explicit if provided, otherwise auto-detect
    vec3 exitOverride = vec3(ExitDx, ExitDy, ExitDz);
    float overrideLen = length(exitOverride);

    vec3 exitDir;
    if (overrideLen > 0.5) {
        exitDir = exitOverride / overrideLen;
    } else {
        vec3 ad = vec3(abs(delta.x), abs(delta.y), abs(delta.z));
        if (ad.y > ad.x && ad.y > ad.z) {
            exitDir = vec3(0.0, delta.y > 0.0 ? 1.0 : -1.0, 0.0);
        } else if (ad.z > ad.x) {
            exitDir = vec3(0.0, 0.0, delta.z > 0.0 ? 1.0 : -1.0);
        } else {
            exitDir = vec3(delta.x > 0.0 ? 1.0 : -1.0, 0.0, 0.0);
        }
        float dxCheck = dot(delta, exitDir);
        if (dxCheck < 0.0) {
            exitDir = -exitDir;
        }
    }

    float dx = dot(delta, exitDir);
    vec3 perpVec = delta - exitDir * dx;
    float perpDist = length(perpVec);
    vec3 perpDir = (perpDist > 0.001) ? perpVec / perpDist : vec3(0.0, 1.0, 0.0);

    vec3 straightPos = mix(PointA, PointB, t);
    vec3 straightTang = normalize(delta + vec3(0.0001, 0.0001, 0.0001));

    float absDx = abs(dx);
    float isUShape = smoothstep(0.5, -0.5, dx);

    float halfAbsDx = absDx * 0.5;
    float r = min(BendRadius, min(max(halfAbsDx, BendRadius) * 0.95, max(perpDist * 0.45, 0.01)));
    r = max(r, 0.01);

    float L1;
    float L3;
    if (isUShape > 0.5) {
        L1 = max(BendRadius, r);
        L3 = L1 + absDx;
    } else {
        L1 = max(halfAbsDx - r, 0.0);
        L3 = max(halfAbsDx - r, 0.0);
    }

    float Larc = 1.5707963 * r;
    float L2 = max(perpDist - 2.0 * r, 0.0);
    float totalLen = L1 + Larc + L2 + Larc + L3;

    float b1 = L1;
    float b2 = b1 + Larc;
    float b3 = b2 + L2;
    float b4 = b3 + Larc;

    vec3 arcCenter1 = PointA + exitDir * L1 + perpDir * r;
    vec3 postFillet1 = arcCenter1 + exitDir * r;

    vec3 arcCenter2;
    if (isUShape > 0.5) {
        arcCenter2 = postFillet1 + perpDir * L2 - exitDir * r;
    } else {
        arcCenter2 = postFillet1 + perpDir * L2 + exitDir * r;
    }

    float dist = t * max(totalLen, 0.001);
    float HALF_PI = 1.5707963;

    vec3 manhattanPos;
    vec3 manhattanTang;

    vec3 exitDirL3 = (isUShape > 0.5) ? -exitDir : exitDir;

    if (dist <= b1) {
        manhattanPos = PointA + exitDir * dist;
        manhattanTang = exitDir;
    } else if (dist <= b2) {
        float s = (dist - b1) / max(Larc, 0.001);
        float alpha = -HALF_PI + s * HALF_PI;
        manhattanPos = arcCenter1 + r * cos(alpha) * exitDir + r * sin(alpha) * perpDir;
        manhattanTang = normalize(-sin(alpha) * exitDir + cos(alpha) * perpDir);
    } else if (dist <= b3) {
        float s = dist - b2;
        manhattanPos = postFillet1 + perpDir * s;
        manhattanTang = perpDir;
    } else if (dist <= b4) {
        float s = (dist - b3) / max(Larc, 0.001);
        if (isUShape > 0.5) {
            float alpha = s * HALF_PI;
            manhattanPos = arcCenter2 + r * cos(alpha) * (-exitDir) + r * sin(alpha) * perpDir;
            manhattanTang = normalize(-sin(alpha) * (-exitDir) + cos(alpha) * perpDir);
        } else {
            float alpha = 3.1415926 - s * HALF_PI;
            manhattanPos = arcCenter2 + r * cos(alpha) * exitDir + r * sin(alpha) * perpDir;
            manhattanTang = normalize(sin(alpha) * exitDir - cos(alpha) * perpDir);
        }
    } else {
        float s = dist - b4;
        vec3 postFillet2 = arcCenter2 + r * perpDir;
        manhattanPos = postFillet2 + exitDirL3 * s;
        manhattanTang = exitDirL3;
    }

    float perpRatio = perpDist / max(absDx, 0.01);
    float blendToManhattan = smoothstep(0.05, 0.25, perpRatio);
    blendToManhattan = max(blendToManhattan, isUShape);

    vec3 pos = mix(straightPos, manhattanPos, blendToManhattan);
    vec3 tang = normalize(mix(straightTang, manhattanTang, blendToManhattan));

    vec3 refUp = cross(exitDir, perpDir);
    float refUpLen = length(refUp);
    if (refUpLen < 0.001) {
        refUp = vec3(0.0, 0.0, 1.0);
    } else {
        refUp = refUp / refUpLen;
    }

    vec3 frameNormal = normalize(cross(refUp, tang));
    vec3 frameBinormal = normalize(cross(tang, frameNormal));

    vec3 offset = (localX * frameNormal + localY * frameBinormal) * tubeR;

    float clipEdge = 0.03;
    float clipMask = 1.0 - smoothstep(ClipT - clipEdge, ClipT + clipEdge, t);
    offset *= clipMask;

    vec3 finalPos = pos + offset;

    vec3 colorBase = ColorBase;
    vec3 colorTip = ColorTip;
    vec3 colorGlow = ColorGlow;

    float gradientT = t * t * (3.0 - 2.0 * t);
    vec3 color = mix(colorBase, colorTip, gradientT);

    float curvature = 0.0;
    if (dist > b1 && dist <= b2) curvature = 1.0;
    if (dist > b3 && dist <= b4) curvature = 1.0;
    color = mix(color, colorTip, curvature * 0.3);

    float frontier = smoothstep(0.06, 0.0, abs(t - ClipT)) * step(0.02, ClipT) * step(ClipT, 0.98);
    color = mix(color, colorGlow, frontier * 0.7);

    transformedPosition = finalPos;
    vertexColor = vec4(color, 1.0);
}
