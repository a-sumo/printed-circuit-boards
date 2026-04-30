#!/usr/bin/env node
// kicad-to-json.mjs  (V2)
// Full-fidelity KiCad .kicad_pcb -> JSON converter.
// Preserves individual segments, arcs, zones, drawings, net classes, stackup.
// Usage: node converters/kicad-to-json.mjs path/to/board.kicad_pcb > board.json

import earcut from 'earcut';

// ---- S-expression tokenizer ----

function tokenize(input) {
    const tokens = [];
    let i = 0;
    const len = input.length;
    while (i < len) {
        const ch = input[i];
        if (ch === '(' || ch === ')') {
            tokens.push(ch);
            i++;
        } else if (ch === '"') {
            let str = '';
            i++;
            while (i < len && input[i] !== '"') {
                if (input[i] === '\\' && i + 1 < len) { str += input[++i]; }
                else { str += input[i]; }
                i++;
            }
            i++; // closing quote
            tokens.push(str);
        } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            i++;
        } else {
            let atom = '';
            while (i < len && input[i] !== '(' && input[i] !== ')' &&
                   input[i] !== ' ' && input[i] !== '\t' &&
                   input[i] !== '\n' && input[i] !== '\r') {
                atom += input[i];
                i++;
            }
            tokens.push(atom);
        }
    }
    return tokens;
}

// ---- Recursive descent parser ----

function parse(tokens) {
    let pos = 0;

    function readExpr() {
        if (tokens[pos] === '(') {
            pos++; // skip (
            const list = [];
            while (pos < tokens.length && tokens[pos] !== ')') {
                list.push(readExpr());
            }
            pos++; // skip )
            return list;
        }
        return tokens[pos++];
    }

    const exprs = [];
    while (pos < tokens.length) {
        exprs.push(readExpr());
    }
    return exprs.length === 1 ? exprs[0] : exprs;
}

// ---- S-expr query helpers ----

function find(node, tag) {
    if (!Array.isArray(node)) return null;
    for (const child of node) {
        if (Array.isArray(child) && child[0] === tag) return child;
    }
    return null;
}

function findAll(node, tag) {
    if (!Array.isArray(node)) return [];
    return node.filter(c => Array.isArray(c) && c[0] === tag);
}

function val(node, tag) {
    const f = find(node, tag);
    return f ? f[1] : null;
}

function numVal(node, tag) {
    const v = val(node, tag);
    return v != null ? parseFloat(v) : null;
}

function xyVal(node) {
    if (!Array.isArray(node) || node.length < 3) return null;
    return [parseFloat(node[1]), parseFloat(node[2])];
}

function xyzVal(node) {
    if (!Array.isArray(node) || node.length < 4) return null;
    return [parseFloat(node[1]), parseFloat(node[2]), parseFloat(node[3])];
}

function rotVal(node) {
    if (!Array.isArray(node) || node.length < 4) return 0;
    return parseFloat(node[3]) || 0;
}

function dist2d(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
}

function q3(v) {
    return Math.round(v * 1000) / 1000;
}

function qPt(p) {
    return [q3(p[0]), q3(p[1])];
}

// ---- Arc math ----

function arcFromThreePoints(start, mid, end) {
    const ax = start[0], ay = start[1];
    const bx = mid[0], by = mid[1];
    const cx = end[0], cy = end[1];

    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-10) return null; // degenerate

    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    const radius = Math.sqrt((ax - ux) * (ax - ux) + (ay - uy) * (ay - uy));

    let a0 = Math.atan2(ay - uy, ax - ux);
    let a1 = Math.atan2(by - uy, bx - ux);
    let a2 = Math.atan2(cy - uy, cx - ux);

    let sweep = a2 - a0;
    let midTest = a1 - a0;
    if (midTest > Math.PI) midTest -= 2 * Math.PI;
    if (midTest < -Math.PI) midTest += 2 * Math.PI;
    if (sweep > Math.PI) sweep -= 2 * Math.PI;
    if (sweep < -Math.PI) sweep += 2 * Math.PI;
    if ((midTest > 0) !== (sweep > 0)) {
        sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
    }

    return {
        center: [q3(ux), q3(uy)],
        radius: q3(radius),
        startAngle: a0,
        endAngle: a0 + sweep
    };
}

function linearizeArc(start, mid, end, numSegs) {
    const arc = arcFromThreePoints(start, mid, end);
    if (!arc) return [start, mid, end];

    const points = [];
    const sweep = arc.endAngle - arc.startAngle;
    for (let i = 0; i <= numSegs; i++) {
        const t = i / numSegs;
        const angle = arc.startAngle + sweep * t;
        points.push([arc.center[0] + arc.radius * Math.cos(angle),
                      arc.center[1] + arc.radius * Math.sin(angle)]);
    }
    return points;
}

