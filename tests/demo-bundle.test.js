/**
 * Verifies js/demo-disk-source.js is up to date with the current
 * disks/gmc64-demo.d64. Re-run `node tools/bundle-demo-disk.js` to
 * refresh; this test will fail until you do.
 *
 * The bundle exists so editor.html's autoLoadDemo() works from file://
 * too — see tools/bundle-demo-disk.js for the rationale.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generate } from '../tools/bundle-demo-disk.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

describe('demo disk bundle', () => {
    test('js/demo-disk-source.js matches the current disks/gmc64-demo.d64', () => {
        const expected = generate();
        const actual = readFileSync(resolve(ROOT, 'js', 'demo-disk-source.js'), 'utf8');
        if (actual !== expected) {
            throw new Error(
                'js/demo-disk-source.js is out of date with disks/gmc64-demo.d64. ' +
                'Re-run `node tools/bundle-demo-disk.js` and commit the result.'
            );
        }
    });
});
