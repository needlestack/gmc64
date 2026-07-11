/**
 * Player-chrome input tests — stuck-key recovery
 *
 * Pins down the recovery paths added for macOS's Cmd/Meta keyup swallowing
 * (holding Cmd while releasing arrows means the arrow's keyup never fires,
 * leaving the joystick direction stuck). Also covers the general
 * focus-loss safety net so alt-tab / tab-switch never strand held keys.
 *
 * We can't reproduce the actual macOS quirk in puppeteer, but we CAN
 * exercise the two recovery paths directly:
 *   1. Meta keyup → all directions cleared
 *   2. blur / visibilitychange:hidden → all directions AND fire cleared
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
// editor.html loads gmPlayerChrome.js — using it as the browser context
// avoids maintaining a dedicated test fixture page.
const HOST_URL = `file://${join(PROJECT_ROOT, 'editor.html')}`;

let browser;

beforeAll(async () => {
    browser = await puppeteer.launch({ headless: true });
});

afterAll(async () => {
    if (browser) await browser.close();
});

// Load the editor page, wait for GMPlayerChrome to be present, then wire
// up a fresh set of input listeners against a fake inputState so this
// test doesn't have to run a real VM. Returns the page and a helper that
// evaluates in-page code with the test's inputState reference.
async function setupInputHarness() {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('Page error:', err.message));
    await page.goto(HOST_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() =>
        typeof GMPlayerChrome === 'object' && typeof GMPlayerChrome.setupInputListeners === 'function');

    // Fresh inputState + setupInputListeners with always-enabled + cursors preset.
    // Attached at test setup so keydown/keyup dispatches below hit our handlers.
    await page.evaluate(() => {
        window._testInputState = {
            joystick1: { up: false, down: false, left: false, right: false },
            joystick2: { up: false, down: false, left: false, right: false },
            button1: false,
            button2: false,
        };
        window._testDetach = GMPlayerChrome.setupInputListeners({
            inputState: window._testInputState,
            getPresets: () => ({ joy1: 'cursors', joy2: 'none' }),
            isEnabled: () => true,
        });
    });
    return page;
}

async function readInputState(page) {
    return page.evaluate(() => JSON.parse(JSON.stringify(window._testInputState)));
}

describe('input listeners — stuck-key recovery', () => {
    test('ArrowRight keydown sets joystick.right, keyup clears it (baseline)', async () => {
        const page = await setupInputHarness();
        try {
            await page.evaluate(() => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            });
            let s = await readInputState(page);
            expect(s.joystick1.right).toBe(true);

            await page.evaluate(() => {
                window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
            });
            s = await readInputState(page);
            expect(s.joystick1.right).toBe(false);
        } finally {
            await page.close();
        }
    });

    test('Meta keyup clears any lingering direction booleans', async () => {
        // Simulates the macOS scenario: user held ArrowRight, then pressed
        // Cmd (Meta), then released ArrowRight during the Cmd-down window
        // (where its keyup got eaten by the browser). Result: joystick.right
        // stays true even though the user let go. When Cmd finally comes
        // up, our handler clears all directions as a recovery step.
        const page = await setupInputHarness();
        try {
            await page.evaluate(() => {
                // ArrowRight down — enters our normal handler, sets right=true
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
                // Meta down — sets button1 (Meta is mapped to fire in cursors preset)
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }));
                // Now the user releases ArrowRight during the Cmd-hold window.
                // In the real macOS bug the browser wouldn't dispatch this keyup;
                // in the test we just skip it. joystick1.right stays true.
                // Then Meta comes up.
                window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }));
            });
            const s = await readInputState(page);
            // Meta's own keyup clears button1 (via applyKey), AND our recovery
            // path clears all direction booleans. Both must be false now.
            expect(s.joystick1.right).toBe(false);
            expect(s.joystick1.up).toBe(false);
            expect(s.joystick1.left).toBe(false);
            expect(s.joystick1.down).toBe(false);
            expect(s.button1).toBe(false);
        } finally {
            await page.close();
        }
    });

    test('window blur clears every joystick direction AND fire button', async () => {
        const page = await setupInputHarness();
        try {
            await page.evaluate(() => {
                // Simulate several keys "held" via keydowns (matching user
                // pressing arrows + fire, then alt-tabbing to another app).
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                // Now focus goes away.
                window.dispatchEvent(new Event('blur'));
            });
            const s = await readInputState(page);
            expect(s.joystick1.right).toBe(false);
            expect(s.joystick1.down).toBe(false);
            expect(s.button1).toBe(false);
        } finally {
            await page.close();
        }
    });

    test('visibilitychange to hidden clears input state', async () => {
        const page = await setupInputHarness();
        try {
            await page.evaluate(() => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                // Simulate tab going hidden by overriding document.hidden briefly
                // and firing the event. (In a real page, the browser sets hidden
                // for us; here we redefine so our handler sees it.)
                Object.defineProperty(document, 'hidden', { configurable: true, value: true });
                document.dispatchEvent(new Event('visibilitychange'));
                Object.defineProperty(document, 'hidden', { configurable: true, value: false });
            });
            const s = await readInputState(page);
            expect(s.joystick1.left).toBe(false);
            expect(s.button1).toBe(false);
        } finally {
            await page.close();
        }
    });
});
