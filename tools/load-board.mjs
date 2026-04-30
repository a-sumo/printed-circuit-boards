#!/usr/bin/env node
/**
 * load-board.mjs
 *
 * Fetch a .kicad_pcb file (local path, URL, or GitHub search), convert it,
 * and register it in the Lens Studio project — no manual steps.
 *
 * Usage:
 *   node tools/load-board.mjs <path-or-url> <slug> [display name]
 *   node tools/load-board.mjs --search <query>
 *
 * Options:
 *   --sch <path-or-url>   Also convert and embed a .kicad_sch schematic
 *   --autoroute           Run autorouter before converting
 *   --no-patch            Write boards/slug.js but skip KiCadBoard.ts patching
 *
 * Examples:
 *   node tools/load-board.mjs ./my-board.kicad_pcb my-board "My Board"
 *   node tools/load-board.mjs https://github.com/org/repo/blob/main/hw/board.kicad_pcb my-board
 *   node tools/load-board.mjs --search "esp32 devkit"
 *
 * GitHub search uses GITHUB_TOKEN env var if set (avoids rate limits).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BOARDS_DIR = join(ROOT, 'CircuitBoards/Assets/Scripts/Board/data');
const KICADBOARD_TS = join(ROOT, 'CircuitBoards/Assets/Scripts/Board/KiCadBoard.ts');
const CATALOG_TS = join(ROOT, 'CircuitBoards/Assets/Scripts/Board/BoardCatalog.ts');

// ---- Arg parsing ----

const argv = process.argv.slice(2);

const flags = {
    search: null,
    sch: null,
    autoroute: false,
    noPatch: false,
};

const positional = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--search') { flags.search = argv[++i]; }
    else if (argv[i] === '--sch') { flags.sch = argv[++i]; }
    else if (argv[i] === '--autoroute') { flags.autoroute = true; }
    else if (argv[i] === '--no-patch') { flags.noPatch = true; }
    else { positional.push(argv[i]); }
}

// ---- GitHub helpers ----

function githubHeaders() {
    const headers = { 'User-Agent': 'load-board-cli', 'Accept': 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    return headers;
}

async function githubSearch(query) {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(`filename:.kicad_pcb ${query}`)}&per_page=15`;
    const res = await fetch(url, { headers: githubHeaders() });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub search failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return data.items || [];
}

// Convert GitHub blob URL to raw URL
// https://github.com/owner/repo/blob/main/path/to/file.kicad_pcb
// -> https://raw.githubusercontent.com/owner/repo/main/path/to/file.kicad_pcb
function toRawUrl(url) {
    return url
        .replace('https://github.com/', 'https://raw.githubusercontent.com/')
        .replace('/blob/', '/');
}

// ---- Fetch helpers ----

async function fetchBytes(url) {
    const raw = url.includes('github.com') && url.includes('/blob/') ? toRawUrl(url) : url;
    console.error(`Fetching ${raw}`);
    const res = await fetch(raw);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw}`);
    return Buffer.from(await res.arrayBuffer());
}

function writeTemp(bytes, ext) {
    const path = join(tmpdir(), `load-board-${Date.now()}${ext}`);
    writeFileSync(path, bytes);
    return path;
}

// ---- Converters ----

function convertPcb(filePath) {
    if (flags.autoroute) {
        console.error('Running autorouter...');
        const ar = spawnSync('node', [join(ROOT, 'converters/autoroute.mjs'), filePath], { encoding: 'utf8' });
        if (ar.status !== 0) throw new Error(`Autorouter failed:\n${ar.stderr}`);
        console.error(ar.stderr.trim());
    }
    console.error('Converting PCB...');
    const result = spawnSync('node', [join(ROOT, 'converters/kicad-to-json-cli.mjs'), filePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`kicad-to-json failed:\n${result.stderr}`);
    console.error(result.stderr.trim());
    return result.stdout.trim();
}

function convertSch(filePath) {
    console.error('Converting schematic...');
    const result = spawnSync('node', [join(ROOT, 'converters/kicad-sch-to-json.mjs'), filePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`kicad-sch-to-json failed:\n${result.stderr}`);
    console.error(result.stderr.trim());
    return result.stdout.trim();
}

// ---- Board JS writer ----

function writeBoardJs(slug, displayName, pcbJson, schJson) {
    const jsPath = join(BOARDS_DIR, `${slug}.js`);
    let content = `// Auto-generated board data: ${displayName}\n// Generated with tools/load-board.mjs\n`;
    content += `module.exports.name = ${JSON.stringify(displayName)};\n`;
    content += `module.exports.pcb = ${pcbJson};\n`;
    if (schJson) {
        content += `module.exports.sch = ${JSON.stringify(schJson)};\n`;
    }
    writeFileSync(jsPath, content);
    console.error(`Wrote ${jsPath}`);

    // Write .meta file
    const uuid1 = randomUUID(); // AssetImportMetadata
    const uuid2 = randomUUID(); // JavaScriptAsset ref
    const uuid3 = randomUUID(); // ScriptAssetData
    const uuid4 = randomUUID(); // ComponentUid
    const meta = `- !<AssetImportMetadata/${uuid1}>
  ImportedAssetIds:
    JavaScriptAsset: !<reference> ${uuid2}
  ImporterName: JavaScriptAssetImporter
  PrimaryAsset: !<reference> ${uuid2}
  PackageType: NotAPackage
  LegacyPackagePolicy: ~
  ExtraData:
    {}
  AssetDataMap:
    JavaScriptAsset: !<own> ${uuid3}
  DependentFiles:
    []
  ImporterSettings: !<AssetImporterSettings>
    {}
  CompressionSettings: !<own> 00000000-0000-0000-0000-000000000000
- !<ScriptAssetData/${uuid3}>
  SvgIcon: ""
  SetupScript:
    code: ""
  Description: ""
  VersionMajor: 0
  VersionMinor: 0
  VersionPatch: 0
  ComponentUid: ${uuid4}
  ExportUid: 00000000-0000-0000-0000-000000000000
  PackagePolicy: CanBeUnpacked
  ScriptInputsHidden:
    {}
  ScriptTypesHidden:
    {}
  ReadMe: !<reference> 00000000-0000-0000-0000-000000000000
  DeclarationFile: !<reference> 00000000-0000-0000-0000-000000000000
  Tags:
    []
  Attachments:
    []
  DefaultScriptInputs:
    -
      {}
  ScriptTypes:
    -
      {}
`;
    writeFileSync(`${jsPath}.meta`, meta);
    console.error(`Wrote ${jsPath}.meta`);
}

// ---- KiCadBoard.ts patcher ----

function patchKiCadBoard(slug, displayName) {
    let src = readFileSync(KICADBOARD_TS, 'utf8');

    // 1. Patch ComboBoxWidget (the board-selector one, identified by 'boardSlug' following it)
    // Append new ComboBoxItem before the closing ])) that precedes boardSlug
    const comboRe = /([ \t]+new ComboBoxItem\("[^"]+", "[^"]+"\),\n)([ \t]+\]\)\))\n([ \t]+@hint[^\n]*\n[ \t]+boardSlug)/;
    if (comboRe.test(src)) {
        const indent = src.match(/( +)new ComboBoxItem\("[^"]+"/)?.[1] ?? '        ';
        src = src.replace(comboRe, `$1${indent}new ComboBoxItem(${JSON.stringify(displayName)}, ${JSON.stringify(slug)}),\n$2\n$3`);
    } else {
        console.error('WARNING: Could not find ComboBoxWidget block in KiCadBoard.ts. Manual patch needed.');
    }

    // 2. Patch BOARD_MODULES map (module-level, single instance)
    const modulesRe = /([ \t]+"[^"]+": require\("Connectors\/boards\/[^"]+\.js"\),\n)([ \t]*\};)/;
    if (!src.includes(`"${slug}": require`)) {
        if (modulesRe.test(src)) {
            src = src.replace(modulesRe, (match, lastEntry, closing) => {
                const indent = lastEntry.match(/^([ \t]+)/)?.[1] ?? '    ';
                return `${lastEntry}${indent}${JSON.stringify(slug)}: require("Scripts/Board/data/${slug}.js"),\n${closing}`;
            });
            console.error('Patched BOARD_MODULES in KiCadBoard.ts');
        } else {
            console.error('WARNING: Could not find BOARD_MODULES map in KiCadBoard.ts. Manual patch needed.');
        }
    }

    writeFileSync(KICADBOARD_TS, src);

    // 3. Patch BoardCatalog.ts — append entry to BOARD_CATALOG array
    if (existsSync(CATALOG_TS)) {
        let catSrc = readFileSync(CATALOG_TS, 'utf8');
        if (!catSrc.includes(`slug: ${JSON.stringify(slug)}`)) {
            // Find the last entry in the BOARD_CATALOG array (line ending with '},')
            const lastEntryRe = /([ \t]+\{ slug: "[^"]+",\s+displayName: "[^"]+",\s+desc: "[^"]+",\s+layers: \d+,\s+mcu: "[^"]+" \},)\n(\];)/;
            if (lastEntryRe.test(catSrc)) {
                catSrc = catSrc.replace(lastEntryRe, (match, lastEntry, closing) => {
                    const indent = lastEntry.match(/^([ \t]+)/)?.[1] ?? '    ';
                    return `${lastEntry}\n${indent}{ slug: ${JSON.stringify(slug)}, displayName: ${JSON.stringify(displayName)}, desc: "Custom KiCad PCB.", layers: 2, mcu: "Unknown" },\n${closing}`;
                });
                writeFileSync(CATALOG_TS, catSrc);
                console.error('Patched BoardCatalog.ts');
            } else {
                console.error('WARNING: Could not find BOARD_CATALOG array end in BoardCatalog.ts. Manual patch needed.');
            }
        }
    } else {
        console.error('WARNING: BoardCatalog.ts not found. Create it or run without --no-patch.');
    }
}

// ---- Interactive search ----

async function runSearch(query) {
    console.log(`Searching GitHub for: "${query}" (.kicad_pcb files)`);
    if (!process.env.GITHUB_TOKEN) {
        console.log('Tip: set GITHUB_TOKEN env var to avoid rate limits');
    }

    let items;
    try {
        items = await githubSearch(query);
    } catch (e) {
        console.error(`Search error: ${e.message}`);
        process.exit(1);
    }

    if (items.length === 0) {
        console.log('No results found.');
        process.exit(0);
    }

    console.log(`\nFound ${items.length} results:\n`);
    items.forEach((item, i) => {
        const repo = item.repository?.full_name ?? '?';
        const file = item.path;
        console.log(`  [${i + 1}] ${repo}`);
        console.log(`      ${file}\n`);
    });

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question('Select [1-' + items.length + '] or q to quit: ', resolve));
    rl.close();

    if (answer.toLowerCase() === 'q') process.exit(0);
    const idx = parseInt(answer, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= items.length) {
        console.error('Invalid selection.');
        process.exit(1);
    }

    const selected = items[idx];
    const rawUrl = toRawUrl(selected.html_url);
    const defaultSlug = basename(selected.name, '.kicad_pcb').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const defaultName = selected.repository?.name ?? defaultSlug;

    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const slugAnswer = await new Promise(resolve => rl2.question(`Slug [${defaultSlug}]: `, resolve));
    const nameAnswer = await new Promise(resolve => rl2.question(`Display name [${defaultName}]: `, resolve));
    rl2.close();

    const slug = slugAnswer.trim() || defaultSlug;
    const displayName = nameAnswer.trim() || defaultName;

    return { url: rawUrl, slug, displayName };
}

// ---- Main ----

async function main() {
    let source, slug, displayName;

    if (flags.search) {
        const picked = await runSearch(flags.search);
        source = picked.url;
        slug = picked.slug;
        displayName = picked.displayName;
    } else {
        [source, slug, displayName] = positional;
        if (!source || !slug) {
            console.error('Usage:');
            console.error('  node tools/load-board.mjs <path-or-url> <slug> [display name]');
            console.error('  node tools/load-board.mjs --search <query>');
            process.exit(1);
        }
        displayName = displayName ?? slug;
    }

    // Validate slug
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        console.error(`Invalid slug "${slug}" — use lowercase letters, numbers, hyphens only.`);
        process.exit(1);
    }

    const boardJsPath = join(BOARDS_DIR, `${slug}.js`);
    if (existsSync(boardJsPath)) {
        console.error(`Board "${slug}" already exists at ${boardJsPath}`);
        console.error('Delete it first or choose a different slug.');
        process.exit(1);
    }

    // Resolve PCB file
    let pcbFilePath;
    if (source.startsWith('http://') || source.startsWith('https://')) {
        const bytes = await fetchBytes(source);
        pcbFilePath = writeTemp(bytes, '.kicad_pcb');
    } else {
        pcbFilePath = source;
        if (!existsSync(pcbFilePath)) {
            console.error(`File not found: ${pcbFilePath}`);
            process.exit(1);
        }
    }

    // Convert PCB
    const pcbJson = convertPcb(pcbFilePath);

    // Convert schematic if provided
    let schJson = null;
    if (flags.sch) {
        let schFilePath;
        if (flags.sch.startsWith('http://') || flags.sch.startsWith('https://')) {
            const bytes = await fetchBytes(flags.sch);
            schFilePath = writeTemp(bytes, '.kicad_sch');
        } else {
            schFilePath = flags.sch;
        }
        schJson = convertSch(schFilePath);
    }

    // Write board JS + meta
    writeBoardJs(slug, displayName, pcbJson, schJson);

    // Patch KiCadBoard.ts
    if (!flags.noPatch) {
        patchKiCadBoard(slug, displayName);
    }

    console.log(`\nBoard "${displayName}" (${slug}) added successfully.`);
    if (!flags.noPatch) {
        console.log('KiCadBoard.ts patched. Hot-deploy to Lens Studio to pick up the change.');
    }
    console.log(`  ${boardJsPath}`);
}

main().catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
});
