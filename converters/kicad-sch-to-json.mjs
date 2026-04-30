#!/usr/bin/env node
// kicad-sch-to-json.mjs
// Convert KiCad .kicad_sch S-expression schematic files to compact JSON.
// Usage: node scripts/kicad-sch-to-json.mjs path/to/schematic.kicad_sch > schematic.json
// Stats to stderr, JSON to stdout.

import { readFileSync } from 'fs';

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
    // (at x y [rot]) or (start x y) or (end x y) or (xy x y)
    if (!Array.isArray(node) || node.length < 3) return null;
    return [parseFloat(node[1]), parseFloat(node[2])];
}

function rotVal(node) {
    if (!Array.isArray(node) || node.length < 4) return 0;
    return parseFloat(node[3]) || 0;
}

// ---- Extract lib_symbols ----

function extractLibSymbols(tree) {
    const libSymNode = find(tree, 'lib_symbols');
    if (!libSymNode) return {};

    const symbols = {};
    for (const symNode of findAll(libSymNode, 'symbol')) {
        const symName = symNode[1];
        if (!symName) continue;

        const graphics = [];
        const pins = [];

        // Collect from all sub-symbols (e.g. SymbolName_0_1, SymbolName_1_1)
        // Sub-symbols are nested (symbol ...) nodes inside this symbol
        const subSymbols = findAll(symNode, 'symbol');

        // Also check the symbol node itself for direct graphics/pins (rare)
        const sources = [symNode, ...subSymbols];

        for (const src of sources) {
            // Polylines
            for (const pl of findAll(src, 'polyline')) {
                const ptsNode = find(pl, 'pts');
                if (!ptsNode) continue;
                const points = [];
                for (const xy of findAll(ptsNode, 'xy')) {
                    const p = xyVal(xy);
                    if (p) points.push(p);
                }
                if (points.length > 0) {
                    graphics.push({ type: 'polyline', points });
                }
            }

            // Rectangles
            for (const rect of findAll(src, 'rectangle')) {
                const start = xyVal(find(rect, 'start'));
                const end = xyVal(find(rect, 'end'));
                if (start && end) {
                    graphics.push({ type: 'rectangle', start, end });
                }
            }

            // Arcs
            for (const arc of findAll(src, 'arc')) {
                const start = xyVal(find(arc, 'start'));
                const mid = xyVal(find(arc, 'mid'));
                const end = xyVal(find(arc, 'end'));
                if (start && mid && end) {
                    graphics.push({ type: 'arc', start, mid, end });
                }
            }

            // Circles
            for (const circ of findAll(src, 'circle')) {
                const center = xyVal(find(circ, 'center'));
                const radius = numVal(circ, 'radius');
                if (center && radius != null) {
                    graphics.push({ type: 'circle', center, radius });
                }
            }

            // Pins: (pin type direction (at x y rot) (length l) (name "n") (number "n"))
            for (const pin of findAll(src, 'pin')) {
                const pinType = pin[1] || '';    // power_in, passive, etc.
                // pin[2] is the direction (line, etc.) - skip
                const atNode = find(pin, 'at');
                const pos = atNode ? xyVal(atNode) : [0, 0];
                const rot = atNode ? rotVal(atNode) : 0;
                const length = numVal(pin, 'length') || 0;
                const nameNode = find(pin, 'name');
                const name = nameNode ? nameNode[1] || '' : '';
                const numNode = find(pin, 'number');
                const number = numNode ? numNode[1] || '' : '';
                pins.push({ pos, rot, length, name, number, type: pinType });
            }
        }

        symbols[symName] = { graphics, pins };
    }

    return symbols;
}

// ---- Extract placed symbol instances ----

function extractInstances(tree) {
    const instances = [];

    for (const node of findAll(tree, 'symbol')) {
        const libId = val(node, 'lib_id');
        if (!libId) continue; // skip lib_symbols sub-symbols (they don't have lib_id)

        const atNode = find(node, 'at');
        const pos = atNode ? xyVal(atNode) : [0, 0];
        const rot = atNode ? rotVal(atNode) : 0;

        // Mirror
        const mirrorNode = find(node, 'mirror');
        const mirror = mirrorNode ? mirrorNode[1] || null : null;

        // Properties: Reference, Value
        let ref = '', value = '';
        for (const prop of findAll(node, 'property')) {
            if (prop[1] === 'Reference') ref = prop[2] || '';
            if (prop[1] === 'Value') value = prop[2] || '';
        }

        const inst = { lib_id: libId, pos, rot, ref, value };
        if (mirror) inst.mirror = mirror;
        instances.push(inst);
    }

    return instances;
}

