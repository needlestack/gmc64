/**
 * Cross-editor dispatch tests
 *
 * When the disk popup shows a non-primary GM file (e.g. a /PIC while
 * you're in sprite-maker), the Load button relabels to "Open in
 * scene-maker" and both Load + double-click dispatch to that editor
 * with the disk + file encoded in the URL. The target editor's
 * GMTools.initFromUrl picks up the params, resolves the `pool:` prefix
 * against localStorage, and auto-loads the file.
 *
 * These tests cover:
 *   1. URL construction — dispatch generates the right target for each ext
 *   2. Target auto-load — the destination editor lands with the file loaded
 *   3. Session survives — browser-back returns to the origin editor with
 *      its in-progress work restored
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

let browser;
let testDiskBase64;

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    testDiskBase64 = readFileSync(
        join(PROJECT_ROOT, 'tests/disks/gmc64-test.d64')
    ).toString('base64');
});

afterAll(async () => { if (browser) await browser.close(); });

// Seed the shared pool + a per-page selection so `disk.autoLoad()` on
// page init lands on gmc64-test.d64. Uses the legacy `gm_disk_<page>`
// key which the constructor auto-migrates into the pool on first
// touch — same pattern the disk-popup tests use.
//
// The seed lives in evaluateOnNewDocument (fires on every load, so it
// re-arms across the dispatch navigation), but the storage-mutation
// is guarded by a `_seeded` flag so it only writes once — subsequent
// navigations don't re-clear the localStorage we're testing against.
async function openEditor(page, editorPage) {
    await page.evaluateOnNewDocument((data, name, key) => {
        if (window.name === '_seeded') return;
        localStorage.clear();
        localStorage.setItem(key, data);
        localStorage.setItem(key + '_name', name);
        window.name = '_seeded';
    }, testDiskBase64, 'gmc64-test.d64', `gm_disk_${editorPage}`);
    await page.goto(`file://${join(PROJECT_ROOT, editorPage + '.html')}`, {
        waitUntil: 'domcontentloaded'
    });
    await page.waitForFunction(() => typeof disk !== 'undefined' && disk.disk !== null);
}

// Each editor has its own top-level function that configures + opens
// the shared popup. Call it directly (rather than clicking through the
// UI) so this test doesn't have to know each editor's file-button
// selector or coordinates. music-maker's helper is `showFilePopup`;
// the other three use `showDiskPopup`.
async function openDiskPopup(page) {
    await page.evaluate(() => {
        if (typeof showDiskPopup === 'function') showDiskPopup();
        else if (typeof showFilePopup === 'function') showFilePopup();
    });
    await page.waitForSelector('.gm-disk-dialog');
}

// Click the row whose data-file-name matches. Returns the entry's
// dispatchTo (or null) so tests can assert on the row's state.
async function selectRow(page, fileName) {
    return page.evaluate((name) => {
        const row = document.querySelector(`.gm-disk-files tr[data-file-name="${name}"]`);
        if (!row) return null;
        row.click();
        const entry = disk.directoryEntries[Number(row.dataset.index)];
        return entry.dispatchTo || null;
    }, fileName);
}

describe('cross-editor dispatch — URL construction', () => {
    test('sprite-maker → clicking Load on a /PIC row dispatches to scene-maker', async () => {
        const page = await browser.newPage();
        await openEditor(page, 'sprite-maker');
        const poolId = await page.evaluate(() => disk.currentDiskId);

        await openDiskPopup(page);
        const dispatchTarget = await selectRow(page, 'STARS /PIC');
        expect(dispatchTarget).toBe('scene-maker');

        // Load stays labeled "Load" but is enabled for dispatchable rows.
        const btn = await page.evaluate(() => ({
            disabled: document.querySelector('.gm-disk-load').disabled
        }));
        expect(btn.disabled).toBe(false);

        // Click Load and wait for the navigation to fire. Same-tab
        // navigation via location.href — puppeteer follows automatically.
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click('.gm-disk-load')
        ]);

        const url = new URL(page.url());
        expect(url.pathname.endsWith('/scene-maker.html')).toBe(true);
        expect(url.searchParams.get('disk')).toBe(`pool:${poolId}`);
        expect(url.searchParams.get('file')).toBe('STARS /PIC');
        await page.close();
    }, 20000);

    test('scene-maker → double-click on a /SNG row dispatches to music-maker', async () => {
        const page = await browser.newPage();
        await openEditor(page, 'scene-maker');
        const poolId = await page.evaluate(() => disk.currentDiskId);

        await openDiskPopup(page);
        // Simulate a native dblclick on the /SNG row. Fire click first so
        // the row selects (the popup expects click → dblclick, matching
        // real dblclick sequence), then dblclick to trigger dispatch.
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.evaluate(() => {
                const row = document.querySelector('.gm-disk-files tr[data-file-name="MINUTE/SNG"]');
                row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            })
        ]);

        const url = new URL(page.url());
        expect(url.pathname.endsWith('/music-maker.html')).toBe(true);
        expect(url.searchParams.get('disk')).toBe(`pool:${poolId}`);
        expect(url.searchParams.get('file')).toBe('MINUTE/SNG');
        await page.close();
    }, 20000);
});

describe('cross-editor dispatch — target auto-loads the file', () => {
    test('landing on scene-maker.html?disk=pool:X&file=STARS /PIC loads STARS into the editor', async () => {
        // Establish sprite-maker's pool + selection, then read the pool
        // id so we can craft the dispatch URL by hand (no interaction
        // needed for this test's assertion).
        const setup = await browser.newPage();
        await openEditor(setup, 'sprite-maker');
        const poolId = await setup.evaluate(() => disk.currentDiskId);
        // The pool lives in localStorage which is shared across pages
        // served from the same file:// origin, so this new page inherits
        // the pool automatically — no re-seed needed.
        await setup.close();

        const target = await browser.newPage();
        const params = new URLSearchParams({ disk: `pool:${poolId}`, file: 'STARS /PIC' });
        await target.goto(
            `file://${join(PROJECT_ROOT, 'scene-maker.html')}?${params.toString()}`,
            { waitUntil: 'domcontentloaded' }
        );
        // Wait for scene-maker to finish initFromUrl. The scene is
        // considered loaded once currentSceneFileName is set.
        await target.waitForFunction(() =>
            typeof currentSceneFileName !== 'undefined' && currentSceneFileName === 'STARS /PIC',
            { timeout: 5000 }
        );
        await target.close();
    }, 20000);
});

describe('cross-editor dispatch — session state survives', () => {
    // Verifies that dispatching AWAY from an editor doesn't wipe its
    // session — so browser-back returns the user to their in-progress
    // work. All four sub-editors use GMTools.session under a
    // `gm_session_<page>` localStorage key, written debounced on edit.
    // Dispatch is same-tab navigation (location.href), which normally
    // preserves localStorage on the same origin.
    test('sprite-maker session persists across dispatch to scene-maker', async () => {
        const page = await browser.newPage();
        await openEditor(page, 'sprite-maker');

        // Manually seed a session blob so we don't have to script an
        // edit gesture through the sprite editor's DOM (which is
        // complex and orthogonal to the state-retention contract).
        // The blob shape mirrors what saveSpriteSession() writes.
        const sentinel = 'DISPATCH-CANARY-' + Date.now();
        await page.evaluate((s) => {
            GMTools.session.save('sprite-maker', { canary: s });
        }, sentinel);

        // Dispatch away.
        await openDiskPopup(page);
        await selectRow(page, 'STARS /PIC');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click('.gm-disk-load')
        ]);

        // Now on scene-maker. Confirm sprite-maker's session survived.
        // (localStorage is shared across pages on the same origin;
        // dispatch doesn't clear anything, so the session blob is
        // still there for sprite-maker to restore on the next visit.)
        const restored = await page.evaluate(() =>
            GMTools.session.load('sprite-maker')
        );
        expect(restored).toBeTruthy();
        expect(restored.canary).toBe(sentinel);
        await page.close();
    }, 20000);
});
