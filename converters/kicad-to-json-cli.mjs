#!/usr/bin/env node
// CLI wrapper for kicad-to-json.mjs
// Usage: node converters/kicad-to-json-cli.mjs path/to/board.kicad_pcb > board.json

import { readFileSync } from 'fs';
import { convertKiCadPcb } from './kicad-to-json.mjs';

const inputPath = process.argv[2];
if (!inputPath) {
    console.error('Usage: node converters/kicad-to-json-cli.mjs <path/to/board.kicad_pcb>');
    process.exit(1);
}

const raw = readFileSync(inputPath, 'utf-8');
const { output, stats } = convertKiCadPcb(raw);
console.error('KiCad -> JSON:', JSON.stringify(stats));
console.log(JSON.stringify(output));