// ---- Extract wires ----

function extractWires(tree) {
    const wires = [];
    for (const w of findAll(tree, 'wire')) {
        const ptsNode = find(w, 'pts');
        if (!ptsNode) continue;
        const points = [];
        for (const xy of findAll(ptsNode, 'xy')) {
            const p = xyVal(xy);
            if (p) points.push(p);
        }
        if (points.length >= 2) {
            wires.push({ points });
        }
    }
    return wires;
}

// ---- Extract junctions ----

function extractJunctions(tree) {
    const junctions = [];
    for (const j of findAll(tree, 'junction')) {
        const atNode = find(j, 'at');
        const pos = atNode ? xyVal(atNode) : null;
        if (pos) junctions.push(pos);
    }
    return junctions;
}

// ---- Extract labels (local, global, hierarchical) ----

function extractLabels(tree) {
    const labels = [];
    for (const tag of ['label', 'global_label', 'hierarchical_label']) {
        for (const l of findAll(tree, tag)) {
            const name = (l[1] || '').replace(/\{slash\}/g, '/');
            const atNode = find(l, 'at');
            const pos = atNode ? xyVal(atNode) : [0, 0];
            const rot = atNode ? rotVal(atNode) : 0;
            labels.push({ name, pos, rot, type: tag });
        }
    }
    return labels;
}

// ---- Extract power ports as labels ----
// Power symbols (GND, +5V, +3V3) are placed instances that define net names.
// Convert them to label entries so they participate in net propagation.

function extractPowerLabels(instances) {
    const labels = [];
    for (const inst of instances) {
        if (inst.ref.startsWith('#PWR') || inst.ref.startsWith('#FLG') ||
            inst.lib_id.startsWith('power:') || inst.lib_id.startsWith('Power:') ||
            inst.lib_id.startsWith('Power_Gnd:')) {
            if (inst.value) {
                labels.push({ name: inst.value, pos: inst.pos, rot: inst.rot || 0, type: 'power' });
            }
        }
    }
    return labels;
}

// ---- Coordinate-based net resolution via union-find ----