// ---- Extract board outline ----

function extractOutline(tree) {
    const edges = findAll(tree, 'gr_line').concat(findAll(tree, 'gr_arc')).concat(findAll(tree, 'gr_rect'));
    const outlineEdges = edges.filter(e => val(e, 'layer') === 'Edge.Cuts');

    const segments = [];
    for (const e of outlineEdges) {
        if (e[0] === 'gr_line') {
            const start = xyVal(find(e, 'start'));
            const end = xyVal(find(e, 'end'));
            if (start && end) segments.push({ start, end, points: [start, end] });
        } else if (e[0] === 'gr_arc') {
            const start = xyVal(find(e, 'start'));
            const mid = xyVal(find(e, 'mid'));
            const end = xyVal(find(e, 'end'));
            if (start && mid && end) {
                const pts = linearizeArc(start, mid, end, 8);
                segments.push({ start, end, points: pts });
            }
        } else if (e[0] === 'gr_rect') {
            const start = xyVal(find(e, 'start'));
            const end = xyVal(find(e, 'end'));
            if (start && end) {
                const tl = start, br = end;
                const tr = [br[0], tl[1]], bl = [tl[0], br[1]];
                return [tl, tr, br, bl, tl];
            }
        }
    }

    if (segments.length === 0) return [];

    const points = [];
    for (let k = 0; k < segments[0].points.length; k++) {
        points.push(segments[0].points[k]);
    }
    let current = segments[0].end;
    const used = new Set([0]);

    for (let iter = 0; iter < segments.length; iter++) {
        let found = false;
        for (let i = 0; i < segments.length; i++) {
            if (used.has(i)) continue;
            const s = segments[i];
            if (dist2d(current, s.start) < 0.05) {
                for (let k = 1; k < s.points.length; k++) points.push(s.points[k]);
                current = s.end;
                used.add(i);
                found = true;
                break;
            }
            if (dist2d(current, s.end) < 0.05) {
                for (let k = s.points.length - 2; k >= 0; k--) points.push(s.points[k]);
                current = s.start;
                used.add(i);
                found = true;
                break;
            }
        }
        if (!found) break;
    }

    return points;
}

// ---- Extract nets ----

function extractNets(tree) {
    const nets = {};
    for (const n of findAll(tree, 'net')) {
        nets[n[1]] = (n[2] || '').replace(/\{slash\}/g, '/');
    }
    return nets;
}

// ---- Extract layer definitions ----

function extractLayerDefs(root) {
    const layersNode = find(root, 'layers');
    if (!layersNode) return [];
    const layers = [];
    for (let i = 1; i < layersNode.length; i++) {
        const entry = layersNode[i];
        if (!Array.isArray(entry)) continue;
        const ordinal = parseInt(entry[0]);
        const name = entry[1] || '';
        const type = entry[2] || 'user';
        const userName = entry[3] || null;
        layers.push({ ordinal, name, type, ...(userName ? { userName } : {}) });
    }
    return layers;
}

// ---- Extract setup / stackup ----

function extractSetup(root) {
    const setupNode = find(root, 'setup');
    if (!setupNode) return null;

    const setup = {};

    // Stackup
    const stackupNode = find(setupNode, 'stackup');
    if (stackupNode) {
        const stackLayers = [];
        for (const layerNode of findAll(stackupNode, 'layer')) {
            const entry = { name: layerNode[1] || '' };
            const type = val(layerNode, 'type');
            if (type) entry.type = type;
            const thickness = numVal(layerNode, 'thickness');
            if (thickness != null) entry.thickness = thickness;
            const material = val(layerNode, 'material');
            if (material) entry.material = material;
            const epsilonR = numVal(layerNode, 'epsilon_r');
            if (epsilonR != null) entry.epsilonR = epsilonR;
            const lossTangent = numVal(layerNode, 'loss_tangent');
            if (lossTangent != null) entry.lossTangent = lossTangent;
            const color = val(layerNode, 'color');
            if (color) entry.color = color;
            stackLayers.push(entry);
        }
        if (stackLayers.length > 0) setup.stackup = stackLayers;

        const copperFinish = val(stackupNode, 'copper_finish');
        if (copperFinish) setup.copperFinish = copperFinish;
    }

    // Design rules
    const padToMask = numVal(setupNode, 'pad_to_mask_clearance');
    if (padToMask != null) setup.padToMaskClearance = padToMask;
    const solderMaskMinWidth = numVal(setupNode, 'solder_mask_min_width');
    if (solderMaskMinWidth != null) setup.solderMaskMinWidth = solderMaskMinWidth;

    return Object.keys(setup).length > 0 ? setup : null;
}

