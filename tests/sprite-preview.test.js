/**
 * Sprite-maker preview tests
 *
 * Pins down the behaviour of sprite-maker's preview mode so we can confidently
 * lift the framework into a shared GMTools.previewLoader and have sprite-maker
 * delegate to it. Each test exercises one slice of the user-facing behaviour
 * (entry, cycling, confirm, cancel, empty-disk, draggable filename, keyboard
 * shortcuts) so a regression points at a specific failure.
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

let browser;
let testDiskBase64;
let testDiskSpriteFiles; // /SPR fileNames from the test disk, in directory order

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    testDiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/gmc64-test.d64')).toString('base64');
    const dir = JSON.parse(readFileSync(join(PROJECT_ROOT, 'tests/golden/testdisk-directory.json'), 'utf8'));
    testDiskSpriteFiles = dir.filter(e => e.fileName.endsWith('/SPR')).map(e => e.fileName);
});

afterAll(async () => {
    if (browser) await browser.close();
});

/**
 * Seed the shared disk pool with a single disk and select it for sprite-maker.
 * Bypasses the legacy-migration code path so tests start in a known state.
 */
async function openSpriteMaker({ withSprites = true } = {}) {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('Page error:', err.message));

    if (withSprites) {
        await page.evaluateOnNewDocument((data, selKey, idxKey, dataPrefix) => {
            localStorage.clear();
            const id = 'd_test';
            localStorage.setItem(idxKey, JSON.stringify([
                { id, name: 'gmc64-test.d64', diskName: 'LIBRARY' }
            ]));
            localStorage.setItem(dataPrefix + id, data);
            localStorage.setItem(selKey, id);
        }, testDiskBase64, SELECTION_KEY, POOL_INDEX_KEY, POOL_DATA_PREFIX);
    } else {
        await page.evaluateOnNewDocument(() => localStorage.clear());
    }

    await page.goto(SPRITE_MAKER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof disk !== 'undefined' && typeof previewMode !== 'undefined');
    return page;
}

describe('sprite-maker preview mode entry', () => {
    test('entering preview mode populates spriteFiles and previews the first one', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            enterPreviewMode();
            return {
                active: previewMode.active,
                fileCount: previewMode.spriteFiles.length,
                currentIndex: previewMode.currentIndex,
                firstFileName: previewMode.spriteFiles[0].fileName,
                previewLoaded: !!previewMode.previewSprite,
                currentSpriteIsPreview: currentSprite === previewMode.previewSprite
            };
        });

        expect(state.active).toBe(true);
        expect(state.fileCount).toBe(testDiskSpriteFiles.length);
        expect(state.firstFileName).toBe(testDiskSpriteFiles[0]);
        expect(state.currentIndex).toBe(0);
        expect(state.previewLoaded).toBe(true);
        expect(state.currentSpriteIsPreview).toBe(true);
        await page.close();
    });

    test('preview mode saves the prior sprite/filename/colors for cancel-restore', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            // Set a distinctive baseline so the saved snapshot is observable
            currentSpriteFileName = 'BEFORE/SPR';
            currentSprite.setColor(0, 7);
            currentFrame = 3;
            currentQuad = 1;
            enterPreviewMode();
            return {
                savedFileName: previewMode.savedFileName,
                savedColors0: previewMode.savedSpriteColors[0],
                savedFrame: previewMode.savedCurrentFrame,
                savedQuad: previewMode.savedCurrentQuad
            };
        });

        expect(state.savedFileName).toBe('BEFORE/SPR');
        expect(state.savedColors0).toBe(7);
        expect(state.savedFrame).toBe(3);
        expect(state.savedQuad).toBe(1);
        await page.close();
    });

    test('entering preview mode with no sprites flashes "no sprites on current disk"', async () => {
        const page = await openSpriteMaker({ withSprites: false });

        // Create a blank disk (no sprites) and select it
        await page.evaluate(async () => {
            await disk.createBlank('BLANK', '00');
        });

        const msg = await page.evaluate(() => {
            enterPreviewMode();
            return {
                active: previewMode.active,
                messageText: document.getElementById('messageArea').textContent
            };
        });

        expect(msg.active).toBe(false); // didn't enter preview mode
        expect(msg.messageText).toMatch(/no sprites on current disk/i);
        await page.close();
    });

    test('entering preview mode with no d64 mounted flashes the same "no sprites" message', async () => {
        // Same message as the empty-disk case — user sees "there's nothing to
        // preview here" regardless of whether the disk is empty or missing.
        // GMDisk.listFiles() returns [] when there's no d64 attached, which
        // hits the empty-branch in previewLoader.enter naturally.
        const page = await openSpriteMaker({ withSprites: false });

        const msg = await page.evaluate(() => {
            disk.disk = null;  // detach the mounted d64 from the GMDisk wrapper
            enterPreviewMode();
            return {
                active: previewMode.active,
                messageText: document.getElementById('messageArea').textContent
            };
        });

        expect(msg.active).toBe(false);
        expect(msg.messageText).toMatch(/no sprites on current disk/i);
        await page.close();
    });
});

