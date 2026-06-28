/**
 * Sprite-maker frame model tests
 *
 * Defines the contract for the "31 slots" frame model that mirrors original
 * GameMaker: every sprite has 31 reachable frame slots (no "add frame"
 * concept), the user can navigate to or copy from/to any of them, and the
 * serializer trims trailing-empty slots on save while preserving frames
 * within the animation range and any middle-empty frames.
 *
 * These tests are written BEFORE the refactor — most will fail against the
 * current code, which is correct: they're the spec the refactor must hit.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const SPRITE_MAKER_URL = `file://${join(PROJECT_ROOT, 'sprite-maker.html')}`;
const SELECTION_KEY = 'gm_disk_selection_sprite-maker';
const POOL_INDEX_KEY = 'gm_disk_pool_index';
const POOL_DATA_PREFIX = 'gm_disk_pool_data_';

const MAX_FRAMES = 31;

let browser;
let blankDiskBase64;
let s2DiskBase64;

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    blankDiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/BlankDisk.d64')).toString('base64');
    s2DiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/gmc64-test.d64')).toString('base64');
});

afterAll(async () => {
    if (browser) await browser.close();
});

async function openSpriteMaker({ disk = 'blank' } = {}) {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('Page error:', err.message));

    const data = disk === 's2' ? s2DiskBase64 : blankDiskBase64;
    const name = disk === 's2' ? 'gmc64-test.d64' : 'BlankDisk.d64';

    await page.evaluateOnNewDocument((data, name, selKey, idxKey, dataPrefix) => {
        localStorage.clear();
        const id = 'd_t';
        localStorage.setItem(idxKey, JSON.stringify([{ id, name, diskName: 'LIBRARY' }]));
        localStorage.setItem(dataPrefix + id, data);
        localStorage.setItem(selKey, id);
    }, data, name, SELECTION_KEY, POOL_INDEX_KEY, POOL_DATA_PREFIX);

    await page.goto(SPRITE_MAKER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof newSprite !== 'undefined' && typeof serializeSprite !== 'undefined');
    return page;
}

// For a single-quad sprite, frame count = (size - 37) / 64.
function spriteFrameCount(bytes) {
    return (bytes.length - 37) / 64;
}

// Paint one pixel at (x,y) in the currently-selected frame.
async function paintPixel(page, x, y) {
    await page.evaluate((x, y) => {
        selectColor(1);
        const cell = document.querySelector(`#fatbits td[data-x="${x}"][data-y="${y}"]`);
        cellMouseDown({ target: cell, preventDefault: () => {}, stopPropagation: () => {} });
        drawMode = null;
        syncToSprite();
    }, x, y);
}

describe('sprite-maker — frame button shows all 31 slots, no "add new"', () => {
    test('opening the frame dropdown lists 31 options on a fresh sprite', async () => {
        const page = await openSpriteMaker();

        const result = await page.evaluate((MAX) => {
            newSprite();
            showFrameSelector({ stopPropagation: () => {}, target: document.body });
            const options = Array.from(document.querySelectorAll('#frameDropdown .selector-option'));
            const hasAddNew = options.some(o => o.classList.contains('add-new'));
            return { count: options.length, hasAddNew };
        }, MAX_FRAMES);

        expect(result.count).toBe(MAX_FRAMES);
        expect(result.hasAddNew).toBe(false);
        await page.close();
    });

    test('selectFrame(14) on a fresh sprite navigates to frame 15 without an "add" step', async () => {
        const page = await openSpriteMaker();

        const result = await page.evaluate(() => {
            newSprite();
            selectFrame(14); // 0-based: frame 15
            return { currentFrame, pixelGridIsBlank: pixelData.every(row => row.every(p => p === 0)) };
        });

        expect(result.currentFrame).toBe(14);
        expect(result.pixelGridIsBlank).toBe(true);
        await page.close();
    });
});

describe('sprite-maker — copy dropdown shows all 31 slots', () => {
    test('copy "from" dropdown has 31 options on a fresh sprite', async () => {
        const page = await openSpriteMaker();

        const options = await page.evaluate(() => {
            newSprite();
            enterCopyMode();
            const fromSpan = document.querySelector('#messageArea .anima-value');
            selectCopyFrame('from', { stopPropagation: () => {}, target: fromSpan });
            return Array.from(document.querySelectorAll('#animaDropdown .anima-dropdown-option')).map(o => o.textContent);
        });

        expect(options.length).toBe(MAX_FRAMES);
        expect(options[0]).toBe('01');
        expect(options[30]).toBe('31');
        await page.close();
    });

    test('copy "to" dropdown has 31 options on a fresh sprite', async () => {
        const page = await openSpriteMaker();

        const options = await page.evaluate(() => {
            newSprite();
            enterCopyMode();
            const spans = document.querySelectorAll('#messageArea .anima-value');
            selectCopyFrame('to', { stopPropagation: () => {}, target: spans[1] });
            return Array.from(document.querySelectorAll('#animaDropdown .anima-dropdown-option')).map(o => o.textContent);
        });

        expect(options.length).toBe(MAX_FRAMES);
        await page.close();
    });
});

describe('sprite-maker — save truncates trailing empty frames', () => {
    test('navigating to a frame without painting does not extend the saved file', async () => {
        const page = await openSpriteMaker();

        await page.evaluate(() => newSprite());
        await paintPixel(page, 0, 0);
        // Navigate to frame 5 (0-based 4) without painting
        await page.evaluate(() => selectFrame(4));

        const frames = await page.evaluate(() => Math.ceil((serializeSprite().length - 37) / 64));
        // Single-quad sprite: only frame 1 has data; trailing empties trimmed
        expect(frames).toBe(1);
        await page.close();
    });

    test('painting frames 1 and 5 preserves the gap (saves 5 frames)', async () => {
        const page = await openSpriteMaker();

        await page.evaluate(() => newSprite());
        await paintPixel(page, 0, 0);
        await page.evaluate(() => selectFrame(4)); // frame 5
        await paintPixel(page, 1, 1);

        const frames = await page.evaluate(() => Math.ceil((serializeSprite().length - 37) / 64));
        expect(frames).toBe(5);
        await page.close();
    });

    test('anima range extends saved frames even when those frames are blank', async () => {
        const page = await openSpriteMaker();

        await page.evaluate(() => newSprite());
        await paintPixel(page, 0, 0);
        await page.evaluate(() => {
            animaMode.fromFrame = 1;
            currentSprite.setNumFrames(4); // anima loops to frame 4
        });

        const frames = await page.evaluate(() => Math.ceil((serializeSprite().length - 37) / 64));
        expect(frames).toBe(4);
        await page.close();
    });

    test('empty sprite serializes with exactly one frame', async () => {
        const page = await openSpriteMaker();

        const frames = await page.evaluate(() => {
            newSprite();
            return Math.ceil((serializeSprite().length - 37) / 64);
        });

        expect(frames).toBe(1);
        await page.close();
    });
});

describe('sprite-maker — loading and saving existing .SPR files is stable', () => {
    // A single round-trip may trim trailing blanks (intentional — matches GM
    // behaviour), so we can't require byte-equality with the original. But a
    // second round-trip MUST be byte-equal: once we've serialized, loading and
    // re-serializing should be a no-op fixed point.
    test('S2 sprites reach a stable size on the second round-trip', async () => {
        const page = await openSpriteMaker({ disk: 's2' });

        const results = await page.evaluate(() => {
            const dir = disk.disk.getDirectory();
            const sprites = dir.filter(e => e.fileName.endsWith('/SPR'));
            const checked = [];
            for (const e of sprites) {
                const bytes = disk.loadFile(e.fileName);
                const s = new gmSprite(bytes);
                if (s.sprite[0].numSprites !== 1) continue;
                loadSpriteFromDisk(e.fileName, bytes);
                const out1 = serializeSprite();
                loadSpriteFromDisk(e.fileName, out1);
                const out2 = serializeSprite();
                checked.push({ name: e.fileName, len1: out1.length, len2: out2.length });
                if (checked.length >= 5) break;
            }
            return checked;
        });

        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
            expect(r.len2).toBe(r.len1);
        }
        await page.close();
    });
});

describe('sprite-maker — anima range covers all 31 slots and tolerates from > to', () => {
    test('anima from/to fields accept values up to 31', async () => {
        const page = await openSpriteMaker();

        const max = await page.evaluate(() => {
            newSprite();
            enterAnimaMode();
            // The fields use GMTools.draggableField with type:numeric and a max value.
            // We can't dispatch real drags easily, so just call setValue directly via
            // the dragger and check the value sticks.
            const fromSpan = document.querySelector('.anima-from');
            const toSpan = document.querySelector('.anima-to');
            const fromCfg = fromSpan._draggableOptions;
            const toCfg = toSpan._draggableOptions;
            return { fromMax: fromCfg.max, toMax: toCfg.max };
        });

        expect(max.fromMax).toBe(31);
        expect(max.toMax).toBe(31);
        await page.close();
    });

    test('setting from > to is allowed (no auto-clamp)', async () => {
        const page = await openSpriteMaker();

        const result = await page.evaluate(() => {
            newSprite();
            enterAnimaMode();
            const fromSpan = document.querySelector('.anima-from');
            const toSpan = document.querySelector('.anima-to');
            toSpan._draggableOptions.setValue(5);
            fromSpan._draggableOptions.setValue(10);
            // "to" lives on the sprite (numFrames) now — anima end is sprite-owned.
            return { from: animaMode.fromFrame, to: currentSprite.getNumFrames() };
        });

        expect(result.from).toBe(10);
        expect(result.to).toBe(5);
        await page.close();
    });

    // (No "from > to collapses to 01-01" test: fromFrame is transient
    // editor state that doesn't persist anywhere, so it can no longer
    // affect what gets saved. Setting numFrames=1 directly is the way to
    // express "no animation" now.)
});
