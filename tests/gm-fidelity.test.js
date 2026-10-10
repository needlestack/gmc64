/**
 * Fidelity against real GameMaker output and a real 1541 implementation.
 *
 * Our D64 reader and writer once had mirror-image bugs in the last-sector byte (the writer
 * stored one byte too many, the reader dropped one). They cancelled, so every round-trip
 * through our own code was perfect -- and the file formats were then fitted to what the buggy
 * reader showed, one byte short at the end of every file. Self-consistency tests could never
 * see it. These tests check against things that aren't us:
 *
 *   1. d64lib: pure checks of the 1541 last-sector convention, including legacy disks.
 *   2. c1541 (VICE): our reader and writer against an independent implementation, both ways.
 *      Skipped when c1541 isn't installed (set C1541=/path/to/c1541 to point at it).
 *   3. Original GameMaker disks: every .SPR/.PIC/.SND/.SNG GameMaker wrote must re-save from
 *      gmc64 byte-for-byte; every .PRG must parse, keep GameMaker's length rule and its 80-byte
 *      tail. The disks are Activision's and are never committed (*.d64 is gitignored), so this
 *      runs only where they exist locally: pristine GameMaker-S1.d64 / GameMaker-S2.d64 in
 *      tests/disks/, or in $GM_ORIGINAL_DISKS.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await import('../js/c64lib.js');
await import('../js/d64lib.js');
await import('../js/gmOpcodes.js');
await import('../js/gmSprite.js');
await import('../js/gmScene.js');
await import('../js/gmSound.js');
await import('../js/gmMusic.js');
await import('../js/gmCharset.js');
globalThis.debugLog = () => {};
await import('../js/gmParser.js');
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

const { D64, gmSprite, gmScene, gmSound, gmMusic, parseProgramData, serializeProgram } = globalThis;

// Deterministic, non-repeating-ish payload so an off-by-one shows up as a byte mismatch.
const payload = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + n) & 0xFF);

// Edge sizes around the 254-byte sector payload, including exact multiples.
const SIZES = [1, 2, 253, 254, 255, 507, 508, 509, 762, 19050];

// Walk a file's sector chain and return its final sector's byte 1.
function lastSectorByte1(disk, fileName) {
    const entry = disk.getDirectory().find(e => e.fileName === fileName);
    let t = entry.startTrack, s = entry.startSector;
    for (;;) {
        const o = D64._getTrackSectorOffset(t, s);
        if (disk.data[o] === 0) return disk.data[o + 1];
        t = disk.data[o]; s = disk.data[o + 1];
    }
}

describe('d64lib: 1541 last-sector convention', () => {
    test('byte 1 of the final sector is the offset of the last used byte (N + 1)', () => {
        const disk = D64.createEmpty('TEST', 'AB');
        for (const n of SIZES) disk.writeFile('F' + n, payload(n), D64.FILE_TYPE_PRG);
        for (const n of SIZES) {
            const inLast = n % 254 === 0 ? 254 : n % 254;
            expect(lastSectorByte1(disk, 'F' + n)).toBe(inLast + 1);
            expect(Array.from(disk.readFile('F' + n))).toEqual(Array.from(payload(n)));
        }
    });

    test('reads a legacy full final sector (byte 1 = 0, as the old writer stored it) as 254 bytes', () => {
        const disk = D64.createEmpty('TEST', 'AB');
        disk.writeFile('LEGACY', payload(508), D64.FILE_TYPE_PRG);
        const entry = disk.getDirectory().find(e => e.fileName === 'LEGACY');
        const second = D64._getTrackSectorOffset(entry.startTrack, entry.startSector);
        const last = D64._getTrackSectorOffset(disk.data[second], disk.data[second + 1]);
        disk.data[last + 1] = 0;
        expect(Array.from(disk.readFile('LEGACY'))).toEqual(Array.from(payload(508)));
    });
});

// --- c1541 ------------------------------------------------------------------

function findC1541() {
    const candidates = [
        process.env.C1541,
        '/Applications/vice-arm64-gtk3-3.8/bin/c1541',
        '/opt/homebrew/bin/c1541',
        '/usr/local/bin/c1541',
        '/usr/bin/c1541',
    ].filter(Boolean);
    for (const c of candidates) if (existsSync(c)) return c;
    try { return execFileSync('which', ['c1541'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}
const C1541 = findC1541();

describe.skipIf(!C1541)('d64lib vs c1541 (VICE)', () => {
    const run = (...args) => execFileSync(C1541, args, { stdio: 'pipe' });

    test('files we write extract byte-identical with c1541, and the disk validates', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gmc64-c1541-'));
        try {
            const disk = D64.createEmpty('TEST', 'AB');
            for (const n of SIZES) disk.writeFile('F' + n, payload(n), D64.FILE_TYPE_PRG);
            const img = join(dir, 'ours.d64');
            writeFileSync(img, Buffer.from(disk.getData()));
            for (const n of SIZES) {
                const out = join(dir, 'out' + n);
                run(img, '-read', 'f' + n, out);
                expect(Array.from(readFileSync(out))).toEqual(Array.from(payload(n)));
            }
            run(img, '-validate');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('files c1541 writes read back byte-identical', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gmc64-c1541-'));
        try {
            const img = join(dir, 'vice.d64');
            run('-format', 'vice,ab', 'd64', img);
            for (const n of SIZES) {
                writeFileSync(join(dir, 's' + n), payload(n));
                run(img, '-write', join(dir, 's' + n), 'g' + n);
            }
            const disk = new D64(new Uint8Array(readFileSync(img)));
            for (const n of SIZES) {
                expect(Array.from(disk.readFile('G' + n))).toEqual(Array.from(payload(n)));
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// --- Original GameMaker disks -----------------------------------------------

function findOriginalDisk(name) {
    const dirs = [process.env.GM_ORIGINAL_DISKS, join(__dirname, 'disks')].filter(Boolean);
    for (const d of dirs) if (existsSync(join(d, name))) return join(d, name);
    return null;
}
const ORIGINAL_DISKS = ['GameMaker-S1.d64', 'GameMaker-S2.d64'].map(findOriginalDisk).filter(Boolean);

const MEDIA_RESAVE = {
    SPR: (b) => new gmSprite(b).serialize(),
    PIC: (b) => new gmScene(b).save(),
    SND: (b) => new gmSound(b).serialize(),
    SNG: (b) => new gmMusic(b).serialize(),
};

describe.skipIf(ORIGINAL_DISKS.length === 0)('original GameMaker files', () => {
    for (const path of ORIGINAL_DISKS) {
        const disk = new D64(new Uint8Array(readFileSync(path)));
        const files = disk.getDirectory().filter(e => /\/(SPR|PIC|SND|SNG|PRG)$/i.test(e.fileName));
        const diskName = path.split('/').pop();

        test.skipIf(!C1541)(`${diskName}: our reader matches c1541 for every file`, () => {
            const dir = mkdtempSync(join(tmpdir(), 'gmc64-orig-'));
            try {
                for (const e of files) {
                    const out = join(dir, 'f');
                    execFileSync(C1541, [path, '-read', e.fileName.toLowerCase(), out], { stdio: 'pipe' });
                    expect(Array.from(disk.readFile(e.fileName)), e.fileName).toEqual(Array.from(readFileSync(out)));
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        test(`${diskName}: every sprite, scene, sound and song re-saves byte-for-byte`, () => {
            let checked = 0;
            for (const e of files) {
                const type = e.fileName.slice(-3).toUpperCase();
                if (!MEDIA_RESAVE[type]) continue;
                const original = disk.readFile(e.fileName);
                expect(Array.from(MEDIA_RESAVE[type](original)), e.fileName).toEqual(Array.from(original));
                checked++;
            }
            expect(checked).toBeGreaterThan(0);
        });

        test(`${diskName}: every program keeps GameMaker's length and 80-byte tail`, () => {
            globalThis.loadFileByName = (n) => { try { return disk.readFile(n); } catch { return null; } };
            for (const e of files.filter(f => /\/PRG$/i.test(f.fileName))) {
                const original = disk.readFile(e.fileName);
                const progEnd = 514 + (original[514] + ((original[515] - 6) << 8));
                const dataEnd = 0x3D90 - (original[516] + (original[517] << 8));
                expect(original.length, e.fileName).toBe(progEnd + dataEnd + 624);

                const saved = serializeProgram(parseProgramData(original), original);
                const sProgEnd = 514 + (saved[514] + ((saved[515] - 6) << 8));
                const sDataEnd = 0x3D90 - (saved[516] + (saved[517] << 8));
                expect(saved.length, e.fileName).toBe(sProgEnd + sDataEnd + 624);
                expect(Array.from(saved.slice(-80)), e.fileName).toEqual(Array.from(original.slice(-80)));
            }
        });
    }
});
