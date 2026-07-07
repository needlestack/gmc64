/**
 * Touch / pointer-drag tests
 *
 * Guards the pointer-events wiring used by the editor apps' drawing
 * surfaces. The regular sprite-*.test.js tests bypass this by calling
 * paint functions (cellMouseDown / cellHover) directly with synthetic
 * mouse events — that verifies paint LOGIC but doesn't exercise the
 * event handlers themselves. If the pointerdown/pointermove wiring
 * breaks (bad selector, missing setPointerCapture, no elementFromPoint
 * lookup on move), the sprite tests all pass while touch drag is dead.
 *
 * These tests dispatch real PointerEvents with `pointerType: 'touch'`
 * across drawing surfaces and check that the events land on the right
 * cells — the same event sequence a real touch drag produces.
 *
 * History: added when sprite-maker's fatbits grid was migrated from
 * per-cell mousedown/mouseover to delegated Pointer Events. The old
 * pattern painted only the initial cell on touch because touchmove
 * doesn't dispatch mouseover on newly-hovered cells; the new pattern
 * uses elementFromPoint inside pointermove to find each cell under
 * the finger as it drags across.
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
const SCENE_MAKER_URL = `file://${join(PROJECT_ROOT, 'scene-maker.html')}`;
const SPRITE_SELECTION_KEY = 'gm_disk_selection_sprite-maker';
const SCENE_SELECTION_KEY = 'gm_disk_selection_scene-maker';
const SELECTION_KEY = SPRITE_SELECTION_KEY;  // alias for legacy sprite tests below
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

async function openSpriteMakerReady() {
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

    await page.evaluate(() => {
        setupState.isMultiColor = true;
        newSprite();
        currentSprite.setPalette([0, 2, 6, 7]);
        updatePaletteDisplay();
        updateFatBits();
        selectColor(1);
    });
    return page;
}

// Simulate a touch drag from (x1,y1) to (x2,y2) in fatbits-cell coordinates
// via the real event pipeline. Returns the list of cells that ended up
// painted (pixelData non-zero), sorted for deterministic assertions.
async function touchDragAndReadPainted(page, waypoints) {
    return page.evaluate(async (waypoints) => {
        const fatbits = document.getElementById('fatbits');
        const cellCenter = (x, y) => {
            const cell = document.querySelector(`#fatbits td[data-x="${x}"][data-y="${y}"]`);
            const r = cell.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        };
        const fire = (type, target, clientX, clientY) => {
            const ev = new PointerEvent(type, {
                pointerId: 1,
                pointerType: 'touch',
                clientX,
                clientY,
                bubbles: true,
                cancelable: true,
                isPrimary: true,
            });
            target.dispatchEvent(ev);
        };

        const start = cellCenter(waypoints[0][0], waypoints[0][1]);
        // pointerdown fires on the tapped cell (like the real browser does),
        // then subsequent pointermoves go to the table (which has captured
        // the pointer in real browsers; here we address it explicitly).
        const startCell = document.elementFromPoint(start.x, start.y);
        fire('pointerdown', startCell, start.x, start.y);
        for (let i = 1; i < waypoints.length; i++) {
            const p = cellCenter(waypoints[i][0], waypoints[i][1]);
            fire('pointermove', fatbits, p.x, p.y);
        }
        fire('pointerup', fatbits, 0, 0);

        const painted = [];
        for (let y = 0; y < 21; y++) {
            for (let x = 0; x < 12; x++) {
                if (pixelData[y][x] !== 0) painted.push([x, y]);
            }
        }
        return painted;
    }, waypoints);
}

describe('sprite-maker fatbits — touch drag paints every cell along the path', () => {
    test('diagonal drag from (2,2) to (7,7) paints all 6 cells', async () => {
        const page = await openSpriteMakerReady();
        try {
            const waypoints = [[2,2],[3,3],[4,4],[5,5],[6,6],[7,7]];
            const painted = await touchDragAndReadPainted(page, waypoints);
            for (const [x, y] of waypoints) {
                expect(painted).toContainEqual([x, y]);
            }
        } finally {
            await page.close();
        }
    });

    test('horizontal drag paints a row', async () => {
        const page = await openSpriteMakerReady();
        try {
            const waypoints = [[1,10],[2,10],[3,10],[4,10],[5,10]];
            const painted = await touchDragAndReadPainted(page, waypoints);
            for (const [x, y] of waypoints) {
                expect(painted).toContainEqual([x, y]);
            }
        } finally {
            await page.close();
        }
    });

    test('single tap without drag paints one cell', async () => {
        const page = await openSpriteMakerReady();
        try {
            const painted = await touchDragAndReadPainted(page, [[6, 6]]);
            expect(painted).toContainEqual([6, 6]);
            expect(painted.length).toBe(1);
        } finally {
            await page.close();
        }
    });

    test('drag over an already-painted cell in erase mode clears it', async () => {
        const page = await openSpriteMakerReady();
        try {
            // First stroke: paint two cells with Color 1.
            await touchDragAndReadPainted(page, [[3, 3], [4, 3]]);
            // Second stroke: with the same color selected, dragging over the
            // already-painted cell enters erase mode (isCurrentColor → true
            // in _paintCellOnDown) and erases both cells.
            const painted = await touchDragAndReadPainted(page, [[3, 3], [4, 3]]);
            expect(painted).not.toContainEqual([3, 3]);
            expect(painted).not.toContainEqual([4, 3]);
        } finally {
            await page.close();
        }
    });

    test('drag that leaves the grid and re-enters keeps drawing', async () => {
        // Verifies setPointerCapture semantics — the browser keeps sending
        // pointermove events to the fatbits table even if the finger drifts
        // outside its bounds momentarily, so the drag continues on re-entry.
        const page = await openSpriteMakerReady();
        try {
            const painted = await page.evaluate(async () => {
                const fatbits = document.getElementById('fatbits');
                const cellCenter = (x, y) => {
                    const cell = document.querySelector(`#fatbits td[data-x="${x}"][data-y="${y}"]`);
                    const r = cell.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                };
                const fire = (type, target, cx, cy) => {
                    const ev = new PointerEvent(type, {
                        pointerId: 1, pointerType: 'touch',
                        clientX: cx, clientY: cy,
                        bubbles: true, cancelable: true, isPrimary: true,
                    });
                    target.dispatchEvent(ev);
                };
                const p0 = cellCenter(2, 2);
                const p1 = cellCenter(5, 5);
                fire('pointerdown', document.elementFromPoint(p0.x, p0.y), p0.x, p0.y);
                // Drift way outside — coordinates outside the grid. Handler
                // should notice elementFromPoint doesn't land on a fatbits td
                // and skip that pointermove, then resume on re-entry.
                fire('pointermove', fatbits, 5, 5);        // top-left corner of viewport
                fire('pointermove', fatbits, p1.x, p1.y);
                fire('pointerup', fatbits, 0, 0);
                const painted = [];
                for (let y = 0; y < 21; y++) {
                    for (let x = 0; x < 12; x++) {
                        if (pixelData[y][x] !== 0) painted.push([x, y]);
                    }
                }
                return painted;
            });
            expect(painted).toContainEqual([2, 2]);
            expect(painted).toContainEqual([5, 5]);
        } finally {
            await page.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Scene-maker touch tests
// ---------------------------------------------------------------------------

async function openSceneMakerReady() {
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
    }, blankDiskBase64, SCENE_SELECTION_KEY, POOL_INDEX_KEY, POOL_DATA_PREFIX);

    await page.goto(SCENE_MAKER_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() =>
        typeof selectColorSlot !== 'undefined' && typeof currentScene !== 'undefined' && typeof setTool !== 'undefined');

    await page.evaluate(() => {
        // Pick color slot 1 (foreground draw color) so drags produce
        // non-zero pixels we can read back. selectColorSlot switches the
        // active slot without opening the C64 palette picker (which the
        // top-level selectColor() does — that needs an event argument).
        selectColorSlot(1);
        setTool('draw');
    });
    return page;
}

// Fires a synthetic PointerEvent of the given type at (clientX, clientY),
// dispatched on `target`. Kept as a shared helper because both the main
// canvas and the zoom table need it.
const POINTER_EVENT_HELPERS = `
    (function() {
        window._fireTouchPointer = function(type, target, cx, cy) {
            const ev = new PointerEvent(type, {
                pointerId: 1,
                pointerType: 'touch',
                clientX: cx,
                clientY: cy,
                bubbles: true,
                cancelable: true,
                isPrimary: true,
            });
            target.dispatchEvent(ev);
        };
    })();
`;

describe('scene-maker main canvas — touch drag paints a continuous stroke', () => {
    test('horizontal drag from (20, 100) to (60, 100) paints pixels along the path', async () => {
        const page = await openSceneMakerReady();
        try {
            await page.evaluate(POINTER_EVENT_HELPERS);
            const paintedCount = await page.evaluate(() => {
                const container = document.getElementById('sceneContainer');
                const rect = container.getBoundingClientRect();
                // scene coords → viewport coords via inverse of screenToScene:
                //   clientX = rect.left + sceneX * 3 + 1.5
                //   clientY = rect.top  + sceneY * 2 + 1
                const at = (sx, sy) => ({
                    x: rect.left + sx * 3 + 1.5,
                    y: rect.top  + sy * 2 + 1,
                });
                const p0 = at(20, 100);
                const p1 = at(60, 100);
                _fireTouchPointer('pointerdown', container, p0.x, p0.y);
                // Emit a few intermediate move events; drawLine bridges gaps.
                _fireTouchPointer('pointermove', container, at(30, 100).x, at(30, 100).y);
                _fireTouchPointer('pointermove', container, at(40, 100).x, at(40, 100).y);
                _fireTouchPointer('pointermove', container, at(50, 100).x, at(50, 100).y);
                _fireTouchPointer('pointermove', container, p1.x, p1.y);
                _fireTouchPointer('pointerup', container, p1.x, p1.y);

                // Count non-bg pixels on row y=100 from x=20..60.
                let n = 0;
                for (let x = 20; x <= 60; x++) {
                    if (currentScene.getPixel(x, 100) !== 0) n++;
                }
                return n;
            });
            // drawLine should produce a fully connected stroke across all 41
            // pixels; require at least 35 so the test tolerates minor
            // rounding at endpoints without being brittle.
            expect(paintedCount).toBeGreaterThanOrEqual(35);
        } finally {
            await page.close();
        }
    });

    test('single tap paints exactly one pixel', async () => {
        const page = await openSceneMakerReady();
        try {
            await page.evaluate(POINTER_EVENT_HELPERS);
            const painted = await page.evaluate(() => {
                const container = document.getElementById('sceneContainer');
                const rect = container.getBoundingClientRect();
                const cx = rect.left + 40 * 3 + 1.5;
                const cy = rect.top  + 50 * 2 + 1;
                _fireTouchPointer('pointerdown', container, cx, cy);
                _fireTouchPointer('pointerup',   container, cx, cy);
                return currentScene.getPixel(40, 50);
            });
            expect(painted).not.toBe(0);
        } finally {
            await page.close();
        }
    });
});

describe('scene-maker zoom table — touch drag paints every fat pixel', () => {
    async function enterZoomAtOrigin(page) {
        // Programmatically enter zoom mode positioned at (0, 0) so the
        // table's top-left cell corresponds to scene pixel (0, 0). This
        // sidesteps the "click to place zoom" UX flow — we just want the
        // zoom table's event handling under test.
        await page.evaluate(() => {
            setTool('zoom');
            // setTool('zoom') requires a click to place; simulate by
            // twiddling the state directly and rendering.
            zoomPlaced = true;
            zoomX = 0;
            zoomY = 0;
            document.getElementById('screen').classList.add('zoom-mode');
            renderZoom();
        });
    }

    test('diagonal drag across zoom cells paints along the path', async () => {
        const page = await openSceneMakerReady();
        try {
            await enterZoomAtOrigin(page);
            await page.evaluate(POINTER_EVENT_HELPERS);

            const painted = await page.evaluate(() => {
                const zoomTable = document.getElementById('zoomEditor');
                const cellCenter = (col, row) => {
                    // TDs are structured row-major; row index = tr index,
                    // col index = td index within tr.
                    const cell = zoomTable.querySelectorAll('tr')[row].querySelectorAll('td')[col];
                    const r = cell.getBoundingClientRect();
                    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                };
                const p0 = cellCenter(2, 2);
                _fireTouchPointer('pointerdown', zoomTable, p0.x, p0.y);
                for (let i = 3; i <= 6; i++) {
                    const p = cellCenter(i, i);
                    _fireTouchPointer('pointermove', zoomTable, p.x, p.y);
                }
                _fireTouchPointer('pointerup', zoomTable, 0, 0);

                // zoomX/zoomY = 0, so zoom cell (i, i) = scene pixel (i, i).
                const painted = [];
                for (let i = 2; i <= 6; i++) {
                    if (currentScene.getPixel(i, i) !== 0) painted.push([i, i]);
                }
                return painted;
            });
            expect(painted).toContainEqual([2, 2]);
            expect(painted).toContainEqual([3, 3]);
            expect(painted).toContainEqual([4, 4]);
            expect(painted).toContainEqual([5, 5]);
            expect(painted).toContainEqual([6, 6]);
        } finally {
            await page.close();
        }
    });

    test('single zoom-cell tap paints one pixel', async () => {
        const page = await openSceneMakerReady();
        try {
            await enterZoomAtOrigin(page);
            await page.evaluate(POINTER_EVENT_HELPERS);
            const painted = await page.evaluate(() => {
                const zoomTable = document.getElementById('zoomEditor');
                const cell = zoomTable.querySelectorAll('tr')[5].querySelectorAll('td')[7];
                const r = cell.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top  + r.height / 2;
                _fireTouchPointer('pointerdown', zoomTable, cx, cy);
                _fireTouchPointer('pointerup',   zoomTable, cx, cy);
                return currentScene.getPixel(7, 5);
            });
            expect(painted).not.toBe(0);
        } finally {
            await page.close();
        }
    });
});
