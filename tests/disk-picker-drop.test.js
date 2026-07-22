/**
 * gmDiskPicker drop-integration tests
 *
 * The full drop path is: window drop event → gmDiskPicker.handleFile →
 * GMDisk.addToPool + selectDisk → showPicker handoff. Editor hosts
 * always route through showPicker (drop behaves like insert — the
 * built-in disk popup shows every file on the disk, dimmed by type).
 * play.html is the exception: it has no file browser, so drops still
 * fall through to auto-load / built-in picker in that host only.
 *
 * Coverage:
 *
 *   1. Pool integration — the dropped disk ends up in the shared
 *      localStorage pool AND becomes the current disk. If this breaks,
 *      users drop a disk and think their work vanished when they hit
 *      "file" and see the old disk.
 *
 *   2. Editor handoff — each editor's showPicker callback fires on
 *      drop regardless of match count. If this breaks, the drop is
 *      silently swallowed or auto-loads without the user's consent.
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
    test('program-editor.html: dropped disk is added to pool AND becomes current', async () => {
        const page = await openPage('program-editor.html');
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

describe('drop → editor handoff', () => {
    test('sprite-maker.html: drop opens preview mode (browsable file list)', async () => {
        const page = await openPage('sprite-maker.html');
        await simulateDrop(page, TEST_DISK_BYTES, 'gmc64-test.d64');

        // enterPreviewMode → GMTools.previewLoader.enter(...) → sets
        // isActive() to true and loads the SPR file list.
        const state = await page.evaluate(() => ({
            previewActive: GMTools.previewLoader.isActive(),
            fileCount: GMTools.previewLoader.files().length,
        }));
        await page.close();

        expect(state.previewActive).toBe(true);
        expect(state.fileCount).toBeGreaterThan(1);
    }, 15000);

    test('scene-maker.html: drop opens preview mode even when the disk has exactly one PIC', async () => {
        // Prior behavior auto-loaded single-match drops. That was
        // surprising when the drop was of a compilation disk being
        // inspected. Drop now behaves like "insert": the picker always
        // appears, no auto-load, so the user is in control.
        const page = await openPage('scene-maker.html');

        // Build a synthetic disk with just one PIC file (STARS extracted
        // from the test disk).
        const singleFileDisk = await page.evaluate((testBytes) => {
            const src = new D64(new Uint8Array(testBytes));
            const dst = D64.createEmpty('SOLO', 'AB');
            const picBytes = src.readFile('STARS /PIC');
            dst.writeFile('STARS /PIC', picBytes);
            return Array.from(dst.getData());
        }, Array.from(TEST_DISK_BYTES));

        await simulateDrop(page, new Uint8Array(singleFileDisk), 'solo.d64');

        const state = await page.evaluate(() => ({
            previewActive: GMTools.previewLoader.isActive(),
        }));
        await page.close();

        // Preview mode being active is the whole contract: drop opens
        // the browsable file list, no auto-commit. Scene-maker may show
        // the first entry as a preview thumbnail — that's not the same
        // as committing it, and testing "loaded filename is empty"
        // would be brittle against that.
        expect(state.previewActive).toBe(true);
    }, 15000);
});
