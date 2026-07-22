// quadropus-build.mjs — convert Invasion of the Quadropus art strips into
// GMC64 multicolor sprites and write them to a fresh quadropus.d64.
//
// Run:  node /Users/jfield/GMC64/code/dev/quadropus-build.mjs
// (node resolves puppeteer from dev/node_modules regardless of cwd)
//
// Pipeline per sprite:
//   1. Extract each 48px frame's RGBA via a headless <canvas> (same trick
//      the original game's frameFromStrip uses).
//   2. Downsample to the C64 multicolor grid: 12 fat-pixels wide x 21 tall.
//   3. Quantize: pick the 3 most-used C64 palette indices across all frames,
//      then map every cell to transparent or one of those 3.
//   4. Pack to a 63-byte/frame multicolor bitmap, build a gmSprite, serialize
//      to .SPR, and write to the disk.
// Also emits a contact-sheet PNG for visual verification.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGES = '/Users/jfield/GMC64/quadropus/images';
const OUT_DISK = '/Users/jfield/GMC64/quadropus/quadropus.d64';
const OUT_SHEET = '/Users/jfield/GMC64/quadropus/sprite-contact-sheet.png';

// gm libs (dependency order); they self-register on globalThis
await import('../js/d64lib.js');
await import('../js/c64lib.js');
await import('../js/gmSprite.js');
const { D64, c64Palette, c64ColorNames, gmSprite } = globalThis;

// ---- C64 palette as a plain 16-entry [r,g,b] array for distance math ----
const PAL = [];
for (let i = 0; i < 16; i++) PAL[i] = c64Palette[i];

function dist2(a, b) {
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
}
function nearestC64(rgb) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 16; i++) {
        const d = dist2(rgb, PAL[i]);
        if (d < bestD) { bestD = d; best = i; }
    }
    return best;
}

// ---- frame extraction via headless canvas ----
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

async function extractFrames(gifFile, frameW, frameH, frameIdxs) {
    const b64 = readFileSync(join(IMAGES, gifFile)).toString('base64');
    return await page.evaluate(async (dataUrl, frameW, frameH, frameIdxs) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return frameIdxs.map(fi => Array.from(ctx.getImageData(fi * frameW, 0, frameW, frameH).data));
    }, `data:image/gif;base64,${b64}`, frameW, frameH, frameIdxs);
}

// ---- downsample one RGBA frame (srcW x srcH) to 12x21 cells ----
// Each cell -> {rgb, cov} where cov is non-transparent coverage 0..1.
const COLS = 12, ROWS = 21;
function downsample(rgba, srcW, srcH) {
    const cells = [];
    for (let r = 0; r < ROWS; r++) {
        const row = [];
        const ys0 = Math.floor(r * srcH / ROWS), ys1 = Math.max(ys0 + 1, Math.floor((r + 1) * srcH / ROWS));
        for (let c = 0; c < COLS; c++) {
            const xs0 = Math.floor(c * srcW / COLS), xs1 = Math.max(xs0 + 1, Math.floor((c + 1) * srcW / COLS));
            let rr = 0, gg = 0, bb = 0, n = 0, total = 0;
            for (let y = ys0; y < ys1; y++) {
                for (let x = xs0; x < xs1; x++) {
                    const i = (y * srcW + x) * 4;
                    total++;
                    if (rgba[i + 3] < 128) continue; // transparent source pixel
                    rr += rgba[i]; gg += rgba[i + 1]; bb += rgba[i + 2]; n++;
                }
            }
            row.push(n === 0 ? { rgb: null, cov: 0 } : { rgb: [rr / n, gg / n, bb / n], cov: n / total });
        }
        cells.push(row);
    }
    return cells;
}

const COV_THRESHOLD = 0.30; // below this, a cell is treated as transparent

// ---- build one gmSprite from a list of downsampled frames ----
const lum = (i) => 0.3 * PAL[i][0] + 0.59 * PAL[i][1] + 0.11 * PAL[i][2];
const lumRGB = (rgb) => 0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2];

