// Builds tests/disks/gmc64-standalone.d64: an IP-clean test fixture made from a GameMaker
// "export to standalone" of our own ALIENS demo.
//
// Why: a GameMaker standalone is a full C64 memory image that bundles GameMaker's 6502 runtime
// (Activision's code, ~6KB at $8800-$9FFF, byte-identical across standalones by different
// authors) alongside the game. The game data is ours; the runtime isn't, so the raw export
// can't be committed. gmc64 never runs that runtime -- it only reads the program, data and
// scene regions back out (standaloneToPRG / standaloneToScenes) -- so this zeroes every byte
// that doesn't change what gmc64 extracts, keeping only the load address so the file is still
// recognised as a standalone. The result holds nothing but ALIENS content.
//
// Usage (from the repo root):
//   node tools/make-standalone-fixture.mjs <path/to/standalone.d64> [FILENAME]
// Writes tests/disks/gmc64-standalone.d64 and verifies the result before writing.

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['d64lib', 'c64lib', 'gmOpcodes', 'gmSprite', 'gmScene', 'gmSound', 'gmMusic', 'gmCharset', 'gmParser']) {
    await import(join(ROOT, 'js', f + '.js'));
}
const { D64, standaloneToPRG, standaloneToScenes } = globalThis;

const [srcPath, fileName = 'ALIENS'] = process.argv.slice(2);
if (!srcPath) {
    console.error('usage: node tools/make-standalone-fixture.mjs <standalone.d64> [FILENAME]');
    process.exit(1);
}
const original = new D64(new Uint8Array(readFileSync(srcPath))).readFile(fileName);
if (!original || original[0] !== 0x02 || original[1] !== 0x03) {
    console.error(`${fileName} is not a GameMaker standalone (load address $0302)`);
    process.exit(1);
}

// Everything gmc64 derives from a standalone, as one comparable string.
const signature = (bytes) => {
    let prg, scenes;
    try {
        prg = standaloneToPRG(bytes);
        scenes = standaloneToScenes(bytes);
    } catch (e) {
        return 'error: ' + e.message;
    }
    const parts = [Buffer.from(prg).toString('base64')];
    for (const name of Object.keys(scenes).sort()) parts.push(name, Buffer.from(scenes[name]).toString('base64'));
    return parts.join('|');
};
const want = signature(original);

// Load address: the extractor doesn't read it, but it is what marks the file as a standalone.
const KEEP_ALWAYS = new Set([0, 1]);
const scrubbed = original.slice();

// Pass 1, whole pages: zero a page and keep it zeroed if the extraction is unchanged.
const PAGE = 256;
for (let start = 0; start < scrubbed.length; start += PAGE) {
    const end = Math.min(start + PAGE, scrubbed.length);
    const saved = scrubbed.slice(start, end);
    for (let i = start; i < end; i++) if (!KEEP_ALWAYS.has(i)) scrubbed[i] = 0;
    if (signature(scrubbed) !== want) scrubbed.set(saved, start);
}
// Pass 2, single bytes within the pages that had to stay.
for (let i = 0; i < scrubbed.length; i++) {
    if (scrubbed[i] === 0 || KEEP_ALWAYS.has(i)) continue;
    const v = scrubbed[i];
    scrubbed[i] = 0;
    if (signature(scrubbed) !== want) scrubbed[i] = v;
}

// Verify: identical extraction, and none of GameMaker's runtime code left.
if (signature(scrubbed) !== want) throw new Error('scrubbed image no longer extracts identically');
const memOffset = (addr) => addr - 0x0302 + 2;   // file offset of a C64 address in a $0302 image
const runtime = scrubbed.slice(memOffset(0x8800), memOffset(0xA000));
if (runtime.some(b => b !== 0)) throw new Error('runtime region $8800-$9FFF is not empty');
const kept = scrubbed.filter(b => b !== 0).length;

const disk = D64.createEmpty('GMC64 STANDALONE', 'SA');
disk.writeFile(fileName, scrubbed, D64.FILE_TYPE_PRG);
const out = join(ROOT, 'tests', 'disks', 'gmc64-standalone.d64');
writeFileSync(out, Buffer.from(disk.getData()));
console.log(`kept ${kept} of ${original.length} non-zero bytes (was ${original.filter(b => b !== 0).length}); $8800-$9FFF empty`);
console.log(`wrote ${out}`);