// ---- Extract title block ----

function extractTitleBlock(root) {
    const tb = find(root, 'title_block');
    if (!tb) return null;
    const result = {};
    const title = val(tb, 'title');
    if (title) result.title = title;
    const rev = val(tb, 'rev');
    if (rev) result.rev = rev;
    const company = val(tb, 'company');
    if (company) result.company = company;
    const date = val(tb, 'date');
    if (date) result.date = date;
    for (const c of findAll(tb, 'comment')) {
        if (!result.comments) result.comments = {};
        result.comments[c[1]] = c[2] || '';
    }
    return Object.keys(result).length > 0 ? result : null;
}

// ---- Extract net classes ----

function extractNetClasses(root) {
    const classes = [];
    for (const nc of findAll(root, 'net_class')) {
        const entry = { name: nc[1] || 'Default', description: nc[2] || '' };
        const clearance = numVal(nc, 'clearance');
        if (clearance != null) entry.clearance = clearance;
        const traceWidth = numVal(nc, 'trace_width');
        if (traceWidth != null) entry.traceWidth = traceWidth;
        const viaDia = numVal(nc, 'via_dia');
        if (viaDia != null) entry.viaDia = viaDia;
        const viaDrill = numVal(nc, 'via_drill');
        if (viaDrill != null) entry.viaDrill = viaDrill;
        const uviaDia = numVal(nc, 'uvia_dia');
        if (uviaDia != null) entry.uviaDia = uviaDia;
        const uviaDrill = numVal(nc, 'uvia_drill');
        if (uviaDrill != null) entry.uviaDrill = uviaDrill;
        const dpWidth = numVal(nc, 'diff_pair_width');
        if (dpWidth != null) entry.diffPairWidth = dpWidth;
        const dpGap = numVal(nc, 'diff_pair_gap');
        if (dpGap != null) entry.diffPairGap = dpGap;
        const nets = [];
        for (const an of findAll(nc, 'add_net')) {
            if (an[1]) nets.push(an[1]);
        }
        if (nets.length > 0) entry.nets = nets;
        classes.push(entry);
    }
    return classes;
}

// ---- Extract individual segments (V2: no merging) ----

function extractSegments(root) {
    const segments = [];
    let id = 0;
    for (const seg of findAll(root, 'segment')) {
        const start = xyVal(find(seg, 'start'));
        const end = xyVal(find(seg, 'end'));
        const width = numVal(seg, 'width') || 0.25;
        const layer = val(seg, 'layer') || 'F.Cu';
        const net = parseInt(val(seg, 'net') || '0');
        if (start && end) {
            segments.push({ id: id++, start: qPt(start), end: qPt(end), width: q3(width), layer, net });
        }
    }
    return { segments, nextId: id };
}

// ---- Extract arcs (V2: preserve arc geometry) ----

function extractArcs(root, startId) {
    const arcs = [];
    let id = startId;
    for (const arcNode of findAll(root, 'arc')) {
        const start = xyVal(find(arcNode, 'start'));
        const mid = xyVal(find(arcNode, 'mid'));
        const end = xyVal(find(arcNode, 'end'));
        const width = numVal(arcNode, 'width') || 0.25;
        const layer = val(arcNode, 'layer') || 'F.Cu';
        const net = parseInt(val(arcNode, 'net') || '0');
        if (start && mid && end) {
            const computed = arcFromThreePoints(start, mid, end);
            const arc = {
                id: id++,
                start: qPt(start),
                mid: qPt(mid),
                end: qPt(end),
                width: q3(width),
                layer,
                net
            };
            if (computed) {
                arc.center = computed.center;
                arc.radius = computed.radius;
                arc.startAngle = q3(computed.startAngle);
                arc.endAngle = q3(computed.endAngle);
            }
            arcs.push(arc);
        }
    }
    return arcs;
}

// ---- Extract vias ----

function extractVias(tree) {
    const vias = [];
    for (const v of findAll(tree, 'via')) {
        const pos = xyVal(find(v, 'at'));
        const size = numVal(v, 'size') || 0.8;
        const drill = numVal(v, 'drill') || 0.4;
        const net = parseInt(val(v, 'net') || '0');
        const layersNode = find(v, 'layers');
        const layers = layersNode ? layersNode.slice(1) : ['F.Cu', 'B.Cu'];
        if (pos) {
            vias.push({ pos: qPt(pos), size: q3(size), drill: q3(drill), net, layers });
        }
    }
    return vias;
}

