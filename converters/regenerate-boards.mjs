#!/usr/bin/env node
// regenerate-boards.mjs
// Convert legacy board modules (raw 2-point segments) to precomputed polyline format.
// Reads each board .js module, runs merge+smooth+decimate pipeline, writes updated module.
//
// Usage: node converters/regenerate-boards.mjs

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const boardsDir = resolve(__dirname, '../CircuitBoards/Assets/Scripts/Board/data');

// ---- Import processing functions from kicad-to-json.mjs ----
// We duplicate the core algorithms here to avoid restructuring the converter.
// These are identical to the functions in kicad-to-json.mjs.

function mergeSegments(segments) {
    const K = 10000;
    const keyFn = (p) => Math.round(p[0] * K) + ',' + Math.round(p[1] * K);
    const visited = new Set();
    const polylines = [];

    const groups = new Map();
    for (let i = 0; i < segments.length; i++) {
        const gk = segments[i].net.toString();
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push(i);
    }

    const junctionKeys = new Set();
    for (const [gk, indices] of groups) {
        const pointCount = new Map();
        for (const idx of indices) {
            const sk = keyFn(segments[idx].start);
            const ek = keyFn(segments[idx].end);
            pointCount.set(sk, (pointCount.get(sk) || 0) + 1);
            pointCount.set(ek, (pointCount.get(ek) || 0) + 1);
        }
        for (const [pk, count] of pointCount) {
            if (count >= 3) junctionKeys.add(gk + '|' + pk);
        }
    }

    for (const [gk, indices] of groups) {
        const startAt = new Map();
        const endAt = new Map();
        for (const idx of indices) {
            const sk = keyFn(segments[idx].start);
            const ek = keyFn(segments[idx].end);
            if (!startAt.has(sk)) startAt.set(sk, []);
            if (!endAt.has(ek)) endAt.set(ek, []);
            startAt.get(sk).push(idx);
            endAt.get(ek).push(idx);
        }

        const isJunction = (pk) => junctionKeys.has(gk + '|' + pk);

        for (const seedIdx of indices) {
            if (visited.has(seedIdx)) continue;
            visited.add(seedIdx);
            const seg = segments[seedIdx];

            const fwdPts = [];
            const fwdWidths = [];
            let cur = seg.end;
            while (true) {
                const ck = keyFn(cur);
                if (isJunction(ck) && fwdPts.length > 0) break;
                let found = false;
                const arr = startAt.get(ck) || [];
                for (const ci of arr) {
                    if (!visited.has(ci)) {
                        visited.add(ci);
                        fwdPts.push(segments[ci].end);
                        fwdWidths.push(segments[ci].width);
                        cur = segments[ci].end;
                        found = true;
                        break;
                    }
                }
                if (found) continue;
                const arr2 = endAt.get(ck) || [];
                for (const ci of arr2) {
                    if (!visited.has(ci)) {
                        visited.add(ci);
                        fwdPts.push(segments[ci].start);
                        fwdWidths.push(segments[ci].width);
                        cur = segments[ci].start;
                        found = true;
                        break;
                    }
                }
                if (!found) break;
            }

            const bwdPts = [];
            const bwdWidths = [];
            cur = seg.start;
            while (true) {
                const ck = keyFn(cur);
                if (isJunction(ck) && bwdPts.length > 0) break;
                let found = false;
                const arr = endAt.get(ck) || [];
                for (const ci of arr) {
                    if (!visited.has(ci)) {
                        visited.add(ci);
                        bwdPts.push(segments[ci].start);
                        bwdWidths.push(segments[ci].width);
                        cur = segments[ci].start;
                        found = true;
                        break;
                    }
                }
                if (found) continue;
                const arr2 = startAt.get(ck) || [];
                for (const ci of arr2) {
                    if (!visited.has(ci)) {
                        visited.add(ci);
                        bwdPts.push(segments[ci].end);
                        bwdWidths.push(segments[ci].width);
                        cur = segments[ci].end;
                        found = true;
                        break;
                    }
                }
                if (!found) break;
            }

            bwdPts.reverse();
            bwdWidths.reverse();

            const allPts = [];
            const allWidths = [];
            for (let bi = 0; bi < bwdPts.length; bi++) {
                allPts.push(bwdPts[bi]);
                allWidths.push(bwdWidths[bi]);
            }
            allPts.push(seg.start);
            allWidths.push(seg.width);
            allPts.push(seg.end);
            allWidths.push(seg.width);
            for (let fi = 0; fi < fwdPts.length; fi++) {
                allPts.push(fwdPts[fi]);
                allWidths.push(fwdWidths[fi]);
            }

            polylines.push({ points: allPts, widths: allWidths, net: seg.net });
        }
    }
    return polylines;
}

