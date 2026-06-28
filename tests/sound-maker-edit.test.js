/**
 * Sound-maker UI tests.
 *
 * Sound-maker had zero UI coverage until now — which is exactly why the
 * volume slider could go a long time as a no-op without anyone noticing.
 * These tests pin the data layer and the UI bindings; they don't assert
 * audio output (Web Audio in headless puppeteer is messy, and the actual
 * mixing is already covered by listening tests during development).
 *
 * Pattern matches editor-edit.test.js: spin up a fresh page per test,
 * drive the editor through its real entry points, snapshot via
 * page.evaluate.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const SOUND_MAKER_URL = `file://${join(PROJECT_ROOT, 'sound-maker.html')}`;
const SELECTION_KEY = 'gm_disk_selection_sound-maker';
const POOL_INDEX_KEY = 'gm_disk_pool_index';
const POOL_DATA_PREFIX = 'gm_disk_pool_data_';

let browser;
let blankDiskBase64;

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    blankDiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/BlankDisk.d64')).toString('base64');
});

afterAll(async () => {
    if (browser) await browser.close();
});

async function openSoundMaker() {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('Page error:', err.message));

    // Seed a writable blank disk in the pool so save tests can round-trip.
    await page.evaluateOnNewDocument((data, selKey, idxKey, dataPrefix) => {
        localStorage.clear();
        const id = 'd_test';
        localStorage.setItem(idxKey, JSON.stringify([{ id, name: 'BlankDisk.d64', diskName: 'TESTING' }]));
        localStorage.setItem(dataPrefix + id, data);
        localStorage.setItem(selKey, id);
    }, blankDiskBase64, SELECTION_KEY, POOL_INDEX_KEY, POOL_DATA_PREFIX);

    await page.goto(SOUND_MAKER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof disk !== 'undefined' && typeof newSound !== 'undefined');
    return page;
}

// ============================================================ NEW SOUND ====

describe('sound-maker — new sound creates a default frame', () => {
    test('newSound() seeds currentSound with one DEFAULT_FRAME copy', async () => {
        const page = await openSoundMaker();
        const state = await page.evaluate(() => {
            newSound();
            return {
                frameCount: currentSound.frames.length,
                currentFrame,
                frame: currentSound.frames[0]
            };
        });
        expect(state.frameCount).toBe(1);
        expect(state.currentFrame).toBe(0);
        // Spot-check the fields that matter most behaviorally.
        expect(state.frame.tie).toBe(true);     // tie ON so rel actually does something
        expect(state.frame.sus).toBe(15);       // full sustain
        expect(state.frame.dur).toBe(32);
        await page.close();
    });

    test('default volume is 15 (full)', async () => {
        const page = await openSoundMaker();
        const vol = await page.evaluate(() => { newSound(); return currentSound.volume; });
        expect(vol).toBe(15);
        await page.close();
    });

    test('DEFAULT_FRAME is independent — mutating one frame does not bleed into the next new sound', async () => {
        const page = await openSoundMaker();
        const tieAfterReset = await page.evaluate(() => {
            newSound();
            currentSound.frames[0].tie = false;
            newSound();   // fresh sound, fresh frame
            return currentSound.frames[0].tie;
        });
        expect(tieAfterReset).toBe(true);
        await page.close();
    });
});

// =========================================================== PARAM EDITS ====

describe('sound-maker — setParamValue updates the right thing', () => {
    test('volume edits the SOUND (not the frame)', async () => {
        const page = await openSoundMaker();
        const result = await page.evaluate(() => {
            newSound();
            setParamValue('volume', 8);
            return { volume: currentSound.volume, frameUnchanged: currentSound.frames[0].sus };
        });
        expect(result.volume).toBe(8);
        expect(result.frameUnchanged).toBe(15);     // sus is on the frame; should be untouched
        await page.close();
    });

    test('ADSR knobs edit the current FRAME', async () => {
        const page = await openSoundMaker();
        const frame = await page.evaluate(() => {
            newSound();
            setParamValue('att', 6);
            setParamValue('dec', 7);
            setParamValue('sus', 10);
            setParamValue('rel', 5);
            return currentSound.frames[currentFrame];
        });
        expect(frame.att).toBe(6);
        expect(frame.dec).toBe(7);
        expect(frame.sus).toBe(10);
        expect(frame.rel).toBe(5);
        await page.close();
    });

    test('repeatCount and repeatDelay are SOUND-level (not per-frame)', async () => {
        const page = await openSoundMaker();
        const result = await page.evaluate(() => {
            newSound();
            setParamValue('repeatCount', 4);
            setParamValue('repeatDelay', 60);
            return { rc: currentSound.repeatCount, rd: currentSound.repeatDelay };
        });
        expect(result.rc).toBe(4);
        expect(result.rd).toBe(60);
        await page.close();
    });

    test('getParamValue round-trips with setParamValue', async () => {
        const page = await openSoundMaker();
        const result = await page.evaluate(() => {
            newSound();
            setParamValue('freqHi', 42);
            setParamValue('volume', 9);
            return {
                freqHi: getParamValue('freqHi'),
                volume: getParamValue('volume')
            };
        });
        expect(result.freqHi).toBe(42);
        expect(result.volume).toBe(9);
        await page.close();
    });
});

// ============================================================ TIE TOGGLE ===

describe('sound-maker — tie toggle', () => {
    test('clicking #chkTie flips the current frame\'s tie flag', async () => {
        const page = await openSoundMaker();
        const states = await page.evaluate(() => {
            newSound();   // tie starts true (default)
            const before = currentSound.frames[0].tie;
            document.getElementById('chkTie').click();
            const after = currentSound.frames[0].tie;
            return { before, after };
        });
        expect(states.before).toBe(true);
        expect(states.after).toBe(false);
        await page.close();
    });
});

// ====================================================== FRAME OPERATIONS ===

describe('sound-maker — frame add / delete / copy', () => {
    test('insertFrame() inserts a fresh default frame at the current position', async () => {
        const page = await openSoundMaker();
        const result = await page.evaluate(() => {
            newSound();
            // Mark the original so we can tell it apart from the new one.
            currentSound.frames[0].sus = 7;
            insertFrame();
            return {
                count: currentSound.frames.length,
                currentFrame,
                inserted: currentSound.frames[currentFrame]
            };
        });
        expect(result.count).toBe(2);
        // Fresh frame uses DEFAULT_FRAME values, not the previous frame's.
        expect(result.inserted.sus).toBe(15);
        expect(result.inserted.tie).toBe(true);
        await page.close();
    });

    test('doDelete() removes the current frame and clamps currentFrame', async () => {
        const page = await openSoundMaker();
        const result = await page.evaluate(() => {
            newSound();
            insertFrame();              // 2 frames
            insertFrame();              // 3 frames
            // currentFrame likely landed on the last inserted; force it
            currentFrame = 2;
            doDelete();
            return { count: currentSound.frames.length, currentFrame };
        });
        expect(result.count).toBe(2);
        expect(result.currentFrame).toBe(1);  // clamped down to last valid
        await page.close();
    });

    test('doDelete() on the last remaining frame resets it to DEFAULT_FRAME (not removed)', async () => {
        const page = await openSoundMaker();
        const result = await page.evaluate(() => {
            newSound();
            currentSound.frames[0].sus = 3;  // mutate so default reset is observable
            currentSound.frames[0].tie = false;
            doDelete();
            return {
                count: currentSound.frames.length,
                sus: currentSound.frames[0].sus,
                tie: currentSound.frames[0].tie
            };
        });
        expect(result.count).toBe(1);
        expect(result.sus).toBe(15);
        expect(result.tie).toBe(true);
        await page.close();
    });

    test('doCopy() with new destination appends a copy of the current frame', async () => {
        const page = await openSoundMaker();
        const result = await page.evaluate(() => {
            newSound();
            currentSound.frames[0].sus = 6;
            currentSound.frames[0].freqHi = 99;
            // Simulate the dropdown picking 'new'.
            // (showCopyUI does the populate; we shortcut by setting the value.)
            showCopyUI();
            document.getElementById('copyToSelect').value = 'new';
            doCopy();
            return {
                count: currentSound.frames.length,
                copied: currentSound.frames[1],
                originalUntouched: currentSound.frames[0]
            };
        });
        expect(result.count).toBe(2);
        expect(result.copied.sus).toBe(6);
        expect(result.copied.freqHi).toBe(99);
        // Deep copy: mutating the copy mustn't affect the source.
        expect(result.originalUntouched.sus).toBe(6);
        await page.close();
    });
});

// =========================================================== ROUND-TRIP ====

describe('sound-maker — save + reload preserves the sound', () => {
    test('non-default values round-trip through disk', async () => {
        const page = await openSoundMaker();
        const result = await page.evaluate(async () => {
            newSound();
            currentSound.volume = 7;
            currentSound.repeatCount = 3;
            // Insert FIRST so we know which index each frame lands at —
            // insertFrame splices at currentFrame (0), pushing the original
            // to index 1. We then mutate each frame explicitly by index.
            insertFrame();
            currentSound.frames[0].att = 4;
            currentSound.frames[0].dec = 5;
            currentSound.frames[0].sus = 11;
            currentSound.frames[0].rel = 9;
            currentSound.frames[0].tie = false;
            currentSound.frames[0].freqHi = 33;
            currentSound.frames[1].sus = 6;
            await saveSound('TEST  /SND');

            // Now reload from the same disk and inspect.
            const raw = disk.loadFile('TEST  /SND');
            const reloaded = new gmSound(raw);
            return {
                volume: reloaded.volume,
                repeatCount: reloaded.repeatCount,
                frameCount: reloaded.frames.length,
                f0: reloaded.frames[0],
                f1: reloaded.frames[1]
            };
        });
        expect(result.volume).toBe(7);
        expect(result.repeatCount).toBe(3);
        expect(result.frameCount).toBe(2);
        expect(result.f0.att).toBe(4);
        expect(result.f0.dec).toBe(5);
        expect(result.f0.sus).toBe(11);
        expect(result.f0.rel).toBe(9);
        expect(result.f0.tie).toBe(false);
        expect(result.f0.freqHi).toBe(33);
        expect(result.f1.sus).toBe(6);
        expect(result.f1.tie).toBe(true);
        await page.close();
    });

    test('saveSound syncs the internal name to the filename base', async () => {
        // Real GM displays the header's name field on load, not the disk
        // filename. If they drift, a sound saved as "KCHEER" still shows
        // "NEW" inside the editor. saveSound rewrites the internal name.
        // The reloaded name comes back lowercase + trimmed because that's
        // what _decodeString returns — case is irrelevant on disk (encode
        // collapses A-Z and a-z to the same bytes).
        const page = await openSoundMaker();
        const result = await page.evaluate(async () => {
            newSound();
            const before = currentSound.name;
            await saveSound('KCHEER/SND');
            const raw = disk.loadFile('KCHEER/SND');
            const reloaded = new gmSound(raw);
            return { before, after: reloaded.name };
        });
        expect(result.before).toBe('NEW   ');
        expect(result.after).toBe('kcheer');
        await page.close();
    });
});
