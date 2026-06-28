// build-demo.js — assembles the GMC64 demo disk from scratch.
//
// Runs the project's runtime modules under Node, hand-builds the sprites
// scene/sounds/program in memory, then writes a .d64 to the repo root.
// One-shot script: `node tools/build-demo.js`
//
// This is also a smoke test of the build path — if any of the format
// serializers regress, the script throws before producing output.

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// All runtime files attach to globalThis. Order matches the editor's
// <script> tag order so dependencies resolve cleanly.
await import(`${ROOT}/js/c64lib.js`);
await import(`${ROOT}/js/d64lib.js`);
await import(`${ROOT}/js/gmCharset.js`);
await import(`${ROOT}/js/gmSprite.js`);
await import(`${ROOT}/js/gmScene.js`);
await import(`${ROOT}/js/gmSound.js`);
await import(`${ROOT}/js/gmOpcodes.js`);
await import(`${ROOT}/js/gmParser.js`);

const { D64, gmSprite, gmScene, gmSound, serializeProgram } = globalThis;

// =============================================================================
// SPRITE HELPERS
// =============================================================================
//
// Multicolor sprite encoding:
//   12 fat pixels wide × 21 rows tall, packed 4 pixels per byte, MSB-first.
//   Each fat pixel is 2 bits:  00 = transparent (background)
//                              01 = color2 (shared)
//                              10 = color1 (unique to this sprite)
//                              11 = color3 (shared)

function row(...pixels) {
    if (pixels.length !== 12) throw new Error('row needs exactly 12 pixels');
    const bytes = new Uint8Array(3);
    for (let b = 0; b < 3; b++) {
        bytes[b] = (pixels[b * 4] << 6) |
                   (pixels[b * 4 + 1] << 4) |
                   (pixels[b * 4 + 2] << 2) |
                   (pixels[b * 4 + 3]);
    }
    return bytes;
}

function frame(rows) {
    if (rows.length !== 21) throw new Error('frame needs 21 rows');
    const buf = new Uint8Array(64);
    for (let r = 0; r < 21; r++) buf.set(rows[r], r * 3);
    return buf;
}

const _ = 0;  // transparent
const a = 1;  // color2 (shared)
const b = 2;  // color1 (unique to sprite)
const c = 3;  // color3 (shared)

// =============================================================================
// HERO — pink blob creature
// =============================================================================
// Palette:  color1 = pink (10, body)
//           color2 = white (1, eye whites)
//           color3 = red   (2, pupils + mouth)

