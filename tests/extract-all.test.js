/**
 * "Extract All": turning a program -- above all a standalone game found without its source
 * disk -- back into separate GameMaker files (programToFiles in gmParser.js, and the program
 * editor's Extract All button).
 *
 * Fixture: tests/disks/gmc64-standalone.d64 is our ALIENS demo exported to standalone by
 * GameMaker, scrubbed of GameMaker's runtime by tools/make-standalone-fixture.mjs. Its source
 * program is ALIENS/PRG on tests/disks/gmc64-test.d64, which gives the key invariant: a
 * standalone must extract to the same files as the program it was exported from.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

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

const { D64, gmSprite, gmScene, gmSound, gmMusic,
        parseProgramData, programToFiles, standaloneToPRG, standaloneToScenes } = globalThis;

const STANDALONE_DISK = join(PROJECT_ROOT, 'tests/disks/gmc64-standalone.d64');
const TEST_DISK = join(PROJECT_ROOT, 'tests/disks/gmc64-test.d64');

const readDisk = (path) => new D64(new Uint8Array(readFileSync(path)));
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// Extract the fixture standalone the way program-editor.html does: scenes come from the
// standalone's bitmap slots via loadFileByName.
function extractStandalone() {
    const bytes = readDisk(STANDALONE_DISK).readFile('ALIENS');
    const scenes = standaloneToScenes(bytes);
    const prg = standaloneToPRG(bytes);
    globalThis.loadFileByName = (name) => scenes[name] || null;
    return { bytes, prg, ...programToFiles(parseProgramData(prg), 'aliens', prg) };
}

function extractTestDiskProgram() {
    const disk = readDisk(TEST_DISK);
    globalThis.loadFileByName = (name) => { try { return disk.readFile(name); } catch { return null; } };
    const prg = disk.readFile('ALIENS/PRG');
    return { disk, ...programToFiles(parseProgramData(prg), 'aliens', prg) };
}

describe('the standalone fixture', () => {
    test('holds none of GameMaker\'s runtime ($8800-$9FFF is empty)', () => {
        const bytes = readDisk(STANDALONE_DISK).readFile('ALIENS');
        const at = (addr) => addr - 0x0302 + 2;   // file offset of a C64 address in a $0302 image
        expect(bytes[0] | (bytes[1] << 8)).toBe(0x0302);
        expect(bytes.slice(at(0x8800), at(0xA000)).every(b => b === 0)).toBe(true);
    });
});

describe('programToFiles', () => {
    test('a standalone extracts to its program, scene, sprites and sounds', () => {
        const { files, skipped } = extractStandalone();
        expect(files.map(f => f.fileName)).toEqual([
            'ALIENS/PRG',
            'SHIP  /SPR', 'PBULL /SPR', 'EBULL /SPR', 'PAIR  /SPR', 'LEFT  /SPR', 'RIGHT /SPR',
            'STARS /PIC',
            'ZAP   /SND', 'BOOM  /SND',
        ]);
        expect(skipped).toEqual([]);
    });

    test('a standalone extracts to the same assets as the program it was exported from', () => {
        const fromStandalone = extractStandalone().files;
        const fromSource = extractTestDiskProgram().files;
        for (const f of fromStandalone.filter(x => x.kind !== 'program')) {
            const g = fromSource.find(x => x.fileName === f.fileName);
            expect(g, f.fileName).toBeDefined();
            expect(same(f.data, g.data), f.fileName).toBe(true);
        }
    });

    test('the extracted program reloads with the same instructions, and finds its scene', () => {
        const { prg, files } = extractStandalone();
        const original = parseProgramData(prg);
        const byName = Object.fromEntries(files.map(f => [f.fileName, f.data]));
        globalThis.loadFileByName = (name) => byName[name] || null;
        const reloaded = parseProgramData(byName['ALIENS/PRG']);
        expect(reloaded.missingScenes).toEqual([]);
        const shape = (pd) => pd.instructions.map(i => [i.label, i.arg1, i.opcode, i.arg2, i.instructionName]);
        expect(shape(reloaded)).toEqual(shape(original));
    });

    test('every extracted asset is a valid GameMaker file that re-saves unchanged', () => {
        const resave = {
            SPR: (b) => new gmSprite(b).serialize(),
            PIC: (b) => new gmScene(b).save(),
            SND: (b) => new gmSound(b).serialize(),
            SNG: (b) => new gmMusic(b).serialize(),
        };
        for (const f of extractStandalone().files.filter(x => x.kind !== 'program')) {
            expect(same(resave[f.fileName.slice(-3)](f.data), f.data), f.fileName).toBe(true);
        }
    });

    test('scene and sounds match the files on the source disk', () => {
        const { disk } = extractTestDiskProgram();
        for (const f of extractStandalone().files.filter(x => x.kind === 'scene' || x.kind === 'sound')) {
            const original = disk.readFile(f.fileName);
            const normalised = f.kind === 'scene' ? new gmScene(original).save() : new gmSound(original).serialize();
            expect(same(normalised, f.data), f.fileName).toBe(true);
        }
    });

    test('skips a scene the program could not load instead of writing a blank one', () => {
        const prg = readDisk(TEST_DISK).readFile('ALIENS/PRG');
        globalThis.loadFileByName = () => null;
        const { files, skipped } = programToFiles(parseProgramData(prg), 'aliens', prg);
        expect(files.some(f => f.kind === 'scene')).toBe(false);
        expect(skipped).toEqual([{ fileName: 'STARS /PIC', kind: 'scene', reason: 'not found' }]);
    });

    test('skips a second asset with an already-used name', () => {
        const prg = readDisk(TEST_DISK).readFile('ALIENS/PRG');
        globalThis.loadFileByName = () => null;
        const pd = parseProgramData(prg);
        const zap = pd.mediaStore.findIndex(e => e && e.name.trim().toUpperCase() === 'ZAP');
        pd.mediaStore.push({ ...pd.mediaStore[zap] });
        const { skipped } = programToFiles(pd, 'aliens', prg);
        expect(skipped).toContainEqual({ fileName: 'ZAP   /SND', kind: 'sound', reason: 'duplicate name' });
    });
});

// --- The program editor's Extract All button ---------------------------------

let browser;
beforeAll(async () => { browser = await puppeteer.launch({ headless: true }); });
afterAll(async () => { if (browser) await browser.close(); });

// Open program-editor.html with the standalone disk inserted, load ALIENS from it, and open
// the file popup.
async function openWithStandalone() {
    const page = await browser.newPage();
    const diskBase64 = readFileSync(STANDALONE_DISK).toString('base64');
    await page.evaluateOnNewDocument((data) => {
        if (window.name === '_seeded') return;
        localStorage.clear();
        localStorage.setItem('gm_disk_editor', data);
        localStorage.setItem('gm_disk_editor_name', 'gmc64-standalone.d64');
        window.name = '_seeded';
    }, diskBase64);
    await page.goto(`file://${join(PROJECT_ROOT, 'program-editor.html')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof gmDisk !== 'undefined' && gmDisk.disk !== null);
    await page.evaluate(() => {
        loadProgramData('ALIENS', gmDisk.loadFile('ALIENS'));
        showFilePopup();
    });
    await page.waitForFunction(() => currentProgramData && currentProgramData.instructions.length > 0);
    return page;
}

const clickExtract = (page) => page.evaluate(() => {
    [...document.querySelectorAll('.gm-disk-custom')].find(b => b.textContent === 'Extract All').click();
});
const message = (page) => page.evaluate(() => document.querySelector('.gm-disk-info-message').textContent);

describe('Extract All button', () => {
    test('writes the program and its assets to the inserted disk', async () => {
        const page = await openWithStandalone();
        await clickExtract(page);
        await page.waitForFunction(() => /Extracted/.test(document.querySelector('.gm-disk-info-message').textContent));
        expect(await message(page)).toBe('Extracted 10 files');
        const names = await page.evaluate(() => gmDisk.listFiles().map(e => e.fileName));
        for (const n of ['ALIENS/PRG', 'STARS /PIC', 'SHIP  /SPR', 'BOOM  /SND']) expect(names).toContain(n);
        await page.close();
    }, 30000);

    test('a second extract finds everything already there', async () => {
        const page = await openWithStandalone();
        await clickExtract(page);
        await page.waitForFunction(() => /Extracted/.test(document.querySelector('.gm-disk-info-message').textContent));
        await clickExtract(page);
        await page.waitForFunction(() => /already on this disk/.test(document.querySelector('.gm-disk-info-message').textContent));
        expect(await message(page)).toBe('All 10 files are already on this disk');
        await page.close();
    }, 30000);

    test('asks before replacing a file that differs, and leaves it alone on "no"', async () => {
        const page = await openWithStandalone();
        await page.evaluate(() => gmDisk.saveFile('BOOM  /SND', new Uint8Array([1, 2, 3])));
        await clickExtract(page);
        await page.waitForFunction(() => !document.querySelector('.gm-disk-replace-prompt').hidden);
        expect(await page.evaluate(() => document.querySelector('.gm-disk-replace-text').textContent))
            .toBe('Replace 1 existing file?');
        await page.evaluate(() => document.querySelector('.gm-disk-replace-no').click());
        expect(await page.evaluate(() => Array.from(gmDisk.loadFile('BOOM  /SND')))).toEqual([1, 2, 3]);
        expect(await page.evaluate(() => gmDisk.listFiles().some(e => e.fileName === 'ALIENS/PRG'))).toBe(false);
        await page.close();
    }, 30000);
});
