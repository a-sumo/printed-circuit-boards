#!/usr/bin/env node
/**
 * autoroute.mjs - Grid-based A* autorouter for KiCad PCB files.
 *
 * Reads a .kicad_pcb with placed footprints and net assignments, strips
 * existing traces, and routes all nets using A* pathfinding on a 2-layer grid.
 * Produces Manhattan + 45-degree traces that look like real PCB routing.
 *
 * Usage: node converters/autoroute.mjs input.kicad_pcb [output.kicad_pcb]
 *   If output is omitted, writes to input file (in-place).
 */

import { readFileSync, writeFileSync } from 'fs';

// ============================================================
// Configuration
// ============================================================
const GRID_RES = 0.20;       // mm per grid cell (finer for dense boards)
const VIA_COST = 15;         // penalty for layer change (lower = more willing to use vias, but higher completion rate)
const BEND_COST = 1;         // penalty for direction change
const DIAG_COST = 1.414;     // cost of diagonal step
const CLEARANCE = 0.10;      // mm clearance between traces
const VIA_DRILL = 0.4;
const VIA_SIZE = 0.8;

// Trace widths per net (mm)
const NET_WIDTHS = {
    1: 0.4,   // GND
    2: 0.4,   // VDD_12V
    3: 0.4,   // +5V
    17: 0.4,  // VIN
    4: 0.3,   // +3V3
    5: 0.25,  // LDO_3V3
    6: 0.25,  // VBUS
};
const DEFAULT_WIDTH = 0.25;

function traceWidth(net) { return NET_WIDTHS[net] || DEFAULT_WIDTH; }

// Route order: small signal nets first, power/GND last
function routeOrder(netPads) {
    const entries = [...netPads.entries()].filter(([net]) => net > 0);
    entries.sort((a, b) => {
        // Sort by pad count ascending (simple nets first)
        // Then by net number for stability
        if (a[1].length !== b[1].length) return a[1].length - b[1].length;
        return a[0] - b[0];
    });
    return entries;
}

// ============================================================
// S-expression parser (reused from kicad-to-json.mjs)
// ============================================================

function tokenize(input) {
    const tokens = [];
    let i = 0;
    const len = input.length;
    while (i < len) {
        const ch = input[i];
        if (ch === ';') {
            // skip comments
            while (i < len && input[i] !== '\n') i++;
            continue;
        }
        if (ch === '(' || ch === ')') { tokens.push(ch); i++; }
        else if (ch === '"') {
            let str = '';
            i++;
            while (i < len && input[i] !== '"') {
                if (input[i] === '\\' && i + 1 < len) { str += input[++i]; }
                else { str += input[i]; }
                i++;
            }
            i++;
            tokens.push(str);
        } else if (ch <= ' ') { i++; }
        else {
            let atom = '';
            while (i < len && input[i] !== '(' && input[i] !== ')' &&
                   input[i] !== ' ' && input[i] !== '\t' &&
                   input[i] !== '\n' && input[i] !== '\r' &&
                   input[i] !== '"') {
                atom += input[i]; i++;
            }
            tokens.push(atom);
        }
    }
    return tokens;
}

function parse(tokens) {
    let pos = 0;
    function readExpr() {
        if (tokens[pos] === '(') {
            pos++;
            const list = [];
            while (pos < tokens.length && tokens[pos] !== ')') list.push(readExpr());
            pos++;
            return list;
        }
        return tokens[pos++];
    }
    const exprs = [];
    while (pos < tokens.length) exprs.push(readExpr());
    return exprs.length === 1 ? exprs[0] : exprs;
}

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
function val(node, tag) { const f = find(node, tag); return f ? f[1] : null; }

// ============================================================
// Extract pad positions from PCB
// ============================================================

