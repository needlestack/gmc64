/**
 * Sprite-maker save mode tests
 *
 * Locks in the in-app save dialog behaviour before extracting it into
 * GMTools.saveDialog. Each test exercises one slice (entry, validation,
 * overwrite branch, confirm, cancel, keyboard shortcuts) so a regression
 * after the extraction points at a specific failure.
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
let s2DiskBase64;
let blankDiskBase64;

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    s2DiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/gmc64-test.d64')).toString('base64');
    blankDiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/BlankDisk.d64')).toString('base64');
});

afterAll(async () => {
    if (browser) await browser.close();
});

async function openSpriteMaker({ diskBase64 = s2DiskBase64, diskName = 'gmc64-test.d64' } = {}) {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('Page error:', err.message));

    await page.evaluateOnNewDocument((data, name, selKey, idxKey, dataPrefix) => {
        localStorage.clear();
        const id = 'd_test';
        localStorage.setItem(idxKey, JSON.stringify([{ id, name, diskName: 'LIBRARY' }]));
        localStorage.setItem(dataPrefix + id, data);
        localStorage.setItem(selKey, id);
    }, diskBase64, diskName, SELECTION_KEY, POOL_INDEX_KEY, POOL_DATA_PREFIX);

    await page.goto(SPRITE_MAKER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof disk !== 'undefined' && typeof saveMode !== 'undefined');
    // Make sure there's a sprite to save (createBlank if none)
    await page.evaluate(() => {
        if (!currentSprite) {
            currentSprite = gmSprite.createBlank({ name: 'TEST  ' });
        }
    });
    return page;
}

describe('sprite-maker save mode entry', () => {
    test('enters save mode with input prefilled from current filename', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            currentSpriteFileName = 'MYTEST/SPR';
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            return {
                active: saveMode.active,
                inputValue: input ? input.value : null
            };
        });

        expect(state.active).toBe(true);
        // Filename trimmed of /SPR extension and trailing space, lowercased for display
        expect(state.inputValue).toBe('mytest');
        await page.close();
    });

    test('enters with empty input when there is no current filename', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            currentSpriteFileName = null;
            enterSaveMode();
            return { value: document.querySelector('.save-filename').value };
        });

        expect(state.value).toBe('');
        await page.close();
    });

    test('no-sprite path flashes "no sprite to save" and does not enter save mode', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            currentSprite = null;
            enterSaveMode();
            return {
                active: saveMode.active,
                messageText: document.getElementById('messageArea').textContent
            };
        });

        expect(state.active).toBe(false);
        expect(state.messageText).toMatch(/no sprite to save/i);
        await page.close();
    });
});

describe('sprite-maker save validation', () => {
    test('confirming with empty filename flashes "enter a name"', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            currentSpriteFileName = null;
            enterSaveMode();
            // confirmSave with empty fileName
            confirmSave();
            return {
                active: saveMode.active,
                messageText: document.getElementById('messageArea').textContent
            };
        });

        expect(state.active).toBe(true); // Still in save mode
        expect(state.messageText).toMatch(/enter a name/i);
        await page.close();
    });
});

describe('sprite-maker save confirm', () => {
    test('Enter on input commits a new file and exits save mode', async () => {
        const page = await openSpriteMaker({ diskBase64: blankDiskBase64, diskName: 'blank.d64' });

        const state = await page.evaluate(async () => {
            currentSpriteFileName = null;
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'NEWONE';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            // Simulate Enter key on the input
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            // Allow async save to settle
            await new Promise(r => setTimeout(r, 50));
            return {
                active: saveMode.active,
                currentSpriteFileName,
                fileExists: disk.listFiles(GMDisk.FILE_TYPES.SPRITE)
                    .some(f => f.fileName.toUpperCase().startsWith('NEWONE'))
            };
        });

        expect(state.active).toBe(false);
        expect(state.currentSpriteFileName).toMatch(/^NEWONE/);
        expect(state.fileExists).toBe(true);
        await page.close();
    });

    test('preserves spaces inside the filename (e.g. "AB CD" stays as "AB CD ")', async () => {
        // GM filenames can have significant whitespace. The old format helper
        // stripped non-alphanumerics, collapsing "AB CD" to "ABCD" — this test
        // pins that down so future regex tightening doesn't silently re-break it.
        const page = await openSpriteMaker({ diskBase64: blankDiskBase64, diskName: 'blank.d64' });

        const state = await page.evaluate(async () => {
            currentSpriteFileName = null;
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'ab cd';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 50));
            return {
                savedNames: disk.listFiles(GMDisk.FILE_TYPES.SPRITE).map(f => f.fileName)
            };
        });

        expect(state.savedNames).toContain('AB CD /SPR');
        await page.close();
    });

    test('clicking "yes" commits and exits', async () => {
        const page = await openSpriteMaker({ diskBase64: blankDiskBase64, diskName: 'blank.d64' });

        const state = await page.evaluate(async () => {
            currentSpriteFileName = null;
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'CLICKY';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('.save-yes').click();
            await new Promise(r => setTimeout(r, 50));
            return {
                active: saveMode.active,
                fileExists: disk.listFiles(GMDisk.FILE_TYPES.SPRITE)
                    .some(f => f.fileName.toUpperCase().startsWith('CLICKY'))
            };
        });

        expect(state.active).toBe(false);
        expect(state.fileExists).toBe(true);
        await page.close();
    });
});

describe('sprite-maker save overwrite branch', () => {
    test('saving over an existing file shows overwrite prompt', async () => {
        // Test disk has PLAYER/SPR — try to save with same name
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'PLAYER';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            confirmSave();
            return {
                confirmingOverwrite: GMTools.saveDialog.confirmingOverwrite(),
                messageText: document.getElementById('messageArea').textContent
            };
        });

        expect(state.confirmingOverwrite).toBe(true);
        expect(state.messageText).toMatch(/overwrite/i);
        await page.close();
    });

    test('overwrite "yes" performs the save and exits', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(async () => {
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'PLAYER';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            confirmSave();
            // Now on the overwrite prompt; click yes
            document.querySelector('.save-yes').click();
            await new Promise(r => setTimeout(r, 50));
            return {
                active: saveMode.active,
                currentSpriteFileName
            };
        });

        expect(state.active).toBe(false);
        expect(state.currentSpriteFileName).toMatch(/^PLAYER/);
        await page.close();
    });

    test('overwrite "no" returns to the name input without saving', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            currentSpriteFileName = null;
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'PLAYER';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            confirmSave();
            // Now on the overwrite prompt; click no
            document.querySelector('.save-no').click();
            return {
                active: GMTools.saveDialog.isActive(),
                confirmingOverwrite: GMTools.saveDialog.confirmingOverwrite(),
                messageText: document.getElementById('messageArea').textContent
            };
        });

        expect(state.active).toBe(true);             // Still in save mode
        expect(state.confirmingOverwrite).toBe(false);
        expect(state.messageText).toMatch(/save/i);  // Back to the save prompt
        await page.close();
    });
});

describe('sprite-maker save cancel', () => {
    test('Escape on the input cancels save mode', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { active: saveMode.active };
        });

        expect(state.active).toBe(false);
        await page.close();
    });

    test('clicking "no" cancels', async () => {
        const page = await openSpriteMaker();

        const state = await page.evaluate(() => {
            enterSaveMode();
            document.querySelector('.save-no').click();
            return { active: saveMode.active };
        });

        expect(state.active).toBe(false);
        await page.close();
    });
});

describe('sprite-maker save keyboard shortcuts outside input', () => {
    test('y / n keys also work when input is not focused', async () => {
        const page = await openSpriteMaker();

        // y at the name-entry prompt with non-empty value commits
        const yResult = await page.evaluate(async () => {
            currentSpriteFileName = null;
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'YTEST';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.blur();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true }));
            await new Promise(r => setTimeout(r, 50));
            return { active: saveMode.active, fileName: currentSpriteFileName };
        });
        expect(yResult.active).toBe(false);
        expect(yResult.fileName).toMatch(/^YTEST/);
        await page.close();

        // n at the name-entry prompt cancels
        const page2 = await openSpriteMaker();
        const nResult = await page2.evaluate(() => {
            enterSaveMode();
            document.querySelector('.save-filename').blur();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
            return { active: saveMode.active };
        });
        expect(nResult.active).toBe(false);
        await page2.close();
    });
});