// ---- Extract zones with triangulation ----

function extractZones(root) {
    const zones = [];
    for (const z of findAll(root, 'zone')) {
        const net = parseInt(val(z, 'net') || '0');
        const netName = (val(z, 'net_name') || '').replace(/\{slash\}/g, '/');
        const layer = val(z, 'layer') || '';
        const priority = numVal(z, 'priority') || 0;
        const minThickness = numVal(z, 'min_thickness') || 0.254;

        // Fill settings
        const fillNode = find(z, 'fill');
        const fillEnabled = fillNode ? fillNode[1] === 'yes' : false;
        const thermalGap = fillNode ? numVal(fillNode, 'thermal_gap') : null;
        const thermalBridge = fillNode ? numVal(fillNode, 'thermal_bridge_width') : null;

        // Connect pads
        const connectNode = find(z, 'connect_pads');
        const connectPads = connectNode ? connectNode[1] === 'yes' : true;
        const clearance = connectNode ? numVal(connectNode, 'clearance') : null;

        // Zone outline polygon
        const polyNode = find(z, 'polygon');
        const outlinePoints = [];
        if (polyNode) {
            const ptsNode = find(polyNode, 'pts');
            if (ptsNode) {
                for (const xy of findAll(ptsNode, 'xy')) {
                    const pt = xyVal(xy);
                    if (pt) outlinePoints.push(qPt(pt));
                }
            }
        }

        // Filled polygons (computed fill results from KiCad DRC)
        const filledPolygons = [];
        for (const fp of findAll(z, 'filled_polygon')) {
            const fpLayer = val(fp, 'layer') || layer;
            const ptsNode = find(fp, 'pts');
            const points = [];
            if (ptsNode) {
                for (const xy of findAll(ptsNode, 'xy')) {
                    const pt = xyVal(xy);
                    if (pt) points.push(qPt(pt));
                }
            }
            if (points.length >= 3) {
                // Triangulate using earcut
                const flat = [];
                for (const p of points) {
                    flat.push(p[0], p[1]);
                }
                const triangles = earcut(flat);
                filledPolygons.push({ layer: fpLayer, points, triangles });
            }
        }

        const zone = { net, netName, layer, priority, fillEnabled };
        if (minThickness !== 0.254) zone.minThickness = minThickness;
        if (thermalGap != null) zone.thermalGap = thermalGap;
        if (thermalBridge != null) zone.thermalBridgeWidth = thermalBridge;
        if (clearance != null) zone.clearance = clearance;
        zone.connectPads = connectPads;
        if (outlinePoints.length > 0) zone.outline = outlinePoints;
        if (filledPolygons.length > 0) zone.filledPolygons = filledPolygons;

        zones.push(zone);
    }
    return zones;
}

// ---- Extract board-level drawings (ALL gr_* on ALL layers) ----

