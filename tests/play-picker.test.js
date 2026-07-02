/**
 * play.html picker / drop-zone tests
 *
 * Verifies the fallback UI when the visitor arrives without a game to
 * play:
 *   - bare play.html (no ?disk=) shows the drop-zone
 *   - the file input inside the drop-zone accepts .d64 files
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

describe('play.html picker', () => {
    test('bare visit shows the drop-zone overlay', async () => {
        const page = await loadPage('');
        const state = await page.evaluate(() => {
            const overlay = document.getElementById('pickerOverlay');
            const drop = document.getElementById('dropContent');
            const pick = document.getElementById('pickContent');
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
        const accept = await page.$eval('#dropInput', el => el.accept);
        await page.close();
        expect(accept).toBe('.d64');
    }, 15000);
});