const heroFrame0 = frame([  // idle: feet flat
    row(_,_,_,_,b,b,b,b,_,_,_,_),
    row(_,_,_,b,b,b,b,b,b,_,_,_),
    row(_,_,b,b,b,b,b,b,b,b,_,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,a,a,b,b,a,a,b,b,_),
    row(_,b,b,a,c,b,b,a,c,b,b,_),
    row(_,b,b,a,a,b,b,a,a,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,c,c,c,c,b,b,b,_),
    row(_,b,b,b,b,c,c,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,_,b,b,b,b,b,b,b,b,_,_),
    row(_,_,_,b,b,b,b,b,b,_,_,_),
    row(_,_,_,_,b,b,b,b,_,_,_,_),
    row(_,_,_,b,b,_,_,b,b,_,_,_),
    row(_,_,_,b,b,_,_,b,b,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
]);
const heroFrame1 = frame([  // walk cycle: pupils shifted, one foot lifted
    row(_,_,_,_,b,b,b,b,_,_,_,_),
    row(_,_,_,b,b,b,b,b,b,_,_,_),
    row(_,_,b,b,b,b,b,b,b,b,_,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,a,a,b,b,a,a,b,b,_),
    row(_,b,b,c,a,b,b,c,a,b,b,_),
    row(_,b,b,a,a,b,b,a,a,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,c,c,c,c,b,b,b,_),
    row(_,b,b,b,b,c,c,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,_,b,b,b,b,b,b,b,b,_,_),
    row(_,_,_,b,b,b,b,b,b,_,_,_),
    row(_,_,_,_,b,b,b,b,_,_,_,_),
    row(_,_,_,_,_,_,_,b,b,_,_,_),  // left foot lifted
    row(_,_,_,b,b,_,_,b,b,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
]);

const hero = gmSprite.createBlank({
    name: 'HERO',
    isMultiColor: true,
    numFrames: 2,
    bgColor: 0,
    gmColor1: 10, gmColor2: 1, gmColor3: 2,
    xPosition: 70,
    yPosition: 185,
});
hero.sprite[0].imageData[0] = heroFrame0;
hero.sprite[0].imageData[1] = heroFrame1;
hero.dirty = true;
const heroSpriteData = hero.serialize();

// =============================================================================
// BALLOON — body in color1 (the per-slot unique color) so two slots can
// render the same sprite asset in different colors. Slot 1 keeps the default
// red; slot 2 sets color1 to cyan at runtime via opcode 0x2F.
// =============================================================================
// Palette:  color1 = red   (2, body)         — UNIQUE, swappable per-slot
//           color2 = white (1, highlight)    — shared
//           color3 = brown (9, string tie)   — shared

const balloonFrame0 = frame([
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,b,b,b,b,_,_,_,_),
    row(_,_,_,b,b,b,b,b,b,_,_,_),
    row(_,_,b,b,a,b,b,b,b,b,_,_),  // 'a' (white) highlight
    row(_,b,b,a,a,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,_,b,b,b,b,b,b,b,b,_,_),
    row(_,_,_,b,b,b,b,b,b,_,_,_),
    row(_,_,_,_,b,b,b,b,_,_,_,_),
    row(_,_,_,_,_,c,c,_,_,_,_,_),  // 'c' (brown) string tie
    row(_,_,_,_,_,_,c,_,_,_,_,_),
    row(_,_,_,_,_,c,_,_,_,_,_,_),
    row(_,_,_,_,_,_,c,_,_,_,_,_),
    row(_,_,_,_,_,c,_,_,_,_,_,_),
    row(_,_,_,_,_,_,c,_,_,_,_,_),
    row(_,_,_,_,_,c,_,_,_,_,_,_),
    row(_,_,_,_,_,_,c,_,_,_,_,_),
]);
const balloonFrame1 = frame([  // bob up: shifted 1 row higher
    row(_,_,_,_,b,b,b,b,_,_,_,_),
    row(_,_,_,b,b,b,b,b,b,_,_,_),
    row(_,_,b,b,a,b,b,b,b,b,_,_),
    row(_,b,b,a,a,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,b,b,b,b,b,b,b,b,b,b,_),
    row(_,_,b,b,b,b,b,b,b,b,_,_),
    row(_,_,_,b,b,b,b,b,b,_,_,_),
    row(_,_,_,_,b,b,b,b,_,_,_,_),
    row(_,_,_,_,_,c,c,_,_,_,_,_),
    row(_,_,_,_,_,c,_,_,_,_,_,_),
    row(_,_,_,_,_,_,c,_,_,_,_,_),
    row(_,_,_,_,_,c,_,_,_,_,_,_),
    row(_,_,_,_,_,_,c,_,_,_,_,_),
    row(_,_,_,_,_,c,_,_,_,_,_,_),
    row(_,_,_,_,_,_,c,_,_,_,_,_),
    row(_,_,_,_,_,c,_,_,_,_,_,_),
    row(_,_,_,_,_,_,c,_,_,_,_,_),
]);

const balloon = gmSprite.createBlank({
    name: 'BALOON',
    isMultiColor: true,
    numFrames: 2,
    bgColor: 0,
    gmColor1: 2, gmColor2: 1, gmColor3: 9,   // red body, white highlight, brown string
    xPosition: 90,
    yPosition: 90,
});
balloon.sprite[0].imageData[0] = balloonFrame0;
balloon.sprite[0].imageData[1] = balloonFrame1;
balloon.dirty = true;
const balloonSpriteData = balloon.serialize();

// =============================================================================
// ALIENS sprites — for the shooter program (SHIP, bullets, alien pairs)
// =============================================================================
//
// Original alien design (NOT a reproduction of the iconic Taito artwork):
// small bipedal critter, antennae up, two red eyes, splayed legs that
// alternate per frame. 5 fat-pixels wide; two of them sit side-by-side in
// a 12-fp pair sprite with a 2-fp gap. xDouble flag → renders 48 px wide.
//
// Three pair variants share the same dimensions and position semantics so
// we can swap them in-place on the same slot via opcode 0x27 (sprite is X).
//   PAIR  — both aliens alive (the default)
//   LEFT  — left alien alive, right half transparent
//   RIGHT — right alien alive, left half transparent
// When both die, we clear the slot via 0x67.

// Single-alien frames laid out in the pair grid (12-fp wide × 21-row).
// Use the helper bodies below to compose left/right/pair variants.

// Frame 0 — legs spread.
function alienRowsFrame0() {
    return [
        //    L A L A           R     A R A
        //    0 1 2 3 4 5 6 7 8 9 A B
        [_,b,_,b,_,_,_,_,b,_,b,_],   // 0  antennae
        [_,b,_,b,_,_,_,_,b,_,b,_],   // 1
        [a,a,a,a,a,_,_,a,a,a,a,a],   // 2  body top
        [a,c,a,c,a,_,_,a,c,a,c,a],   // 3  eyes
        [a,a,a,a,a,_,_,a,a,a,a,a],   // 4
        [_,a,a,a,_,_,_,_,a,a,a,_],   // 5  narrower
        [a,_,a,_,a,_,_,a,_,a,_,a],   // 6  legs spread
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 7
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 8
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 9
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 10
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 11
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 12
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 13
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 14
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 15
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 16
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 17
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 18
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 19
        [_,_,_,_,_,_,_,_,_,_,_,_],   // 20
    ];
}

// Frame 1 — legs alternate (the classic "march" animation).
function alienRowsFrame1() {
    const rows = alienRowsFrame0();
    rows[6] = [_,a,_,a,_,_,_,_,a,_,a,_];  // legs swap pattern
    return rows;
}

// Mask one half of a pair-frame to transparent.
function maskHalf(rows, side) {
    return rows.map(r => r.map((px, x) => {
        if (side === 'left'  && x >= 7) return _;
        if (side === 'right' && x <= 4) return _;
        return px;
    }));
}

function rowsToFrame(rows) { return frame(rows.map(r => row(...r))); }

// Three pair variants, two frames each. xDouble = true → renders 48 px wide.
function buildPairSprite(name, leftAlive, rightAlive) {
    const sprite = gmSprite.createBlank({
        name,
        isMultiColor: true,
        numFrames: 2,
        xDouble: true,                   // each fat pixel rendered 2× wide
        bgColor: 0,
        gmColor1: 1,                     // white antennae (shared)
        gmColor2: 13,                    // light green body
        gmColor3: 2,                     // red eyes
        xPosition: 30,
        yPosition: 70,
    });
    let f0 = alienRowsFrame0();
    let f1 = alienRowsFrame1();
    if (!leftAlive)  { f0 = maskHalf(f0, 'right'); f1 = maskHalf(f1, 'right'); }
    if (!rightAlive) { f0 = maskHalf(f0, 'left');  f1 = maskHalf(f1, 'left');  }
    sprite.sprite[0].imageData[0] = rowsToFrame(f0);
    sprite.sprite[0].imageData[1] = rowsToFrame(f1);
    sprite.dirty = true;
    return sprite.serialize();
}

const pairBothData  = buildPairSprite('PAIR',  true,  true);
const pairLeftData  = buildPairSprite('LEFT',  true,  false);
const pairRightData = buildPairSprite('RIGHT', false, true);

// Pair sprite instances (needed for mediaStore — but only the BOTH variant
// is actually loaded at startup; LEFT/RIGHT are sprite-asset swaps mid-game).
const pairBoth  = new gmSprite(pairBothData);
const pairLeft  = new gmSprite(pairLeftData);
const pairRight = new gmSprite(pairRightData);

// --- Player SHIP — wedge with cockpit details ---
const shipFrame = frame([
    row(_,_,_,_,_,b,b,_,_,_,_,_),   // 0  tip
    row(_,_,_,_,a,a,a,a,_,_,_,_),   // 1
    row(_,_,_,a,a,a,a,a,a,_,_,_),   // 2
    row(_,_,a,a,a,c,c,a,a,a,_,_),   // 3  cockpit (red)
    row(_,a,a,a,a,a,a,a,a,a,a,_),   // 4
    row(a,a,a,a,a,a,a,a,a,a,a,a),   // 5  base
    row(_,_,a,_,_,_,_,_,_,a,_,_),   // 6  thruster stubs
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
    row(_,_,_,_,_,_,_,_,_,_,_,_),
]);
const ship = gmSprite.createBlank({
    name: 'SHIP',
    isMultiColor: true,
    numFrames: 1,
    bgColor: 0,
    gmColor1: 1,    // white tip (shared)
    gmColor2: 3,    // cyan body
    gmColor3: 2,    // red cockpit (shared)
    xPosition: 80,
    yPosition: 220,
});
ship.sprite[0].imageData[0] = shipFrame;
ship.dirty = true;
const shipData = ship.serialize();

// --- Bullets — tiny vertical streaks ---
function bulletFrame() {
    return frame([
        row(_,_,_,_,_,a,a,_,_,_,_,_),
        row(_,_,_,_,_,a,a,_,_,_,_,_),
        row(_,_,_,_,_,a,a,_,_,_,_,_),
        row(_,_,_,_,_,a,a,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
        row(_,_,_,_,_,_,_,_,_,_,_,_),
    ]);
}
function makeBullet(name, color) {
    const s = gmSprite.createBlank({
        name, isMultiColor: true, numFrames: 1,
        bgColor: 0, gmColor1: 1, gmColor2: color, gmColor3: 1,
        xPosition: 0, yPosition: 0,
    });
    s.sprite[0].imageData[0] = bulletFrame();
    s.dirty = true;
    return s.serialize();
}
const pbullData = makeBullet('PBULL', 7);   // yellow
const ebullData = makeBullet('EBULL', 10);  // pink

// =============================================================================
// SCENE — a sunlit meadow
// =============================================================================
//
// 160 × 200 fat-pixel buffer. Color indices 0–3 map to:
//   0 = bgColor (sky)   1 = color1 (grass)
//   2 = color2 (sun)    3 = color3 (horizon / accents)

const scene = gmScene.createBlank(
    6,   // bg: blue (sky)
    5,   // 1:  green (grass)
    7,   // 2:  yellow (sun)
    9    // 3:  brown (horizon)
);
scene.name = 'MEADOW';

const GRASS_TOP = 150;
for (let y = GRASS_TOP; y < 200; y++)
    for (let x = 0; x < 160; x++) scene.setPixel(x, y, 1);

// Horizon line.
for (let x = 0; x < 160; x++) scene.setPixel(x, GRASS_TOP, 3);

// Rolling hills.
function bump(cx, w, h) {
    for (let dx = -w; dx <= w; dx++) {
        const x = cx + dx;
        const k = 1 - (dx * dx) / (w * w);
        const top = GRASS_TOP - Math.round(h * k);
        for (let y = top; y < GRASS_TOP; y++)
            if (x >= 0 && x < 160) scene.setPixel(x, y, 1);
        if (top >= 0 && x >= 0 && x < 160) scene.setPixel(x, top, 3);
    }
}
bump(30, 24, 12);
bump(80, 18, 7);
bump(125, 22, 10);

// Sun: filled circle.
const sunCx = 130, sunCy = 30, sunR = 14;
for (let y = sunCy - sunR; y <= sunCy + sunR; y++)
    for (let x = sunCx - sunR; x <= sunCx + sunR; x++) {
        const dx = x - sunCx, dy = y - sunCy;
        if (dx * dx + dy * dy <= sunR * sunR) scene.setPixel(x, y, 2);
    }

// Flowers on the grass.
for (const [fx, fy] of [[15,175],[50,180],[75,172],[105,178],[140,174]]) {
    scene.setPixel(fx, fy, 2);
    scene.setPixel(fx - 1, fy, 2);
    scene.setPixel(fx + 1, fy, 2);
    scene.setPixel(fx, fy - 1, 2);
    scene.setPixel(fx, fy + 1, 3);
}

// Two stylized clouds. A cloud is 3 fat-pixel-wide white blobs at one height.
function cloud(cx, cy) {
    for (const [ox, oy, r] of [[-6, 0, 3], [0, -1, 4], [6, 0, 3]]) {
        for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++)
                if (dx * dx + dy * dy <= r * r) {
                    const x = cx + ox + dx, y = cy + oy + dy;
                    if (x >= 0 && x < 160 && y >= 0 && y < 200)
                        scene.setPixel(x, y, 2);  // yellow-white-ish
                }
    }
}
cloud(40, 35);
cloud(95, 55);

const sceneFileData = scene.save();

// =============================================================================
// SCENE: STARS — black sky with scattered stars for the shooter program
// =============================================================================

const stars = gmScene.createBlank(
    0,    // bg: black
    1,    // 1: white (bright stars)
    11,   // 2: gray1 (dim stars)
    9     // 3: brown (unused)
);
stars.name = 'STARS';

// Hand-picked star positions — pseudo-random but distributed.
// Mix of bright (color1) and dim (color2) for depth.
const starList = [
    [8,12,1],[23,35,1],[42,18,2],[57,52,1],[71,8,2],[89,28,1],[103,44,2],
    [118,15,1],[134,38,2],[148,22,1],[15,68,2],[33,77,1],[48,90,2],[65,82,1],
    [79,72,2],[94,88,1],[109,75,2],[123,95,1],[140,80,2],[5,105,1],[20,128,2],
    [38,118,1],[52,135,2],[69,112,1],[84,142,2],[99,123,1],[115,138,2],
    [131,118,1],[145,142,1],[12,158,2],[28,170,1],[44,162,2],[60,180,1],
    [76,168,2],[92,185,1],[107,172,2],[122,190,1],[138,175,2],[152,165,1],
];
for (const [x, y, c] of starList) {
    if (x >= 0 && x < 160 && y >= 0 && y < 200) stars.setPixel(x, y, c);
}

const starsFileData = stars.save();

// =============================================================================
// SOUNDS — BLIP (button press) and CHIME (balloon catch)
// =============================================================================
//
// gmSound spd byte semantics (after parse, before display):
//   1–127   sweep UP   (higher = more steps = faster)
//   128–254 sweep DOWN
//   0, 255  dead zone

function makeFrame(opts) {
    return {
        wave: opts.wave,
        att: opts.att || 0, dec: opts.dec || 0,
        sus: opts.sus || 0, rel: opts.rel || 0,
        freqHi: opts.freqHi, freqLo: opts.freqLo || 0,
        spd: opts.spd ?? 0,
        pulseHi: 0, pulseLo: 0,
        dur: opts.dur,
        eqLowPass: 0, eqBandPass: 0, eqHighPass: 0,
        tie: !!opts.tie,
    };
}

// Short and crisp — fires instantly on jump start. Earlier version had
// dur=6 + dec/rel tails that overlapped the next jump if you mashed the
// button. att=0, sus=0 means the envelope hits and decays right away.
const blip = new gmSound();
blip.name = 'BLIP';
blip.speed = 32;
blip.volume = 13;
blip.frames = [
    makeFrame({ wave: gmSound.WAVE_TRIANGLE, att: 0, dec: 2, sus: 0, rel: 2,
        freqHi: 0x18, spd: 0x60, dur: 2 }),  // 0x60 = 96 = brisk sweep UP
];
const blipFileData = blip.serialize();

const chime = new gmSound();
chime.name = 'CHIME';
chime.speed = 32;
chime.volume = 14;
chime.frames = [
    makeFrame({ wave: gmSound.WAVE_TRIANGLE, att: 0, dec: 2, sus: 14, rel: 8,
        freqHi: 0x1C, freqLo: 0x32, dur: 5 }),  // A5-ish
    makeFrame({ wave: gmSound.WAVE_TRIANGLE, att: 0, dec: 2, sus: 14, rel: 10,
        freqHi: 0x2A, freqLo: 0x38, dur: 8 }),  // E6-ish (rising perfect fifth)
];
const chimeFileData = chime.serialize();

// ZAP — short downward sweep, the player ship firing.
const zap = new gmSound();
zap.name = 'ZAP';
zap.speed = 32;
zap.volume = 13;
zap.frames = [
    makeFrame({ wave: gmSound.WAVE_TRIANGLE, att: 0, dec: 4, sus: 2, rel: 2,
        freqHi: 0x30, spd: 0xC0, dur: 3 }),  // 0xC0 = sweep DOWN, brisk
];
const zapFileData = zap.serialize();

// BOOM — noise burst for alien hit. Short, percussive.
const boom = new gmSound();
boom.name = 'BOOM';
boom.speed = 32;
boom.volume = 14;
boom.frames = [
    makeFrame({ wave: gmSound.WAVE_NOISE, att: 0, dec: 8, sus: 4, rel: 6,
        freqHi: 0x08, freqLo: 0x00, dur: 4 }),
];
const boomFileData = boom.serialize();

// =============================================================================
// PROGRAMS
// =============================================================================
//
// The disk ships two programs that share all media:
//
//   BLOB   — the original simple wander. Joystick walks the creature
//            anywhere on screen; button plays a blip. Pure, no goal.
//            Kept as the "tiny first program" — readable in one glance.
//
//   WANDER — the gameplay version. 4-direction movement on the grass band,
//            button-to-jump, score, deterministic balloon positions from a
//            data table. Catch balloons at varied altitudes — some need a
//            jump, some need walking back into the grass to position under
//            the balloon's path.
//
// mediaStore indices (1-based — index 0 is unused per the format):
//   1 = HERO    (sprite)
//   2 = BALOON  (sprite)
//   3 = MEADOW  (scene)
//   4 = BLIP    (sound)
//   5 = CHIME   (sound)
//
// Movement-direction byte: 0=up, 64=right, 128=down, 192=left

const SPRITE_HERO    = 1;
const SPRITE_BALLOON = 2;
const SCENE_MEADOW   = 3;
const SOUND_BLIP     = 4;
const SOUND_CHIME    = 5;

const HERO     = 0;   // slot 0 = sprite 1 in the UI
const BALLOON  = 1;   // slot 1 = sprite 2
const JOY      = 0;   // joystick 1
const CH_BLIP  = 0;   // sound channel 1
const CH_CHIME = 1;   // sound channel 2
const SCN1     = 0;   // scene 1

function I(label, arg1, opcode, arg2) {
    return { label, arg1, opcode, arg2 };
}

const mediaStore = [
    null,
    { name: 'HERO',   type: 'sprite', sprite: hero,    spriteFileData: heroSpriteData,    quadIndex: 0 },
    { name: 'BALOON', type: 'sprite', sprite: balloon, spriteFileData: balloonSpriteData, quadIndex: 0 },
    { name: 'MEADOW', type: 'scene',  scene: scene },
    { name: 'BLIP',   type: 'sound',  soundFileData: blipFileData },
    { name: 'CHIME',  type: 'sound',  soundFileData: chimeFileData },
];

// =============================================================================
// BLOB — the simple version
// =============================================================================
// Variables:
//   a (1) = scratch (rnd, balloon-x reads)
//   b (2) = jump timer — frames of upward movement remaining; 0 = grounded
//   c (3) = scratch (hero-y reads/writes)

{
    const VAR_A = 1, VAR_B = 2, VAR_C = 3;
    const LBL_LOOP = 1;
    const GROUND_Y    = 185;
    const JUMP_FRAMES = 22;
    const JUMP_PX     = 2;
    const HERO_X_MIN  = 14;
    const HERO_X_MAX  = 158;
    const BALLOON_Y_MIN   = 120;
    const BALLOON_Y_RANGE = 18;

    const blobInstructions = [
        I(0, 0,        0x53, SCN1),
        I(0, SCN1,     0x28, SCENE_MEADOW),
        I(0, 0,        0x2E, SCN1),

        I(0, 0,        0x46, 0),
        I(0, 2,        0x42, 0),
        I(0, 0,        0x5B, SCN1),

        I(0, HERO,     0x27, SPRITE_HERO),
        I(0, HERO,     0x1F, 70),
        I(0, HERO,     0x21, GROUND_Y),
        I(0, HERO,     0x29, 28),
        I(0, HERO,     0x65, 0),
        I(0, HERO,     0x25, 0),
        I(0, VAR_B,    0x07, 0),

        I(0, BALLOON,  0x27, SPRITE_BALLOON),
        I(0, BALLOON,  0x1F, 40),
        I(0, BALLOON,  0x21, 135),
        I(0, BALLOON,  0x29, 16),
        I(0, BALLOON,  0x65, 0),
        I(0, BALLOON,  0x23, 64),
        I(0, BALLOON,  0x25, 30),

        I(LBL_LOOP, HERO, 0x25, 0),

        I(0, JOY,     0x19, 2),
        I(0, HERO,    0x23, 192),
        I(0, HERO,    0x25, 90),
        I(0, 0,       0x55, 0),

        I(0, JOY,     0x19, 3),
        I(0, HERO,    0x23, 64),
        I(0, HERO,    0x25, 90),
        I(0, 0,       0x55, 0),

        I(0, 0,       0x1A, 0),
        I(0, VAR_C,   0x2D, HERO),
        I(0, VAR_C,   0x15, GROUND_Y - 1),
        I(0, VAR_B,   0x07, JUMP_FRAMES),
        I(0, CH_BLIP, 0x40, SOUND_BLIP),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),

        I(0, VAR_C,   0x2D, HERO),
        I(0, VAR_B,   0x15, 0),
        I(0, VAR_C,   0x0D, JUMP_PX),
        I(0, VAR_B,   0x0D, 1),
        I(0, 0,       0x55, 0),
        I(0, VAR_B,   0x13, 0),
        I(0, VAR_C,   0x17, GROUND_Y),
        I(0, VAR_C,   0x0B, JUMP_PX),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),
        I(0, VAR_C,   0x15, GROUND_Y),
        I(0, VAR_C,   0x07, GROUND_Y),
        I(0, 0,       0x55, 0),
        I(0, HERO,    0x22, VAR_C),

        I(0, VAR_A,   0x2C, HERO),
        I(0, VAR_A,   0x15, HERO_X_MAX),
        I(0, HERO,    0x1F, HERO_X_MAX),
        I(0, 0,       0x55, 0),
        I(0, VAR_A,   0x17, HERO_X_MIN),
        I(0, HERO,    0x1F, HERO_X_MIN),
        I(0, 0,       0x55, 0),

        I(0, VAR_A,   0x2C, BALLOON),
        I(0, VAR_A,   0x15, 150),
        I(0, BALLOON, 0x23, 192),
        I(0, 0,       0x55, 0),
        I(0, VAR_A,   0x17, 25),
        I(0, BALLOON, 0x23, 64),
        I(0, 0,       0x55, 0),

        I(0, HERO,    0x1B, BALLOON),
        I(0, CH_CHIME, 0x40, SOUND_CHIME),
        I(0, 1,       0x44, 0),
        I(0, VAR_A,   0x09, 100),
        I(0, VAR_A,   0x0B, 25),
        I(0, BALLOON, 0x20, VAR_A),
        I(0, VAR_A,   0x09, BALLOON_Y_RANGE),
        I(0, VAR_A,   0x0B, BALLOON_Y_MIN),
        I(0, BALLOON, 0x22, VAR_A),
        I(0, BALLOON, 0x23, 64),
        I(0, 0,       0x55, 0),

        I(0, 0,       0x01, LBL_LOOP),
    ];
    var blobPrgBytes = serializeProgram({ instructions: blobInstructions, mediaStore, dataTables: {} });
}