function smoothPolylineWithWidths(pts, widths) {
    if (pts.length <= 2) return { points: pts, widths };
    const rPts = [pts[0]];
    const rW = [widths[0]];
    for (let i = 1; i < pts.length - 1; i++) {
        const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
        const w0 = widths[i - 1], w1 = widths[i], w2 = widths[i + 1];
        const dx1 = cur[0] - prev[0], dy1 = cur[1] - prev[1];
        const dx2 = next[0] - cur[0], dy2 = next[1] - cur[1];
        const l1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
        const l2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        if (l1 < 0.001 || l2 < 0.001) { rPts.push(cur); rW.push(w1); continue; }
        const dot = (dx1 * dx2 + dy1 * dy2) / (l1 * l2);
        if (dot > 0.95) {
            rPts.push(cur);
            rW.push(w1);
        } else {
            const d = Math.min(l1, l2) * 0.35;
            const p0x = cur[0] - dx1 / l1 * d, p0y = cur[1] - dy1 / l1 * d;
            const p2x = cur[0] + dx2 / l2 * d, p2y = cur[1] + dy2 / l2 * d;
            const wBez0 = w1 + (w0 - w1) * (d / l1);
            const wBez2 = w1 + (w2 - w1) * (d / l2);
            rPts.push([p0x, p0y]);
            rW.push(wBez0);
            const steps = dot < 0 ? 6 : 4;
            for (let s = 1; s < steps; s++) {
                const t = s / steps;
                const u = 1 - t;
                rPts.push([
                    u * u * p0x + 2 * u * t * cur[0] + t * t * p2x,
                    u * u * p0y + 2 * u * t * cur[1] + t * t * p2y
                ]);
                rW.push(u * u * wBez0 + 2 * u * t * w1 + t * t * wBez2);
            }
            rPts.push([p2x, p2y]);
            rW.push(wBez2);
        }
    }
    rPts.push(pts[pts.length - 1]);
    rW.push(widths[widths.length - 1]);
    return { points: rPts, widths: rW };
}

function smoothWidths(pts, widths, transitionMM) {
    const N = pts.length;
    if (N <= 2) return widths;
    const result = new Array(N);
    for (let i = 0; i < N; i++) result[i] = widths[i];

    const arcLen = [0];
    for (let i = 1; i < N; i++) {
        const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
        arcLen.push(arcLen[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }

    const changes = [];
    for (let i = 1; i < N; i++) {
        if (Math.abs(widths[i] - widths[i - 1]) > 0.001) changes.push(i);
    }
    if (changes.length === 0) return widths;

    for (const cp of changes) {
        const arcAtChange = arcLen[cp];
        const wBefore = widths[cp - 1];
        const wAfter = widths[cp];
        const blendStart = arcAtChange - transitionMM;
        const blendEnd = arcAtChange + transitionMM;

        for (let i = 0; i < N; i++) {
            const a = arcLen[i];
            if (a >= blendStart && a <= blendEnd) {
                const frac = (a - blendStart) / (blendEnd - blendStart);
                const smooth = frac * frac * (3 - 2 * frac);
                result[i] = wBefore + (wAfter - wBefore) * smooth;
            }
        }
    }
    return result;
}

function rdpDecimate(pts, widths, spatialEps, widthEps) {
    const N = pts.length;
    if (N <= 2) return { points: pts, widths };

    function perpDist(p, a, b) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-12) {
            const ex = p[0] - a[0], ey = p[1] - a[1];
            return Math.sqrt(ex * ex + ey * ey);
        }
        return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / Math.sqrt(lenSq);
    }

    function rdpRange(start, end) {
        if (end - start < 2) return;
        let maxDist = 0;
        let maxIdx = start;
        for (let i = start + 1; i < end; i++) {
            const d = perpDist(pts[i], pts[start], pts[end]);
            const t = (i - start) / (end - start);
            const interpW = widths[start] + t * (widths[end] - widths[start]);
            const wDev = Math.abs(widths[i] - interpW);
            const combined = Math.max(d / spatialEps, wDev / widthEps);
            if (combined > maxDist) {
                maxDist = combined;
                maxIdx = i;
            }
        }
        if (maxDist > 1.0) {
            keep[maxIdx] = true;
            rdpRange(start, maxIdx);
            rdpRange(maxIdx, end);
        }
    }

    const keep = new Array(N).fill(false);
    keep[0] = true;
    keep[N - 1] = true;
    rdpRange(0, N - 1);

    const outPts = [];
    const outW = [];
    for (let i = 0; i < N; i++) {
        if (keep[i]) {
            outPts.push(pts[i]);
            outW.push(widths[i]);
        }
    }
    return { points: outPts, widths: outW };
}

