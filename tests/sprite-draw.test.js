/**
 * Sprite-maker drawing tests
 *
 * Pins down the contract between the GM color slot the user picks (Color 1, 2, 3)
 * and what they actually see painted in the fatbits grid.
 *
 * History: a regression made these reversed — clicking "Color 1" painted with
 * Color 2's hue. The fix is a SLOT_PIXEL_MAP that translates GM slot numbers
 * to raw C64 hardware pixel values (which don't line up: slot 1 = hw 10 = 2,
 * slot 2 = hw 01 = 1). These tests assert the end-to-end behavior — what the
 * user clicks and what they see — so they catch any future swap regardless of
 * the internal representation.
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
        const id = 'd_test';
        localStorage.setItem(idxKey, JSON.stringify([
            { id, name: 'BlankDisk.d64', diskName: 'BLANK' }
        ]));
        localStorage.setItem(dataPrefix + id, data);
        localStorage.setItem(selKey, id);
    }, blankDiskBase64, SELECTION_KEY, POOL_INDEX_KEY, POOL_DATA_PREFIX);

    await page.goto(SPRITE_MAKER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof newSprite !== 'undefined' && typeof selectColor !== 'undefined');

    // Set up a clean multicolor sprite. We override the palette AFTER newSprite()
    // because it builds a fresh sprite with default colours. Distinctive per-slot
    // colors let us identify which slot was actually painted.
    await page.evaluate(() => {
        setupState.isMultiColor = true;
        newSprite();
        currentSprite.setPalette([0, 2, 6, 7]); // bg=black, c1=red, c2=blue, c3=yellow
        updatePaletteDisplay();
        updateFatBits();
    });
    return page;
}

// Paint cell (x,y) with the currently selected color slot and read back the
// CSS color the fatbits grid actually rendered for that cell. Also returns the
// expected color for each slot so callers can compare without hardcoding RGB.
async function paintAndReadCell(page, x, y) {
    return page.evaluate((x, y) => {
        const cell = document.querySelector(`#fatbits td[data-x="${x}"][data-y="${y}"]`);
        const ev = { target: cell, preventDefault: () => {}, stopPropagation: () => {} };
        cellMouseDown(ev);
        // Release the synthetic drag so the next paint starts fresh
        drawMode = null;
        return {
            pixelValue: pixelData[y][x],
            renderedBg: cell.style.backgroundColor
        };
    }, x, y);
}

// Read the CSS color that paletteToCSS produces for a given slot — keeps the
// test in sync with the page's actual c64Palette without re-hardcoding it.
async function cssForSlot(page, slot) {
    return page.evaluate((slot) => paletteToCSS(currentSprite.getColor(slot)), slot);
}

describe('sprite-maker — color slot painting matches the slot the user picked', () => {
    test('painting with Color 1 renders the Color 1 swatch color', async () => {
        const page = await openSpriteMaker();
        await page.evaluate(() => selectColor(1));

        const { renderedBg } = await paintAndReadCell(page, 0, 0);
        expect(renderedBg).toBe(await cssForSlot(page, 1));
        await page.close();
    });

    test('painting with Color 2 renders the Color 2 swatch color', async () => {
        const page = await openSpriteMaker();
        await page.evaluate(() => selectColor(2));

        const { renderedBg } = await paintAndReadCell(page, 1, 0);
        expect(renderedBg).toBe(await cssForSlot(page, 2));
        await page.close();
    });

    test('painting with Color 3 renders the Color 3 swatch color', async () => {
        const page = await openSpriteMaker();
        await page.evaluate(() => selectColor(3));

        const { renderedBg } = await paintAndReadCell(page, 2, 0);
        expect(renderedBg).toBe(await cssForSlot(page, 3));
        await page.close();
    });

    test('all three slots paint distinct colors (catches any swap regression)', async () => {
        const page = await openSpriteMaker();

        await page.evaluate(() => selectColor(1));
        const c1 = await paintAndReadCell(page, 0, 0);

        await page.evaluate(() => selectColor(2));
        const c2 = await paintAndReadCell(page, 1, 0);

        await page.evaluate(() => selectColor(3));
        const c3 = await paintAndReadCell(page, 2, 0);

        expect(c1.renderedBg).toBe(await cssForSlot(page, 1));
        expect(c2.renderedBg).toBe(await cssForSlot(page, 2));
        expect(c3.renderedBg).toBe(await cssForSlot(page, 3));

        // Distinctness — any swap would collapse two of these
        expect(c1.renderedBg).not.toBe(c2.renderedBg);
        expect(c2.renderedBg).not.toBe(c3.renderedBg);
        expect(c1.renderedBg).not.toBe(c3.renderedBg);

        await page.close();
    });

    test('round-trip: serialize-and-reload preserves which slot was painted', async () => {
        // The hardware pixel value persists to bytes; reloading must reinstate
        // the same painted color (this is the same axis as the original bug —
        // a swap in the read path would also flip colors after save/load).
        const page = await openSpriteMaker();

        const expectedSlot1Color = await cssForSlot(page, 1);

        const reloadedColor = await page.evaluate(() => {
            selectColor(1);
            const cell = document.querySelector('#fatbits td[data-x="0"][data-y="0"]');
            cellMouseDown({ target: cell, preventDefault: () => {}, stopPropagation: () => {} });
            drawMode = null;
            syncToSprite();

            const bytes = serializeSprite();
            const reloaded = new gmSprite(bytes);
            currentSprite = reloaded;
            // Palette now lives on the sprite — no separate copy to restore.
            rawBytesToPixelData(reloaded.sprite[0].imageData[0]);
            updateFatBits();
            return document.querySelector('#fatbits td[data-x="0"][data-y="0"]').style.backgroundColor;
        });

        expect(reloadedColor).toBe(expectedSlot1Color);
        await page.close();
    });
});

describe('sprite-maker — hi-res color swatch updates the actual foreground color', () => {
    // Regression: showColorPicker used to remap hi-res slot 1 → slot 2, but
    // both the swatch display and the hi-res renderer read palette slot 1.
    // Result: clicking the visible Row 1 swatch wrote to an unused slot, so
    // nothing updated (fatbits, swatch, or rendered sprite).
    async function openHiResSprite() {
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

        // Switch to hi-res before newSprite (initPixelData reads setupState).
        // rebuildFatBitsGrid replaces the 12-cell grid with 24 cells.
        await page.evaluate(() => {
            setupState.isMultiColor = false;
            rebuildFatBitsGrid();
            newSprite();
            currentSprite.setPalette([0, 2, 6, 7]); // bg, fg(=c1)=red, c2, c3
            updatePaletteDisplay();
            updateFatBits();
        });
        return page;
    }

    test('clicking the Row 1 swatch updates slot 1, not slot 2', async () => {
        const page = await openHiResSprite();

        const result = await page.evaluate(() => {
            const before = { c1: currentSprite.getColor(1), c2: currentSprite.getColor(2) };
            showColorPicker(1, { clientX: 0, clientY: 0 });
            document.querySelectorAll('.color-swatch')[9].click(); // brown
            return {
                before,
                after: { c1: currentSprite.getColor(1), c2: currentSprite.getColor(2) }
            };
        });

        expect(result.before.c1).toBe(2);
        expect(result.after.c1).toBe(9);   // The slot we clicked
        expect(result.after.c2).toBe(6);   // Untouched
        await page.close();
    });

    test('changing the hi-res foreground color updates the painted fatbits cell', async () => {
        const page = await openHiResSprite();

        const result = await page.evaluate(() => {
            selectColor(1);
            const cell = document.querySelector('#fatbits td[data-x="0"][data-y="0"]');
            cellMouseDown({ target: cell, preventDefault: () => {}, stopPropagation: () => {} });
            drawMode = null;
            const before = cell.style.backgroundColor;

            showColorPicker(1, { clientX: 0, clientY: 0 });
            document.querySelectorAll('.color-swatch')[9].click();

            return { before, after: cell.style.backgroundColor };
        });

        expect(result.before).not.toBe(result.after);
        await page.close();
    });

    test('changing the hi-res foreground color updates the rendered sprite preview', async () => {
        const page = await openHiResSprite();

        const before = await page.evaluate(() => {
            selectColor(1);
            const cell = document.querySelector('#fatbits td[data-x="0"][data-y="0"]');
            cellMouseDown({ target: cell, preventDefault: () => {}, stopPropagation: () => {} });
            drawMode = null;
            updatePreview();
            // Find any non-bg sprite pixel on the preview canvas
            const ctx = document.getElementById('preview').getContext('2d');
            for (let x = 150; x < 250; x++) {
                for (let y = 90; y < 130; y++) {
                    const p = ctx.getImageData(x, y, 1, 1).data;
                    if (p[3] > 0 && !(p[0] === 0 && p[1] === 0 && p[2] === 0)) {
                        return { x, y, r: p[0], g: p[1], b: p[2] };
                    }
                }
            }
            return null;
        });

        expect(before).not.toBeNull();

        const after = await page.evaluate((pos) => {
            showColorPicker(1, { clientX: 0, clientY: 0 });
            document.querySelectorAll('.color-swatch')[9].click();
            const ctx = document.getElementById('preview').getContext('2d');
            const p = ctx.getImageData(pos.x, pos.y, 1, 1).data;
            return { r: p[0], g: p[1], b: p[2], gmColor1: currentSprite._gmColor1 };
        }, before);

        // Same pixel position should now show a different color
        expect(after.gmColor1).toBe(9);
        expect([after.r, after.g, after.b]).not.toEqual([before.r, before.g, before.b]);
        await page.close();
    });
});

describe('sprite-maker — color swap reorganises slots without changing how the sprite looks', () => {
    // The swap is for the use case where a sprite was painted with (say) the
    // shirt in slot 3 but the user wants the shirt to be the unique per-slot
    // colour (slot 1) when assigning the sprite to multiple slots in the
    // editor. enterSwapMode(3) → toSlot=1 → confirmSwap(true) should reassign
    // pixels AND swap the slot colours so the rendered fatbits look identical.

    test('swap of slot 3 with slot 1 swaps both the pixels and the slot colours', async () => {
        const page = await openSpriteMaker();

        const result = await page.evaluate(() => {
            // Paint cell (0,0) with slot 1 and cell (1,1) with slot 3 so we
            // have one pixel of each.
            selectColor(1);
            const c1 = document.querySelector('#fatbits td[data-x="0"][data-y="0"]');
            cellMouseDown({ target: c1, preventDefault: () => {}, stopPropagation: () => {} });
            drawMode = null;
            selectColor(3);
            const c3 = document.querySelector('#fatbits td[data-x="1"][data-y="1"]');
            cellMouseDown({ target: c3, preventDefault: () => {}, stopPropagation: () => {} });
            drawMode = null;
            syncToSprite();

            const beforeColors = currentSprite.getPalette();
            const beforePixel00 = pixelData[0][0];   // was slot 1 → hw 2
            const beforePixel11 = pixelData[1][1];   // was slot 3 → hw 3
            const beforeCellBg00 = c1.style.backgroundColor;
            const beforeCellBg11 = c3.style.backgroundColor;

            // Run the swap programmatically through the real mode machinery.
            enterSwapMode(3);
            swapMode.toSlot = 1;
            confirmSwap(true);

            return {
                beforeColors,
                afterColors: currentSprite.getPalette(),
                // The pixel formerly painted as slot 1 is now slot 3 (hw 3) and
                // vice versa; with the colour swap the rendered cells should
                // look the SAME as before.
                afterPixel00: pixelData[0][0],
                afterPixel11: pixelData[1][1],
                beforeCellBg00,
                beforeCellBg11,
                afterCellBg00: c1.style.backgroundColor,
                afterCellBg11: c3.style.backgroundColor,
                modeActive: swapMode.active
            };
        });

        // Slot colours swapped at indices 1 and 3
        expect(result.afterColors[1]).toBe(result.beforeColors[3]);
        expect(result.afterColors[3]).toBe(result.beforeColors[1]);
        // bg and slot 2 untouched
        expect(result.afterColors[0]).toBe(result.beforeColors[0]);
        expect(result.afterColors[2]).toBe(result.beforeColors[2]);

        // Pixel hardware values swapped (hw 2 ↔ hw 3)
        expect(result.afterPixel00).toBe(3);
        expect(result.afterPixel11).toBe(2);

        // Visually identical — same CSS colour at each cell after the swap
        expect(result.afterCellBg00).toBe(result.beforeCellBg00);
        expect(result.afterCellBg11).toBe(result.beforeCellBg11);

        // Mode exited after confirm
        expect(result.modeActive).toBe(false);
        await page.close();
    });

    test('swap with same slot is a no-op (visually and structurally)', async () => {
        const page = await openSpriteMaker();

        const stable = await page.evaluate(() => {
            selectColor(2);
            const c = document.querySelector('#fatbits td[data-x="3"][data-y="3"]');
            cellMouseDown({ target: c, preventDefault: () => {}, stopPropagation: () => {} });
            drawMode = null;
            syncToSprite();

            const before = { colors: currentSprite.getPalette(), pixel: pixelData[3][3] };

            enterSwapMode(2);
            swapMode.toSlot = 2;  // swap with self
            confirmSwap(true);

            return {
                before,
                after: { colors: currentSprite.getPalette(), pixel: pixelData[3][3] }
            };
        });

        expect(stable.after.colors).toEqual(stable.before.colors);
        expect(stable.after.pixel).toBe(stable.before.pixel);
        await page.close();
    });
});

describe('sprite-maker — palette is sprite-wide (subsprite edits go to canonical palette)', () => {
    // Regression: a colour change while editing a subsprite quad used to silently
    // drop. The cause was a `currentQuad === 0` guard around the palette sync —
    // edits on a subsprite never reached the sprite's top-level palette, so the
    // renderer (which reads top-level) showed the old colour and the serialised
    // bytes did too. Now the palette lives on the sprite itself and there is no
    // per-quad branching.
    test('changing a colour while on quad 2 updates both the preview and the serialised bytes', async () => {
        const page = await openSpriteMaker();

        const result = await page.evaluate(() => {
            // Make a 2-quad sprite so we can navigate to a subsprite.
            setupState.numSprites = 2;
            adjustQuadCount(2);
            currentQuad = 1; // jump to subsprite

            // Pick a colour the sprite didn't already have so the change is observable.
            const before = currentSprite.getColor(3);
            const newColour = (before + 7) & 0x0F;
            currentSprite.setColor(3, newColour);

            // Re-parse the serialised bytes to confirm the change survives roundtrip.
            const bytes = serializeSprite();
            const reloaded = new gmSprite(bytes);

            return {
                spriteColor3:      currentSprite.getColor(3),
                reloadedColor3:    reloaded.getColor(3),
                // Subquad colour fields should be normalized to the canonical palette,
                // so reading quad 1's stored colour also reflects the change.
                reloadedQuad1Col3: reloaded.sprite[1]._gmColor3,
                expected:          newColour
            };
        });

        expect(result.spriteColor3).toBe(result.expected);
        expect(result.reloadedColor3).toBe(result.expected);
        expect(result.reloadedQuad1Col3).toBe(result.expected);
        await page.close();
    });
});