function extractDrawings(root) {
    const drawings = [];

    for (const e of findAll(root, 'gr_line')) {
        const layer = val(e, 'layer');
        if (layer === 'Edge.Cuts') continue; // outline handled separately
        const start = xyVal(find(e, 'start'));
        const end = xyVal(find(e, 'end'));
        const width = numVal(e, 'width') || numVal(e, 'stroke_width') || 0.1;
        if (start && end) {
            drawings.push({ type: 'line', start: qPt(start), end: qPt(end), width: q3(width), layer });
        }
    }

    for (const e of findAll(root, 'gr_circle')) {
        const center = xyVal(find(e, 'center'));
        const end = xyVal(find(e, 'end'));
        const width = numVal(e, 'width') || numVal(e, 'stroke_width') || 0.1;
        const layer = val(e, 'layer');
        const fillNode = find(e, 'fill');
        const fill = fillNode ? val(fillNode, 'type') || fillNode[1] : 'none';
        if (center && end) {
            const radius = q3(dist2d(center, end));
            drawings.push({ type: 'circle', center: qPt(center), radius, width: q3(width), layer, fill });
        }
    }

    for (const e of findAll(root, 'gr_arc')) {
        const layer = val(e, 'layer');
        if (layer === 'Edge.Cuts') continue;
        const start = xyVal(find(e, 'start'));
        const mid = xyVal(find(e, 'mid'));
        const end = xyVal(find(e, 'end'));
        const width = numVal(e, 'width') || numVal(e, 'stroke_width') || 0.1;
        if (start && mid && end) {
            const arc = { type: 'arc', start: qPt(start), mid: qPt(mid), end: qPt(end), width: q3(width), layer };
            const computed = arcFromThreePoints(start, mid, end);
            if (computed) {
                arc.center = computed.center;
                arc.radius = computed.radius;
                arc.startAngle = q3(computed.startAngle);
                arc.endAngle = q3(computed.endAngle);
            }
            drawings.push(arc);
        }
    }

    for (const e of findAll(root, 'gr_rect')) {
        const layer = val(e, 'layer');
        if (layer === 'Edge.Cuts') continue;
        const start = xyVal(find(e, 'start'));
        const end = xyVal(find(e, 'end'));
        const width = numVal(e, 'width') || numVal(e, 'stroke_width') || 0.1;
        const fillNode = find(e, 'fill');
        const fill = fillNode ? val(fillNode, 'type') || fillNode[1] : 'none';
        if (start && end) {
            drawings.push({ type: 'rect', start: qPt(start), end: qPt(end), width: q3(width), layer, fill });
        }
    }

    for (const e of findAll(root, 'gr_poly')) {
        const layer = val(e, 'layer');
        const width = numVal(e, 'width') || numVal(e, 'stroke_width') || 0.1;
        const fillNode = find(e, 'fill');
        const fill = fillNode ? val(fillNode, 'type') || fillNode[1] : 'none';
        const ptsNode = find(e, 'pts');
        const points = [];
        if (ptsNode) {
            for (const xy of findAll(ptsNode, 'xy')) {
                const pt = xyVal(xy);
                if (pt) points.push(qPt(pt));
            }
        }
        if (points.length >= 2) {
            drawings.push({ type: 'poly', points, width: q3(width), layer, fill });
        }
    }

    for (const e of findAll(root, 'gr_text')) {
        const text = e[1] || '';
        const atNode = find(e, 'at');
        const pos = atNode ? xyVal(atNode) : null;
        const rot = atNode ? rotVal(atNode) : 0;
        const layer = val(e, 'layer');
        const effects = find(e, 'effects');
        let fontSize = [1, 1], fontThickness = 0.15;
        if (effects) {
            const font = find(effects, 'font');
            if (font) {
                const sizeNode = find(font, 'size');
                if (sizeNode) fontSize = [parseFloat(sizeNode[1]) || 1, parseFloat(sizeNode[2]) || 1];
                const thk = numVal(font, 'thickness');
                if (thk != null) fontThickness = thk;
            }
        }
        if (pos) {
            drawings.push({ type: 'text', text, pos: qPt(pos), rot, layer, fontSize, fontThickness });
        }
    }

    return drawings;
}

// ---- Extract footprints (V2: full graphics, models, all text) ----

function shortName(fullName) {
    const parts = fullName.split(':');
    const name = parts[parts.length - 1];
    return name.replace(/_\d+Metric.*$/, '');
}

function extractTextProps(textNode) {
    const effects = find(textNode, 'effects');
    const result = {};
    if (effects) {
        const font = find(effects, 'font');
        if (font) {
            const sizeNode = find(font, 'size');
            if (sizeNode) result.fontSize = [parseFloat(sizeNode[1]) || 1, parseFloat(sizeNode[2]) || 1];
            const thk = numVal(font, 'thickness');
            if (thk != null) result.fontThickness = thk;
            if (find(font, 'bold')) result.bold = true;
            if (find(font, 'italic')) result.italic = true;
        }
        const justifyNode = find(effects, 'justify');
        if (justifyNode) {
            result.justify = justifyNode.slice(1).filter(j => typeof j === 'string');
        }
        if (find(effects, 'hide')) result.hidden = true;
    }
    return result;
}

