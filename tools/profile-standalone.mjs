// Section-by-section profile of a standalone GameMaker file.
//
// The standalone is a ~48KB C64 memory image loaded at $0302. It bundles:
//   • The GameMaker runtime engine (fixed C64 machine code, same across games)
//   • The game's bytecode (variable — from the /PRG)
//   • The game's data (sprites, sounds, songs — variable)
//   • Two scene bitmap slots at $6000 and $A000 (fixed size, may be empty)
//   • Editor state (label table, slot names)
//   • Working RAM / zero-init areas
//
// We compute per-section sizes by:
//   1. Parsing the standalone's fixed offsets (label table, header) to
//      learn the variable ones (bytecode length, data size).
//   2. Counting bytes classified per region.
//   3. Cross-checking that the sum = file size.

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
await import(join(ROOT, 'js/d64lib.js'));
await import(join(ROOT, 'js/c64lib.js'));
await import(join(ROOT, 'js/gmOpcodes.js'));
await import(join(ROOT, 'js/gmSprite.js'));
await import(join(ROOT, 'js/gmScene.js'));
await import(join(ROOT, 'js/gmSound.js'));
await import(join(ROOT, 'js/gmMusic.js'));
await import(join(ROOT, 'js/gmParser.js'));

const files = [
    ['ALIENS', '/Users/jfield/GMC64/code/bludred/ALIENS-standalone.bin'],
    ['1',      '/Users/jfield/GMC64/code/bludred/1.bin'],
    ['2',      '/Users/jfield/GMC64/code/bludred/2.bin'],
    ['3',      '/Users/jfield/GMC64/code/bludred/3.bin'],
];

// file offset X ↔ memory address X + 0x0300 (load addr is at file[0..1] = $0302)
const file2mem = (off) => off + 0x0300;
const mem2file = (mem) => mem - 0x0300;

// Fixed memory offsets from CLAUDE.md's standalone layout table.
const OFFSETS = {
    LOAD_ADDR:          { mem: 0x0302, size: 2,       note: 'PRG-format load address ($0302)' },
    LABEL_TABLE:        { mem: 0x8300, size: 512,     note: 'label num → address map' },
    HEADER:             { mem: 0x8500, size: 9,       note: 'programLen (2) + dataSize (2) + 5 reserved' },
    BYTECODE_HEAD_END:  { mem: 0x87FD, size: 0,       note: 'end of bytecode HEAD (before runtime clobber)' },
    BYTECODE_TAIL_MEM:  { mem: 0x08FD, size: 0,       note: 'start of bytecode TAIL working copy' },
    DATA_SECTION_END:   { mem: 0x3D90, size: 0,       note: 'end of data section (grows downward from here)' },
    POINTER_TABLE:      { mem: 0x3F9C, size: 0,       note: 'pointer table (2-byte entries)' },
    SLOT_NAMES:         { mem: 0x3FB0, size: 79,      note: 'editor state — slot name assignments' },
    SCENE1_BITMAP:      { mem: 0x6000, size: 8000,    note: 'VIC bank 1 hi-res bitmap' },
    SCENE1_FOOTER:      { mem: 0x7F40, size: 10,      note: 'palette + 6-char name' },
    SCENE2_BITMAP:      { mem: 0xA000, size: 8000,    note: 'VIC bank 2 hi-res bitmap' },
    SCENE2_FOOTER:      { mem: 0xBF40, size: 10,      note: 'palette + 6-char name' },
};

// ----- pass 1: byte-identity across all samples ---------------------------
const samples = files.map(([_, path]) => new Uint8Array(readFileSync(path)));
const N = samples[0].length;
const identical = new Uint8Array(N);
const allZero = new Uint8Array(N);
for (let i = 0; i < N; i++) {
    const v = samples[0][i];
    let same = true, zero = (v === 0);
    for (let s = 1; s < samples.length; s++) {
        if (samples[s][i] !== v) same = false;
        if (samples[s][i] !== 0) zero = false;
    }
    identical[i] = same ? 1 : 0;
    allZero[i] = zero ? 1 : 0;
}

// Sum runtime code: bytes identical across all games AND non-zero.
// (Zero bytes that happen to be identical are more likely working RAM.)
function countRegion(fileStart, fileEnd) {
    let ident = 0, differ = 0, zero = 0, nonZero = 0;
    for (let i = fileStart; i < fileEnd && i < N; i++) {
        if (identical[i]) ident++;
        else differ++;
        if (allZero[i]) zero++;
        else nonZero++;
    }
    return { ident, differ, zero, nonZero, size: Math.min(fileEnd, N) - fileStart };
}