describe('sprite-maker preview mode cycling', () => {
    test('ArrowDown advances to the next sprite, ArrowUp goes back', async () => {
        const page = await openSpriteMaker();

        const trace = await page.evaluate(async () => {
            enterPreviewMode();
            const startName = previewMode.spriteFiles[previewMode.currentIndex].fileName;

            // Dispatch real keydown events on document so previewModeKeyHandler picks them up
            const press = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

            press('ArrowDown');
            const after1 = previewMode.spriteFiles[previewMode.currentIndex].fileName;
            press('ArrowDown');
            const after2 = previewMode.spriteFiles[previewMode.currentIndex].fileName;
            press('ArrowUp');
            const after3 = previewMode.spriteFiles[previewMode.currentIndex].fileName;

            return { startName, after1, after2, after3 };
        });

        expect(trace.startName).toBe(testDiskSpriteFiles[0]);
        expect(trace.after1).toBe(testDiskSpriteFiles[1]);
        expect(trace.after2).toBe(testDiskSpriteFiles[2]);
        expect(trace.after3).toBe(testDiskSpriteFiles[1]);
        await page.close();
    });

    test('ArrowUp at index 0 is a no-op, ArrowDown at last is a no-op', async () => {
        const page = await openSpriteMaker();

        const trace = await page.evaluate(() => {
            enterPreviewMode();
            const press = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

            press('ArrowUp'); // already at 0, nothing happens
            const afterUpAtTop = previewMode.currentIndex;

            // Jump to last via the framework's API so its internal index advances too
            GMTools.previewLoader.previewAtIndex(previewMode.spriteFiles.length - 1);
            press('ArrowDown'); // already at last
            const afterDownAtBottom = previewMode.currentIndex;

            return { afterUpAtTop, afterDownAtBottom };
        });

        expect(trace.afterUpAtTop).toBe(0);
        expect(trace.afterDownAtBottom).toBe(testDiskSpriteFiles.length - 1);
        await page.close();
    });

    test('message area shows lowercased filename and yes/no controls', async () => {
        const page = await openSpriteMaker();

        const msg = await page.evaluate(() => {
            enterPreviewMode();
            const area = document.getElementById('messageArea');
            return {
                filename: area.querySelector('.load-filename').textContent,
                hasYes: !!area.querySelector('.load-yes'),
                hasNo: !!area.querySelector('.load-no')
            };
        });

        // First sprite on the test disk is "PLAYER/SPR" (filenames are
        // 6-char padded) → lowercased + extension stripped → "player".
        expect(msg.filename).toBe('player');
        expect(msg.hasYes).toBe(true);
        expect(msg.hasNo).toBe(true);
        await page.close();
    });

    test('dragging the filename to a new value cycles the preview', async () => {
        const page = await openSpriteMaker();

        // Drag from sprite 0 to the LAST sprite on the disk. The test
        // used to hard-code index 5 because S2 had many sprites; the
        // gmc64-test disk has fewer, so derive from the actual length.
        const lastIdx = testDiskSpriteFiles.length - 1;
        const result = await page.evaluate((targetIdx) => {
            enterPreviewMode();
            const fileEl = document.querySelector('.load-filename');
            const opts = fileEl._draggableOptions;
            const target = previewMode.spriteFiles[targetIdx].fileName;
            opts.setValue(target);
            return {
                currentIndex: previewMode.currentIndex,
                currentFile: previewMode.spriteFiles[previewMode.currentIndex].fileName
            };
        }, lastIdx);

        expect(result.currentIndex).toBe(lastIdx);
        expect(result.currentFile).toBe(testDiskSpriteFiles[lastIdx]);
        await page.close();
    });
});