function extractFootprints(root) {
    const footprints = [];
    const fpNodes = findAll(root, 'footprint').concat(findAll(root, 'module'));

    for (const fp of fpNodes) {
        const name = fp[1] || '';
        const atNode = find(fp, 'at');
        const pos = atNode ? xyVal(atNode) : [0, 0];
        const rot = atNode ? rotVal(atNode) : 0;
        const layer = val(fp, 'layer') || 'F.Cu';

        // Reference and value from fp_text (KiCad 6-) or property (KiCad 7+)
        let ref = '', value = '';
        const texts = [];

        for (const prop of findAll(fp, 'fp_text')) {
            const textType = prop[1]; // reference, value, user
            const textContent = prop[2] || '';
            if (textType === 'reference') ref = textContent;
            if (textType === 'value') value = textContent;
            const textAt = find(prop, 'at');
            const textPos = textAt ? xyVal(textAt) : [0, 0];
            const textRot = textAt ? rotVal(textAt) : 0;
            const textLayer = val(prop, 'layer') || layer;
            const textProps = extractTextProps(prop);
            texts.push({
                type: textType,
                text: textContent,
                pos: qPt(textPos),
                rot: textRot,
                layer: textLayer,
                ...textProps
            });
        }

        for (const prop of findAll(fp, 'property')) {
            const propName = prop[1];
            const propVal = prop[2] || '';
            if (propName === 'Reference') ref = propVal;
            if (propName === 'Value') value = propVal;
            const textAt = find(prop, 'at');
            if (textAt) {
                const textPos = xyVal(textAt);
                const textRot = rotVal(textAt);
                const textLayer = val(prop, 'layer') || layer;
                const textProps = extractTextProps(prop);
                texts.push({
                    type: propName.toLowerCase(),
                    text: propVal,
                    pos: textPos ? qPt(textPos) : [0, 0],
                    rot: textRot,
                    layer: textLayer,
                    ...textProps
                });
            }
        }

        // Pads
        const pads = [];
        for (const p of findAll(fp, 'pad')) {
            const padNumber = p[1] || '';
            const padType = p[2] || 'smd';
            const padShape = p[3] || 'rect';
            const padAt = find(p, 'at');
            const padPos = padAt ? xyVal(padAt) : [0, 0];
            const padRot = padAt ? rotVal(padAt) : 0;
            const padSize = find(p, 'size');
            const size = padSize ? [parseFloat(padSize[1]), parseFloat(padSize[2])] : [1, 1];
            const drillNode = find(p, 'drill');
            const drill = drillNode ? parseFloat(drillNode[1]) : null;
            const netNode = find(p, 'net');
            const padNet = netNode ? parseInt(netNode[1] || '0') : 0;
            const padNetName = netNode && netNode[2] ? netNode[2].replace(/\{slash\}/g, '/') : '';
            const pinFunc = val(p, 'pinfunction') || '';
            const pinType = val(p, 'pintype') || '';
            const layersNode = find(p, 'layers');
            const padLayers = layersNode ? layersNode.slice(1) : [];
            const rratio = numVal(p, 'roundrect_rratio');

            const pad = {
                number: padNumber,
                pos: qPt(padPos),
                rot: padRot,
                size: [q3(size[0]), q3(size[1])],
                shape: padShape,
                type: padType,
                net: padNet,
                netName: padNetName,
                drill,
                layers: padLayers
            };
            if (pinFunc) pad.pinFunction = pinFunc;
            if (pinType) pad.pinType = pinType;
            if (rratio != null) pad.roundrectRatio = rratio;
            pads.push(pad);
        }

        // Footprint graphics (fp_line, fp_circle, fp_arc, fp_poly on ALL layers)
        const graphics = [];

        for (const line of findAll(fp, 'fp_line')) {
            const lineLayer = val(line, 'layer') || '';
            const start = xyVal(find(line, 'start'));
            const end = xyVal(find(line, 'end'));
            const width = numVal(line, 'width') || numVal(line, 'stroke_width') || 0.1;
            if (start && end) {
                graphics.push({ type: 'line', start: qPt(start), end: qPt(end), width: q3(width), layer: lineLayer });
            }
        }

        for (const circle of findAll(fp, 'fp_circle')) {
            const circleLayer = val(circle, 'layer') || '';
            const center = xyVal(find(circle, 'center'));
            const end = xyVal(find(circle, 'end'));
            const width = numVal(circle, 'width') || numVal(circle, 'stroke_width') || 0.1;
            const fillNode = find(circle, 'fill');
            const fill = fillNode ? val(fillNode, 'type') || fillNode[1] : 'none';
            if (center && end) {
                const radius = q3(dist2d(center, end));
                graphics.push({ type: 'circle', center: qPt(center), radius, width: q3(width), layer: circleLayer, fill });
            }
        }

        for (const arcNode of findAll(fp, 'fp_arc')) {
            const arcLayer = val(arcNode, 'layer') || '';
            const start = xyVal(find(arcNode, 'start'));
            const mid = xyVal(find(arcNode, 'mid'));
            const end = xyVal(find(arcNode, 'end'));
            const width = numVal(arcNode, 'width') || numVal(arcNode, 'stroke_width') || 0.1;
            if (start && mid && end) {
                const g = { type: 'arc', start: qPt(start), mid: qPt(mid), end: qPt(end), width: q3(width), layer: arcLayer };
                const computed = arcFromThreePoints(start, mid, end);
                if (computed) {
                    g.center = computed.center;
                    g.radius = computed.radius;
                    g.startAngle = q3(computed.startAngle);
                    g.endAngle = q3(computed.endAngle);
                }
                graphics.push(g);
            }
        }

        for (const polyNode of findAll(fp, 'fp_poly')) {
            const polyLayer = val(polyNode, 'layer') || '';
            const width = numVal(polyNode, 'width') || numVal(polyNode, 'stroke_width') || 0.1;
            const fillNode = find(polyNode, 'fill');
            const fill = fillNode ? val(fillNode, 'type') || fillNode[1] : 'none';
            const ptsNode = find(polyNode, 'pts');
            const points = [];
            if (ptsNode) {
                for (const xy of findAll(ptsNode, 'xy')) {
                    const pt = xyVal(xy);
                    if (pt) points.push(qPt(pt));
                }
            }
            if (points.length >= 2) {
                graphics.push({ type: 'poly', points, width: q3(width), layer: polyLayer, fill });
            }
        }

        // 3D model references
        const models = [];
        for (const m of findAll(fp, 'model')) {
            const path = m[1] || '';
            const offset = find(m, 'offset');
            const scale = find(m, 'scale');
            const rotate = find(m, 'rotate');
            models.push({
                path,
                offset: offset ? xyzVal(find(offset, 'xyz')) : [0, 0, 0],
                scale: scale ? xyzVal(find(scale, 'xyz')) : [1, 1, 1],
                rotate: rotate ? xyzVal(find(rotate, 'xyz')) : [0, 0, 0]
            });
        }

        const fpOut = {
            name: shortName(name),
            ref: ref || name,
            value,
            pos: qPt(pos),
            rot,
            layer,
            pads,
            graphics,
            texts
        };
        if (models.length > 0) fpOut.models = models;
        footprints.push(fpOut);
    }

    return footprints;
}