function buildSprite(name, framesCells, excludeColors = new Set(), forcePalette = null) {
    // pass 1: histogram nearest-C64 for every covered cell across all frames.
    // Colours in excludeColors (e.g. black for the aliens, whose near-black
    // anti-aliased edges we'd rather render transparent) are skipped here and
    // mapped to transparent below — freeing that palette slot for a real
    // colour so the sprite reads with more definition, like the original.
    const hist = new Map();
    for (const cells of framesCells)
        for (const row of cells)
            for (const cell of row) {
                if (!cell.rgb || cell.cov < COV_THRESHOLD) continue;
                const idx = nearestC64(cell.rgb);
                if (excludeColors.has(idx)) continue;
                hist.set(idx, (hist.get(idx) || 0) + 1);
            }
    // Choose the 3-colour palette. forcePalette overrides the auto-pick:
    // the C64 palette has only one true green, so the aliens' shading would
    // collapse to green+grey on a nearest-RGB pick. Forcing [green, lt green]
    // and mapping cells by *brightness* (below) turns that shading into a
    // green highlight — more definition, truer to the original.
    let chosen;
    if (forcePalette) {
        chosen = [...forcePalette];
        while (chosen.length < 3) chosen.push(chosen[chosen.length - 1]);
        // Forced palette maps by luminance, so order dark→light.
        chosen.sort((a, b) => lum(a) - lum(b));
    } else {
        chosen = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
        while (chosen.length < 3) chosen.push(chosen.length === 0 ? 1 : chosen[chosen.length - 1]);
        // Deterministic slot assignment: order by C64 palette index (NOT by
        // frequency) so the same colour always lands in the same Color 1/2/3
        // slot across sprites — this keeps the ship's greys in consistent
        // slots between SHIP/SHIELD/SHIPDI. Slot order doesn't affect
        // appearance (pixels still point at the same colours); it only fixes
        // which gmColorN holds which colour.
        chosen.sort((a, b) => a - b);
    }

    // Cell → palette-slot index: forced palettes match by luminance (preserve
    // brightness shading); auto palettes match by nearest RGB.
    const mapToSlot = forcePalette
        ? (rgb) => { const cl = lumRGB(rgb); let best = 0, bd = Infinity;
                     for (let k = 0; k < 3; k++) { const d = Math.abs(cl - lum(chosen[k])); if (d < bd) { bd = d; best = k; } } return best; }
        : (rgb) => { let best = 0, bd = Infinity;
                     for (let k = 0; k < 3; k++) { const d = dist2(rgb, PAL[chosen[k]]); if (d < bd) { bd = d; best = k; } } return best; };

    // pixel-value assignment: chosen[0]->Color1 (value 2), [1]->Color2 (1), [2]->Color3 (3)
    const gmColor1 = chosen[0], gmColor2 = chosen[1], gmColor3 = chosen[2];
    const valueForChosen = [2, 1, 3]; // chosen index -> multicolor pixel value

    const sprite = gmSprite.createBlank({
        name, isMultiColor: true, numFrames: framesCells.length,
        bgColor: 0, gmColor1, gmColor2, gmColor3
    });

    framesCells.forEach((cells, f) => {
        const buf = new Uint8Array(64);
        for (let r = 0; r < ROWS; r++) {
            for (let byteCol = 0; byteCol < 3; byteCol++) {
                let byte = 0;
                for (let bitPair = 0; bitPair < 4; bitPair++) {
                    const fatX = byteCol * 4 + bitPair;
                    const cell = cells[r][fatX];
                    let val = 0;
                    if (cell.rgb && cell.cov >= COV_THRESHOLD && !excludeColors.has(nearestC64(cell.rgb))) {
                        val = valueForChosen[mapToSlot(cell.rgb)];
                    }
                    byte |= (val & 3) << (6 - bitPair * 2);
                }
                buf[r * 3 + byteCol] = byte;
            }
        }
        sprite.sprite[0].imageData[f] = buf;
    });

    return { sprite, palette: [gmColor1, gmColor2, gmColor3] };
}