function extractPadsAndObstacles(tree) {
    const netNames = {};
    for (const n of findAll(tree, 'net')) {
        netNames[parseInt(n[1])] = n[2];
    }

    const pads = [];       // {x, y, net, layer, w, h}

    for (const fp of findAll(tree, 'footprint')) {
        const atNode = find(fp, 'at');
        if (!atNode) continue;
        const fpX = parseFloat(atNode[1]);
        const fpY = parseFloat(atNode[2]);
        const fpRot = atNode.length > 3 ? parseFloat(atNode[3]) || 0 : 0;
        const fpLayer = val(fp, 'layer');
        const rad = fpRot * Math.PI / 180;
        const cosR = Math.cos(rad), sinR = Math.sin(rad);

        // No courtyard obstacles - let traces route between pads freely
        // (real PCBs route between component pads, courtyard is assembly clearance)

        // Extract pads
        for (const pad of findAll(fp, 'pad')) {
            const netNode = find(pad, 'net');
            const netId = netNode ? parseInt(netNode[1]) : 0;
            if (netId === 0) continue; // unconnected

            const padAt = find(pad, 'at');
            if (!padAt) continue;
            const px = parseFloat(padAt[1]), py = parseFloat(padAt[2]);

            // Rotate pad offset by footprint rotation
            const absX = px * cosR - py * sinR + fpX;
            const absY = px * sinR + py * cosR + fpY;

            const sizeNode = find(pad, 'size');
            const w = sizeNode ? parseFloat(sizeNode[1]) : 1.0;
            const h = sizeNode ? parseFloat(sizeNode[2]) : 1.0;

            // Determine pad layer
            const padType = pad[2]; // smd, thru_hole, np_thru_hole
            let padLayers;
            if (padType === 'thru_hole') {
                padLayers = [0, 1]; // both layers
            } else {
                padLayers = fpLayer === 'B.Cu' ? [1] : [0];
            }

            pads.push({ x: absX, y: absY, net: netId, layers: padLayers, w, h });
        }
    }

    return { pads, netNames };
}

// ============================================================
// Board outline
// ============================================================

function extractOutline(tree) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const line of findAll(tree, 'gr_line')) {
        const ly = val(line, 'layer');
        if (ly !== 'Edge.Cuts') continue;
        const s = find(line, 'start'), e = find(line, 'end');
        if (!s || !e) continue;
        for (const pt of [s, e]) {
            const x = parseFloat(pt[1]), y = parseFloat(pt[2]);
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
    }
    return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

// ============================================================
// Priority Queue (binary min-heap)
// ============================================================

class MinHeap {
    constructor() { this.data = []; }
    get size() { return this.data.length; }

    push(item) {
        this.data.push(item);
        this._bubbleUp(this.data.length - 1);
    }

    pop() {
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length > 0) {
            this.data[0] = last;
            this._sinkDown(0);
        }
        return top;
    }

    _bubbleUp(i) {
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.data[i].f >= this.data[p].f) break;
            [this.data[i], this.data[p]] = [this.data[p], this.data[i]];
            i = p;
        }
    }

    _sinkDown(i) {
        const n = this.data.length;
        while (true) {
            let smallest = i;
            const l = 2 * i + 1, r = 2 * i + 2;
            if (l < n && this.data[l].f < this.data[smallest].f) smallest = l;
            if (r < n && this.data[r].f < this.data[smallest].f) smallest = r;
            if (smallest === i) break;
            [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
            i = smallest;
        }
    }
}

// ============================================================
// Grid Router
// ============================================================

// 8 directions: dx, dy, cost multiplier
const DIRS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],           // cardinal
    [1, 1, DIAG_COST], [-1, 1, DIAG_COST],                    // diagonal
    [1, -1, DIAG_COST], [-1, -1, DIAG_COST],
];

const LAYER_NAMES = ['F.Cu', 'B.Cu'];

