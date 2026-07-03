/**
 * gmDiskPicker drop-integration tests
 *
 * The full drop path is: window drop event → gmDiskPicker.handleFile →
 * GMDisk.addToPool + selectDisk → showPicker handoff (for 2+ matches)
 * or onPickFile (for 1 match). This file covers the three regressions
 * that would silently break real users:
 *
 *   1. Pool integration — the dropped disk ends up in the shared
 *      localStorage pool AND becomes the current disk. If this breaks,
 *      users drop a disk and think their work vanished when they hit
 *      "file" and see the old disk.
 *
 *   2. Multi-match handoff — each editor's showPicker callback fires
 *      when the disk has 2+ matching files. If this breaks, sprite/
 *      scene-maker open the wrong browsing UI (or nothing at all).
 *
 *   3. Single-match auto-load — 1 matching file skips the picker and
 *      loads directly via onPickFile. If this breaks, users have to
 *      click through a picker for a disk with just one relevant file.
 */

import { describe, test, expect, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// The IP-clean fixture disk: 2 PRGs (GMC64I, ALIENS), multiple SPRs
// (SAUCER, PLAYER, ALIENS, ...), 2 PICs (STARS, MEADOW), various SNDs,
// and 1 SNG (MINUTE). Broad enough to exercise multi- and single-match
// paths depending on which editor we're testing against.
const TEST_DISK_BYTES = readFileSync(
    join(PROJECT_ROOT, 'tests', 'disks', 'gmc64-test.d64')
);

let browser;
afterAll(async () => { if (browser) await browser.close(); });

async function openPage(htmlPath) {
    if (!browser) browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`file://${join(PROJECT_ROOT, htmlPath)}`, {
        waitUntil: 'domcontentloaded', timeout: 10000
    });
    // Editors run their init on DOMContentLoaded (mount, autoLoad, etc.).
    // Give them a beat to finish before we start dropping.
    await new Promise(r => setTimeout(r, 400));
    return page;
}

// Dispatch a synthetic window-level `drop` event with a File attached to
// its DataTransfer. Mirrors what a real drag-and-drop does — the picker's
// window listener reads dt.types (includes 'Files') and dt.files[0].
async function simulateDrop(page, bytes, filename) {
    await page.evaluate((byteArr, name) => {
        const file = new File([new Uint8Array(byteArr)], name);
        const dt = new DataTransfer();
        dt.items.add(file);
        const drop = new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: dt
        });
        window.dispatchEvent(drop);
    }, Array.from(bytes), filename);
    // handleFile is async (awaits file.arrayBuffer(), addToPool). Give
    // the whole chain a chance to run before assertions read state.
    await new Promise(r => setTimeout(r, 500));
}

describe('drop → pool + select', () => {
    test('editor.html: dropped disk is added to pool AND becomes current', async () => {
        const page = await openPage('editor.html');
        await simulateDrop(page, TEST_DISK_BYTES, 'gmc64-test.d64');

        const state = await page.evaluate(() => ({
            poolCount: GMDisk.getPool().length,
            currentFileName: gmDisk.diskFileName,
            currentDiskId: gmDisk.currentDiskId,
        }));
        await page.close();

        expect(state.poolCount).toBeGreaterThan(0);
        expect(state.currentFileName).toBe('gmc64-test.d64');
        expect(state.currentDiskId).toBeTruthy();
    }, 15000);
});

describe('drop → multi-match handoff', () => {
    test('sprite-maker.html: 2+ SPRs drops the user into browsable load mode', async () => {
        const page = await openPage('sprite-maker.html');
        await simulateDrop(page, TEST_DISK_BYTES, 'gmc64-test.d64');

        // enterLoadMode → GMTools.previewLoader.enter(...) → sets
        // isActive() to true and loads the SPR file list.
        const state = await page.evaluate(() => ({
            previewActive: GMTools.previewLoader.isActive(),
            fileCount: GMTools.previewLoader.files().length,
        }));
        await page.close();

        expect(state.previewActive).toBe(true);
        expect(state.fileCount).toBeGreaterThan(1);
    }, 15000);
});

describe('drop → single-match auto-load', () => {
    test('scene-maker.html: dropping a disk with exactly one PIC auto-loads that scene', async () => {
        const page = await openPage('scene-maker.html');

        // Build a synthetic disk with just one PIC file (STARS extracted
        // from the test disk). This is the single-match code path — no
        // picker should appear, the file should load directly via
        // onPickFile → loadSceneFromDisk.
        const singleFileDisk = await page.evaluate((testBytes) => {
            const src = new D64(new Uint8Array(testBytes));
            const dst = D64.createEmpty('SOLO', 'AB');
            // Test disk directory has "STARS /PIC" (padded to 6 chars).
            const picBytes = src.readFile('STARS /PIC');
            dst.writeFile('STARS /PIC', picBytes);
            return Array.from(dst.getData());
        }, Array.from(TEST_DISK_BYTES));

        await simulateDrop(page, new Uint8Array(singleFileDisk), 'solo.d64');

        // scene-maker stores the loaded scene's filename in
        // currentSceneFileName (updated inside loadSceneFromDisk).
        // Non-null / non-empty means auto-load fired.
        const state = await page.evaluate(() => ({
            loadedFileName: typeof currentSceneFileName !== 'undefined'
                ? currentSceneFileName : null,
            previewActive: GMTools.previewLoader.isActive(),
        }));
        await page.close();

        // Single-match path bypasses the picker — previewLoader stays
        // inactive, but the loader function ran.
        expect(state.previewActive).toBe(false);
        expect(state.loadedFileName).toBeTruthy();
    }, 15000);
});
