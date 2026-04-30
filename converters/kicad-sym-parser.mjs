#!/usr/bin/env node
// kicad-sym-parser.mjs
// Parses KiCad symbol library files (.kicad_sym / .kicad_symdir) into JSON.
// Extracts graphics primitives and pin definitions for runtime rendering.
//
// Usage:
//   node kicad-sym-parser.mjs <path>
//   - If path is a .kicad_sym file: parse that single symbol
//   - If path is a .kicad_symdir directory: parse all symbols in it
//   - If path is a directory of .kicad_symdir dirs: parse entire library
//
// Output: JSON object { "lib:name": { graphics: [...], pins: [...] } }

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, extname } from 'path';

// ---- S-expression tokenizer ----
function tokenize(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '(' || ch === ')') {
            tokens.push(ch);
            i++;
        } else if (ch === '"') {
            let s = '';
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\') { i++; }
                s += text[i];
                i++;
            }
            i++; // closing quote
            tokens.push(s);
        } else if (/\s/.test(ch)) {
            i++;
        } else {
            let s = '';
            while (i < text.length && !/[\s()]/.test(text[i]) && text[i] !== '"') {
                s += text[i];
                i++;
            }
            tokens.push(s);
        }
    }
    return tokens;
}

function buildTree(tokens) {
    let i = 0;
    function parse() {
        if (tokens[i] === '(') {
            i++;
            const list = [];
            while (i < tokens.length && tokens[i] !== ')') {
                list.push(parse());
            }
            i++; // skip ')'
            return list;
        }
        return tokens[i++];
    }
    const result = [];
    while (i < tokens.length) result.push(parse());
    return result.length === 1 ? result[0] : result;
}

function parseSexpr(text) {
    return buildTree(tokenize(text));
}

// ---- Find child nodes by tag ----
function findAll(node, tag) {
    if (!Array.isArray(node)) return [];
    return node.filter(c => Array.isArray(c) && c[0] === tag);
}

function findFirst(node, tag) {
    if (!Array.isArray(node)) return null;
    for (const c of node) {
        if (Array.isArray(c) && c[0] === tag) return c;
    }
    return null;
}

function numAt(node, idx) {
    return parseFloat(node[idx]) || 0;
}

// ---- Parse a single symbol definition ----
function parseSymbolDef(symNode) {
    const graphics = [];
    const pins = [];

    // Process sub-symbols (unit variants like Symbol_0_1, Symbol_1_1)
    for (const child of symNode) {
        if (!Array.isArray(child)) continue;
        const tag = child[0];

        if (tag === 'symbol') {
            // Nested symbol (unit/variant) - recurse
            const sub = parseSymbolDef(child);
            graphics.push(...sub.graphics);
            pins.push(...sub.pins);
        } else if (tag === 'rectangle') {
            const start = findFirst(child, 'start');
            const end = findFirst(child, 'end');
            if (start && end) {
                graphics.push({
                    type: 'rectangle',
                    start: [numAt(start, 1), numAt(start, 2)],
                    end: [numAt(end, 1), numAt(end, 2)]
                });
            }
        } else if (tag === 'polyline') {
            const ptsNode = findFirst(child, 'pts');
            if (ptsNode) {
                const pts = findAll(ptsNode, 'xy').map(xy => [numAt(xy, 1), numAt(xy, 2)]);
                if (pts.length >= 2) {
                    graphics.push({ type: 'polyline', points: pts });
                }
            }
        } else if (tag === 'circle') {
            const center = findFirst(child, 'center');
            const radiusNode = findFirst(child, 'radius');
            if (center && radiusNode) {
                graphics.push({
                    type: 'circle',
                    center: [numAt(center, 1), numAt(center, 2)],
                    radius: numAt(radiusNode, 1)
                });
            }
        } else if (tag === 'arc') {
            const start = findFirst(child, 'start');
            const mid = findFirst(child, 'mid');
            const end = findFirst(child, 'end');
            if (start && end) {
                graphics.push({
                    type: 'arc',
                    start: [numAt(start, 1), numAt(start, 2)],
                    mid: mid ? [numAt(mid, 1), numAt(mid, 2)] : null,
                    end: [numAt(end, 1), numAt(end, 2)]
                });
            }
        } else if (tag === 'pin') {
            // pin <type> <style> (at x y rot) (length L) (name "N" ...) (number "N" ...)
            const pinType = child[1] || 'passive';
            const at = findFirst(child, 'at');
            const lengthNode = findFirst(child, 'length');
            const nameNode = findFirst(child, 'name');
            const numberNode = findFirst(child, 'number');

            pins.push({
                pos: at ? [numAt(at, 1), numAt(at, 2)] : [0, 0],
                rot: at && at.length > 3 ? numAt(at, 3) : 0,
                length: lengthNode ? numAt(lengthNode, 1) : 2.54,
                name: nameNode ? (nameNode[1] || '') : '',
                number: numberNode ? (numberNode[1] || '') : '',
                type: pinType
            });
        }
    }

    return { graphics, pins };
}

// ---- Parse a .kicad_sym file ----
function parseSymFile(filePath) {
    const text = readFileSync(filePath, 'utf8');
    const tree = parseSexpr(text);

    // Top level: (kicad_symbol_lib ... (symbol "name" ...) ...)
    const result = {};
    const symNodes = findAll(tree, 'symbol');

    for (const symNode of symNodes) {
        const name = symNode[1];
        if (!name || typeof name !== 'string') continue;

        // Check if this extends another symbol
        const extendsNode = findFirst(symNode, 'extends');
        if (extendsNode) {
            // Store the extends reference - caller resolves later
            result[name] = { extends: extendsNode[1] };
            continue;
        }

        const parsed = parseSymbolDef(symNode);
        result[name] = parsed;
    }

    return result;
}

// ---- Parse a .kicad_symdir directory ----
function parseSymDir(dirPath) {
    const libName = basename(dirPath).replace('.kicad_symdir', '');
    const result = {};
    const allParsed = {};

    for (const file of readdirSync(dirPath)) {
        if (!file.endsWith('.kicad_sym')) continue;
        try {
            const parsed = parseSymFile(join(dirPath, file));
            Object.assign(allParsed, parsed);
        } catch (e) {
            // Skip unparseable files
        }
    }

    // Resolve extends references
    for (const [name, data] of Object.entries(allParsed)) {
        if (data.extends) {
            const parent = allParsed[data.extends];
            if (parent && !parent.extends) {
                result[libName + ':' + name] = parent;
            }
        } else {
            result[libName + ':' + name] = data;
        }
    }

    return result;
}

// ---- Parse entire library root ----
function parseLibraryRoot(rootPath) {
    const result = {};
    for (const entry of readdirSync(rootPath)) {
        const fullPath = join(rootPath, entry);
        if (entry.endsWith('.kicad_symdir') && statSync(fullPath).isDirectory()) {
            Object.assign(result, parseSymDir(fullPath));
        }
    }
    return result;
}

// ---- CLI ----
const target = process.argv[2];
if (!target) {
    console.error('Usage: node kicad-sym-parser.mjs <path>');
    console.error('  path: .kicad_sym file, .kicad_symdir dir, or library root dir');
    process.exit(1);
}

const stat = statSync(target);
let result;

if (stat.isFile() && target.endsWith('.kicad_sym')) {
    result = parseSymFile(target);
} else if (stat.isDirectory() && target.endsWith('.kicad_symdir')) {
    result = parseSymDir(target);
} else if (stat.isDirectory()) {
    result = parseLibraryRoot(target);
} else {
    console.error('Unrecognized path: ' + target);
    process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