// ----- pass 2: parse ALIENS's specific values for variable sizes ----------
// Header at $8500 (file 0x8200): programLen low, high(+6), dataSize low, high
const alienSample = samples[0];
const hdrFile = mem2file(0x8500);
const programLenLow  = alienSample[hdrFile + 0];
const programLenHigh = alienSample[hdrFile + 1];
const dataSizeLow    = alienSample[hdrFile + 2];
const dataSizeHigh   = alienSample[hdrFile + 3];
// Undo the +6 high-byte quirk mentioned in CLAUDE.md
const programLen = programLenLow + ((programLenHigh - 6) << 8);
const dataSize   = dataSizeLow + (dataSizeHigh << 8);
console.log(`ALIENS-standalone.bin:`);
console.log(`  file size:  ${N} bytes`);
console.log(`  programLen: ${programLen} (bytecode section length in the editor PRG format)`);
console.log(`  dataSize:   $${dataSize.toString(16).toUpperCase()} — data section spans $${dataSize.toString(16).toUpperCase()}..$3D8F = ${0x3D90 - dataSize} bytes\n`);

// ----- pass 3: build labeled regions --------------------------------------
// Each region: [memStart, memEnd, name, category, note]
// Categories: runtime, bytecode, data, scene, editor-state, empty
const regions = [];

// Parse the extracted PRG to learn actual bytecode size (programLen field
// in the standalone header has a +9 discrepancy against the real ins count).
// HEAD is capped at 756 bytes (189 instructions × 4); TAIL is the rest.
globalThis.loadFileByName = () => null;
const extracted = new Uint8Array(readFileSync('/Users/jfield/GMC64/code/bludred/ALIENS-extracted.prg'));
const pd = parseProgramData(extracted);
const totalBytecodeBytes = pd.instructions.length * 4;
const HEAD_MAX = 189 * 4;   // 756 bytes — from CLAUDE.md "ins 0..188 survive there"
const bytecodeHeadBytes = Math.min(totalBytecodeBytes, HEAD_MAX);
const bytecodeTailBytes = Math.max(0, totalBytecodeBytes - HEAD_MAX);
console.log(`  bytecode: ${pd.instructions.length} instructions × 4 = ${totalBytecodeBytes} bytes`);
console.log(`     HEAD: ${bytecodeHeadBytes} bytes at $8509 (ins 0..188)`);
console.log(`     TAIL: ${bytecodeTailBytes} bytes at $08FD (ins 189..end)\n`);

const bytecodeHeadStart = 0x8509;
const bytecodeHeadEnd   = bytecodeHeadStart + bytecodeHeadBytes;
const bytecodeTailStart = 0x08FD;
const bytecodeTailEnd   = bytecodeTailStart + bytecodeTailBytes;
const dataStart         = dataSize;

// Emit in memory order.
regions.push({ memStart: 0x0302, memEnd: 0x0400, cat: 'load-addr',     name: 'Load address + startup',   note: '$0302 magic (loader trick)' });
regions.push({ memStart: 0x0400, memEnd: 0x0800, cat: 'runtime',       name: 'Runtime code / text screen', note: 'C64 text screen mem doubles as runtime area' });
regions.push({ memStart: 0x0800, memEnd: bytecodeTailStart, cat: 'zero-init', name: 'Zero page / low RAM',      note: 'up to bytecode TAIL' });
regions.push({ memStart: bytecodeTailStart, memEnd: bytecodeTailEnd, cat: 'bytecode-tail', name: 'Bytecode TAIL',   note: `runtime working copy of ins 189..${pd.instructions.length-1}` });
regions.push({ memStart: bytecodeTailEnd, memEnd: dataStart, cat: 'runtime-ram', name: 'Runtime working RAM',       note: 'variables, sprite state, etc.' });
regions.push({ memStart: dataStart, memEnd: 0x3D90, cat: 'game-data', name: 'Data section',            note: 'sprites, sounds, songs, print strings' });
regions.push({ memStart: 0x3D90, memEnd: 0x3F9C, cat: 'zero-init',     name: 'Data-section headroom',    note: 'unused gap up to pointer table' });
regions.push({ memStart: 0x3F9C, memEnd: 0x3FB0, cat: 'editor-state',  name: 'Pointer table',            note: '2-byte entries pointing into data section' });
regions.push({ memStart: 0x3FB0, memEnd: 0x4000, cat: 'editor-state',  name: 'Slot names region',        note: '79 bytes of editor sprite/sound slot state' });
regions.push({ memStart: 0x4000, memEnd: 0x6000, cat: 'runtime',       name: 'Runtime code (mid)',       note: 'engine machine code + tables' });
regions.push({ memStart: 0x6000, memEnd: 0x7F40, cat: 'scene',         name: 'Scene slot 1 bitmap',      note: 'VIC bank 1 hi-res (8KB)' });
regions.push({ memStart: 0x7F40, memEnd: 0x7F4A, cat: 'scene',         name: 'Scene slot 1 footer',      note: 'palette + 6-char name' });
regions.push({ memStart: 0x7F4A, memEnd: 0x8300, cat: 'runtime',       name: 'Runtime code (post-scene1)', note: 'more engine code' });
regions.push({ memStart: 0x8300, memEnd: 0x8500, cat: 'editor-state',  name: 'Label table',              note: '256 low + 256 high bytes for labels 1..255' });
regions.push({ memStart: 0x8500, memEnd: 0x8509, cat: 'editor-state',  name: 'Program header',           note: 'programLen + dataSize + 5 reserved' });
regions.push({ memStart: 0x8509, memEnd: bytecodeHeadEnd, cat: 'bytecode-head', name: 'Bytecode HEAD',    note: `ins 0..188 (${bytecodeHeadEnd - 0x8509} bytes used)` });
regions.push({ memStart: bytecodeHeadEnd, memEnd: 0x87FD, cat: 'zero-init', name: 'Bytecode HEAD headroom', note: 'unused tail of HEAD region' });
regions.push({ memStart: 0x87FD, memEnd: 0xA000, cat: 'runtime',       name: 'Runtime code (main)',      note: 'engine main + working tables' });
regions.push({ memStart: 0xA000, memEnd: 0xBF40, cat: 'scene',         name: 'Scene slot 2 bitmap',      note: 'VIC bank 2 hi-res (8KB)' });
regions.push({ memStart: 0xBF40, memEnd: 0xBF4A, cat: 'scene',         name: 'Scene slot 2 footer',      note: 'palette + 6-char name' });
regions.push({ memStart: 0xBF4A, memEnd: 0xC000, cat: 'runtime',       name: 'Runtime code (tail)',      note: 'trailing engine bytes' });