// =============================================================================
// WANDER — gameplay version with grass depth + data-table balloon positions
// =============================================================================
//
// Variables:
//   a (1) = scratch (rnd, x reads, data-table offset)
//   b (2) = jump timer (0 = not rising, 1..22 = rising)
//   c (3) = scratch (hero-y reads/writes)
//   d (4) = balloon spawn index, 0..7, cycles through the data table
//   e (5) = falling flag (0 = not falling, 1 = falling)
//
// Labels:
//   l001 = main loop
//   l002 = balloon position data table (8 (x,y) pairs)
//
// Grass band: the hero can walk in y range [GROUND_Y..BACK_Y]. y=GROUND_Y
// is the "front edge" of the grass; y=BACK_Y is the back. Low balloons
// hover at y values reachable from the back of the grass band; high ones
// need a jump from any depth. Jump only fires when grounded (b==0, e==0).
//
// Vertical motion is hand-rolled: GM's auto-mover only handles L/R/U/D
// walking. The jump-and-fall arc is a separate state machine on top so
// we can have a real "floor" and still allow horizontal control mid-jump.

{
    const VAR_A = 1, VAR_B = 2, VAR_C = 3, VAR_D = 4, VAR_E = 5;
    const VAR_F = 6, VAR_G = 7;
    const LBL_LOOP = 1, LBL_DATA = 2;
    const GROUND_Y    = 185;
    const BACK_Y      = 205;
    const JUMP_FRAMES = 22;
    const JUMP_PX     = 2;
    const WALK_SPEED  = 90;
    const DEPTH_SPEED = 50;
    const HERO_X_MIN  = 14;
    const HERO_X_MAX  = 158;

    // Slot 1 = sprite 2 (red BALOON, default colors).
    // Slot 2 = sprite 3 (same BALOON sprite asset, recolored to cyan at
    // runtime via opcode 0x2F — per-slot unique color).
    const BALLOON_A = 1;       // slot 1 (sprite 2 in UI)
    const BALLOON_B = 2;       // slot 2 (sprite 3 in UI)
    const CYAN      = 3;       // C64 palette: cyan body for second balloon
    const PLOT_YELLOW = 2;     // plot color = scene color slot 2 (yellow)

    // Sparkles: when a balloon is caught we plot a 5-pixel "+" at the
    // balloon's current position. Plotting at variable coords requires
    // converting GM-space (sprite x in fat-pixels 12..171, y in 50..249)
    // to scene-space (0..159, 0..199). The sprite's top-left maps to
    // (gm_x - 12, gm_y - 50); its 12×21 body's center is +6 / +10 from
    // there, so the catch-point in scene coords is (gm_x - 6, gm_y - 40).

    const wanderInstructions = [
        // ---- Setup ----
        I(0, 0,        0x53, SCN1),               // clear scene 1
        I(0, SCN1,     0x28, SCENE_MEADOW),       // scene 1 is MEADOW
        I(0, 0,        0x2E, SCN1),               // display scene 1

        I(0, 0,        0x46, 0),                  // score1 at row 0 col 0
        I(0, 2,        0x42, 0),                  // color = scene-color2 on bg
        I(0, 0,        0x5B, SCN1),               // displays on scene 1

        // Plot color for sparkles — set once, used by both collision blocks.
        I(0, PLOT_YELLOW, 0x4D, SCN1),            // plot color = 2 (yellow) on scene 1

        I(0, HERO,     0x27, SPRITE_HERO),
        I(0, HERO,     0x1F, 70),
        I(0, HERO,     0x21, GROUND_Y),
        I(0, HERO,     0x29, 28),
        I(0, HERO,     0x65, 0),
        I(0, HERO,     0x25, 0),
        I(0, VAR_B,    0x07, 0),
        I(0, VAR_E,    0x07, 0),
        I(0, VAR_D,    0x07, 2),                  // d = 2 (next data-table position after the two initial loads)

        // Balloon A — slot 1, default red body.
        I(0, BALLOON_A, 0x27, SPRITE_BALLOON),
        I(0, BALLOON_A, 0x29, 16),
        I(0, BALLOON_A, 0x65, 0),
        I(0, BALLOON_A, 0x23, 64),                // dir = right
        I(0, BALLOON_A, 0x25, 30),

        // Balloon B — slot 2, same sprite asset but recolor color1 to cyan.
        I(0, BALLOON_B, 0x27, SPRITE_BALLOON),
        I(0, BALLOON_B, 0x2F, CYAN),              // sprite 3 color 1 = cyan (per-slot)
        I(0, BALLOON_B, 0x29, 16),
        I(0, BALLOON_B, 0x65, 0),
        I(0, BALLOON_B, 0x23, 192),               // dir = left (drift opposite)
        I(0, BALLOON_B, 0x25, 30),

        I(0, 0,        0x1C, LBL_DATA),           // bind data table at l002

        // Load A at data[0..1], B at data[2..3]. d already = 2 above.
        I(0, VAR_A,    0x07, 0),
        I(0, VAR_A,    0x0A, VAR_A),
        I(0, BALLOON_A, 0x20, VAR_A),             // A x = data[0]
        I(0, VAR_A,    0x07, 1),
        I(0, VAR_A,    0x0A, VAR_A),
        I(0, BALLOON_A, 0x22, VAR_A),             // A y = data[1]
        I(0, VAR_A,    0x07, 2),
        I(0, VAR_A,    0x0A, VAR_A),
        I(0, BALLOON_B, 0x20, VAR_A),             // B x = data[2]
        I(0, VAR_A,    0x07, 3),
        I(0, VAR_A,    0x0A, VAR_A),
        I(0, BALLOON_B, 0x22, VAR_A),             // B y = data[3]

        // =================================================== MAIN LOOP =====
        I(LBL_LOOP, HERO, 0x25, 0),

        // --- Horizontal input ---
        I(0, JOY,     0x19, 2),
        I(0, HERO,    0x23, 192),
        I(0, HERO,    0x25, WALK_SPEED),
        I(0, 0,       0x55, 0),

        I(0, JOY,     0x19, 3),
        I(0, HERO,    0x23, 64),
        I(0, HERO,    0x25, WALK_SPEED),
        I(0, 0,       0x55, 0),

        // --- Vertical input (only when grounded) ---
        I(0, VAR_B,   0x13, 0),
        I(0, VAR_E,   0x13, 0),
        I(0, JOY,     0x19, 0),
        I(0, HERO,    0x23, 0),
        I(0, HERO,    0x25, DEPTH_SPEED),
        I(0, 0,       0x55, 0),
        I(0, JOY,     0x19, 1),
        I(0, HERO,    0x23, 128),
        I(0, HERO,    0x25, DEPTH_SPEED),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),

        // --- Jump start ---
        I(0, 0,       0x1A, 0),
        I(0, VAR_B,   0x13, 0),
        I(0, VAR_E,   0x13, 0),
        I(0, VAR_B,   0x07, JUMP_FRAMES),
        I(0, CH_BLIP, 0x40, SOUND_BLIP),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),

        // --- Vertical motion: rising ---
        I(0, VAR_C,   0x2D, HERO),
        I(0, VAR_B,   0x15, 0),
        I(0, VAR_C,   0x0D, JUMP_PX),
        I(0, VAR_B,   0x0D, 1),
        I(0, VAR_B,   0x13, 0),
        I(0, VAR_E,   0x07, 1),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),

        // --- Vertical motion: falling ---
        I(0, VAR_E,   0x15, 0),
        I(0, VAR_C,   0x0B, JUMP_PX),
        I(0, VAR_C,   0x15, GROUND_Y - 1),
        I(0, VAR_C,   0x07, GROUND_Y),
        I(0, VAR_E,   0x07, 0),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),

        // --- Grass band clamp ---
        I(0, VAR_B,   0x13, 0),
        I(0, VAR_E,   0x13, 0),
        I(0, VAR_C,   0x17, GROUND_Y),
        I(0, VAR_C,   0x07, GROUND_Y),
        I(0, 0,       0x55, 0),
        I(0, VAR_C,   0x15, BACK_Y),
        I(0, VAR_C,   0x07, BACK_Y),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),

        I(0, HERO,    0x22, VAR_C),

        // --- Hero x clamp ---
        I(0, VAR_A,   0x2C, HERO),
        I(0, VAR_A,   0x15, HERO_X_MAX),
        I(0, HERO,    0x1F, HERO_X_MAX),
        I(0, 0,       0x55, 0),
        I(0, VAR_A,   0x17, HERO_X_MIN),
        I(0, HERO,    0x1F, HERO_X_MIN),
        I(0, 0,       0x55, 0),

        // --- Balloon A edge bounce ---
        I(0, VAR_A,   0x2C, BALLOON_A),
        I(0, VAR_A,   0x15, 150),
        I(0, BALLOON_A, 0x23, 192),
        I(0, 0,       0x55, 0),
        I(0, VAR_A,   0x17, 25),
        I(0, BALLOON_A, 0x23, 64),
        I(0, 0,       0x55, 0),

        // --- Balloon B edge bounce ---
        I(0, VAR_A,   0x2C, BALLOON_B),
        I(0, VAR_A,   0x15, 150),
        I(0, BALLOON_B, 0x23, 192),
        I(0, 0,       0x55, 0),
        I(0, VAR_A,   0x17, 25),
        I(0, BALLOON_B, 0x23, 64),
        I(0, 0,       0x55, 0),

        // --- Collision: hero hit balloon A ---
        I(0, HERO,    0x1B, BALLOON_A),           // if hero hit A
        I(0, CH_CHIME, 0x40, SOUND_CHIME),
        I(0, 1,       0x44, 0),

        // Sparkles at A's current position. f = sprite x - 6, g = sprite y - 40.
        I(0, VAR_F,   0x2C, BALLOON_A),
        I(0, VAR_F,   0x0D, 6),
        I(0, VAR_G,   0x2D, BALLOON_A),
        I(0, VAR_G,   0x0D, 40),
        I(0, VAR_F,   0x50, VAR_G),               // plot at (f, g) — center
        I(0, VAR_F,   0x0D, 1),
        I(0, VAR_F,   0x50, VAR_G),               // left
        I(0, VAR_F,   0x0B, 2),
        I(0, VAR_F,   0x50, VAR_G),               // right
        I(0, VAR_F,   0x0D, 1),                   // back to center
        I(0, VAR_G,   0x0D, 1),
        I(0, VAR_F,   0x50, VAR_G),               // up
        I(0, VAR_G,   0x0B, 2),
        I(0, VAR_F,   0x50, VAR_G),               // down

        // Load next position from data[d*2 .. d*2+1] into A.
        I(0, VAR_A,   0x08, VAR_D),
        I(0, VAR_A,   0x0F, 2),
        I(0, VAR_A,   0x0A, VAR_A),
        I(0, BALLOON_A, 0x20, VAR_A),

        I(0, VAR_A,   0x08, VAR_D),
        I(0, VAR_A,   0x0F, 2),
        I(0, VAR_A,   0x0B, 1),
        I(0, VAR_A,   0x0A, VAR_A),
        I(0, BALLOON_A, 0x22, VAR_A),

        I(0, BALLOON_A, 0x23, 64),                // reset dir

        I(0, VAR_D,   0x0B, 1),                   // d += 1
        I(0, VAR_D,   0x15, 7),
        I(0, VAR_D,   0x07, 0),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),                   // end if hit A

        // --- Collision: hero hit balloon B ---
        I(0, HERO,    0x1B, BALLOON_B),           // if hero hit B
        I(0, CH_CHIME, 0x40, SOUND_CHIME),
        I(0, 1,       0x44, 0),

        // Sparkles at B's current position.
        I(0, VAR_F,   0x2C, BALLOON_B),
        I(0, VAR_F,   0x0D, 6),
        I(0, VAR_G,   0x2D, BALLOON_B),
        I(0, VAR_G,   0x0D, 40),
        I(0, VAR_F,   0x50, VAR_G),
        I(0, VAR_F,   0x0D, 1),
        I(0, VAR_F,   0x50, VAR_G),
        I(0, VAR_F,   0x0B, 2),
        I(0, VAR_F,   0x50, VAR_G),
        I(0, VAR_F,   0x0D, 1),
        I(0, VAR_G,   0x0D, 1),
        I(0, VAR_F,   0x50, VAR_G),
        I(0, VAR_G,   0x0B, 2),
        I(0, VAR_F,   0x50, VAR_G),

        // Load next position into B.
        I(0, VAR_A,   0x08, VAR_D),
        I(0, VAR_A,   0x0F, 2),
        I(0, VAR_A,   0x0A, VAR_A),
        I(0, BALLOON_B, 0x20, VAR_A),

        I(0, VAR_A,   0x08, VAR_D),
        I(0, VAR_A,   0x0F, 2),
        I(0, VAR_A,   0x0B, 1),
        I(0, VAR_A,   0x0A, VAR_A),
        I(0, BALLOON_B, 0x22, VAR_A),

        I(0, BALLOON_B, 0x23, 192),               // reset dir (left, B's natural drift)

        I(0, VAR_D,   0x0B, 1),
        I(0, VAR_D,   0x15, 7),
        I(0, VAR_D,   0x07, 0),
        I(0, 0,       0x55, 0),
        I(0, 0,       0x55, 0),                   // end if hit B

        I(0, 0,       0x01, LBL_LOOP),            // loop

        // ============================================== DATA: balloon (x, y)
        I(LBL_DATA, 30,  0x1D, 130),              // 0: high left, easy jump
        I(0,        110, 0x1D, 132),              // 1: high right
        I(0,        65,  0x1D, 175),              // 2: low mid — walk back
        I(0,        100, 0x1D, 138),              // 3: jump apex
        I(0,        40,  0x1D, 168),              // 4: low left
        I(0,        130, 0x1D, 134),              // 5: high far right
        I(0,        70,  0x1D, 178),              // 6: low far back
        I(0,        90,  0x1D, 124),              // 7: high center
    ];
    var wanderPrgBytes = serializeProgram({ instructions: wanderInstructions, mediaStore, dataTables: {} });
}