function resolveNets(wires, instances, symbols, labels) {
    // Union-Find with path compression and union by rank
    const parent = {};
    const rank = {};

    function makeSet(k) {
        if (!(k in parent)) {
            parent[k] = k;
            rank[k] = 0;
        }
    }

    function findRoot(k) {
        makeSet(k);
        while (parent[k] !== k) {
            parent[k] = parent[parent[k]]; // path compression
            k = parent[k];
        }
        return k;
    }

    function union(a, b) {
        makeSet(a);
        makeSet(b);
        const ra = findRoot(a);
        const rb = findRoot(b);
        if (ra === rb) return;
        if (rank[ra] < rank[rb]) { parent[ra] = rb; }
        else if (rank[ra] > rank[rb]) { parent[rb] = ra; }
        else { parent[rb] = ra; rank[ra]++; }
    }

    // Coordinate key with 0.01mm tolerance grid
    function coordKey(x, y) {
        return Math.round(x * 100) + ',' + Math.round(y * 100);
    }

    // 1. Connect wire endpoints: union all points within each wire
    for (const wire of wires) {
        if (wire.points.length < 2) continue;
        const k0 = coordKey(wire.points[0][0], wire.points[0][1]);
        for (let i = 1; i < wire.points.length; i++) {
            const ki = coordKey(wire.points[i][0], wire.points[i][1]);
            union(k0, ki);
        }
    }

    // 2. Compute pin world positions and union with wire endpoints
    // Build a map of pin world positions per instance for later pinNets assignment
    const instancePinPositions = []; // parallel to instances array
    for (const inst of instances) {
        const pinPositions = {}; // padNumber -> coordKey

        // Look up the lib symbol. KiCad sub-symbols use naming like "Device:R_0_1"
        // For an instance with lib_id "Device:R", we need pins from "Device:R" and its
        // sub-symbols "Device:R_0_1", "Device:R_1_1", etc.
        const libSym = symbols[inst.lib_id];
        if (libSym) {
            for (const pin of libSym.pins) {
                const [px, py] = pin.pos;
                // Apply rotation (degrees to radians), negative because KiCad rotation convention
                const rad = -inst.rot * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                // Handle mirror
                let mx = px, my = py;
                if (inst.mirror === 'x') my = -my;
                if (inst.mirror === 'y') mx = -mx;
                // Rotate
                const rx = mx * cos - my * sin;
                const ry = mx * sin + my * cos;
                // Translate to world
                const wx = inst.pos[0] + rx;
                const wy = inst.pos[1] + ry;

                const key = coordKey(wx, wy);
                makeSet(key);
                pinPositions[pin.number] = key;
            }
        }
        instancePinPositions.push(pinPositions);
    }

    // Pin-to-wire connectivity is implicit: pins and wire endpoints that share
    // the same coordinate key are already the same node in the union-find.
    // No explicit union needed since coordKey is the identity.

    // 3. Connect label positions to wire/pin groups
    // Labels at the same coordinate as a wire endpoint or pin are automatically
    // in the same union-find set via shared coordKey.
    for (const label of labels) {
        const key = coordKey(label.pos[0], label.pos[1]);
        makeSet(key);
    }

    // 4. Propagate label names through connected groups
    // Priority: global_label > power > label (local) > hierarchical_label
    const typePriority = {
        'global_label': 4,
        'power': 3,
        'label': 2,
        'hierarchical_label': 1
    };

    // Rebuild labelGroups after all unions are done (roots may have changed)
    const finalLabelGroups = {};
    for (const label of labels) {
        const key = coordKey(label.pos[0], label.pos[1]);
        const root = findRoot(key);
        if (!finalLabelGroups[root]) finalLabelGroups[root] = [];
        finalLabelGroups[root].push({ name: label.name, type: label.type });
    }

    // For each group root, pick the best label name
    const groupNetName = {}; // root -> net name
    let autoNetCounter = 0;

    function getNetName(root) {
        if (root in groupNetName) return groupNetName[root];
        const lbls = finalLabelGroups[root];
        if (lbls && lbls.length > 0) {
            // Sort by priority descending, pick first
            lbls.sort((a, b) => (typePriority[b.type] || 0) - (typePriority[a.type] || 0));
            groupNetName[root] = lbls[0].name;
        } else {
            groupNetName[root] = 'net_' + autoNetCounter++;
        }
        return groupNetName[root];
    }

    // 5. Assign nets to wires
    for (const wire of wires) {
        if (wire.points.length > 0) {
            const key = coordKey(wire.points[0][0], wire.points[0][1]);
            const root = findRoot(key);
            wire.net = getNetName(root);
        }
    }

    // 6. Assign pinNets to instances
    for (let i = 0; i < instances.length; i++) {
        const pinPositions = instancePinPositions[i];
        const pinNets = {};
        for (const padNum of Object.keys(pinPositions)) {
            const root = findRoot(pinPositions[padNum]);
            pinNets[padNum] = getNetName(root);
        }
        instances[i].pinNets = pinNets;
    }

    // Return stats
    const allRoots = new Set();
    for (const k of Object.keys(parent)) {
        allRoots.add(findRoot(k));
    }
    const namedNets = Object.values(groupNetName).filter(n => !n.startsWith('net_')).length;
    return {
        totalNets: allRoots.size,
        namedNets,
        autoNets: allRoots.size - namedNets
    };
}

// ---- Main ----

const inputPath = process.argv[2];
if (!inputPath) {
    console.error('Usage: node scripts/kicad-sch-to-json.mjs <path/to/schematic.kicad_sch>');
    process.exit(1);
}

const raw = readFileSync(inputPath, 'utf-8');
const tokens = tokenize(raw);
const tree = parse(tokens);

// The root should be (kicad_sch ...)
const root = Array.isArray(tree) && tree[0] === 'kicad_sch' ? tree : tree[0];

const symbols = extractLibSymbols(root);
const instances = extractInstances(root);
const wires = extractWires(root);
const junctions = extractJunctions(root);
const labels = extractLabels(root);
const powerLabels = extractPowerLabels(instances);
// Merge power labels into labels array
const allLabels = [...labels, ...powerLabels];

// Resolve nets via coordinate-based union-find
const netStats = resolveNets(wires, instances, symbols, allLabels);

const output = {
    symbols,
    instances,
    wires,
    junctions,
    labels: allLabels
};

// Stats
const stats = {
    libSymbols: Object.keys(symbols).length,
    instances: instances.length,
    wires: wires.length,
    junctions: junctions.length,
    labels: labels.length,
    globalLabels: labels.filter(l => l.type === 'global_label').length,
    powerLabels: powerLabels.length,
    nets: netStats
};
console.error('KiCad Schematic -> JSON:', JSON.stringify(stats));

console.log(JSON.stringify(output, null, 2));
