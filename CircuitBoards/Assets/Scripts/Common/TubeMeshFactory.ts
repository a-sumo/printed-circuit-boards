/**
 * TubeMeshFactory.ts
 *
 * Shared parametric mesh builders for GPU-deformed tubes.
 * Three profile modes:
 *   - Tube: circular cross-section with hemisphere caps
 *   - RoundedRect: rounded rectangle cross-section with smooth caps
 *   - Rings: independent torus donuts along the path
 *
 * Vertex encoding matches ConnectorShader.js expectations:
 *   texture0 = (localX, localY) cross-section coordinates
 *   texture1 = (t, isBody) parametric t + body/cap flag
 *
 * Ported from augmented-lerobot.
 */

var HALF_PI = Math.PI / 2;

// ── Profile helpers ──

function circleProfile(R: number): { px: number[], py: number[] } {
    var TWO_PI = Math.PI * 2;
    var px: number[] = [];
    var py: number[] = [];
    for (var j = 0; j < R; j++) {
        var theta = (j / R) * TWO_PI;
        px.push(Math.cos(theta));
        py.push(Math.sin(theta));
    }
    return { px: px, py: py };
}

function roundedRectProfile(
    R: number,
    halfW: number,
    halfH: number,
    cr: number
): { px: number[], py: number[] } {
    var maxCr = Math.min(halfW, halfH);
    if (cr > maxCr) cr = maxCr;
    if (cr < 0.001) cr = 0.001;

    var arcLen = HALF_PI * cr;
    var rSideLen = 2 * Math.max(halfH - cr, 0);
    var tSideLen = 2 * Math.max(halfW - cr, 0);

    var segLens: number[] = [arcLen, rSideLen, arcLen, tSideLen, arcLen, rSideLen, arcLen, tSideLen];
    var totalLen = 0;
    for (var i = 0; i < 8; i++) totalLen += segLens[i];

    var cumLen: number[] = [0];
    for (var i = 0; i < 8; i++) cumLen.push(cumLen[i] + segLens[i]);

    var px: number[] = [];
    var py: number[] = [];

    for (var i = 0; i < R; i++) {
        var target = (i / R) * totalLen;
        var si = 0;
        while (si < 7 && target >= cumLen[si + 1]) si++;
        var local = target - cumLen[si];
        var x: number;
        var y: number;

        if (si == 0) {
            var angle = -HALF_PI + local / cr;
            x = (halfW - cr) + cr * Math.cos(angle);
            y = -(halfH - cr) + cr * Math.sin(angle);
        } else if (si == 1) {
            var frac = rSideLen > 0.001 ? local / rSideLen : 0;
            x = halfW; y = -(halfH - cr) + frac * rSideLen;
        } else if (si == 2) {
            var angle = local / cr;
            x = (halfW - cr) + cr * Math.cos(angle);
            y = (halfH - cr) + cr * Math.sin(angle);
        } else if (si == 3) {
            var frac = tSideLen > 0.001 ? local / tSideLen : 0;
            x = (halfW - cr) - frac * tSideLen; y = halfH;
        } else if (si == 4) {
            var angle = HALF_PI + local / cr;
            x = -(halfW - cr) + cr * Math.cos(angle);
            y = (halfH - cr) + cr * Math.sin(angle);
        } else if (si == 5) {
            var frac = rSideLen > 0.001 ? local / rSideLen : 0;
            x = -halfW; y = (halfH - cr) - frac * rSideLen;
        } else if (si == 6) {
            var angle = Math.PI + local / cr;
            x = -(halfW - cr) + cr * Math.cos(angle);
            y = -(halfH - cr) + cr * Math.sin(angle);
        } else {
            var frac = tSideLen > 0.001 ? local / tSideLen : 0;
            x = -(halfW - cr) + frac * tSideLen; y = -halfH;
        }

        px.push(x);
        py.push(y);
    }

    return { px: px, py: py };
}

// ── Generic profile tube builder ──

