/**
 * gmDiskPicker mount + play.html-specific behavior
 *
 *   - bare play.html (no ?disk=) shows the drop-zone
 *   - the file input inside the drop-zone accepts .d64 files
 *   - every editor (editor / sprite / scene / sound / music) mounts the
 *     picker on load, but keeps it hidden until a drag/URL triggers it
 */

import { describe, test, expect, afterAll } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

let browser;

afterAll(async () => {
    if (browser) await browser.close();
});

async function loadPage(pathAndQuery) {
    if (!browser) browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const url = `file://${join(PROJECT_ROOT, 'play.html')}${pathAndQuery}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    // Give the async init() a beat to run — it awaits loadGame() which
    // decides which overlay to show.
    await new Promise(r => setTimeout(r, 300));
    return page;
}

// GMDiskPicker uses class-based DOM (`.gmdp-*`) rather than IDs so that
// multiple pickers or hosts can't collide. Test against those class hooks.
describe('play.html picker', () => {
    test('bare visit shows the drop-zone overlay', async () => {
        const page = await loadPage('');
        const state = await page.evaluate(() => {
            const overlay = document.querySelector('.gmdp-overlay');
            const drop = document.querySelector('.gmdp-drop-section');
            const pick = document.querySelector('.gmdp-pick-section');
            return {
                overlayActive: overlay?.classList.contains('active'),
                dropVisible: drop && drop.style.display !== 'none',
                pickVisible: pick && pick.style.display !== 'none',
            };
        });
        await page.close();
        expect(state.overlayActive).toBe(true);
        expect(state.dropVisible).toBe(true);
        expect(state.pickVisible).toBe(false);
    }, 15000);

    test('drop-zone hosts a file input accepting .d64', async () => {
        const page = await loadPage('');
        const accept = await page.$eval('.gmdp-drop-input', el => el.accept);
        await page.close();
        expect(accept).toBe('.d64');
    }, 15000);
});

// Every editor mounts the picker at init (used by both the ?disk= URL
// fallback and the window-level drag-and-drop). Verify it exists but
// stays hidden on a bare visit.
describe('editor picker mounts', () => {
    const HTMLS = ['editor.html', 'sprite-maker.html', 'scene-maker.html',
                   'sound-maker.html', 'music-maker.html'];
    for (const html of HTMLS) {
        test(`${html} mounts the picker hidden`, async () => {
            if (!browser) browser = await puppeteer.launch({ headless: true });
            const page = await browser.newPage();
            await page.goto(`file://${join(PROJECT_ROOT, html)}`, {
                waitUntil: 'domcontentloaded', timeout: 10000
            });
            await new Promise(r => setTimeout(r, 300));
            const state = await page.evaluate(() => {
                const overlay = document.querySelector('.gmdp-overlay');
                return {
                    exists: !!overlay,
                    active: overlay?.classList.contains('active'),
                };
            });
            await page.close();
            expect(state.exists).toBe(true);
            expect(state.active).toBe(false);
        }, 15000);
    }
});
