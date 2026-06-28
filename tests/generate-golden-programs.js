/**
 * Generate golden files for gmParser tests
 *
 * Run with: node tests/generate-golden-programs.js
 *
 * Golden files capture:
 * - mediaStore summary: [{type, name, quadIndex}, ...]
 * - instructionList: ["l001 sprite 1 is player", "     goto l005", ...]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load all dependencies (they populate globalThis)
await import('../js/c64lib.js');
await import('../js/d64lib.js');
await import('../js/gmOpcodes.js');
await import('../js/gmSprite.js');
await import('../js/gmScene.js');
await import('../js/gmSound.js');
await import('../js/gmMusic.js');

// Suppress debug output
globalThis.debugLog = () => {};

// Load gmParser after globals are set
await import('../js/gmParser.js');

// Extract from globalThis
const { D64, parseProgramData } = globalThis;

const GOLDEN_DIR = join(__dirname, 'golden');
const DISKS_DIR = join(__dirname, 'disks');

// Ensure golden directory exists
mkdirSync(GOLDEN_DIR, { recursive: true });

// Programs to generate golden files for. The two test fixtures together
// cover the full parser/runtime surface:
//   GMC64I — intro demo: multi-quad sprites, per-slot color, scene
//            plotting, character printing, music, subroutines, data tables
//   ALIENS — shooter: 4-direction input, data table reads, sprite
//            swap-on-hit, scene bg mutation, score, collision, hi-res sprites
const PROGRAMS = [
    { disk: 'gmc64-test.d64', name: 'GMC64I/PRG', desc: 'intro demo with multi-part sprites, plotting, music' },
    { disk: 'gmc64-test.d64', name: 'ALIENS/PRG', desc: 'shooter with data tables, sprite swaps, collision' },
];

// Load disk and set up loadFileByName for scene loading
let currentDisk = null;
globalThis.loadFileByName = (fileName) => {
    if (!currentDisk) return null;
    return currentDisk.readFile(fileName);
};

console.log('Generating gmParser golden files...\n');

for (const progInfo of PROGRAMS) {
    console.log(`Processing ${progInfo.name} from ${progInfo.disk} (${progInfo.desc})...`);

    // Load disk
    const diskData = new Uint8Array(readFileSync(join(DISKS_DIR, progInfo.disk)));
    currentDisk = new D64(diskData);

    const fileData = currentDisk.readFile(progInfo.name);
    if (!fileData) {
        console.error(`  ERROR: File not found: ${progInfo.name}`);
        continue;
    }

    // Parse program
    const programData = parseProgramData(fileData);

    // Generate instruction list with labels
    const instructionList = programData.instructions.map(instr => {
        let line = '     ';
        if (instr.label > 0) {
            line = 'l' + instr.label.toString().padStart(3, '0') + ' ';
        }
        line += instr.instructionName;
        return line;
    });

    // Generate mediaStore summary (skip index 0 which is null)
    const mediaStoreSummary = [];
    for (let i = 1; i < programData.mediaStore.length; i++) {
        const entry = programData.mediaStore[i];
        if (!entry) continue;

        mediaStoreSummary.push({
            index: i,
            type: entry.type,
            name: entry.name,
            quadIndex: entry.quadIndex || 0
        });
    }

    // Build golden file
    const golden = {
        originalSize: fileData.length,
        instructionCount: programData.instructions.length,
        mediaStoreCount: mediaStoreSummary.length,
        mediaStoreSummary,
        instructionList
    };

    // Generate output filename
    const outName = 'program-' + progInfo.name.replace(/\//g, '-') + '.json';
    const outPath = join(GOLDEN_DIR, outName);

    writeFileSync(outPath, JSON.stringify(golden, null, 2));
    console.log(`  -> ${outName}`);
    console.log(`     ${programData.instructions.length} instructions, ${mediaStoreSummary.length} media entries`);
}

console.log('\nDone!');