class Router {
    constructor(outline) {
        // Add margin around board
        const margin = 1.0; // mm
        this.x0 = outline.x0 - margin;
        this.y0 = outline.y0 - margin;
        this.x1 = outline.x1 + margin;
        this.y1 = outline.y1 + margin;
        this.cols = Math.ceil((this.x1 - this.x0) / GRID_RES) + 1;
        this.rows = Math.ceil((this.y1 - this.y0) / GRID_RES) + 1;

        // Grid: 0 = free, -1 = obstacle, >0 = reserved by net N
        this.grid = [
            new Int16Array(this.cols * this.rows),  // F.Cu
            new Int16Array(this.cols * this.rows),   // B.Cu
        ];

        this.segments = [];  // output segments
        this.vias = [];      // output vias

        // Mark board edges as obstacles (traces must stay inside outline)
        const edgeCells = Math.ceil(margin / GRID_RES);
        for (let layer = 0; layer < 2; layer++) {
            for (let gy = 0; gy < this.rows; gy++) {
                for (let gx = 0; gx < this.cols; gx++) {
                    const [mx, my] = this.toMm(gx, gy);
                    if (mx < outline.x0 || mx > outline.x1 ||
                        my < outline.y0 || my > outline.y1) {
                        this.grid[layer][this.idx(gx, gy)] = -1;
                    }
                }
            }
        }

        console.error(`Grid: ${this.cols}x${this.rows} (${this.cols * this.rows} cells/layer)`);
    }

    toGrid(x, y) {
        return [Math.round((x - this.x0) / GRID_RES), Math.round((y - this.y0) / GRID_RES)];
    }

    toMm(gx, gy) {
        return [this.x0 + gx * GRID_RES, this.y0 + gy * GRID_RES];
    }

    idx(gx, gy) { return gy * this.cols + gx; }

    inBounds(gx, gy) { return gx >= 0 && gx < this.cols && gy >= 0 && gy < this.rows; }

    // Mark a rectangular area as obstacle on given layers
    markObstacle(x0, y0, x1, y1, layers) {
        const [gx0, gy0] = this.toGrid(x0, y0);
        const [gx1, gy1] = this.toGrid(x1, y1);
        for (const layer of layers) {
            for (let gy = Math.max(0, gy0); gy <= Math.min(this.rows - 1, gy1); gy++) {
                for (let gx = Math.max(0, gx0); gx <= Math.min(this.cols - 1, gx1); gx++) {
                    this.grid[layer][this.idx(gx, gy)] = -1; // obstacle
                }
            }
        }
    }

    // Clear pad area (make routable through obstacle)
    clearPad(x, y, w, h, layers) {
        const halfW = w / 2, halfH = h / 2;
        const [gx0, gy0] = this.toGrid(x - halfW, y - halfH);
        const [gx1, gy1] = this.toGrid(x + halfW, y + halfH);
        for (const layer of layers) {
            for (let gy = Math.max(0, gy0); gy <= Math.min(this.rows - 1, gy1); gy++) {
                for (let gx = Math.max(0, gx0); gx <= Math.min(this.cols - 1, gx1); gx++) {
                    if (this.grid[layer][this.idx(gx, gy)] === -1) {
                        this.grid[layer][this.idx(gx, gy)] = 0; // clear for routing
                    }
                }
            }
        }
    }

    // Mark routed trace cells as occupied
    markTrace(path, halfWidthCells, net) {
        for (const { gx, gy, layer } of path) {
            for (let dy = -halfWidthCells; dy <= halfWidthCells; dy++) {
                for (let dx = -halfWidthCells; dx <= halfWidthCells; dx++) {
                    const nx = gx + dx, ny = gy + dy;
                    if (this.inBounds(nx, ny)) {
                        const i = this.idx(nx, ny);
                        if (this.grid[layer][i] === 0) {
                            this.grid[layer][i] = net; // reserved
                        }
                    }
                }
            }
        }
    }

    // Check if cell is routable for given net
    isRoutable(gx, gy, layer, net) {
        if (!this.inBounds(gx, gy)) return false;
        const v = this.grid[layer][this.idx(gx, gy)];
        return v === 0 || v === net; // free or same net
    }

