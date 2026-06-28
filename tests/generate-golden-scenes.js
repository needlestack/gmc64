/**
 * Generate golden files for gmScene tests
 *
 * Run with: node tests/generate-golden-scenes.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load dependencies (they populate globalThis)
await import('../js/c64lib.js');
await import('../js/d64lib.js');
await import('../js/gmScene.js');

const { D64, gmScene } = globalThis;

const GOLDEN_DIR = join(__dirname, 'golden');
const DISKS_DIR = join(__dirname, 'disks');

// Ensure golden directory exists
mkdirSync(GOLDEN_DIR, { recursive: true });

// Scenes from the IP-clean fixture disk.
const SCENES = [
    { name: 'MEADOW/PIC', desc: 'sunlit meadow (bg=blue, grass=green, sun=yellow, dirt=brown)' },
    { name: 'STARS /PIC', desc: 'starfield (black bg, scattered white + gray stars)' }
];

// Load disk
const diskData = new Uint8Array(readFileSync(join(DISKS_DIR, 'gmc64-test.d64')));
const disk = new D64(diskData);

console.log('Generating gmScene golden files...\n');

for (const sceneInfo of SCENES) {
    const fileName = sceneInfo.name;
    console.log(`Processing ${fileName} (${sceneInfo.desc})...`);

    const fileData = disk.readFile(fileName);
    if (!fileData) {
        console.error(`  ERROR: File not found: ${fileName}`);
        continue;
    }

    const scene = new gmScene(fileData);

    // Serialize scene data for golden file
    const golden = {
        // File metadata
        originalSize: fileData.length,
        isRLE: fileData[5] === 0xFF,

        // Scene properties
        name: scene.name,
        bgColor: scene._bgColor,
        color1: scene._color1,
        color2: scene._color2,
        color3: scene._color3,

        // Pixel buffer as base64 (160x200 = 32000 bytes)
        pixelBuffer: Buffer.from(scene.pixelBuffer).toString('base64'),

        // Also store a checksum for quick validation
        pixelChecksum: Array.from(scene.pixelBuffer).reduce((a, b) => a + b, 0)
    };

    // Generate output filename (replace / and spaces)
    const outName = 'scene-' + fileName.replace(/\//g, '-').replace(/ /g, '_') + '.json';
    const outPath = join(GOLDEN_DIR, outName);

    writeFileSync(outPath, JSON.stringify(golden, null, 2));
    console.log(`  -> ${outName}`);
    console.log(`     name: "${scene.name}", colors: [${scene._bgColor}, ${scene._color1}, ${scene._color2}, ${scene._color3}]`);
    console.log(`     RLE: ${golden.isRLE}, original size: ${fileData.length} bytes`);
    console.log(`     pixel checksum: ${golden.pixelChecksum}`);
}

console.log('\nDone!');