// ---- sprite jobs: [diskName, gifFile, frameW, frameH, frameIndexes, excludeColors] ----
// excludeColors: C64 indices to force transparent. The aliens exclude black
// (0x00) so their near-black edges drop out and the palette fills with real
// colour instead — more definition, closer to the originals. The ship family
// keeps every colour (its greys are meaningful).
// forcePalette (7th col): override the auto-pick with specific C64 colours.
// The aliens force [green, lt green] so their shading reads as a green
// highlight instead of desaturating to grey — see buildSprite.
const ALIEN_H = 36, PLAYER_WH = 48, BLACK = 0x00, GREEN = 0x05, LT_GREEN = 0x0D;
const GREENS = [GREEN, LT_GREEN];
const jobs = [
    ['ALIEN',  'alienstrip.gif',  48, ALIEN_H,  [0,1,2,3,4,5,6,7],        [BLACK], GREENS], // ufo walk
    ['ATTACK', 'alienstrip.gif',  48, ALIEN_H,  [8,9,10,11,12,13,14,15],  [BLACK], GREENS], // dive
    ['EXPLOD', 'alienstrip.gif',  48, ALIEN_H,  [16,17,18,19],            [BLACK], null],   // death
    ['SHIP',   'playerstrip.gif', 48, PLAYER_WH,[0],                      [],      null],   // gun
    ['SHIELD', 'playerstrip.gif', 48, PLAYER_WH,[1,2,3,4],                [],      null],   // shield flash
    ['SHIPDI', 'playerstrip.gif', 48, PLAYER_WH,[5,6,7,8],                [],      null],   // player death
];

const disk = D64.createEmpty('QUADROPUS', 'QP');
const built = [];
for (const [name, gif, fw, fh, idxs, excl, force] of jobs) {
    const rawFrames = await extractFrames(gif, fw, fh, idxs);
    const framesCells = rawFrames.map(f => downsample(f, fw, fh));
    const { sprite, palette } = buildSprite(name, framesCells, new Set(excl), force);
    const bytes = sprite.serialize();

    // round-trip sanity: re-parse the serialized .SPR
    const reparsed = new gmSprite(bytes);
    const okFrames = reparsed.getNumFrames() === idxs.length;

    disk.writeFile(name.padEnd(6, ' ') + '/SPR', bytes, D64.FILE_TYPE_PRG);
    built.push({ name, sprite: reparsed, palette, frames: idxs.length, okFrames, bytes: bytes.length });
    console.log(`${name.padEnd(6)}  ${idxs.length} frames  ${bytes.length}b  palette=[${palette.map(i => c64ColorNames[i]).join(', ')}]  roundtrip=${okFrames}`);
}

writeFileSync(OUT_DISK, Buffer.from(disk.getData()));
console.log(`\nwrote ${OUT_DISK}`);

// ---- contact sheet: render every frame of every sprite (4x zoom) ----
const SCALE = 4, PAD = 6, CELL_W = 24 * SCALE, CELL_H = 21 * SCALE;
const maxFrames = Math.max(...built.map(b => b.frames));
const sheetW = PAD + maxFrames * (CELL_W + PAD);
const sheetH = PAD + built.length * (CELL_H + PAD + 12);

// gather rendered RGBA frames (gmSprite renders at 24x21 for multicolor)
const renderData = built.map(b => {
    const frames = [];
    for (let f = 0; f < b.frames; f++) {
        const fr = b.sprite.getFrame(0, f);
        frames.push({ w: fr.width, h: fr.height, px: Array.from(fr.pixels) });
    }
    return { name: b.name, frames };
});

const sheetB64 = await page.evaluate((data, SCALE, PAD, CELL_W, CELL_H, sheetW, sheetH) => {
    const canvas = document.createElement('canvas');
    canvas.width = sheetW; canvas.height = sheetH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, sheetW, sheetH);
    ctx.imageSmoothingEnabled = false;
    ctx.font = '10px monospace'; ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
    let y = PAD;
    for (const sp of data) {
        ctx.fillStyle = '#8fdcff'; ctx.fillText(sp.name, PAD, y);
        y += 12;
        let x = PAD;
        for (const fr of sp.frames) {
            // build an ImageData at native size then scale via drawImage
            const tmp = document.createElement('canvas');
            tmp.width = fr.w; tmp.height = fr.h;
            const tctx = tmp.getContext('2d');
            const id = tctx.createImageData(fr.w, fr.h);
            id.data.set(fr.px);
            tctx.putImageData(id, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(tmp, 0, 0, fr.w, fr.h, x, y, fr.w * SCALE, fr.h * SCALE);
            x += CELL_W + PAD;
        }
        y += CELL_H + PAD;
    }
    return canvas.toDataURL('image/png').split(',')[1];
}, renderData, SCALE, PAD, CELL_W, CELL_H, sheetW, sheetH);

writeFileSync(OUT_SHEET, Buffer.from(sheetB64, 'base64'));
console.log(`wrote ${OUT_SHEET}`);

await browser.close();