    // A* pathfinding between two points, optionally across layers
    astar(sx, sy, sLayer, ex, ey, eLayer, net) {
        const open = new MinHeap();
        // State key: layer * rows * cols + gy * cols + gx
        const stateSize = this.cols * this.rows;
        const gScore = [new Float32Array(stateSize), new Float32Array(stateSize)];
        gScore[0].fill(Infinity);
        gScore[1].fill(Infinity);

        const cameFrom = [new Int32Array(stateSize), new Int32Array(stateSize)];
        cameFrom[0].fill(-1);
        cameFrom[1].fill(-1);
        // Encode previous state as: layer * stateSize + idx
        const cameFromLayer = [new Int8Array(stateSize), new Int8Array(stateSize)];
        cameFromLayer[0].fill(-1);
        cameFromLayer[1].fill(-1);

        const si = this.idx(sx, sy);
        gScore[sLayer][si] = 0;

        const heuristic = (gx, gy, l) => {
            const dx = Math.abs(gx - ex), dy = Math.abs(gy - ey);
            // Chebyshev distance (allows diagonal moves)
            const h = Math.max(dx, dy) + (DIAG_COST - 1) * Math.min(dx, dy);
            // Add via penalty if on wrong layer
            return h + (l !== eLayer ? VIA_COST : 0);
        };

        open.push({ gx: sx, gy: sy, layer: sLayer, f: heuristic(sx, sy, sLayer), g: 0, dir: -1 });

        let iterations = 0;
        const maxIter = stateSize * 8; // generous limit for dense boards

        while (open.size > 0 && iterations < maxIter) {
            iterations++;
            const curr = open.pop();
            const { gx, gy, layer, g, dir } = curr;

            if (gx === ex && gy === ey && layer === eLayer) {
                // Reconstruct path
                return this._reconstructPath(cameFrom, cameFromLayer, ex, ey, eLayer);
            }

            const ci = this.idx(gx, gy);
            if (g > gScore[layer][ci]) continue; // stale

            // Try 8 directional moves
            for (let d = 0; d < DIRS.length; d++) {
                const [dx, dy, baseCost] = DIRS[d];
                const nx = gx + dx, ny = gy + dy;
                if (!this.isRoutable(nx, ny, layer, net)) continue;

                let cost = baseCost;
                // Bend penalty
                if (dir >= 0 && dir !== d) cost += BEND_COST;

                const ng = g + cost;
                const ni = this.idx(nx, ny);
                if (ng < gScore[layer][ni]) {
                    gScore[layer][ni] = ng;
                    cameFrom[layer][ni] = ci;
                    cameFromLayer[layer][ni] = layer;
                    open.push({ gx: nx, gy: ny, layer, f: ng + heuristic(nx, ny, layer), g: ng, dir: d });
                }
            }

            // Try via (layer change)
            const otherLayer = 1 - layer;
            if (this.isRoutable(gx, gy, otherLayer, net)) {
                const ng = g + VIA_COST;
                if (ng < gScore[otherLayer][ci]) {
                    gScore[otherLayer][ci] = ng;
                    cameFrom[otherLayer][ci] = ci;
                    cameFromLayer[otherLayer][ci] = layer;
                    open.push({ gx, gy, layer: otherLayer, f: ng + heuristic(gx, gy, otherLayer), g: ng, dir: -1 });
                }
            }
        }

        return null; // no path found
    }

    _reconstructPath(cameFrom, cameFromLayer, ex, ey, eLayer) {
        const path = [];
        let gx = ex, gy = ey, layer = eLayer;
        let ci = this.idx(gx, gy);

        while (cameFrom[layer][ci] !== -1) {
            path.push({ gx, gy, layer });
            const prevI = cameFrom[layer][ci];
            const prevLayer = cameFromLayer[layer][ci];
            gx = prevI % this.cols;
            gy = Math.floor(prevI / this.cols);
            layer = prevLayer;
            ci = prevI;
        }
        path.push({ gx, gy, layer }); // start point
        path.reverse();
        return path;
    }