// =============================================================================
// ALIENS — a Space-Invaders-style shooter (original alien artwork)
// =============================================================================
//
// 5 sprite pairs × 2 aliens = 10 invaders, marching in formation. Player ship
// at the bottom moves L/R with the joystick and fires upward with the button.
// Hit detection determines which half of a pair was struck; the pair's sprite
// asset is swapped from PAIR → LEFT or PAIR → RIGHT, then to "cleared" on
// the second hit. An enemy bullet drops periodically from the middle pair.
//
// Win = all 10 aliens dead. Lose = enemy bullet hits ship OR formation
// reaches the bottom.

const aliensMediaStore = [
    null,
    { name: 'SHIP',  type: 'sprite', sprite: ship,      spriteFileData: shipData,      quadIndex: 0 },
    { name: 'PBULL', type: 'sprite', sprite: new gmSprite(pbullData), spriteFileData: pbullData, quadIndex: 0 },
    { name: 'EBULL', type: 'sprite', sprite: new gmSprite(ebullData), spriteFileData: ebullData, quadIndex: 0 },
    { name: 'PAIR',  type: 'sprite', sprite: pairBoth,  spriteFileData: pairBothData,  quadIndex: 0 },
    { name: 'LEFT',  type: 'sprite', sprite: pairLeft,  spriteFileData: pairLeftData,  quadIndex: 0 },
    { name: 'RIGHT', type: 'sprite', sprite: pairRight, spriteFileData: pairRightData, quadIndex: 0 },
    { name: 'STARS', type: 'scene',  scene: stars },
    { name: 'ZAP',   type: 'sound',  soundFileData: zapFileData },
    { name: 'BOOM',  type: 'sound',  soundFileData: boomFileData },
];