function computeArcLengths(pts) {
    const arcLengths = [0];
    for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0];
        const dy = pts[i][1] - pts[i - 1][1];
        arcLengths.push(arcLengths[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    return arcLengths;
}

function quantize(pts, widths, decimals) {
    const factor = Math.pow(10, decimals);
    return {
        points: pts.map(p => [Math.round(p[0] * factor) / factor, Math.round(p[1] * factor) / factor]),
        widths: widths.map(w => Math.round(w * factor) / factor)
    };
}

// ---- Main ----

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const boards = [
    { name: 'arduino-nano', file: 'arduino-nano.js', displayName: 'Arduino Nano' },
    { name: 'stickhub-usb', file: 'stickhub-usb.js', displayName: 'StickHub USB' },
    { name: 'rpi-cm4io', file: 'rpi-cm4io.js', displayName: 'RPi CM4 IO' },
    { name: 'attiny85-usb', file: 'attiny85-usb.js', displayName: 'ATtiny85 USB' },
];

console.error('Regenerating legacy board modules...\n');

for (const b of boards) {
    const filePath = resolve(boardsDir, b.file);
    const mod = require(filePath);
    const board = JSON.parse(mod.pcb);

    if (board.polylines) {
        console.error(`  ${b.name}: already has polylines, skipping`);
        continue;
    }

    if (!board.traces) {
        console.error(`  ${b.name}: no traces found, skipping`);
        continue;
    }

    // Group raw traces into 2-point segments by layer
    const byLayer = new Map();
    for (const tr of board.traces) {
        const layer = tr.layer || 'F.Cu';
        if (!byLayer.has(layer)) byLayer.set(layer, []);
        const pts = tr.points;
        for (let i = 0; i < pts.length - 1; i++) {
            byLayer.get(layer).push({
                start: pts[i], end: pts[i + 1],
                width: tr.width, net: tr.net
            });
        }
    }

    // Run pipeline
    const polylines = [];
    let rawCount = 0;
    let ptsBefore = 0;
    let ptsAfter = 0;

    for (const [layer, segments] of byLayer) {
        rawCount += segments.length;
        const merged = mergeSegments(segments);
        for (const pl of merged) {
            const sm = smoothPolylineWithWidths(pl.points, pl.widths);
            const smW = smoothWidths(sm.points, sm.widths, 2.0);
            ptsBefore += sm.points.length;

            const dec = rdpDecimate(sm.points, smW, 0.05, 0.01);
            const q = quantize(dec.points, dec.widths, 3);
            ptsAfter += q.points.length;

            const arcLengths = computeArcLengths(q.points);

            polylines.push({
                points: q.points,
                widths: q.widths,
                arcLengths,
                net: pl.net,
                layer
            });
        }
    }

    const decPct = ptsBefore > 0 ? ((1 - ptsAfter / ptsBefore) * 100).toFixed(1) : '0';
    console.error(`  ${b.name}: ${rawCount} segs -> ${polylines.length} polylines, ${ptsBefore} -> ${ptsAfter} pts (${decPct}% decimation)`);

    // Build new board data (replace traces with polylines)
    const newBoard = { ...board };
    delete newBoard.traces;
    newBoard.polylines = polylines;

    // Reconstruct output JSON matching original structure
    const outputData = {
        board: newBoard.board || board.board,
        nets: newBoard.nets || board.nets,
        polylines,
        vias: newBoard.vias || board.vias || [],
        footprints: newBoard.footprints || board.footprints || [],
    };
    if (board.simulation) outputData.simulation = board.simulation;

    // Write new module (preserve name and sch exports)
    const pcbJson = JSON.stringify(outputData);
    let content = `// Auto-generated board data: ${b.displayName}\n`;
    content += `// Regenerated with converters/regenerate-boards.mjs\n`;
    content += `module.exports.name = ${JSON.stringify(mod.name)};\n`;
    if (mod.sch) {
        content += `module.exports.sch = '${mod.sch.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';\n`;
    }
    content += `module.exports.pcb = '${pcbJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';\n`;

    writeFileSync(filePath, content, 'utf-8');
    const oldSize = readFileSync(filePath, 'utf-8').length;
    console.error(`  -> wrote ${filePath} (${(content.length / 1024).toFixed(1)}KB)\n`);
}

console.error('Done.');