    // Build MST of pad positions for a net, return edges to route
    buildMST(padPositions) {
        if (padPositions.length <= 1) return [];
        if (padPositions.length === 2) return [[0, 1]];

        // Prim's algorithm
        const n = padPositions.length;
        const inMST = new Array(n).fill(false);
        const minEdge = new Array(n).fill(Infinity);
        const minFrom = new Array(n).fill(-1);
        const edges = [];

        inMST[0] = true;
        for (let i = 1; i < n; i++) {
            const dx = padPositions[i].x - padPositions[0].x;
            const dy = padPositions[i].y - padPositions[0].y;
            minEdge[i] = Math.sqrt(dx * dx + dy * dy);
            minFrom[i] = 0;
        }

        for (let iter = 0; iter < n - 1; iter++) {
            let bestIdx = -1, bestDist = Infinity;
            for (let i = 0; i < n; i++) {
                if (!inMST[i] && minEdge[i] < bestDist) {
                    bestDist = minEdge[i];
                    bestIdx = i;
                }
            }
            if (bestIdx === -1) break;

            inMST[bestIdx] = true;
            edges.push([minFrom[bestIdx], bestIdx]);

            for (let i = 0; i < n; i++) {
                if (!inMST[i]) {
                    const dx = padPositions[i].x - padPositions[bestIdx].x;
                    const dy = padPositions[i].y - padPositions[bestIdx].y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < minEdge[i]) {
                        minEdge[i] = dist;
                        minFrom[i] = bestIdx;
                    }
                }
            }
        }