// ---- Segment ordering (BFS from power nets) ----

function isPowerNet(name) {
    if (!name) return false;
    return /^(GND|VCC|VDD|VBUS|VIN|\+\d|V\d)/i.test(name) || /gnd/i.test(name);
}

function computeSegmentOrder(segments, arcs, vias, footprints, nets) {
    const K = 10000;
    const keyFn = p => Math.round(p[0] * K) + ',' + Math.round(p[1] * K);

    // Build node graph: each node is a quantized position, edges are segment/arc IDs
    const nodeEdges = new Map(); // key -> [{ id, otherKey }]
    const addEdge = (p1, p2, id) => {
        const k1 = keyFn(p1), k2 = keyFn(p2);
        if (!nodeEdges.has(k1)) nodeEdges.set(k1, []);
        if (!nodeEdges.has(k2)) nodeEdges.set(k2, []);
        nodeEdges.get(k1).push({ id, otherKey: k2 });
        nodeEdges.get(k2).push({ id, otherKey: k1 });
    };

    for (const seg of segments) addEdge(seg.start, seg.end, seg.id);
    for (const arc of arcs) addEdge(arc.start, arc.end, arc.id);

    // Via connectivity: vias connect layers at same position
    const viaKeys = new Set();
    for (const v of vias) viaKeys.add(keyFn(v.pos));

    // Find power net pad positions as BFS seeds
    const powerSeeds = new Set();
    for (const fp of footprints) {
        const fpx = fp.pos[0], fpy = fp.pos[1];
        const rot = (fp.rot || 0) * Math.PI / 180;
        const cosR = Math.cos(rot), sinR = Math.sin(rot);
        for (const pad of fp.pads) {
            const netName = nets[pad.net] || pad.netName || '';
            if (isPowerNet(netName)) {
                const rx = pad.pos[0] * cosR - pad.pos[1] * sinR;
                const ry = pad.pos[0] * sinR + pad.pos[1] * cosR;
                powerSeeds.add(keyFn([fpx + rx, fpy + ry]));
            }
        }
    }

    // Also add power via positions
    for (const v of vias) {
        const netName = nets[v.net] || '';
        if (isPowerNet(netName)) powerSeeds.add(keyFn(v.pos));
    }

    // BFS from power seeds
    const visited = new Set();
    const order = [];
    const queue = [...powerSeeds];
    const visitedNodes = new Set(powerSeeds);

    while (queue.length > 0) {
        const nextQueue = [];
        for (const nodeKey of queue) {
            const edges = nodeEdges.get(nodeKey) || [];
            for (const edge of edges) {
                if (visited.has(edge.id)) continue;
                visited.add(edge.id);
                order.push(edge.id);
                if (!visitedNodes.has(edge.otherKey)) {
                    visitedNodes.add(edge.otherKey);
                    nextQueue.push(edge.otherKey);
                }
            }
        }
        queue.length = 0;
        queue.push(...nextQueue);
    }

    // Append any segments not reached by BFS (disconnected nets)
    for (const seg of segments) {
        if (!visited.has(seg.id)) order.push(seg.id);
    }
    for (const arc of arcs) {
        if (!visited.has(arc.id)) order.push(arc.id);
    }

    // Group by layer
    const idToLayer = new Map();
    for (const seg of segments) idToLayer.set(seg.id, seg.layer);
    for (const arc of arcs) idToLayer.set(arc.id, arc.layer);

    const byLayer = {};
    for (const id of order) {
        const layer = idToLayer.get(id) || 'F.Cu';
        if (!byLayer[layer]) byLayer[layer] = [];
        byLayer[layer].push(id);
    }

    return byLayer;
}

