/**
 * Scene-maker file menu + load preview tests
 *
 * Covers the GM-style file menu (file → disk/ok/load/save) and the load-mode
 * delegation through GMTools.previewLoader.
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
let testDiskBase64;
let testDiskSceneFiles;

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    testDiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/gmc64-test.d64')).toString('base64');
    const dir = JSON.parse(readFileSync(join(PROJECT_ROOT, 'tests/golden/testdisk-directory.json'), 'utf8'));
    testDiskSceneFiles = dir.filter(e => e.fileName.endsWith('/PIC')).map(e => e.fileName);
});

afterAll(async () => {
    if (browser) await browser.close();
});

async function openSceneMaker() {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('Page error:', err.message));

    await page.evaluateOnNewDocument((data, selKey, idxKey, dataPrefix) => {
        localStorage.clear();
        const id = 'd_test';
        localStorage.setItem(idxKey, JSON.stringify([
            { id, name: 'gmc64-test.d64', diskName: 'LIBRARY' }
        ]));
        localStorage.setItem(dataPrefix + id, data);
        localStorage.setItem(selKey, id);
    }, testDiskBase64, SELECTION_KEY, POOL_INDEX_KEY, POOL_DATA_PREFIX);

    await page.goto(SCENE_MAKER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof disk !== 'undefined' && typeof fileMenuMode !== 'undefined');
    return page;
}

describe('scene-maker file menu', () => {
    test('clicking "file" swaps the four action buttons to disk/ok/load/save in red', async () => {
        const page = await openSceneMaker();

        const labels = await page.evaluate(() => {
            fileMenu();
            return ['actionBtn1', 'actionBtn2', 'actionBtn3', 'actionBtn4'].map(id => {
                const el = document.getElementById(id);
                return { text: el.textContent.trim(), red: el.classList.contains('cmd-mode') };
            });
        });

        expect(labels.map(l => l.text)).toEqual(['disk', 'ok', 'load', 'save']);
        expect(labels.every(l => l.red)).toBe(true);
        await page.close();
    });

    test('clicking "ok" exits file menu and restores original button labels', async () => {
        const page = await openSceneMaker();

        const after = await page.evaluate(() => {
            fileMenu();          // enter
            actionBtn2Click();   // ok → exit
            return {
                active: fileMenuMode.active,
                labels: ['actionBtn1', 'actionBtn2', 'actionBtn3', 'actionBtn4'].map(id =>
                    document.getElementById(id).textContent.trim()
                )
            };
        });

        expect(after.active).toBe(false);
        expect(after.labels).toEqual(['file', 'menu', 'undo', 'clear']);
        await page.close();
    });

    test('clicking a tool button while in file menu mode exits the menu (and is consumed)', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            const before = currentTool;
            fileMenu();                    // enter file menu mode
            setTool('line');               // click a tool — should just exit
            return {
                fileMenuActive: fileMenuMode.active,
                toolBefore: before,
                toolAfter: currentTool     // unchanged — the click was consumed by exit
            };
        });

        expect(state.fileMenuActive).toBe(false);
        expect(state.toolAfter).toBe(state.toolBefore);
        await page.close();
    });

    test('clicking a color slot while in file menu mode exits the menu', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            const before = selectedColorSlot;
            fileMenu();
            selectColorSlot(2);
            return {
                fileMenuActive: fileMenuMode.active,
                slotBefore: before,
                slotAfter: selectedColorSlot
            };
        });

        expect(state.fileMenuActive).toBe(false);
        expect(state.slotAfter).toBe(state.slotBefore); // click consumed, no slot change
        await page.close();
    });
});

describe('scene-maker load mode', () => {
    test('clicking load enters preview mode and previews first scene', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            fileMenu();
            actionBtn3Click(); // load
            return {
                loaderActive: GMTools.previewLoader.isActive(),
                fileCount: GMTools.previewLoader.files().length,
                firstFile: GMTools.previewLoader.files()[0].fileName,
                currentSceneFileName
            };
        });

        expect(state.loaderActive).toBe(true);
        expect(state.fileCount).toBe(testDiskSceneFiles.length);
        expect(state.firstFile).toBe(testDiskSceneFiles[0]);
        expect(state.currentSceneFileName).toBe(testDiskSceneFiles[0]);
        await page.close();
    });

    test('ArrowDown previews the next scene and updates currentSceneFileName', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            fileMenu();
            actionBtn3Click();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            return {
                currentIndex: GMTools.previewLoader.currentIndex(),
                currentSceneFileName
            };
        });

        expect(state.currentIndex).toBe(1);
        expect(state.currentSceneFileName).toBe(testDiskSceneFiles[1]);
        await page.close();
    });

    test('Enter commits the previewed scene and exits load + file menu', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            fileMenu();
            actionBtn3Click();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return {
                loaderActive: GMTools.previewLoader.isActive(),
                fileMenuActive: fileMenuMode.active,
                currentSceneFileName,
                btn1Label: document.getElementById('actionBtn1').textContent.trim()
            };
        });

        expect(state.loaderActive).toBe(false);
        expect(state.fileMenuActive).toBe(false);
        expect(state.currentSceneFileName).toBe(testDiskSceneFiles[1]);
        expect(state.btn1Label).toBe('file');
        await page.close();
    });

    test('Escape cancels: scene/colors/filename restored, file menu exited', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            // Establish a distinctive baseline
            currentSceneFileName = 'KEEPME/PIC';
            sceneColors.color1 = 7;
            const baselineScene = currentScene;

            fileMenu();
            actionBtn3Click();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

            return {
                loaderActive: GMTools.previewLoader.isActive(),
                fileMenuActive: fileMenuMode.active,
                sceneRestored: currentScene === baselineScene,
                fileName: currentSceneFileName,
                color1: sceneColors.color1
            };
        });

        expect(state.loaderActive).toBe(false);
        expect(state.fileMenuActive).toBe(false);
        expect(state.sceneRestored).toBe(true);
        expect(state.fileName).toBe('KEEPME/PIC');
        expect(state.color1).toBe(7);
        await page.close();
    });

    test('clicking a tool button during load mode cancels the load', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            currentSceneFileName = 'KEEPME/PIC';
            fileMenu();
            actionBtn3Click();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            setTool('line'); // any tool click → cancels load + exits file menu
            return {
                loaderActive: GMTools.previewLoader.isActive(),
                fileMenuActive: fileMenuMode.active,
                fileName: currentSceneFileName
            };
        });

        expect(state.loaderActive).toBe(false);
        expect(state.fileMenuActive).toBe(false);
        expect(state.fileName).toBe('KEEPME/PIC'); // cancelled, restored
        await page.close();
    });
});

describe('scene-maker save mode', () => {
    test('clicking save enters save mode with input prefilled from current filename', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            currentSceneFileName = 'MYPIC/PIC';
            fileMenu();
            actionBtn4Click(); // save
            const input = document.querySelector('.save-filename');
            return {
                saveActive: saveMode.active,
                inputValue: input ? input.value : null
            };
        });

        expect(state.saveActive).toBe(true);
        expect(state.inputValue).toBe('mypic');
        await page.close();
    });

    test('Escape cancels save mode and exits file menu', async () => {
        const page = await openSceneMaker();

        const state = await page.evaluate(() => {
            fileMenu();
            actionBtn4Click();
            // Blur the input so the document-level handler picks up Escape
            document.querySelector('.save-filename').blur();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return {
                saveActive: saveMode.active,
                fileMenuActive: fileMenuMode.active
            };
        });

        expect(state.saveActive).toBe(false);
        expect(state.fileMenuActive).toBe(false);
        await page.close();
    });
});