// ----- pass 4: print the table --------------------------------------------
console.log('Section breakdown (regions ordered by memory address):\n');
console.log('  memory range         file range     size   category       name');
console.log('  -------------------- -------------- -----  -------------- -----------------------');

const totals = {};
for (const r of regions) {
    const memEnd = Math.min(r.memEnd, 0x0302 + N - 2);
    const fileStart = mem2file(r.memStart);
    const fileEnd   = mem2file(memEnd);
    const size = memEnd - r.memStart;
    if (size <= 0) continue;
    const mrange = `$${r.memStart.toString(16).toUpperCase().padStart(4,'0')}-$${(memEnd-1).toString(16).toUpperCase().padStart(4,'0')}`;
    const frange = `${fileStart.toString().padStart(5)}-${(fileEnd-1).toString().padStart(5)}`;
    const stats = countRegion(fileStart, fileEnd);
    const identPct = Math.round(100 * stats.ident / stats.size);
    const zeroPct  = Math.round(100 * stats.zero / stats.size);
    console.log(`  ${mrange.padEnd(20)} ${frange.padEnd(14)} ${String(size).padStart(5)}  ${r.cat.padEnd(14)} ${r.name.padEnd(35)}  id=${String(identPct).padStart(3)}% z=${String(zeroPct).padStart(3)}%`);
    totals[r.cat] = (totals[r.cat] || 0) + size;
}

console.log(`\n\nTOTAL BY CATEGORY (ALIENS-standalone.bin):\n`);
const catOrder = ['runtime', 'runtime-ram', 'bytecode-head', 'bytecode-tail', 'game-data', 'scene', 'editor-state', 'zero-init', 'load-addr'];
let grandTotal = 0;
const labels = {
    'runtime':       'Runtime engine code + fixed tables',
    'runtime-ram':   'Runtime working RAM (variables, sprite state)',
    'bytecode-head': 'Game bytecode (HEAD chunk)',
    'bytecode-tail': 'Game bytecode (TAIL chunk)',
    'game-data':     'Game data (sprites/sounds/songs/strings)',
    'scene':         'Scene bitmap slots (2 × ~8KB)',
    'editor-state':  'Editor state (labels, pointers, slot names)',
    'zero-init':     'Zero-init / low RAM / headroom',
    'load-addr':     'Load address + startup area',
};
for (const cat of catOrder) {
    const bytes = totals[cat] || 0;
    grandTotal += bytes;
    console.log(`  ${labels[cat].padEnd(50)} ${String(bytes).padStart(6)} bytes  (${(bytes / N * 100).toFixed(1)}%)`);
}
console.log(`  ${'---'.padEnd(50)} ${String(grandTotal).padStart(6)} bytes (of ${N} total)`);
