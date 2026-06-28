/**
 * Scene-maker save mode tests — mirrors sprite-save.test.js so we have
 * parallel coverage for both consumers of the extracted save dialog.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const SCENE_MAKER_URL = `file://${join(PROJECT_ROOT, 'scene-maker.html')}`;
const SELECTION_KEY = 'gm_disk_selection_scene-maker';
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

async function openSceneMaker({ diskBase64 = s2DiskBase64, diskName = 'gmc64-test.d64' } = {}) {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('Page error:', err.message));

    await page.evaluateOnNewDocument((data, name, selKey, idxKey, dataPrefix) => {
        localStorage.clear();
        const id = 'd_test';
        localStorage.setItem(idxKey, JSON.stringify([{ id, name, diskName: 'LIBRARY' }]));
        localStorage.setItem(dataPrefix + id, data);
        localStorage.setItem(selKey, id);
    }, diskBase64, diskName, SELECTION_KEY, POOL_INDEX_KEY, POOL_DATA_PREFIX);

    await page.goto(SCENE_MAKER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof disk !== 'undefined' && typeof saveMode !== 'undefined');
    return page;
}

describe('scene-maker save entry', () => {
    test('enters save mode with input prefilled from current filename', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            currentSceneFileName = 'MYPIC/PIC';
            fileMenu();
            enterSaveMode();
            return {
                active: saveMode.active,
                inputValue: document.querySelector('.save-filename').value
            };
        });

        expect(state.active).toBe(true);
        expect(state.inputValue).toBe('mypic');
        await page.close();
    });

    test('enters with empty input when there is no current filename', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            currentSceneFileName = null;
            fileMenu();
            enterSaveMode();
            return { value: document.querySelector('.save-filename').value };
        });

        expect(state.value).toBe('');
        await page.close();
    });

    test('no-scene path flashes "no scene to save" and does not enter save mode', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            currentScene = null;
            fileMenu();
            enterSaveMode();
            return {
                active: saveMode.active,
                messageText: document.getElementById('message').textContent
            };
        });

        expect(state.active).toBe(false);
        expect(state.messageText).toMatch(/no scene to save/i);
        await page.close();
    });
});

describe('scene-maker save confirm and overwrite', () => {
    test('Enter on input commits a new file and exits', async () => {
        const page = await openSceneMaker({ diskBase64: blankDiskBase64, diskName: 'blank.d64' });

        const state = await page.evaluate(async () => {
            currentSceneFileName = null;
            fileMenu();
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'NEWPIC';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 50));
            return {
                active: saveMode.active,
                currentSceneFileName,
                fileExists: disk.listFiles(GMDisk.FILE_TYPES.SCENE)
                    .some(f => f.fileName.toUpperCase().startsWith('NEWPIC'))
            };
        });

        expect(state.active).toBe(false);
        expect(state.currentSceneFileName).toMatch(/^NEWPIC/);
        expect(state.fileExists).toBe(true);
        await page.close();
    });

    test('preserves spaces inside the filename (e.g. "AB CD" stays as "AB CD ")', async () => {
        // GM filenames can have significant whitespace; the shared saveDialog
        // helper used to strip middle spaces. This test pins the contract for
        // scene-maker specifically — sprite-save has the matching test.
        const page = await openSceneMaker({ diskBase64: blankDiskBase64, diskName: 'blank.d64' });

        const state = await page.evaluate(async () => {
            currentSceneFileName = null;
            fileMenu();
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'ab cd';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await new Promise(r => setTimeout(r, 50));
            return {
                savedNames: disk.listFiles(GMDisk.FILE_TYPES.SCENE).map(f => f.fileName)
            };
        });

        expect(state.savedNames).toContain('AB CD /PIC');
        await page.close();
    });

    test('saving over an existing file shows overwrite prompt', async () => {
        // S2 has MEADOW/PIC — try to save with that name
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            fileMenu();
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'MEADOW';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            confirmSave();
            return {
                confirmingOverwrite: GMTools.saveDialog.confirmingOverwrite(),
                messageText: document.getElementById('message').textContent
            };
        });

        expect(state.confirmingOverwrite).toBe(true);
        expect(state.messageText).toMatch(/overwrite/i);
        await page.close();
    });

    test('overwrite "yes" performs the save and exits', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(async () => {
            fileMenu();
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'MEADOW';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            confirmSave();
            document.querySelector('.save-yes').click();
            await new Promise(r => setTimeout(r, 50));
            return { active: saveMode.active, currentSceneFileName };
        });

        expect(state.active).toBe(false);
        expect(state.currentSceneFileName).toMatch(/^MEADOW/);
        await page.close();
    });

    test('overwrite "no" returns to the name input without saving', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            currentSceneFileName = null;
            fileMenu();
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.value = 'MEADOW';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            confirmSave();
            document.querySelector('.save-no').click();
            return {
                active: GMTools.saveDialog.isActive(),
                confirmingOverwrite: GMTools.saveDialog.confirmingOverwrite()
            };
        });

        expect(state.active).toBe(true);
        expect(state.confirmingOverwrite).toBe(false);
        await page.close();
    });
});

describe('scene-maker save cancel', () => {
    test('Escape on input cancels save mode and exits file menu', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            fileMenu();
            enterSaveMode();
            const input = document.querySelector('.save-filename');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { saveActive: saveMode.active, fileMenuActive: fileMenuMode.active };
        });

        expect(state.saveActive).toBe(false);
        expect(state.fileMenuActive).toBe(false);
        await page.close();
    });
});