{
    // mediaStore indices for this program
    const SPR_SHIP        = 1;
    const SPR_PBULL       = 2;
    const SPR_EBULL       = 3;
    const SPR_PAIR_BOTH   = 4;
    const SPR_PAIR_LEFT   = 5;
    const SPR_PAIR_RIGHT  = 6;
    const SCN_STARS       = 7;
    const SND_ZAP         = 8;
    const SND_BOOM        = 9;

    // Slot assignments
    const SHIP_S  = 0;          // sprite 1 in UI
    const PBULL_S = 1;
    const EBULL_S = 2;
    const P0 = 3, P1 = 4, P2 = 5, P3 = 6, P4 = 7;

    const JOY    = 0;
    const CH_ZAP  = 0;
    const CH_BOOM = 1;
    const SCN1    = 0;

    // Vars — 17 of them; GM allows a–z so plenty of headroom.
    const VAR_A = 1, VAR_B = 2, VAR_C = 3, VAR_D = 4, VAR_E = 5;
    const VAR_F = 6, VAR_G = 7, VAR_H = 8;
    const VAR_I = 9, VAR_J = 10, VAR_K = 11, VAR_L = 12, VAR_M = 13;
    const VAR_N = 14, VAR_O = 15, VAR_P = 16, VAR_Q = 17;

    // Game state in VAR_Q: 0 = playing, 1 = lost, 2 = won. When non-zero
    // the main loop short-circuits to LBL_GAMEOVER which waits for the
    // joystick up/down "restart" signal (button/left/right are still used
    // by gameplay so they'd be too easy to mash through a game-over).
    const LBL_LOOP = 1;
    const LBL_INIT = 2;
    const LBL_GAMEOVER = 3;

    // Constants
    const SHIP_X_MIN  = 14, SHIP_X_MAX = 158;
    const SHIP_Y      = 220;
    const PBULL_HIDE  = 30;       // y when player bullet is "inactive"
    const EBULL_HIDE  = 30;
    // Formation drift: starts at b=0 (leftmost) and climbs to FORMATION_MAX_X
    // (rightmost). Base positions below place the leftmost pair near the
    // screen's left edge at b=0; at b=MAX the rightmost pair sits flush
    // against the right edge.
    const FORMATION_MAX_X = 28;
    const DROP_FRAMES = 8;
    const SPAWN_INTERVAL = 90;
    const KILLS_TO_WIN = 10;

    // Move throttle — formation advances by 1 fat pixel every MOVE_EVERY
    // loop iterations. At ~40 Hz loop rate, MOVE_EVERY=3 → ~13 Hz march.
    // Input + hit detection still run every iteration (silky).
    const MOVE_EVERY = 3;

    // Base x — centered, 26-pitch (24-wide pair + 2 fat-pixel gap). With
    // FORMATION_MAX_X=28 the formation sweeps from screen-edge to screen-edge.
    const BX0 = 14, BX1 = 40, BX2 = 66, BX3 = 92, BX4 = 118;
    const PAIR_BASE_Y = 70;

    // Per-pair state encoding (state var per pair):
    //   0 = BOTH alive    1 = LEFT-only    2 = RIGHT-only    3 = DEAD
    // Pair state vars: i, j, k, l, m for pairs 0-4

    // Per-pair hit detection — generated as a block so we don't repeat
    // 30+ lines by hand. takes pair slot + state var + a sprite-asset
    // constants for L/R; spawns the full hit/score/swap logic.
    function pairHit(slot, stateVar) {
        return [
            I(0, PBULL_S, 0x1B, slot),                  // if pbull hit pair
            I(0, VAR_H, 0x2C, PBULL_S),                 //   h = pbull x
            I(0, VAR_H, 0x0B, 5),                       //   h += 5 (bullet center, not left edge)
            I(0, VAR_A, 0x2C, slot),                    //   a = pair x
            I(0, VAR_A, 0x0B, 12),                      //   a = a + 12 (midpoint of 24-wide pair)

            // ----- LEFT side (h < a) -----
            I(0, VAR_H, 0x18, VAR_A),                   //   if h < a then  (LEFT side hit)
            I(0, stateVar, 0x17, 2),                    //     if state < 2 (left alive)
            I(0, stateVar, 0x13, 0),                    //       if state = 0 (BOTH → RIGHT-only)
            I(0, stateVar, 0x07, 2),
            I(0, slot,  0x27, SPR_PAIR_RIGHT),
            I(0, 0,     0x55, 0),                       //       endif
            I(0, stateVar, 0x13, 1),                    //       if state = 1 (LEFT only → DEAD)
            I(0, stateVar, 0x07, 3),
            I(0, 0,     0x67, slot),                    //         clear sprite
            I(0, 0,     0x55, 0),                       //       endif
            I(0, CH_BOOM, 0x40, SND_BOOM),
            I(0, 1,     0x44, 0),                       //       add 1 to score
            I(0, VAR_O, 0x0D, 1),                       //       kills_remaining -= 1
            I(0, VAR_F, 0x07, 0),                       //       f = 0
            I(0, PBULL_S, 0x21, PBULL_HIDE),            //       hide pbull
            I(0, PBULL_S, 0x25, 0),                     //       pbull speed = 0
            I(0, 0,     0x55, 0),                       //     endif (left alive)
            I(0, 0,     0x55, 0),                       //   endif (LEFT side)

            // ----- RIGHT side (h > a) -----
            I(0, VAR_H, 0x16, VAR_A),                   //   if h > a then  (RIGHT side hit)
            I(0, stateVar, 0x13, 0),                    //     if state = 0 (BOTH → LEFT-only)
            I(0, stateVar, 0x07, 1),
            I(0, slot,  0x27, SPR_PAIR_LEFT),
            I(0, CH_BOOM, 0x40, SND_BOOM),
            I(0, 1,     0x44, 0),
            I(0, VAR_O, 0x0D, 1),
            I(0, VAR_F, 0x07, 0),
            I(0, PBULL_S, 0x21, PBULL_HIDE),
            I(0, PBULL_S, 0x25, 0),
            I(0, 0,     0x55, 0),                       //     endif (BOTH)
            I(0, stateVar, 0x13, 2),                    //     if state = 2 (RIGHT only → DEAD)
            I(0, stateVar, 0x07, 3),
            I(0, 0,     0x67, slot),
            I(0, CH_BOOM, 0x40, SND_BOOM),
            I(0, 1,     0x44, 0),
            I(0, VAR_O, 0x0D, 1),
            I(0, VAR_F, 0x07, 0),
            I(0, PBULL_S, 0x21, PBULL_HIDE),
            I(0, PBULL_S, 0x25, 0),
            I(0, 0,     0x55, 0),                       //     endif (RIGHT only)
            I(0, 0,     0x55, 0),                       //   endif (RIGHT side)

            I(0, 0,     0x55, 0),                       // endif (collision)
        ];
    }

    // Spawn the enemy bullet from this pair iff the random pick (h) lands
    // on its index AND the pair is alive. Visually anchors the bullet to
    // an actual living alien — picking from random x without this gate
    // produced bullets emerging from gaps where pairs had been killed.
    //
    // Half selection: state 0 (BOTH) and state 1 (LEFT-only) spawn from
    // the left half (pair_x + 6); state 2 (RIGHT-only) shifts +12 to the
    // right half (pair_x + 18). The bullet never appears under a dead
    // half, which is the whole point of the gate.
    function spawnFromPair(slot, stateVar, hValue) {
        return [
            I(0, VAR_H, 0x13, hValue),                  // if h = hValue
            I(0, stateVar, 0x17, 3),                    //   if state < 3 (alive)
            I(0, VAR_A, 0x2C, slot),                    //     a = pair x
            I(0, VAR_A, 0x0B, 6),                       //     a += 6 (left-half center)
            I(0, stateVar, 0x13, 2),                    //     if state = 2 (RIGHT-only)
            I(0, VAR_A, 0x0B, 12),                      //       a += 12 (shift to right half)
            I(0, 0,     0x55, 0),                       //     endif
            I(0, EBULL_S, 0x20, VAR_A),                 //     ebull x = [a]
            I(0, VAR_A, 0x2D, slot),                    //     a = pair y
            I(0, VAR_A, 0x0B, 20),                      //     a += 20 (just below pair)
            I(0, EBULL_S, 0x22, VAR_A),                 //     ebull y = [a]
            I(0, EBULL_S, 0x23, 128),                   //     dir = down
            I(0, EBULL_S, 0x25, 50),                    //     speed
            I(0, VAR_G, 0x07, 1),                       //     g = 1 (active)
            I(0, 0,     0x55, 0),                       //   endif (alive)
            I(0, 0,     0x55, 0),                       // endif (h matches)
        ];
    }

    // Freeze everything that's still in motion when game ends. The Q-check
    // at loop top skips game logic, but GM's auto-mover keeps moving any
    // sprite with non-zero direction+speed — so bullets that were in flight
    // continue, wrap on 8-bit overflow, and reappear from the top. The
    // ship has the same problem if the joystick was held at the moment of
    // death. Set everything to speed 0, hide bullets off-screen, and stop
    // pair animation so the red/green tint is a true freeze.
    function freezeGame() {
        return [
            I(0, SHIP_S,  0x25, 0),                     // ship speed = 0
            I(0, PBULL_S, 0x25, 0),                     // pbull speed = 0
            I(0, PBULL_S, 0x21, PBULL_HIDE),            // pbull off-screen
            I(0, EBULL_S, 0x25, 0),                     // ebull speed = 0
            I(0, EBULL_S, 0x21, EBULL_HIDE),            // ebull off-screen
            I(0, P0, 0x29, 0),                          // pair 0 anim = 0
            I(0, P1, 0x29, 0),
            I(0, P2, 0x29, 0),
            I(0, P3, 0x29, 0),
            I(0, P4, 0x29, 0),
        ];
    }


    // Per-pair positioning block — set x = b + baseX, y = c + PAIR_BASE_Y
    // when alive (state < 3). Skipped when dead so cleared slots aren't
    // resurrected by setting a position.
    function pairPos(slot, stateVar, baseX) {
        return [
            I(0, stateVar, 0x17, 3),                    // if state < 3 (alive)
            I(0, VAR_A, 0x08, VAR_B),                   //   a = b
            I(0, VAR_A, 0x0B, baseX),                   //   a += baseX
            I(0, slot,  0x20, VAR_A),                   //   sprite slot x = [a]
            I(0, VAR_A, 0x08, VAR_C),                   //   a = c
            I(0, VAR_A, 0x0B, PAIR_BASE_Y),             //   a += PAIR_BASE_Y
            I(0, slot,  0x22, VAR_A),                   //   sprite slot y = [a]
            I(0, 0,     0x55, 0),                       // endif
        ];
    }

    const aliensInstructions = [
        // =========================================================== SETUP
        //
        // Restart hygiene: the runtime reuses the cached STARS scene object
        // across runs. Any mutation from a prior run (the lose/win bg tint,
        // the previously-rendered score digits) is still on it. We *don't*
        // `clear scene 1` here because that wipes the stars too. Instead:
        //   - reassign bg to black so the post-lose red tint goes away
        //   - clear score 1 (below) to repaint "000000" over the old digits
        //
        // LBL_INIT tagged here so the in-game restart can jump back and
        // re-run the whole setup sequence (cleared sprites get re-assigned,
        // vars zeroed, formation reset to top — full fresh game).
        I(LBL_INIT, SCN1, 0x28, SCN_STARS),            // scene 1 is STARS
        I(0, SCN1,     0x33, 0),                       // scene 1 bg = black (reset from any prior tint)
        I(0, 0,        0x2E, SCN1),                    // display scene 1

        // Score in top-left, white on black
        I(0, 0,        0x46, 0),                       // score1 at row 0 col 0
        I(0, 1,        0x42, 0),                       // color = scene-color1 (white) on bg (black)
        I(0, 0,        0x5B, SCN1),                    // displays on scene 1
        I(0, 0,        0x48, 0),                       // clear score 1 → renders "000000" (also wipes any prior-game digits)

        // Ship
        I(0, SHIP_S,   0x27, SPR_SHIP),
        I(0, SHIP_S,   0x1F, 80),
        I(0, SHIP_S,   0x21, SHIP_Y),
        I(0, SHIP_S,   0x25, 0),

        // Player bullet — created but hidden
        I(0, PBULL_S,  0x27, SPR_PBULL),
        I(0, PBULL_S,  0x1F, 0),
        I(0, PBULL_S,  0x21, PBULL_HIDE),
        I(0, PBULL_S,  0x23, 0),                       // up
        I(0, PBULL_S,  0x25, 0),

        // Enemy bullet — created but hidden
        I(0, EBULL_S,  0x27, SPR_EBULL),
        I(0, EBULL_S,  0x1F, 0),
        I(0, EBULL_S,  0x21, EBULL_HIDE),
        I(0, EBULL_S,  0x23, 128),                     // down
        I(0, EBULL_S,  0x25, 0),

        // Five alien pairs — all start in BOTH state
        I(0, P0,       0x27, SPR_PAIR_BOTH), I(0, P0, 0x29, 24), I(0, P0, 0x65, 0),
        I(0, P1,       0x27, SPR_PAIR_BOTH), I(0, P1, 0x29, 24), I(0, P1, 0x65, 0),
        I(0, P2,       0x27, SPR_PAIR_BOTH), I(0, P2, 0x29, 24), I(0, P2, 0x65, 0),
        I(0, P3,       0x27, SPR_PAIR_BOTH), I(0, P3, 0x29, 24), I(0, P3, 0x65, 0),
        I(0, P4,       0x27, SPR_PAIR_BOTH), I(0, P4, 0x29, 24), I(0, P4, 0x65, 0),

        // Game vars
        I(0, VAR_B, 0x07, 0),                          // formation x = 0
        I(0, VAR_C, 0x07, 0),                          // formation y = 0
        I(0, VAR_D, 0x07, 0),                          // direction = right
        I(0, VAR_E, 0x07, 0),                          // drop counter = 0
        I(0, VAR_F, 0x07, 0),                          // pbull inactive
        I(0, VAR_G, 0x07, 0),                          // ebull inactive
        I(0, VAR_I, 0x07, 0),                          // pair 0 BOTH
        I(0, VAR_J, 0x07, 0),                          // pair 1 BOTH
        I(0, VAR_K, 0x07, 0),                          // pair 2 BOTH
        I(0, VAR_L, 0x07, 0),                          // pair 3 BOTH
        I(0, VAR_M, 0x07, 0),                          // pair 4 BOTH
        I(0, VAR_N, 0x07, 0),                          // spawn counter
        I(0, VAR_O, 0x07, KILLS_TO_WIN),               // kills remaining
        I(0, VAR_P, 0x07, 0),                          // formation move tick counter
        I(0, VAR_Q, 0x07, 0),                          // game state: 0 = playing

        // ============================================== MAIN LOOP =======
        // First: if the game has ended (Q > 0), branch to the game-over
        // input loop. The bg tint set on lose/win persists across the
        // jump, so the player sees a red or green screen until they
        // press joystick up or down to restart.
        I(LBL_LOOP, VAR_Q, 0x15, 0),                   // if Q > 0
        I(0, 0,     0x01, LBL_GAMEOVER),               //   jump game-over
        I(0, 0,     0x55, 0),                          // endif

        I(0, SHIP_S, 0x25, 0),                         // ship speed = 0

        // ---- Ship input ----
        I(0, JOY, 0x19, 2),                            // if joy1 left
        I(0, SHIP_S, 0x23, 192),
        I(0, SHIP_S, 0x25, 80),
        I(0, 0,     0x55, 0),
        I(0, JOY, 0x19, 3),                            // if joy1 right
        I(0, SHIP_S, 0x23, 64),
        I(0, SHIP_S, 0x25, 80),
        I(0, 0,     0x55, 0),

        // ---- Ship x clamp ----
        I(0, VAR_A, 0x2C, SHIP_S),
        I(0, VAR_A, 0x15, SHIP_X_MAX),
        I(0, SHIP_S, 0x1F, SHIP_X_MAX),
        I(0, 0,     0x55, 0),
        I(0, VAR_A, 0x17, SHIP_X_MIN),
        I(0, SHIP_S, 0x1F, SHIP_X_MIN),
        I(0, 0,     0x55, 0),

        // ---- Fire player bullet (button) ----
        I(0, 0, 0x1A, 0),                              // if button 1 on
        I(0, VAR_F, 0x13, 0),                          //   if f = 0 (bullet ready)
        I(0, VAR_A, 0x2C, SHIP_S),                     //     a = ship x
        I(0, VAR_A, 0x0B, 5),                          //     a += 5 (center)
        I(0, PBULL_S, 0x1F, 0),                        //     pbull x will be set from a below
        I(0, PBULL_S, 0x20, VAR_A),                    //     pbull x = [a]
        I(0, PBULL_S, 0x21, SHIP_Y - 8),               //     pbull y = above ship
        I(0, PBULL_S, 0x23, 0),                        //     dir = up
        I(0, PBULL_S, 0x25, 120),                      //     speed = fast
        I(0, VAR_F, 0x07, 1),                          //     f = 1 (in flight)
        I(0, CH_ZAP, 0x40, SND_ZAP),                   //     play ZAP
        I(0, 0,     0x55, 0),                          //   endif
        I(0, 0,     0x55, 0),                          // endif

        // ---- Player bullet off-screen check ----
        I(0, VAR_F, 0x13, 1),                          // if f = 1
        I(0, VAR_H, 0x2D, PBULL_S),                    //   h = pbull y
        I(0, VAR_H, 0x17, 55),                         //   if h < 55 (off top)
        I(0, PBULL_S, 0x21, PBULL_HIDE),               //     hide bullet
        I(0, PBULL_S, 0x25, 0),
        I(0, VAR_F, 0x07, 0),                          //     f = 0
        I(0, 0,     0x55, 0),
        I(0, 0,     0x55, 0),

        // ---- Formation movement (throttled via VAR_P tick counter) ----
        // Update only every MOVE_EVERY iterations; otherwise the formation
        // rips across the screen because the loop ticks at ~40 Hz.
        I(0, VAR_P, 0x0B, 1),                          // p += 1
        I(0, VAR_P, 0x15, MOVE_EVERY - 1),             // if p > MOVE_EVERY-1
        I(0, VAR_P, 0x07, 0),                          //   p = 0

        I(0, VAR_E, 0x15, 0),                          //   if e > 0 (dropping)
        I(0, VAR_C, 0x0B, 1),                          //     c += 1
        I(0, VAR_E, 0x0D, 1),                          //     e -= 1
        I(0, 0,     0x55, 0),

        I(0, VAR_E, 0x13, 0),                          //   if e = 0 (marching)
        I(0, VAR_D, 0x13, 0),                          //     if d = 0 (right)
        I(0, VAR_B, 0x0B, 1),                          //       b += 1
        I(0, VAR_B, 0x15, FORMATION_MAX_X),            //       if b > MAX (hit right)
        I(0, VAR_E, 0x07, DROP_FRAMES),                //         e = DROP_FRAMES
        I(0, VAR_D, 0x07, 1),                          //         d = 1 (now left)
        I(0, 0,     0x55, 0),                          //       endif
        I(0, 0,     0x55, 0),                          //     endif
        I(0, VAR_D, 0x13, 1),                          //     if d = 1 (left)
        I(0, VAR_B, 0x15, 0),                          //       if b > 0
        I(0, VAR_B, 0x0D, 1),                          //         b -= 1
        I(0, 0,     0x55, 0),
        I(0, VAR_B, 0x13, 0),                          //       if b = 0 (hit left)
        I(0, VAR_E, 0x07, DROP_FRAMES),
        I(0, VAR_D, 0x07, 0),                          //         d = 0 (now right)
        I(0, 0,     0x55, 0),
        I(0, 0,     0x55, 0),                          //     endif
        I(0, 0,     0x55, 0),                          //   endif

        I(0, 0,     0x55, 0),                          // endif (move-throttle)

        // ---- Pair positioning (each pair, if alive) ----
        ...pairPos(P0, VAR_I, BX0),
        ...pairPos(P1, VAR_J, BX1),
        ...pairPos(P2, VAR_K, BX2),
        ...pairPos(P3, VAR_L, BX3),
        ...pairPos(P4, VAR_M, BX4),

        // ---- Hit detection (player bullet vs each pair) ----
        ...pairHit(P0, VAR_I),
        ...pairHit(P1, VAR_J),
        ...pairHit(P2, VAR_K),
        ...pairHit(P3, VAR_L),
        ...pairHit(P4, VAR_M),

        // ---- Enemy bullet spawn (from a random alive pair) ----
        // Pick a random pair index h ∈ 0..4. Each spawnFromPair block
        // is gated on `h == its index` AND `state < 3`, so exactly one
        // pair attempts to fire — and only if it's still alive. This
        // guarantees the bullet visually emerges from an actual living
        // alien half. If h lands on a dead pair, the player gets a
        // breather this round (subtle strategic reward for killing the
        // pair "above" your favorite position).
        I(0, VAR_N, 0x0B, 1),                          // spawn counter += 1
        I(0, VAR_N, 0x15, SPAWN_INTERVAL),             // if counter > interval
        I(0, VAR_N, 0x07, 0),                          //   reset counter
        I(0, VAR_G, 0x13, 0),                          //   if ebull inactive
        I(0, VAR_O, 0x15, 0),                          //     if any aliens alive
        I(0, VAR_H, 0x09, 4),                          //       h = rnd 0..4 (pick pair)
        ...spawnFromPair(P0, VAR_I, 0),
        ...spawnFromPair(P1, VAR_J, 1),
        ...spawnFromPair(P2, VAR_K, 2),
        ...spawnFromPair(P3, VAR_L, 3),
        ...spawnFromPair(P4, VAR_M, 4),
        I(0, 0,     0x55, 0),                          //     endif (aliens alive)
        I(0, 0,     0x55, 0),                          //   endif (ebull inactive)
        I(0, 0,     0x55, 0),                          // endif (timer)

        // ---- Enemy bullet off-screen check ----
        I(0, VAR_G, 0x13, 1),                          // if ebull active
        I(0, VAR_H, 0x2D, EBULL_S),                    //   h = ebull y
        I(0, VAR_H, 0x15, 245),                        //   if h > 245 (off bottom)
        I(0, EBULL_S, 0x21, EBULL_HIDE),
        I(0, EBULL_S, 0x25, 0),
        I(0, VAR_G, 0x07, 0),
        I(0, 0,     0x55, 0),
        I(0, 0,     0x55, 0),

        // ---- Game-over signaling ----
        // Each branch tints the background, freezes everything still in
        // motion (see freezeGame), and sets Q. We DON'T call `stop program`
        // — the next loop iteration's Q > 0 check redirects to
        // LBL_GAMEOVER for the "press up/down to restart" wait.

        // Enemy bullet hit ship = lose
        I(0, SHIP_S, 0x1B, EBULL_S),                   // if ship hit ebull
        I(0, SCN1,  0x33, 2),                          //   scene 1 bg = red
        ...freezeGame(),
        I(0, VAR_Q, 0x07, 1),                          //   Q = 1 (lost)
        I(0, 0,     0x55, 0),

        // Formation reaches the bottom = lose
        I(0, VAR_C, 0x15, 100),                        // if c > 100
        I(0, SCN1,  0x33, 2),                          //   scene 1 bg = red
        ...freezeGame(),
        I(0, VAR_Q, 0x07, 1),
        I(0, 0,     0x55, 0),

        // All aliens dead = win
        I(0, VAR_O, 0x13, 0),                          // if kills remaining = 0
        I(0, SCN1,  0x33, 5),                          //   scene 1 bg = green
        ...freezeGame(),
        I(0, VAR_Q, 0x07, 2),                          //   Q = 2 (won)
        I(0, 0,     0x55, 0),

        I(0, 0,     0x01, LBL_LOOP),                   // loop

        // ============================================== GAME-OVER ========
        // Reached from the Q>0 check at loop top. Joystick up or down
        // restarts (button + L/R reserved for gameplay — pressing them
        // here would be too easy to do by accident). On press: jump to
        // LBL_INIT which re-runs the whole setup. Otherwise, jump back
        // to the top of the main loop, which will re-test Q and bring
        // us right back here — a 60-Hz busy wait, but tight.
        I(LBL_GAMEOVER, JOY, 0x19, 0),                 // if joy1 up
        I(0, 0,     0x01, LBL_INIT),                   //   restart
        I(0, 0,     0x55, 0),
        I(0, JOY,   0x19, 1),                          // if joy1 down
        I(0, 0,     0x01, LBL_INIT),                   //   restart
        I(0, 0,     0x55, 0),
        I(0, 0,     0x01, LBL_LOOP),                   // loop back (busy wait)
    ];

    var aliensPrgBytes = serializeProgram({ instructions: aliensInstructions, mediaStore: aliensMediaStore, dataTables: {} });
}

