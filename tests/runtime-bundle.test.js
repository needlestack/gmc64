/**
 * Verifies js/runtime-source.js is up to date with the runtime JS files
 * it bundles. Re-run `node tools/bundle-runtime.js` to refresh after
 * changing any of those files; this test will fail until you do.
 *
 * The bundle exists so editor.html's "Export Game" flow works from
 * file:// — see tools/bundle-runtime.js for the rationale.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generate } from '../tools/bundle-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

describe('runtime bundle', () => {
    test('js/runtime-source.js matches the current runtime JS files', () => {
        const expected = generate();
        const actual = readFileSync(resolve(ROOT, 'js', 'runtime-source.js'), 'utf8');
        if (actual !== expected) {
            // Test message guides the fix rather than dumping the diff —
            // the file is hundreds of KB and the diff would be useless.
            throw new Error(
                'js/runtime-source.js is out of date with the runtime JS files. ' +
                'Re-run `node tools/bundle-runtime.js` and commit the result.'
            );
        }
    });
});