function buildProfileTubeMesh(
    profileX: number[],
    profileY: number[],
    pathSegments: number,
    capRings: number
): RenderMesh {
    var mb = new MeshBuilder([
        { name: "position",  components: 3 },
        { name: "normal",    components: 3 },
        { name: "texture0",  components: 2 },
        { name: "texture1",  components: 2 },
    ]);
    mb.topology = MeshTopology.Triangles;
    mb.indexType = MeshIndexType.UInt16;

    var segs = pathSegments;
    var rings = segs + 1;
    var R = profileX.length;
    var CR = capRings;

    var pushStrip = (baseA: number, baseB: number) => {
        for (var s = 0; s < R; s++) {
            var next = (s + 1) % R;
            mb.appendIndices([baseA + s, baseA + next, baseB + s]);
            mb.appendIndices([baseA + next, baseB + next, baseB + s]);
        }
    };

    // Body rings
    var bodyBase = 0;
    for (var i = 0; i < rings; i++) {
        var t = i / segs;
        for (var j = 0; j < R; j++) {
            mb.appendVerticesInterleaved([
                0, 0, 0,  0, 0, 0,
                profileX[j], profileY[j],
                t, 1,
            ]);
        }
    }
    for (var seg = 0; seg < segs; seg++) {
        pushStrip(bodyBase + seg * R, bodyBase + (seg + 1) * R);
    }

    var lastBody = bodyBase + segs * R;

    if (CR === 0) {
        var sApex = mb.getVerticesCount();
        mb.appendVerticesInterleaved([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        for (var j = 0; j < R; j++) {
            mb.appendIndices([sApex, bodyBase + (j + 1) % R, bodyBase + j]);
        }
        var eApex = mb.getVerticesCount();
        mb.appendVerticesInterleaved([0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
        for (var j = 0; j < R; j++) {
            mb.appendIndices([eApex, lastBody + j, lastBody + (j + 1) % R]);
        }
    } else {
        // Hemisphere caps
        var sCap = mb.getVerticesCount();
        for (var ring = 0; ring < CR; ring++) {
            var phi = HALF_PI * (ring + 1) / (CR + 1);
            var cosPhi = Math.cos(phi);
            for (var j = 0; j < R; j++) {
                mb.appendVerticesInterleaved([
                    0, 0, 0,  0, 0, 0,
                    profileX[j], profileY[j],
                    0, cosPhi,
                ]);
            }
        }
        pushStrip(sCap, bodyBase);
        for (var ring = 0; ring < CR - 1; ring++) {
            pushStrip(sCap + (ring + 1) * R, sCap + ring * R);
        }
        var sApex = mb.getVerticesCount();
        mb.appendVerticesInterleaved([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        var lastSCap = sCap + (CR - 1) * R;
        for (var j = 0; j < R; j++) {
            mb.appendIndices([sApex, lastSCap + (j + 1) % R, lastSCap + j]);
        }

        var eCap = mb.getVerticesCount();
        for (var ring = 0; ring < CR; ring++) {
            var phi = HALF_PI * (ring + 1) / (CR + 1);
            var cosPhi = Math.cos(phi);
            for (var j = 0; j < R; j++) {
                mb.appendVerticesInterleaved([
                    0, 0, 0,  0, 0, 0,
                    profileX[j], profileY[j],
                    1, cosPhi,
                ]);
            }
        }
        pushStrip(lastBody, eCap);
        for (var ring = 0; ring < CR - 1; ring++) {
            pushStrip(eCap + ring * R, eCap + (ring + 1) * R);
        }
        var eApex = mb.getVerticesCount();
        mb.appendVerticesInterleaved([0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
        var lastECap = eCap + (CR - 1) * R;
        for (var j = 0; j < R; j++) {
            mb.appendIndices([eApex, lastECap + j, lastECap + (j + 1) % R]);
        }
    }

    if (mb.isValid()) {
        mb.updateMesh();
        return mb.getMesh();
    }
    print("[TubeMeshFactory] ERROR: mesh invalid");
    return null;
}

// ── Public API ──

export function buildTubeMesh(
    pathSegments: number,
    radialSegments: number,
    capRings: number
): RenderMesh {
    var profile = circleProfile(radialSegments);
    return buildProfileTubeMesh(profile.px, profile.py, pathSegments, capRings);
}

export function buildRoundedRectTubeMesh(
    pathSegments: number,
    radialSegments: number,
    capRings: number,
    rectWidth: number,
    rectHeight: number,
    cornerRadius: number
): RenderMesh {
    var profile = roundedRectProfile(radialSegments, rectWidth, rectHeight, cornerRadius);
    return buildProfileTubeMesh(profile.px, profile.py, pathSegments, capRings);
}
