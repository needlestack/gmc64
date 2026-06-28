/**
 * Sprite-maker mode-handling tests
 *
 * Covers the multicolor/hi-res mode boundary across editor operations:
 * loading sprites of either mode, clearing, mode toggles. These have been
 * a recurring regression surface — pixel grid width, palette swatch
 * visibility, and which palette slot drives the renderer all have to
 * agree, and any drift shows up as a half-cleared canvas or a picker
 * showing too many swatches.
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
let blankDiskBase64;

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    blankDiskBase64 = readFileSync(join(PROJECT_ROOT, 'tests/disks/BlankDisk.d64')).toString('base64');
});

afterAll(async () => {
    if (browser) await browser.close();
});

async function openSpriteMaker() {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('Page error:', err.message));

    await page.evaluateOnNewDocument((data, selKey, idxKey, dataPrefix) => {
        localStorage.clear();
        const id = 'd_t';
        localStorage.setItem(idxKey, JSON.stringify([{ id, name: 'BlankDisk.d64', diskName: 'BLANK' }]));
        localStorage.setItem(dataPrefix + id, data);
        localStorage.setItem(selKey, id);
    }, blankDiskBase64, SELECTION_KEY, POOL_INDEX_KEY, POOL_DATA_PREFIX);

    await page.goto(SPRITE_MAKER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof newSprite !== 'undefined' && typeof rebuildFatBitsGrid !== 'undefined');
    return page;
}

// Builds a hi-res .SPR file in-page and writes it to the in-memory disk so the
// load-mode preview will pick it up like any user-saved sprite.
async function writeHiResSpriteToDisk(page, fileName) {
    await page.evaluate(async (name) => {
        const original = setupState.isMultiColor;
        setupState.isMultiColor = false;
        rebuildFatBitsGrid();
        newSprite();
        // Paint one pixel so it's not a totally empty sprite
        selectColor(1);
        const cell = document.querySelector('#fatbits td[data-x="0"][data-y="0"]');
        cellMouseDown({ target: cell, preventDefault: () => {}, stopPropagation: () => {} });
        drawMode = null;
        syncToSprite();
        const bytes = serializeSprite();
        await disk.saveFile(name, bytes);
        // Restore default state so the next test op starts clean
        setupState.isMultiColor = original;
        rebuildFatBitsGrid();
        newSprite();
    }, fileName);
}

describe('sprite-maker — loading a hi-res sprite shows hi-res palette UI', () => {
    test('load-mode preview of a hi-res sprite hides rows 2 and 3 in the picker', async () => {
        const page = await openSpriteMaker();
        await writeHiResSpriteToDisk(page, 'HIRES/SPR');

        const visibility = await page.evaluate(() => {
            enterLoadMode();
            // The previewLoader auto-previews the first file alphabetically;
            // HIRES is the only sprite on the test disk.
            return {
                isMultiColor: setupState.isMultiColor,
                color1: document.getElementById('color1Swatch').style.visibility,
                color2: document.getElementById('color2Swatch').style.visibility,
                color3: document.getElementById('color3Swatch').style.visibility
            };
        });

        expect(visibility.isMultiColor).toBe(false);  // Sanity: we loaded hi-res
        expect(visibility.color1).toBe('visible');     // Foreground stays
        expect(visibility.color2).toBe('hidden');      // Unused in hi-res
        expect(visibility.color3).toBe('hidden');      // Unused in hi-res
        await page.close();
    });

    test('loadSpriteFromDisk for a hi-res sprite also hides rows 2 and 3', async () => {
        // Different code path from load-mode preview — covers the disk-popup
        // confirm path so both stay in sync.
        const page = await openSpriteMaker();
        await writeHiResSpriteToDisk(page, 'HIRES/SPR');

        const visibility = await page.evaluate(() => {
            const bytes = disk.loadFile('HIRES/SPR');
            loadSpriteFromDisk('HIRES/SPR', bytes);
            return {
                color2: document.getElementById('color2Swatch').style.visibility,
                color3: document.getElementById('color3Swatch').style.visibility
            };
        });

        expect(visibility.color2).toBe('hidden');
        expect(visibility.color3).toBe('hidden');
        await page.close();
    });
});

describe('sprite-maker — clearing a sprite leaves no ghost cells from the previous mode', () => {
    test('clearing after switching to hi-res rebuilds the grid to multicolor width', async () => {
        const page = await openSpriteMaker();

        const cellCounts = await page.evaluate(() => {
            // Switch to hi-res (24 cells per row) and paint enough pixels to
            // make stale-cell bugs visible.
            setupState.isMultiColor = false;
            rebuildFatBitsGrid();
            newSprite();
            selectColor(1);
            for (let x = 0; x < 24; x++) {
                const cell = document.querySelector(`#fatbits td[data-x="${x}"][data-y="0"]`);
                cellMouseDown({ target: cell, preventDefault: () => {}, stopPropagation: () => {} });
                drawMode = null;
            }
            const beforeCellsPerRow = document.querySelectorAll('#fatbits tr:first-child td').length;

            // confirmClear forces isMultiColor=true and calls newSprite(); the
            // fix puts rebuildFatBitsGrid inside newSprite so the DOM resizes.
            confirmClear(true);

            const afterCellsPerRow = document.querySelectorAll('#fatbits tr:first-child td').length;
            // Verify no cell has a painted color left over
            const leftoverPainted = Array.from(document.querySelectorAll('#fatbits td'))
                .filter(c => {
                    const bg = c.style.backgroundColor;
                    // bg color (after clear, slot 0 = green = c64 idx 5)
                    return bg && bg !== paletteToCSS(currentSprite.getColor(0));
                }).length;

            return { beforeCellsPerRow, afterCellsPerRow, leftoverPainted };
        });

        expect(cellCounts.beforeCellsPerRow).toBe(24);  // hi-res before clear
        expect(cellCounts.afterCellsPerRow).toBe(12);   // multicolor after clear
        expect(cellCounts.leftoverPainted).toBe(0);     // no ghost cells
        await page.close();
    });
});

// (Copy-dropdown frame-count coverage now lives in tests/sprite-frames.test.js
// under the "31 slots" model — every dropdown always shows 31 options.)