// ---- Build simulation netlist ----

function parseComponentValue(valueStr) {
    if (!valueStr || valueStr === '~') return null;
    const cleaned = valueStr.trim();
    const m = cleaned.match(/^([0-9]*\.?[0-9]+)\s*([kKMmuUnNpP]?)\s*([oO]hm|\u03A9|[FHVfhv])?/);
    if (!m) return null;
    const num = parseFloat(m[1]);
    if (isNaN(num)) return null;
    const suffix = m[2];
    let multiplier = 1;
    switch (suffix) {
        case 'k': case 'K': multiplier = 1e3; break;
        case 'M': multiplier = 1e6; break;
        case 'm': multiplier = 1e-3; break;
        case 'u': case 'U': multiplier = 1e-6; break;
        case 'n': case 'N': multiplier = 1e-9; break;
        case 'p': case 'P': multiplier = 1e-12; break;
    }
    return num * multiplier;
}

function componentTypeFromRef(ref) {
    if (!ref) return null;
    const prefix = ref.replace(/[0-9]+$/, '');
    switch (prefix) {
        case 'R': return 'R';
        case 'C': return 'C';
        case 'D': return 'LED';
        case 'L': return 'L';
        case 'U': return 'IC';
        case 'J': return 'connector';
        default: return null;
    }
}

function buildSimulation(footprints, nets) {
    const elements = [];
    const groundNets = [];

    for (const [id, name] of Object.entries(nets)) {
        if (name && /gnd/i.test(name)) groundNets.push(name);
    }

    for (const fp of footprints) {
        const type = componentTypeFromRef(fp.ref);
        if (!type) continue;
        const parsedValue = parseComponentValue(fp.value);

        const pins = [];
        for (const pad of fp.pads) {
            if (pad.net === 0 || !pad.netName) continue;
            pins.push({ number: pad.number, net: pad.netName });
        }

        if (pins.length !== 2) continue;
        if (type === 'IC' || type === 'connector') continue;

        elements.push({ type, ref: fp.ref, value: parsedValue, pins });
    }

    return { elements, groundNets };
}

// ---- Exported conversion function (V2) ----

export function convertKiCadPcb(raw) {
    const tokens = tokenize(raw);
    const tree = parse(tokens);
    const root = Array.isArray(tree) && tree[0] === 'kicad_pcb' ? tree : tree[0];

    const outline = extractOutline(root);
    const thickness = numVal(find(root, 'general'), 'thickness') || 1.6;
    const nets = extractNets(root);
    const layers = extractLayerDefs(root);
    const setup = extractSetup(root);
    const titleBlock = extractTitleBlock(root);
    const netClasses = extractNetClasses(root);
    const { segments, nextId } = extractSegments(root);
    const arcs = extractArcs(root, nextId);
    const vias = extractVias(root);
    const footprints = extractFootprints(root);
    const zones = extractZones(root);
    const drawings = extractDrawings(root);
    const simulation = buildSimulation(footprints, nets);
    const segmentOrder = computeSegmentOrder(segments, arcs, vias, footprints, nets);

    const output = {
        version: 2,
        board: {
            outline,
            thickness,
            layers,
            ...(setup ? { setup } : {}),
            ...(titleBlock ? { titleBlock } : {})
        },
        nets,
        ...(netClasses.length > 0 ? { netClasses } : {}),
        segments,
        arcs,
        vias,
        footprints,
        ...(zones.length > 0 ? { zones } : {}),
        ...(drawings.length > 0 ? { drawings } : {}),
        segmentOrder,
        simulation
    };

    const stats = {
        version: 2,
        outline: outline.length + ' points',
        segments: segments.length,
        arcs: arcs.length,
        layers: [...new Set(segments.map(s => s.layer).concat(arcs.map(a => a.layer)))],
        vias: vias.length,
        footprints: footprints.length,
        zones: zones.length,
        drawings: drawings.length,
        nets: Object.keys(nets).length,
        netClasses: netClasses.length,
        simElements: simulation.elements.length,
        groundNets: simulation.groundNets.length
    };

    return { output, stats };
}
