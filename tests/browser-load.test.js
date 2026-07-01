/**
 * Browser compatibility test
 *
 * Loads each HTML file in a headless browser and checks for script errors.
 * This catches issues like ESM export statements in non-module scripts.
 */

import { describe, test, expect, afterAll } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// HTML files to test
const HTML_FILES = [
    'editor.html',
    'sprite-maker.html',
    'scene-maker.html',
    'sound-maker.html',
    'music-maker.html',
    // Chrome-free player. Must load without touching any editor JS; the
    // test catches accidental coupling (e.g. a runtime file starting to
    // reference an editor DOM id or global) at import time.
    'play.html',
    'tools/hex-viewer.html'
];

let browser;

afterAll(async () => {
    if (browser) {
        await browser.close();
    }
});

describe('browser script loading', () => {
    for (const htmlFile of HTML_FILES) {
        test(`${htmlFile} loads without script errors`, async () => {
            if (!browser) {
                browser = await puppeteer.launch({ headless: true });
            }

            const page = await browser.newPage();
            const errors = [];

            // Capture page errors (uncaught exceptions, syntax errors)
            page.on('pageerror', err => {
                errors.push(`Page error: ${err.message}`);
            });

            // Capture console.error calls
            page.on('console', msg => {
                if (msg.type() === 'error') {
                    const text = msg.text();
                    // Ignore favicon 404s and other non-script errors
                    if (!text.includes('favicon') && !text.includes('net::ERR_')) {
                        errors.push(`Console error: ${text}`);
                    }
                }
            });

            const filePath = join(PROJECT_ROOT, htmlFile);
            await page.goto(`file://${filePath}`, {
                waitUntil: 'domcontentloaded',
                timeout: 10000
            });

            // Give scripts a moment to execute
            await new Promise(r => setTimeout(r, 500));

            await page.close();

            expect(errors).toEqual([]);
        }, 15000); // 15 second timeout per test
    }
});