// =============================================================================
// D64 — assemble the disk image with all files.
// =============================================================================

// GM disk-file naming convention: the base name is always exactly 6 chars
// (space-padded), then '/' + 3-char extension. Short names like "STARS"
// or "HERO" must be written padded — internal whitespace is significant
// to the runtime's name-based lookup. write() centralizes the padding
// so we can't quietly forget it.
const disk = D64.createEmpty('CLAUDE DEMO', 'CL');
function write(base, ext, data) {
    const fileName = base.padEnd(6, ' ').substring(0, 6) + '/' + ext;
    disk.writeFile(fileName, data, D64.FILE_TYPE_PRG);
}
write('HERO',   'SPR', heroSpriteData);
write('BALOON', 'SPR', balloonSpriteData);
write('SHIP',   'SPR', shipData);
write('PBULL',  'SPR', pbullData);
write('EBULL',  'SPR', ebullData);
write('PAIR',   'SPR', pairBothData);
write('LEFT',   'SPR', pairLeftData);
write('RIGHT',  'SPR', pairRightData);
write('MEADOW', 'PIC', sceneFileData);
write('STARS',  'PIC', starsFileData);
write('BLIP',   'SND', blipFileData);
write('CHIME',  'SND', chimeFileData);
write('ZAP',    'SND', zapFileData);
write('BOOM',   'SND', boomFileData);
write('BLOB',   'PRG', blobPrgBytes);
write('WANDER', 'PRG', wanderPrgBytes);
write('ALIENS', 'PRG', aliensPrgBytes);

