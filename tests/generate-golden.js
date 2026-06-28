/**
 * Golden file generator for d64lib tests.
 *
 * Runs d64lib against tests/disks/gmc64-test.d64 and saves outputs as
 * golden reference files. Tests then compare live d64lib behavior
 * against these snapshots.
 *
 * Usage: npm run generate-golden (or node tests/generate-golden.js)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

await import('../js/d64lib.js');
const { D64 } = globalThis;

const GOLDEN_DIR = join(__dirname, 'golden');
const DISKS_DIR = join(__dirname, 'disks');
const TEST_DISK = join(DISKS_DIR, 'gmc64-test.d64');

mkdirSync(GOLDEN_DIR, { recursive: true });

console.log('\n=== gmc64-test.d64 ===');
const data = new Uint8Array(readFileSync(TEST_DISK));
const disk = new D64(data);

writeFileSync(join(GOLDEN_DIR, 'testdisk-diskname.txt'), disk.getDiskName());
console.log('Disk name:', disk.getDiskName());

const dir = disk.getDirectory();
writeFileSync(join(GOLDEN_DIR, 'testdisk-directory.json'), JSON.stringify(dir, null, 2));
console.log('Directory entries:', dir.length);

writeFileSync(join(GOLDEN_DIR, 'testdisk-freeblocks.txt'), String(disk.getFreeBlocks()));
console.log('Free blocks:', disk.getFreeBlocks());

// Sample one file of each major type so the test can verify byte-level
// readFile fidelity across formats. Filenames must use the 6-char-padded
// GM convention (significant internal whitespace).
const sampleFiles = [
    'GMC64I/PRG',  // program (large)
    'ALIENS/PRG',  // program (small)
    'PLAYER/SPR',  // sprite
    'MINUTE/SNG',  // song
    'ENGINE/SND',  // sound
    'STARS /PIC',  // scene (note the trailing space before /PIC)
];

for (const fileName of sampleFiles) {
    const entry = dir.find(e => e.fileName === fileName);
    if (!entry) {
        console.log(`File not found: ${fileName}`);
        continue;
    }
    try {
        const fileData = disk.readFile(fileName);
        const safeName = fileName.replace('/', '-').replace(/ /g, '_');
        writeFileSync(join(GOLDEN_DIR, `testdisk-file-${safeName}.bin`), fileData);
        console.log(`Extracted: ${fileName} (${fileData.length} bytes)`);
    } catch (e) {
        console.log(`Failed to extract ${fileName}: ${e.message}`);
    }
}

console.log('\nGolden files generated in:', GOLDEN_DIR);
