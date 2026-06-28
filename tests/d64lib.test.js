/**
 * d64lib tests using golden file comparison.
 *
 * Verifies d64lib behavior against snapshots of tests/disks/gmc64-test.d64,
 * the fixture disk containing the GMC64I intro demo and the ALIENS game
 * plus their assets — all original content.
 *
 * Regenerate goldens with: npm run generate-golden
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

await import('../js/d64lib.js');
const { D64 } = globalThis;

const GOLDEN_DIR = join(__dirname, 'golden');
const DISKS_DIR = join(__dirname, 'disks');
const TEST_DISK = join(DISKS_DIR, 'gmc64-test.d64');
const BLANK_DISK = join(DISKS_DIR, 'BlankDisk.d64');

function loadGolden(filename) {
    return readFileSync(join(GOLDEN_DIR, filename));
}
function loadGoldenText(filename) {
    return readFileSync(join(GOLDEN_DIR, filename), 'utf-8');
}
function loadGoldenJSON(filename) {
    return JSON.parse(readFileSync(join(GOLDEN_DIR, filename), 'utf-8'));
}

describe('d64lib - gmc64-test.d64 (read paths)', () => {
    let disk;

    beforeAll(() => {
        disk = new D64(new Uint8Array(readFileSync(TEST_DISK)));
    });

    test('getDiskName returns expected name', () => {
        expect(disk.getDiskName()).toBe(loadGoldenText('testdisk-diskname.txt'));
    });

    test('getDirectory returns expected entries', () => {
        expect(disk.getDirectory()).toEqual(loadGoldenJSON('testdisk-directory.json'));
    });

    test('getFreeBlocks returns expected count', () => {
        const expected = parseInt(loadGoldenText('testdisk-freeblocks.txt'), 10);
        expect(disk.getFreeBlocks()).toBe(expected);
    });

    // One byte-exact read of each file type covers the chained-sector
    // path for short and long files plus the internal-space handling
    // for short-name files like STARS /PIC.
    test('readFile GMC64I/PRG returns expected data (large program)', () => {
        expect(Buffer.from(disk.readFile('GMC64I/PRG')))
            .toEqual(loadGolden('testdisk-file-GMC64I-PRG.bin'));
    });

    test('readFile ALIENS/PRG returns expected data', () => {
        expect(Buffer.from(disk.readFile('ALIENS/PRG')))
            .toEqual(loadGolden('testdisk-file-ALIENS-PRG.bin'));
    });

    test('readFile PLAYER/SPR returns expected data (sprite)', () => {
        expect(Buffer.from(disk.readFile('PLAYER/SPR')))
            .toEqual(loadGolden('testdisk-file-PLAYER-SPR.bin'));
    });

    test('readFile MINUTE/SNG returns expected data (song)', () => {
        expect(Buffer.from(disk.readFile('MINUTE/SNG')))
            .toEqual(loadGolden('testdisk-file-MINUTE-SNG.bin'));
    });

    test('readFile ENGINE/SND returns expected data (sound)', () => {
        expect(Buffer.from(disk.readFile('ENGINE/SND')))
            .toEqual(loadGolden('testdisk-file-ENGINE-SND.bin'));
    });

    test('readFile "STARS /PIC" returns expected data (short name with trailing space)', () => {
        // Significant trailing space — the disk filename is the 6-char-
        // padded GM convention. This test pins that readFile handles
        // internal whitespace correctly.
        expect(Buffer.from(disk.readFile('STARS /PIC')))
            .toEqual(loadGolden('testdisk-file-STARS_-PIC.bin'));
    });
});

describe('d64lib - write operations', () => {
    let diskData;

    beforeAll(() => {
        // Start from the test disk for write tests so we have enough free
        // blocks but don't mutate any test fixture committed alongside.
        diskData = new Uint8Array(readFileSync(TEST_DISK));
    });

    test('writeFile round-trip: write then find in directory then read back', () => {
        const disk = new D64(new Uint8Array(diskData));
        const originalFreeBlocks = disk.getFreeBlocks();
        const originalDirCount = disk.getDirectory().length;

        // 512 bytes = 3 sectors (254 bytes per sector)
        const testData = new Uint8Array(512);
        for (let i = 0; i < testData.length; i++) testData[i] = i & 0xFF;

        disk.writeFile('TESTFL/PRG', testData);

        const entry = disk.getDirectory().find(e => e.fileName === 'TESTFL/PRG');
        expect(entry).toBeDefined();
        expect(entry.fileSize).toBe(Math.ceil(512 / 254)); // 3 blocks

        expect(disk.getDirectory().length).toBe(originalDirCount + 1);
        expect(disk.getFreeBlocks()).toBe(originalFreeBlocks - entry.fileSize);

        const readBack = disk.readFile('TESTFL/PRG');
        expect(Buffer.from(readBack)).toEqual(Buffer.from(testData));
    });

    test('writeFile with multi-sector file spans correctly', () => {
        const disk = new D64(new Uint8Array(diskData));
        // ~2KB = 8 sectors. The test disk has plenty of free blocks.
        const testData = new Uint8Array(2000);
        for (let i = 0; i < testData.length; i++) testData[i] = (i * 7) & 0xFF;

        disk.writeFile('BIGFIL/PRG', testData);

        const entry = disk.getDirectory().find(e => e.fileName === 'BIGFIL/PRG');
        expect(entry).toBeDefined();

        const readBack = disk.readFile('BIGFIL/PRG');
        expect(readBack.length).toBe(testData.length);
        expect(Buffer.from(readBack)).toEqual(Buffer.from(testData));
    });

    test('deleteFile removes file from directory and frees blocks', () => {
        const disk = new D64(new Uint8Array(diskData));

        // Delete one of the test-disk's known files.
        const targetFile = 'PLAYER/SPR';
        const dirBefore = disk.getDirectory();
        const entryBefore = dirBefore.find(e => e.fileName === targetFile);
        expect(entryBefore).toBeDefined();

        const freeBlocksBefore = disk.getFreeBlocks();
        const blocksToFree = entryBefore.fileSize;

        disk.deleteFile(targetFile);

        const dirAfter = disk.getDirectory();
        expect(dirAfter.find(e => e.fileName === targetFile)).toBeUndefined();
        expect(dirAfter.length).toBe(dirBefore.length - 1);
        expect(disk.getFreeBlocks()).toBe(freeBlocksBefore + blocksToFree);
    });

    test('write then delete then write reuses space', () => {
        const disk = new D64(new Uint8Array(diskData));
        const initialFreeBlocks = disk.getFreeBlocks();

        const testData = new Uint8Array(254); // 1 block
        testData.fill(0xAA);
        disk.writeFile('TEMP  /PRG', testData);
        expect(disk.getFreeBlocks()).toBe(initialFreeBlocks - 1);

        disk.deleteFile('TEMP  /PRG');
        expect(disk.getFreeBlocks()).toBe(initialFreeBlocks);

        const testData2 = new Uint8Array(254);
        testData2.fill(0xBB);
        disk.writeFile('TEMP2 /PRG', testData2);
        expect(disk.getFreeBlocks()).toBe(initialFreeBlocks - 1);

        const entry = disk.getDirectory().find(e => e.fileName === 'TEMP2 /PRG');
        expect(entry).toBeDefined();
        expect(entry.fileSize).toBe(1);

        expect(Buffer.from(disk.readFile('TEMP2 /PRG'))).toEqual(Buffer.from(testData2));
    });
});
