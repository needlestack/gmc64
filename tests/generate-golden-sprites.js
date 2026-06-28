/**
 * Golden file generator for gmSprite tests
 *
 * Loads sprites from test disk and saves their parsed structure as golden reference files.
 *
 * Usage: node tests/generate-golden-sprites.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load dependencies (they populate globalThis)
await import('../js/c64lib.js');
await import('../js/d64lib.js');
await import('../js/gmSprite.js');

const { D64, gmSprite } = globalThis;

const GOLDEN_DIR = join(__dirname, 'golden');
const DISKS_DIR = join(__dirname, 'disks');

// Test sprites from the IP-clean fixture disk.
const TEST_SPRITES = [
    { name: 'PLAYER/SPR', desc: 'single-quad multicolor (8 frames)' },
    { name: 'ALIENS/SPR', desc: '2-quad multicolor (6 frames per quad)' }
];

// Ensure golden directory exists
mkdirSync(GOLDEN_DIR, { recursive: true });

// Load disk
console.log('\n=== Loading gmc64-test.d64 ===');
const diskData = new Uint8Array(readFileSync(join(DISKS_DIR, 'gmc64-test.d64')));
const disk = new D64(diskData);

// Extract and serialize each sprite
for (const spriteInfo of TEST_SPRITES) {
    console.log(`\nProcessing: ${spriteInfo.name} (${spriteInfo.desc})`);

    const fileData = disk.readFile(spriteInfo.name);
    if (!fileData) {
        console.log(`  ERROR: File not found`);
        continue;
    }
    console.log(`  File size: ${fileData.length} bytes`);

    // Parse the sprite
    const sprite = new gmSprite(fileData);

    // Create a serializable representation of the sprite
    // (excluding rendered frames which are derived data)
    const goldenData = {
        // Top-level properties
        sizeInBytes: sprite.sizeInBytes,
        _bgColor: sprite._bgColor,
        _gmColor1: sprite._gmColor1,
        _gmColor2: sprite._gmColor2,
        _gmColor3: sprite._gmColor3,

        // Quads array (the main sprite structure)
        quads: sprite.sprite.map((quad, index) => ({
            quadIndex: index,
            spriteName: quad.spriteName,
            isMultiColor: quad.isMultiColor,
            numFrames: quad.numFrames,
            totalFrames: quad.totalFrames,
            numSprites: quad.numSprites,
            xDouble: quad.xDouble,
            yDouble: quad.yDouble,
            xPosition: quad.xPosition,
            yPosition: quad.yPosition,
            spriteNum: quad.spriteNum,
            _bgColor: quad._bgColor,
            _gmColor1: quad._gmColor1,
            _gmColor2: quad._gmColor2,
            _gmColor3: quad._gmColor3,
            // Store imageData as base64 for each frame
            imageData: quad.imageData.map(frame =>
                Buffer.from(frame).toString('base64')
            )
        }))
    };

    // Save the golden file
    const safeName = spriteInfo.name.replace(/\s+/g, '_').replace('/', '-');
    const goldenPath = join(GOLDEN_DIR, `sprite-${safeName}.json`);
    writeFileSync(goldenPath, JSON.stringify(goldenData, null, 2));

    // Log summary
    console.log(`  Quads: ${sprite.sprite.length}`);
    for (let q = 0; q < sprite.sprite.length; q++) {
        const quad = sprite.sprite[q];
        console.log(`    [${q}] ${quad.spriteName}: ${quad.numFrames} frames, ` +
            `${quad.isMultiColor ? 'multicolor' : 'hi-res'}, ` +
            `${quad.xDouble ? '2x' : '1x'}W ${quad.yDouble ? '2x' : '1x'}H`);
    }
    console.log(`  Saved: ${goldenPath}`);
}

console.log('\nGolden sprite files generated.');