        return edges;
    }

    // Route a single net
    routeNet(net, pads) {
        if (pads.length < 2) return;

        // Deduplicate pads at same grid position
        const seen = new Set();
        const uniquePads = [];
        for (const p of pads) {
            const [gx, gy] = this.toGrid(p.x, p.y);
            const key = `${gx},${gy}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniquePads.push({ ...p, gx, gy, preferredLayer: p.layers[0] });
            }
        }

        if (uniquePads.length < 2) return;

        const edges = this.buildMST(uniquePads);
        const width = traceWidth(net);
        // Mark only exact path cells (no clearance buffer) - for visual routing
        // we just need plausible paths, not DRC-quality clearance
        const halfWidthCells = 0;

        let routedCount = 0;
        const failedEdges = [];
        for (const [ai, bi] of edges) {
            const a = uniquePads[ai], b = uniquePads[bi];
            const sLayer = a.preferredLayer;
            const eLayer = b.preferredLayer;

            const path = this.astar(a.gx, a.gy, sLayer, b.gx, b.gy, eLayer, net);
            if (!path) {
                failedEdges.push([ai, bi]);
                continue;
            }

            routedCount++;
            this.markTrace(path, halfWidthCells, net);
            this._pathToSegments(path, width, net);
        }

        // Retry failed edges on all layer combos
        for (const [ai, bi] of failedEdges) {
            const a = uniquePads[ai], b = uniquePads[bi];
            let found = false;
            for (const sl of [1 - a.preferredLayer, a.preferredLayer]) {
                for (const el of [1 - b.preferredLayer, b.preferredLayer]) {
                    if (sl === a.preferredLayer && el === b.preferredLayer) continue; // already tried
                    const p = this.astar(a.gx, a.gy, sl, b.gx, b.gy, el, net);
                    if (p) {
                        routedCount++;
                        this.markTrace(p, halfWidthCells, net);
                        this._pathToSegments(p, width, net);
                        found = true;
                        break;
                    }
                }
                if (found) break;
            }
        }

        const totalEdges = edges.length;
        if (routedCount < totalEdges) {
            const failed = totalEdges - routedCount;
            console.error(`  Net ${net}: ${routedCount}/${totalEdges} edges, ${failed} FAILED (${uniquePads.length} pads)`);
        } else {
            console.error(`  Net ${net}: ${routedCount}/${totalEdges} edges (${uniquePads.length} pads)`);
        }
    }

    _pathToSegments(path, width, net) {
        if (path.length < 2) return;

        // Split at layer changes and simplify collinear points
        let segStart = 0;
        for (let i = 1; i < path.length; i++) {
            const layerChanged = path[i].layer !== path[i - 1].layer;
            const isLast = i === path.length - 1;

            if (layerChanged) {
                // Emit segments up to here on current layer
                this._emitSimplifiedSegments(path, segStart, i - 1, path[i - 1].layer, width, net);
                // Emit via
                const [vx, vy] = this.toMm(path[i].gx, path[i].gy);
                this.vias.push({ x: vx, y: vy, net });
                segStart = i;
            } else if (isLast) {
                this._emitSimplifiedSegments(path, segStart, i, path[i].layer, width, net);
            }
        }
    }

    _emitSimplifiedSegments(path, startIdx, endIdx, layer, width, net) {
        if (startIdx >= endIdx) return;

        // Collect points, remove collinear
        const points = [];
        for (let i = startIdx; i <= endIdx; i++) {
            const [mx, my] = this.toMm(path[i].gx, path[i].gy);
            if (points.length >= 2) {
                const prev = points[points.length - 1];
                const prev2 = points[points.length - 2];
                // Check collinearity
                const dx1 = prev[0] - prev2[0], dy1 = prev[1] - prev2[1];
                const dx2 = mx - prev[0], dy2 = my - prev[1];
                if (Math.abs(dx1 * dy2 - dy1 * dx2) < 0.001) {
                    // Collinear, replace last point
                    points[points.length - 1] = [mx, my];
                    continue;
                }
            }
            points.push([mx, my]);
        }

        // Emit segments
        for (let i = 0; i < points.length - 1; i++) {
            this.segments.push({
                x0: points[i][0], y0: points[i][1],
                x1: points[i + 1][0], y1: points[i + 1][1],
                width, layer: LAYER_NAMES[layer], net,
            });
        }
    }
}

// ============================================================
// Rewrite .kicad_pcb with new routing
// ============================================================

function rewritePcb(originalText, segments, vias) {
    const lines = originalText.split('\n');

    // First pass: collect non-routing lines
    const cleanLines = [];
    for (const line of lines) {
        const trimmed = line.trim();

        // Skip existing segments, vias, and routing comments
        if (trimmed.startsWith('(segment ') || trimmed.startsWith('(via ')) continue;
        if (trimmed.startsWith(';; TRACE ROUTING') || trimmed.startsWith(';; VIAS') ||
            trimmed.startsWith(';; AUTOROUTED')) continue;
        if (trimmed.startsWith(';; Net ') && /^;; Net \d+$/.test(trimmed)) continue;
        // Skip old routing comments (hand-routed version)
        if (trimmed.startsWith(';;') && (
            trimmed.includes('VIN from') || trimmed.includes('VDD_12V from') ||
            trimmed.includes('SW from') || trimmed.includes('+5V from') ||
            trimmed.includes('+5V to') || trimmed.includes('FB from') ||
            trimmed.includes('Ground') || trimmed.includes('TX from') ||
            trimmed.includes('TX to') || trimmed.includes('TXEN from') ||
            trimmed.includes('DATA from') || trimmed.includes('DATA to') ||
            trimmed.includes('RX from') || trimmed.includes('DP from') ||
            trimmed.includes('DN from') || trimmed.includes('VBUS from') ||
            trimmed.includes('CH343') || trimmed.includes('LDO_3V3') ||
            trimmed.includes('+3V3 from') || trimmed.includes('GND to') ||
            trimmed.includes('to servo') || trimmed.includes('bus along') ||
            trimmed.includes('Power Path') || trimmed.includes('Ground Bus') ||
            trimmed.includes('UART Signal') || trimmed.includes('USB Path') ||
            trimmed.includes('from XIAO') || trimmed.includes('to servo connector')
        )) continue;
        // Skip separator comments from previous routing sections
        if (trimmed === ';; ============================================================') continue;

        cleanLines.push(line);
    }

    // Find the last closing paren and insert routing before it
    let lastCloseParen = -1;
    for (let i = cleanLines.length - 1; i >= 0; i--) {
        if (cleanLines[i].trim() === ')') {
            lastCloseParen = i;
            break;
        }
    }

    if (lastCloseParen === -1) {
        throw new Error('Could not find closing paren in PCB file');
    }

    // Build routing block
    const routingLines = [];
    routingLines.push('');
    routingLines.push('  ;; ============================================================');
    routingLines.push('  ;; AUTOROUTED TRACES');
    routingLines.push('  ;; ============================================================');

    const byNet = new Map();
    for (const seg of segments) {
        if (!byNet.has(seg.net)) byNet.set(seg.net, []);
        byNet.get(seg.net).push(seg);
    }

    for (const [net, segs] of [...byNet.entries()].sort((a, b) => a[0] - b[0])) {
        routingLines.push(`  ;; Net ${net}`);
        for (const s of segs) {
            routingLines.push(`  (segment (start ${s.x0.toFixed(4)} ${s.y0.toFixed(4)}) (end ${s.x1.toFixed(4)} ${s.y1.toFixed(4)}) (width ${s.width}) (layer "${s.layer}") (net ${s.net}))`);
        }
    }

    if (vias.length > 0) {
        routingLines.push('');
        routingLines.push('  ;; ============================================================');
        routingLines.push('  ;; VIAS');
        routingLines.push('  ;; ============================================================');
        for (const v of vias) {
            routingLines.push(`  (via (at ${v.x.toFixed(4)} ${v.y.toFixed(4)}) (size ${VIA_SIZE}) (drill ${VIA_DRILL}) (net ${v.net}))`);
        }
    }

    routingLines.push('');

    // Insert before last closing paren
    cleanLines.splice(lastCloseParen, 0, ...routingLines);

    return cleanLines.join('\n');
}

// ============================================================
// Main
// ============================================================

const inputPath = process.argv[2];
if (!inputPath) {
    console.error('Usage: node converters/autoroute.mjs input.kicad_pcb [output.kicad_pcb]');
    process.exit(1);
}

const outputPath = process.argv[3] || inputPath;
const pcbText = readFileSync(inputPath, 'utf-8');
const tree = parse(tokenize(pcbText));

console.error('Extracting board data...');
const outline = extractOutline(tree);
console.error(`Board outline: (${outline.x0}, ${outline.y0}) to (${outline.x1}, ${outline.y1}) = ${(outline.x1 - outline.x0).toFixed(1)}mm x ${(outline.y1 - outline.y0).toFixed(1)}mm`);

const { pads, netNames } = extractPadsAndObstacles(tree);
console.error(`Found ${pads.length} pads`);

// Group pads by net
const netPads = new Map();
for (const p of pads) {
    if (!netPads.has(p.net)) netPads.set(p.net, []);
    netPads.get(p.net).push(p);
}

console.error(`Nets to route: ${netPads.size}`);
for (const [net, ps] of netPads) {
    console.error(`  Net ${net} (${netNames[net] || '?'}): ${ps.length} pads`);
}

// Build router (board edges already marked as obstacles)
const router = new Router(outline);

// Route all nets
console.error('\nRouting...');
const ordered = routeOrder(netPads);
for (const [net, padList] of ordered) {
    router.routeNet(net, padList);
}

console.error(`\nGenerated ${router.segments.length} segments, ${router.vias.length} vias`);

// Write output
const output = rewritePcb(pcbText, router.segments, router.vias);
writeFileSync(outputPath, output);
console.error(`Written to ${outputPath}`);
