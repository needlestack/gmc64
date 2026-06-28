/**
 * Generate golden files for gmSound tests
 *
 * Run with: node tests/generate-golden-sounds.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load dependencies (they populate globalThis)
await import('../js/c64lib.js');
await import('../js/d64lib.js');
await import('../js/gmSound.js');

const { D64, gmSound } = globalThis;

const GOLDEN_DIR = join(__dirname, 'golden');
const DISKS_DIR = join(__dirname, 'disks');

// Ensure golden directory exists
mkdirSync(GOLDEN_DIR, { recursive: true });

// Sounds from the IP-clean fixture disk.
const SOUNDS = [
    { name: 'ENGINE/SND', desc: '2-frame looped engine sound (repeat=100)' },
    { name: 'KCHEER/SND', desc: '2-frame one-shot cheer (no repeat)' }
];

// Load disk
const diskData = new Uint8Array(readFileSync(join(DISKS_DIR, 'gmc64-test.d64')));
const disk = new D64(diskData);

console.log('Generating gmSound golden files...\n');

for (const soundInfo of SOUNDS) {
    const fileName = soundInfo.name;
    console.log(`Processing ${fileName} (${soundInfo.desc})...`);

    const fileData = disk.readFile(fileName);
    if (!fileData) {
        console.error(`  ERROR: File not found: ${fileName}`);
        continue;
    }

    const sound = new gmSound(fileData);

    // Serialize sound data for golden file
    const golden = {
        // File metadata
        originalSize: fileData.length,

        // Sound properties
        name: sound.name,
        repeatCount: sound.repeatCount,
        repeatDelay: sound.repeatDelay,
        speed: sound.speed,
        eqOn: sound.eqOn,
        volume: sound.volume,

        // Frame data
        frames: sound.frames.map((frame, index) => ({
            index,
            wave: frame.wave,
            att: frame.att,
            dec: frame.dec,
            sus: frame.sus,
            rel: frame.rel,
            freqHi: frame.freqHi,
            freqLo: frame.freqLo,
            spd: frame.spd,
            pulseHi: frame.pulseHi,
            pulseLo: frame.pulseLo,
            dur: frame.dur,
            eqLowPass: frame.eqLowPass,
            eqBandPass: frame.eqBandPass,
            eqHighPass: frame.eqHighPass,
            tie: frame.tie
        }))
    };

    // Generate output filename (replace / and spaces)
    const outName = 'sound-' + fileName.replace(/\//g, '-').replace(/ /g, '_') + '.json';
    const outPath = join(GOLDEN_DIR, outName);

    writeFileSync(outPath, JSON.stringify(golden, null, 2));
    console.log(`  -> ${outName}`);
    console.log(`     name: "${sound.name}", frames: ${sound.frames.length}, repeat: ${sound.repeatCount}`);
}

console.log('\nDone!');