const outPath = resolve(ROOT, 'demo-claude.d64');
writeFileSync(outPath, disk.data);
console.log(`wrote ${outPath}`);
console.log('  HERO/SPR    ', heroSpriteData.length, 'bytes');
console.log('  BALOON/SPR  ', balloonSpriteData.length, 'bytes');
console.log('  SHIP/SPR    ', shipData.length, 'bytes');
console.log('  PBULL/SPR   ', pbullData.length, 'bytes');
console.log('  EBULL/SPR   ', ebullData.length, 'bytes');
console.log('  PAIR/SPR    ', pairBothData.length, 'bytes');
console.log('  LEFT/SPR    ', pairLeftData.length, 'bytes');
console.log('  RIGHT/SPR   ', pairRightData.length, 'bytes');
console.log('  MEADOW/PIC  ', sceneFileData.length, 'bytes');
console.log('  STARS/PIC   ', starsFileData.length, 'bytes');
console.log('  BLIP/SND    ', blipFileData.length, 'bytes');
console.log('  CHIME/SND   ', chimeFileData.length, 'bytes');
console.log('  ZAP/SND     ', zapFileData.length, 'bytes');
console.log('  BOOM/SND    ', boomFileData.length, 'bytes');
console.log('  BLOB/PRG    ', blobPrgBytes.length, 'bytes');
console.log('  WANDER/PRG  ', wanderPrgBytes.length, 'bytes');
console.log('  ALIENS/PRG  ', aliensPrgBytes.length, 'bytes');
