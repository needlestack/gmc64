/**
 * Verifies js/standalone-source.js is up to date with play.html and the
 * runtime JS it inlines. Re-run `node tools/bundle-standalone.js` to
 * refresh after changing either; this test fails until you do.
 *
 * The bundle exists so editor.html's Export Game flow works from
 * file:// — see tools/bundle-standalone.js for the rationale.
 */

import { describe, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generate } from '../tools/bundle-standalone.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

describe('standalone bundle', () => {
    test('js/standalone-source.js matches the current play.html + runtime JS', () => {
        const expected = generate();
        const actual = readFileSync(resolve(ROOT, 'js', 'standalone-source.js'), 'utf8');
        if (actual !== expected) {
            // Test message guides the fix rather than dumping the diff —
            // the file is hundreds of KB and the diff would be useless.
            throw new Error(
                'js/standalone-source.js is out of date with play.html or the runtime JS. ' +
                'Re-run `node tools/bundle-standalone.js` and commit the result.'
            );
        }
    });
});