describe('sprite-maker preview mode confirm', () => {
    test('Enter commits the previewed sprite as the current one and exits', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            enterPreviewMode();
            // Move to the 3rd sprite, then confirm
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return {
                active: previewMode.active,
                currentSpriteFileName,
                savedSpriteCleared: previewMode.savedSprite === null
            };
        });

        expect(state.active).toBe(false);
        expect(state.currentSpriteFileName).toBe(testDiskSpriteFiles[2]);
        expect(state.savedSpriteCleared).toBe(true);
        await page.close();
    });

    test('clicking "yes" commits and exits', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            enterPreviewMode();
            document.querySelector('.load-yes').click();
            return {
                active: previewMode.active,
                currentSpriteFileName
            };
        });

        expect(state.active).toBe(false);
        expect(state.currentSpriteFileName).toBe(testDiskSpriteFiles[0]);
        await page.close();
    });
});

describe('sprite-maker preview mode cancel', () => {
    test('Escape restores saved sprite, filename, colors, frame, and quad', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            // Establish a distinct baseline
            currentSpriteFileName = 'KEEPME/SPR';
            currentSprite.setColor(0, 11);
            currentFrame = 4;
            currentQuad = 2;
            const baselineSprite = currentSprite;

            enterPreviewMode();
            // Cycle and then cancel
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

            return {
                active: previewMode.active,
                spriteRestored: currentSprite === baselineSprite,
                fileName: currentSpriteFileName,
                color0: currentSprite.getColor(0),
                frame: currentFrame,
                quad: currentQuad
            };
        });

        expect(state.active).toBe(false);
        expect(state.spriteRestored).toBe(true);
        expect(state.fileName).toBe('KEEPME/SPR');
        expect(state.color0).toBe(11);
        expect(state.frame).toBe(4);
        expect(state.quad).toBe(2);
        await page.close();
    });

    test('clicking "no" cancels and restores saved state', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            currentSpriteFileName = 'KEEPME/SPR';
            enterPreviewMode();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            document.querySelector('.load-no').click();
            return { active: previewMode.active, fileName: currentSpriteFileName };
        });

        expect(state.active).toBe(false);
        expect(state.fileName).toBe('KEEPME/SPR');
        await page.close();
    });

    test('lowercase "y" / "n" also confirm / cancel', async () => {
        const page = await openSpriteMaker();

        const yResult = await page.evaluate(() => {
            enterPreviewMode();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true }));
            return { active: previewMode.active, fileName: currentSpriteFileName };
        });
        expect(yResult.active).toBe(false);
        expect(yResult.fileName).toBe(testDiskSpriteFiles[0]);
        await page.close();

        const page2 = await openSpriteMaker();
        const nResult = await page2.evaluate(() => {
            currentSpriteFileName = 'KEEPME/SPR';
            enterPreviewMode();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
            return { active: previewMode.active, fileName: currentSpriteFileName };
        });
        expect(nResult.active).toBe(false);
        expect(nResult.fileName).toBe('KEEPME/SPR');
        await page2.close();
    });
});
