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
let standaloneDiskBase64;

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
    testDiskBase64 = readFileSync(
        join(PROJECT_ROOT, 'tests/disks/gmc64-test.d64')
    ).toString('base64');
    standaloneDiskBase64 = readFileSync(
        join(PROJECT_ROOT, 'tests/disks/gmc64-standalone.d64')
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
async function openEditor(page, editorPage, { diskBase64 = testDiskBase64, diskName = 'gmc64-test.d64' } = {}) {
    // program-editor.html is a rename hangover: its GMDisk still uses the
    // legacy 'editor' selection key, and the legacy-seed migration only
    // recognises the page name 'editor' — so seed under that name for it.
    const seedPage = editorPage === 'program-editor' ? 'editor' : editorPage;
    await page.evaluateOnNewDocument((data, name, key) => {
        if (window.name === '_seeded') return;
        localStorage.clear();
        localStorage.setItem(key, data);
        localStorage.setItem(key + '_name', name);
        window.name = '_seeded';
    }, diskBase64, diskName, `gm_disk_${seedPage}`);
    await page.goto(`file://${join(PROJECT_ROOT, editorPage + '.html')}`, {
        waitUntil: 'domcontentloaded'
    });
    // Every editor exposes its disk instance as `disk` except program-editor,
    // which names it `gmDisk`. Wait on either, then alias to `disk` so the
    // shared helpers and tests below can always reference `disk`.
    await page.waitForFunction(() =>
        (typeof disk !== 'undefined' && disk.disk !== null) ||
        (typeof gmDisk !== 'undefined' && gmDisk.disk !== null));
    await page.evaluate(() => {
        if (typeof disk === 'undefined' && typeof gmDisk !== 'undefined') window.disk = gmDisk;
    });
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

describe('cross-editor dispatch — standalone exports', () => {
    // Standalones only load in the program editor (only it detects the
    // $0302 magic and routes through standaloneToPRG). Everywhere else the
    // row is dimmed and Load dispatches to the program editor instead of
    // erroring on a raw load.
    test('sprite-maker → Load on a dimmed standalone dispatches to program-editor', async () => {
        const page = await browser.newPage();
        await openEditor(page, 'sprite-maker', {
            diskBase64: standaloneDiskBase64, diskName: 'gmc64-standalone.d64'
        });
        const poolId = await page.evaluate(() => disk.currentDiskId);

        await openDiskPopup(page);
        // Find the standalone row by its dispatch target, select it, and
        // confirm it's dimmed with Load enabled (dispatch mode).
        const info = await page.evaluate(() => {
            const idx = disk.directoryEntries.findIndex(e => e.dispatchTo === 'program-editor');
            if (idx < 0) return null;
            const row = document.querySelector(`.gm-disk-files tr[data-index="${idx}"]`);
            row.click();
            return {
                fileName: disk.directoryEntries[idx].fileName,
                dimmed: row.classList.contains('gm-disk-row-dimmed'),
                loadDisabled: document.querySelector('.gm-disk-load').disabled
            };
        });
        expect(info).toBeTruthy();
        expect(info.dimmed).toBe(true);
        expect(info.loadDisabled).toBe(false);

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click('.gm-disk-load')
        ]);

        const url = new URL(page.url());
        expect(url.pathname.endsWith('/program-editor.html')).toBe(true);
        expect(url.searchParams.get('disk')).toBe(`pool:${poolId}`);
        expect(url.searchParams.get('file')).toBe(info.fileName);
        await page.close();
    }, 20000);

    test('landing on program-editor.html?file=<standalone> loads it (no "wrong file type")', async () => {
        // Establish the pool + read the standalone's disk filename from a
        // sprite-maker page, then craft the dispatch URL by hand.
        const setup = await browser.newPage();
        await openEditor(setup, 'sprite-maker', {
            diskBase64: standaloneDiskBase64, diskName: 'gmc64-standalone.d64'
        });
        await openDiskPopup(setup); // populates disk.directoryEntries
        const { poolId, fileName } = await setup.evaluate(() => {
            const e = disk.directoryEntries.find(x => x.dispatchTo === 'program-editor');
            return { poolId: disk.currentDiskId, fileName: e.fileName };
        });
        await setup.close();

        const target = await browser.newPage();
        const errors = [];
        // The "wrong file type" rejection surfaces via showMessage, which
        // routes to the on-screen status area — capture console.warn too in
        // case a headless path logs instead of rendering.
        target.on('console', m => { if (m.type() === 'warning') errors.push(m.text()); });
        const params = new URLSearchParams({ disk: `pool:${poolId}`, file: fileName });
        await target.goto(
            `file://${join(PROJECT_ROOT, 'program-editor.html')}?${params.toString()}`,
            { waitUntil: 'domcontentloaded' }
        );
        // The standalone loads once loadProgramData → standaloneToPRG has
        // populated currentProgramData with instructions.
        await target.waitForFunction(() =>
            typeof currentProgramData !== 'undefined' &&
            currentProgramData !== null &&
            Array.isArray(currentProgramData.instructions) &&
            currentProgramData.instructions.length > 0,
            { timeout: 5000 }
        );
        await target.close();
    }, 20000);

    test('program-editor → the same standalone is loadable, not dimmed', async () => {
        const page = await browser.newPage();
        await openEditor(page, 'program-editor', {
            diskBase64: standaloneDiskBase64, diskName: 'gmc64-standalone.d64'
        });

        await openDiskPopup(page);
        const info = await page.evaluate(() => {
            // In the program editor the standalone is loadable, so it has
            // no dispatchTo — identify it as the non-GM-extension entry.
            const idx = disk.directoryEntries.findIndex(e =>
                e.loadable && !/\/(SPR|PIC|SND|SNG|PRG)$/i.test(e.fileName));
            if (idx < 0) return null;
            const row = document.querySelector(`.gm-disk-files tr[data-index="${idx}"]`);
            const entry = disk.directoryEntries[idx];
            return {
                dimmed: row.classList.contains('gm-disk-row-dimmed'),
                loadable: entry.loadable,
                hasDispatch: !!entry.dispatchTo
            };
        });
        expect(info).toBeTruthy();
        expect(info.dimmed).toBe(false);
        expect(info.loadable).toBe(true);
        expect(info.hasDispatch).toBe(false);
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

        // Let sprite-maker write its OWN session rather than seeding a
        // synthetic blob. sprite-maker autosaves on every render via a
        // debounced saver (updatePreview → saveSpriteSession, ~500ms), so
        // an earlier version of this test that seeded a canary then
        // immediately dispatched was racing that pending write: under
        // full-suite CPU load the debounce fired *after* the seed and
        // clobbered it, making the test flaky. Waiting for the editor's
        // real write to land (instead of racing it) removes the race and
        // tests the actual contract — the in-progress session the editor
        // itself persisted survives dispatch. Poll for the real blob
        // (identified by its `bytes` field) so we know the debounce fired.
        await page.waitForFunction(() => {
            const raw = localStorage.getItem('gm_session_sprite-maker');
            if (!raw) return false;
            try { return typeof JSON.parse(raw).bytes === 'string'; }
            catch { return false; }
        }, { timeout: 5000 });

        await openDiskPopup(page);
        await selectRow(page, 'STARS /PIC');

        // Snapshot the live session at the last moment before dispatch.
        // Nothing re-renders sprite-maker during the popup interaction, so
        // this value is stable; comparing it verbatim after navigation is
        // a race-free assertion that dispatch neither wipes nor mutates it.
        const before = await page.evaluate(() =>
            localStorage.getItem('gm_session_sprite-maker')
        );
        expect(before).toBeTruthy();

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click('.gm-disk-load')
        ]);

        // Now on scene-maker. localStorage is shared across pages on the
        // same origin and scene-maker never touches sprite-maker's key, so
        // the blob must be byte-identical — ready for sprite-maker to
        // restore verbatim on the next visit (browser-back).
        const after = await page.evaluate(() =>
            localStorage.getItem('gm_session_sprite-maker')
        );
        expect(after).toBe(before);
        await page.close();
    }, 20000);
});
