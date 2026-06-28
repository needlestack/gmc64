/**
 * Generate golden files for gmMusic tests
 *
 * Run with: node tests/generate-golden-music.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load dependencies (they populate globalThis)
await import('../js/c64lib.js');
await import('../js/d64lib.js');
await import('../js/gmMusic.js');

const { D64, gmMusic } = globalThis;

const GOLDEN_DIR = join(__dirname, 'golden');
const DISKS_DIR = join(__dirname, 'disks');

// Ensure golden directory exists
mkdirSync(GOLDEN_DIR, { recursive: true });

// Song(s) from the IP-clean fixture disk.
const SONGS = [
    { name: 'MINUTE/SNG', desc: "minute waltz (Jonathan's transcription, 3-channel)" }
];

// Load disk
const diskData = new Uint8Array(readFileSync(join(DISKS_DIR, 'gmc64-test.d64')));
const disk = new D64(diskData);

console.log('Generating gmMusic golden files...\n');

for (const songInfo of SONGS) {
    const fileName = songInfo.name;
    console.log(`Processing ${fileName} (${songInfo.desc})...`);

    const fileData = disk.readFile(fileName);
    if (!fileData) {
        console.error(`  ERROR: File not found: ${fileName}`);
        continue;
    }

    const song = new gmMusic(fileData);

    // Serialize song data for golden file
    const golden = {
        // File metadata
        originalSize: fileData.length,

        // Song properties
        name: song.name,
        tempo: song.tempo,
        bpm: song.bpm,
        instruments: song.instruments,

        // Channel note counts
        channelNoteCounts: song.channels.map(c => c.length),

        // Full channel data for verification
        channels: song.channels.map((channel, chIndex) => ({
            channelIndex: chIndex,
            noteCount: channel.length,
            notes: channel.map((note, noteIndex) => ({
                index: noteIndex,
                durationByte: note.durationByte,
                pitch: note.pitch,
                isRest: note.isRest,
                isNullSlot: note.isNullSlot,
                isTied: note.isTied,
                duration: note.duration
            }))
        }))
    };

    // Generate output filename (replace / and spaces)
    const outName = 'music-' + fileName.replace(/\//g, '-').replace(/ /g, '_') + '.json';
    const outPath = join(GOLDEN_DIR, outName);

    writeFileSync(outPath, JSON.stringify(golden, null, 2));
    console.log(`  -> ${outName}`);
    console.log(`     name: "${song.name}", tempo: ${song.tempo}, instruments: [${song.instruments}]`);
    console.log(`     channels: ${song.channels.map(c => c.length).join('/')} notes`);
}

console.log('\nDone!');
