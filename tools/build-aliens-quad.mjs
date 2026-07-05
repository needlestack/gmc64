// tools/build-aliens-quad.mjs
//
// Rebuild disks/aliens-quad.d64 — an extended variant of ALIENS/PRG with:
//   • 20 individually-tracked aliens (5 slots × 2×2 quad) per column
//   • Front-kills-first-per-column bullet logic
//   • Diving attacks: 50% chance when a slot reaches 1-alien state, the
//     last alien breaks formation and dive-bombs the player using GM's
//     built-in speed/direction primitives. If it misses (reaches bottom),
//     it reverses and rejoins formation at the top.
//   • Bonus saucer: when a slot's 4 aliens are all destroyed, its now-unused
//     hardware sprite becomes a big red saucer drifting across the top. Hit
//     it for +100 (Space-Invaders-mystery-ship style); it self-clears when
//     it drifts off the far edge.
//
// See ALIENS.md for the state model, variable map, and mutation strategy.
//
// Usage:
//     node tools/build-aliens-quad.mjs
//
// Reads original assets from disks/gmc64-demo.d64, produces a fresh
// disks/aliens-quad.d64 (overwriting).

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

await import(join(ROOT, 'js/d64lib.js'));
await import(join(ROOT, 'js/c64lib.js'));
await import(join(ROOT, 'js/gmOpcodes.js'));
await import(join(ROOT, 'js/gmSprite.js'));
await import(join(ROOT, 'js/gmScene.js'));
await import(join(ROOT, 'js/gmSound.js'));
await import(join(ROOT, 'js/gmMusic.js'));
await import(join(ROOT, 'js/gmParser.js'));

// ============================================================================
// SPRITE ART
// ============================================================================
// Multicolor palette (matches PAIR):
//   '.' = bg (transparent)   'a' = c2 (light green, body)
//   'B' = c1 (white, accent) 'c' = c3 (red, eyes)

const BACK_F0 = [
    '.B.B.',  '.B.B.',  'aaaaa',  'acaca',  'aaaaa',  '.aaa.',  'a.a.a',
];
const BACK_F1 = [
    '.B.B.',  '.B.B.',  'aaaaa',  'acaca',  'aaaaa',  '.aaa.',  '.a.a.',
];
const FRONT_F0 = [
    '.aaa.',  'aaaaa',  'cacac',  'aaaaa',  '.aca.',  'a.a.a',  '.B.B.',
];
const FRONT_F1 = [
    '.aaa.',  'aaaaa',  'cacac',  'aaaaa',  '.aca.',  '.a.a.',  'B.B.B',
];

// Canvas positions inside the 12×21 fat-pixel sprite:
//   BL/BR at (0,0)  and (7,0)  — back row (rows 0-6)
//   FL/FR at (0,13) and (7,13) — front row (rows 13-19)
const CELLS = {
    BL_F0: { x: 0, y: 0,  art: BACK_F0  },  BL_F1: { x: 0, y: 0,  art: BACK_F1  },
    BR_F0: { x: 7, y: 0,  art: BACK_F0  },  BR_F1: { x: 7, y: 0,  art: BACK_F1  },
    FL_F0: { x: 0, y: 13, art: FRONT_F0 },  FL_F1: { x: 0, y: 13, art: FRONT_F1 },
    FR_F0: { x: 7, y: 13, art: FRONT_F0 },  FR_F1: { x: 7, y: 13, art: FRONT_F1 },
};

// State→cells table. Sprite name maps state 0..7 to a specific variant.
const QUAD_STATES = [
    { state: 0, name: 'QUAD', backs: ['BL', 'BR'], fronts: ['FL', 'FR'] },
    { state: 1, name: 'Q1',   backs: ['BL', 'BR'], fronts: ['FL']       },
    { state: 2, name: 'Q2',   backs: ['BL'],       fronts: ['FL']       },
    { state: 3, name: 'Q3',   backs: ['BL', 'BR'], fronts: ['FR']       },
    { state: 4, name: 'Q4',   backs: ['BL', 'BR'], fronts: []           },
    { state: 5, name: 'Q5',   backs: ['BL'],       fronts: []           },
    { state: 6, name: 'Q6',   backs: ['BR'],       fronts: ['FR']       },
    { state: 7, name: 'Q7',   backs: ['BR'],       fronts: []           },
    // state 8 = cleared (or saucer)
];

// Saucer: fills upper portion of the canvas with red, distinct silhouette.
const SAUCER_F0 = [
    '.....cc.....',
    '....cccc....',
    '...cccccc...',
    '..cccccccc..',
    '.cccBccBccc.',
    'aaacccccccaa',
    'accccccccccc',
    'cccBcccBcccc',
    'ccccccccccca',
    'aaaaaaaaaaaa',
    '.cc.cc.cc.cc',
    '............',  '............',  '............',  '............',
    '............',  '............',  '............',  '............',
    '............',  '............',
];
const SAUCER_F1 = [
    '.....cc.....',
    '....cccc....',
    '...cccccc...',
    '..cccccccc..',
    '.cccBccBccc.',
    'aaacccccccaa',
    'accccccccccc',
    'cccBcccBcccc',
    'ccccccccccca',
    'aaaaaaaaaaaa',
    'cc.cc.cc.cc.',
    '............',  '............',  '............',  '............',
    '............',  '............',  '............',  '............',
    '............',  '............',
];

function buildFrame(cells) {
    const pixels = Array.from({ length: 21 }, () => new Array(12).fill(0));
    for (const { x, y, art } of cells) {
        for (let r = 0; r < art.length; r++) {
            const dr = y + r;
            if (dr < 0 || dr > 20) continue;
            for (let c = 0; c < art[r].length; c++) {
                const dc = x + c;
                if (dc < 0 || dc > 11) continue;
                const ch = art[r][c];
                const val = ch === 'a' ? 1 : ch === 'B' ? 2 : ch === 'c' ? 3 : 0;
                if (val) pixels[dr][dc] = val;
            }
        }
    }
    const bytes = new Uint8Array(64);
    for (let r = 0; r < 21; r++) {
        for (let bi = 0; bi < 3; bi++) {
            let b = 0;
            for (let p = 0; p < 4; p++) {
                b |= (pixels[r][bi * 4 + p] & 3) << (6 - p * 2);
            }
            bytes[r * 3 + bi] = b;
        }
    }
    return bytes;
}

function buildQuadSpr(name, backs, fronts) {
    const cells0 = [...backs.map(k => CELLS[k + '_F0']), ...fronts.map(k => CELLS[k + '_F0'])];
    const cells1 = [...backs.map(k => CELLS[k + '_F1']), ...fronts.map(k => CELLS[k + '_F1'])];
    const s = gmSprite.createBlank({
        name, isMultiColor: true, xDouble: true, yDouble: false, numFrames: 2,
        bgColor: 0, gmColor1: 1, gmColor2: 13, gmColor3: 2,
        xPosition: 86, yPosition: 100,
    });
    s.sprite[0].imageData[0] = buildFrame(cells0);
    s.sprite[0].imageData[1] = buildFrame(cells1);
    return s.serialize();
}

function buildSaucerSpr() {
    const s = gmSprite.createBlank({
        name: 'SAUCER', isMultiColor: true, xDouble: true, yDouble: false,
        numFrames: 2, bgColor: 0,
        gmColor1: 1,   // white
        gmColor2: 5,   // green
        gmColor3: 2,   // red — dominant
        xPosition: 20, yPosition: 25,
    });
    s.sprite[0].imageData[0] = buildFrame([{ x: 0, y: 0, art: SAUCER_F0 }]);
    s.sprite[0].imageData[1] = buildFrame([{ x: 0, y: 0, art: SAUCER_F1 }]);
    return s.serialize();
}

// ============================================================================
// STEP 1: Build sprites
// ============================================================================
const sprites = {};
for (const { state, name, backs, fronts } of QUAD_STATES) {
    sprites[name] = buildQuadSpr(name, backs, fronts);
    console.log(`  ${name.padEnd(6)}/SPR: ${sprites[name].length} bytes  (state ${state})`);
}
sprites.SAUCER = buildSaucerSpr();
console.log(`  SAUCER/SPR: ${sprites.SAUCER.length} bytes`);

// ============================================================================
// STEP 2: Fresh disk
// ============================================================================
const DEMO_PATH = join(ROOT, 'disks/gmc64-demo.d64');
const NEW_PATH  = join(ROOT, 'disks/aliens-quad.d64');
if (existsSync(NEW_PATH)) console.log(`(overwriting ${NEW_PATH})`);

const demoDisk = new D64(new Uint8Array(readFileSync(DEMO_PATH)));
const newDisk = D64.createEmpty('QUAD ALIENS', 'QA');

for (const name of [
    'SHIP  /SPR', 'PBULL /SPR', 'EBULL /SPR',
    'ZAP   /SND', 'BOOM  /SND',
    'STARS /PIC',
]) {
    const data = demoDisk.readFile(name);
    if (!data) throw new Error(`missing from demo: ${JSON.stringify(name)}`);
    newDisk.writeFile(name, data, D64.FILE_TYPE_PRG);
}
for (const { name } of QUAD_STATES) {
    const fname = name.padEnd(6, ' ').substring(0, 6) + '/SPR';
    newDisk.writeFile(fname, sprites[name], D64.FILE_TYPE_PRG);
}
newDisk.writeFile('SAUCER/SPR', sprites.SAUCER, D64.FILE_TYPE_PRG);

// ============================================================================
// STEP 3: Load ALIENS/PRG, register new sprites in mediaStore
// ============================================================================
globalThis.currentDisk = demoDisk;
globalThis.loadFileByName = (n) => demoDisk.readFile(n);
const originalPrg = demoDisk.readFile('ALIENS/PRG');
const pd = parseProgramData(originalPrg);
console.log(`\noriginal: ${pd.instructions.length} instructions, ${pd.mediaStore.filter(x=>x).length} media`);

function findMediaIdx(type, name) {
    const target = name.toUpperCase().trim();
    for (let i = 0; i < pd.mediaStore.length; i++) {
        const e = pd.mediaStore[i];
        if (!e) continue;
        if (e.type === type && (e.name || '').toUpperCase().trim() === target) return i;
    }
    return -1;
}
const idxPair = findMediaIdx('sprite', 'PAIR');
const idxBoom = findMediaIdx('sound', 'BOOM');

function pushSprite(name, bytes) {
    pd.mediaStore.push({
        name: name.padEnd(6, ' ').substring(0, 6),
        type: 'sprite',
        sprite: new gmSprite(bytes),
        spriteFileData: bytes,
        quadIndex: 0,
    });
    return pd.mediaStore.length - 1;
}
const stateSpriteIdx = {};
for (const { state, name } of QUAD_STATES) {
    stateSpriteIdx[state] = pushSprite(name, sprites[name]);
}
const idxSaucer = pushSprite('SAUCER', sprites.SAUCER);

// ============================================================================
// VARIABLE MAP
// ============================================================================
const V_A = 1;   // scratch
const V_H = 8;   // scratch
const V_F = 6;   // player-bullet-in-flight
const V_O = 15;  // kills-to-win
const V_W = 23;  // hit-column flag (scratch inside collision block)
const V_X = 24;  // global "saucer active" flag (0 = none in flight, 1 = one somewhere)

// SLOT ↔ hardware sprite ↔ state var ↔ mode var
//   slotIdx = arg for sprite N (0-based); sprite # in UI is slotIdx+1
//   varIdx  = state variable (i, j, k, l, m — vals 0..8)
//   modeIdx = mode variable  (r, s, t, u, v — 0=normal, 1=diving, 2=returning, 3=saucer)
//   offset  = formation X offset (bumped from 14/40/66/92/118 by +0/+2/+4/+6/+8)
const SLOTS = [
    { slotIdx: 3, varIdx: 9,  varLetter: 'i', modeIdx: 18, modeLetter: 'r', offset:  14 },
    { slotIdx: 4, varIdx: 10, varLetter: 'j', modeIdx: 19, modeLetter: 's', offset:  42 },
    { slotIdx: 5, varIdx: 11, varLetter: 'k', modeIdx: 20, modeLetter: 't', offset:  70 },
    { slotIdx: 6, varIdx: 12, varLetter: 'l', modeIdx: 21, modeLetter: 'u', offset:  98 },
    { slotIdx: 7, varIdx: 13, varLetter: 'm', modeIdx: 22, modeLetter: 'v', offset: 126 },
];
const SLOT_VARS = new Set(SLOTS.map(x => x.varIdx));
const ORIGINAL_OFFSET_BY_VAR = {  // for the AST walker's pattern match
    9: 14, 10: 40, 11: 66, 12: 92, 13: 118,
};

const LABEL_GAMEOVER = 4;   // new shared game-over label (l004)

// ============================================================================
// AST HELPERS
// ============================================================================
function instr(opcode, arg1, arg2, name = '', label = 0) {
    return { label, arg1, arg2, opcode, instructionName: name };
}

// Build the collision block for one slot. Three modes handled:
//   • SAUCER mode (mode==3): bonus +100, clear, mode→0
//   • Normal / dive / return (mode < 3): standard quad hit transitions;
//     on state→8 spawn saucer instead of clearing; on state 5/7 (last
//     alien alive), roll 50/50 to trigger a dive.
function buildQuadHitBlock({ slotIdx, varIdx, varLetter, modeIdx, modeLetter }) {
    const spriteNum = slotIdx + 1;
    const out = [];

    out.push(instr(0x1B, 1, slotIdx, `if sprite 2 hit sprite ${spriteNum} then`));

    // Scratch flag h=0 → "handled?" for exclusive-branch bookkeeping.
    out.push(instr(0x07, V_H, 0, 'set h = 000'));

    // SAUCER branch: bonus, clear, back to normal mode. Release the global
    // saucer-active flag so another cleared slot can spawn the next saucer.
    out.push(instr(0x13, modeIdx, 3, `if ${modeLetter} = 003 then`));
    out.push(instr(0x44, 10, 0, 'add 0100 to score1'));                    // +100
    out.push(instr(0x40, 1, idxBoom, 'sound channel 2 = boom'));
    out.push(instr(0x67, 0, slotIdx, `clear sprite ${spriteNum}`));
    out.push(instr(0x07, modeIdx, 0, `set ${modeLetter} = 000`));
    out.push(instr(0x07, V_X, 0, 'set x = 000'));                          // release global flag
    out.push(instr(0x07, V_H, 1, 'set h = 001'));                          // handled
    out.push(instr(0x07, V_F, 0, 'set f = 000'));
    out.push(instr(0x21, 1, 30, 'sprite 2 y position =030'));
    out.push(instr(0x25, 1, 0, 'sprite 2 movement speed=000'));
    out.push(instr(0x55, 0, 0, 'endif'));

    // Normal / dive / return branch: only if h is still 0 (not the saucer path)
    out.push(instr(0x13, V_H, 0, 'if h = 000 then'));

    // determine hit column into w
    out.push(instr(0x2C, V_H, 1, 'set h =sprite 2 x position'));
    out.push(instr(0x0B, V_H, 5, 'set h = h + 005'));
    out.push(instr(0x2C, V_A, slotIdx, `set a =sprite ${spriteNum} x position`));
    out.push(instr(0x0B, V_A, 12, 'set a = a + 012'));
    out.push(instr(0x07, V_W, 0, 'set w = 000'));
    out.push(instr(0x16, V_H, V_A, 'if h > [a] then'));
    out.push(instr(0x07, V_W, 1, 'set w = 001'));
    out.push(instr(0x55, 0, 0, 'endif'));

    // snapshot old state
    out.push(instr(0x08, V_A, varIdx, `set a = [${varLetter}]`));

    // LEFT transitions
    out.push(instr(0x13, V_W, 0, 'if w = 000 then'));
    for (const [from, to] of [[0,3],[1,4],[2,5],[3,6],[4,7],[5,8]]) {
        out.push(instr(0x13, V_A, from, `if a = ${String(from).padStart(3,'0')} then`));
        out.push(instr(0x07, varIdx, to, `set ${varLetter} = ${String(to).padStart(3,'0')}`));
        out.push(instr(0x55, 0, 0, 'endif'));
    }
    out.push(instr(0x55, 0, 0, 'endif'));

    // RIGHT transitions
    out.push(instr(0x13, V_W, 1, 'if w = 001 then'));
    for (const [from, to] of [[0,1],[1,2],[3,4],[4,5],[6,7],[7,8]]) {
        out.push(instr(0x13, V_A, from, `if a = ${String(from).padStart(3,'0')} then`));
        out.push(instr(0x07, varIdx, to, `set ${varLetter} = ${String(to).padStart(3,'0')}`));
        out.push(instr(0x55, 0, 0, 'endif'));
    }
    out.push(instr(0x55, 0, 0, 'endif'));

    // If state advanced (a < var), hit registered
    out.push(instr(0x18, V_A, varIdx, `if a < [${varLetter}] then`));
    for (let s = 1; s <= 7; s++) {
        out.push(instr(0x13, varIdx, s, `if ${varLetter} = ${String(s).padStart(3,'0')} then`));
        out.push(instr(0x27, slotIdx, stateSpriteIdx[s], `sprite ${spriteNum} is Q${s}`));
        out.push(instr(0x55, 0, 0, 'endif'));
    }
    // On state=8 (fully cleared): just clear the sprite. The saucer is now
    // a rare per-frame event (1/1000) triggered from the slot behavior block
    // instead of appearing on every clear.
    out.push(instr(0x15, varIdx, 7, `if ${varLetter} > 007 then`));
    out.push(instr(0x67, 0, slotIdx, `clear sprite ${spriteNum}`));
    out.push(instr(0x55, 0, 0, 'endif'));

    out.push(instr(0x40, 1, idxBoom, 'sound channel 2 = boom'));
    out.push(instr(0x44, 1, 0, 'add 0010 to score1'));
    out.push(instr(0x0D, V_O, 1, 'set o = o - 001'));

    // DIVE trigger: if new state is 5 or 7 (last alien alive) and mode is 0,
    // roll 50/50 to dispatch on a dive.
    out.push(instr(0x13, modeIdx, 0, `if ${modeLetter} = 000 then`));
    for (const st of [5, 7]) {
        out.push(instr(0x13, varIdx, st, `if ${varLetter} = ${String(st).padStart(3,'0')} then`));
        out.push(instr(0x09, V_H, 1, 'set h = rnd number 0 to 001'));
        out.push(instr(0x13, V_H, 0, 'if h = 000 then'));
        out.push(instr(0x07, modeIdx, 1, `set ${modeLetter} = 001`));
        out.push(instr(0x23, slotIdx, 128, `sprite ${spriteNum} dir =128  down`));
        out.push(instr(0x25, slotIdx, 40,  `sprite ${spriteNum} movement speed=040`));   // slower — erratic dir handled in behavior block
        out.push(instr(0x55, 0, 0, 'endif'));
        out.push(instr(0x55, 0, 0, 'endif'));
    }
    out.push(instr(0x55, 0, 0, 'endif'));

    out.push(instr(0x55, 0, 0, 'endif'));  // close: if a < [var]

    // Bullet always resets on collision in this branch.
    out.push(instr(0x07, V_F, 0, 'set f = 000'));
    out.push(instr(0x21, 1, 30, 'sprite 2 y position =030'));
    out.push(instr(0x25, 1, 0, 'sprite 2 movement speed=000'));

    out.push(instr(0x55, 0, 0, 'endif'));  // close: if h = 0

    out.push(instr(0x55, 0, 0, 'endif'));  // close: if sprite 2 hit sprite N
    return out;
}

// Slot behavior — runs every frame regardless of formation tick. Handles:
//   • Diving alien (mode 1): erratic direction update biased toward the
//     player, player-collision → game over, bottom check → flip to return
//   • Returning alien (mode 2): teleport X to slot's formation X on the
//     transition, then head straight up, stop at formation Y (dynamic)
//   • Formation alien with 1 alien left (state 5 or 7, mode 0): small
//     per-frame chance to re-dive
//   • Saucer (mode 3): check off-screen, clear
function buildSlotBehaviorBlock({ slotIdx, varIdx, varLetter, modeIdx, modeLetter, offset }) {
    const spriteNum = slotIdx + 1;
    const out = [];

    // -----------------------------------------------------------------
    // MODE 1: diving
    // -----------------------------------------------------------------
    out.push(instr(0x13, modeIdx, 1, `if ${modeLetter} = 001 then`));

    // Player collision (dive-bomb landed) → jump to shared game over
    out.push(instr(0x1B, 0, slotIdx, `if sprite 1 hit sprite ${spriteNum} then`));
    out.push(instr(0x01, 0, LABEL_GAMEOVER, `jump to label l${String(LABEL_GAMEOVER).padStart(3,'0')}`));
    out.push(instr(0x55, 0, 0, 'endif'));

    // Erratic direction — gated on p<2 so the roll happens 2 out of every
    // 3 frames (~40 Hz at 60fps). More erratic than the previous every-3rd
    // frame cadence but still gives the alien a moment to move in each
    // chosen direction. Roll a d6 (rnd 0..5):
    //   0..3 → aim at player (SW if player-left, SE if player-right)
    //   4    → force SW  (down-left, 160)
    //   5    → force SE  (down-right, 96)
    out.push(instr(0x17, 16, 2, 'if p < 002 then'));   // p is var 16
    out.push(instr(0x09, V_H, 5, 'set h = rnd number 0 to 005'));
    // Cases 0..3: aim at player
    out.push(instr(0x17, V_H, 4, 'if h < 004 then'));
    out.push(instr(0x2C, V_H, 0, 'set h =sprite 1 x position'));
    out.push(instr(0x2C, V_A, slotIdx, `set a =sprite ${spriteNum} x position`));
    out.push(instr(0x18, V_H, V_A, 'if h < [a] then'));                       // player left
    out.push(instr(0x23, slotIdx, 160, `sprite ${spriteNum} dir =160  SW`));
    out.push(instr(0x55, 0, 0, 'endif'));
    out.push(instr(0x16, V_H, V_A, 'if h > [a] then'));                       // player right
    out.push(instr(0x23, slotIdx, 96, `sprite ${spriteNum} dir =096  SE`));
    out.push(instr(0x55, 0, 0, 'endif'));
    out.push(instr(0x55, 0, 0, 'endif'));
    // Case 4: force SW
    out.push(instr(0x13, V_H, 4, 'if h = 004 then'));
    out.push(instr(0x23, slotIdx, 160, `sprite ${spriteNum} dir =160  SW`));
    out.push(instr(0x55, 0, 0, 'endif'));
    // Case 5: force SE
    out.push(instr(0x13, V_H, 5, 'if h = 005 then'));
    out.push(instr(0x23, slotIdx, 96, `sprite ${spriteNum} dir =096  SE`));
    out.push(instr(0x55, 0, 0, 'endif'));
    out.push(instr(0x55, 0, 0, 'endif'));   // close: if p = 0

    // Bottom check — flip to return. NO X teleport: the alien starts its
    // ascent from wherever it dove to. Return-mode logic aims direction
    // back toward the slot's formation X over the course of the flight.
    out.push(instr(0x2D, V_H, slotIdx, `set h =sprite ${spriteNum} y position`));
    out.push(instr(0x15, V_H, 240, 'if h > 240 then'));
    out.push(instr(0x07, modeIdx, 2, `set ${modeLetter} = 002`));
    out.push(instr(0x23, slotIdx, 0, `sprite ${spriteNum} dir =000  up`));
    out.push(instr(0x55, 0, 0, 'endif'));

    out.push(instr(0x55, 0, 0, 'endif'));  // close: mode = 1

    // -----------------------------------------------------------------
    // MODE 2: returning
    // -----------------------------------------------------------------
    // Aim direction toward slot X while heading up: NE if left of slot,
    // NW if right of slot, straight up if aligned. Then check formation
    // Y — when sprite Y drops below formation Y (c+70), alien has arrived.
    out.push(instr(0x13, modeIdx, 2, `if ${modeLetter} = 002 then`));

    // Direction toward slot X (b + slot_offset)
    out.push(instr(0x08, V_A, 2, 'set a = [b]'));
    out.push(instr(0x0B, V_A, offset, `set a = a + ${String(offset).padStart(3,'0')}`));
    out.push(instr(0x2C, V_H, slotIdx, `set h =sprite ${spriteNum} x position`));
    out.push(instr(0x23, slotIdx, 0, `sprite ${spriteNum} dir =000  up`));   // default up
    out.push(instr(0x18, V_H, V_A, 'if h < [a] then'));                       // alien left of slot
    out.push(instr(0x23, slotIdx, 32, `sprite ${spriteNum} dir =032  NE`));
    out.push(instr(0x55, 0, 0, 'endif'));
    out.push(instr(0x16, V_H, V_A, 'if h > [a] then'));                       // alien right of slot
    out.push(instr(0x23, slotIdx, 224, `sprite ${spriteNum} dir =224  NW`));
    out.push(instr(0x55, 0, 0, 'endif'));

    // Formation-Y check (dynamic — depends on current c)
    out.push(instr(0x2D, V_H, slotIdx, `set h =sprite ${spriteNum} y position`));
    out.push(instr(0x08, V_A, 3, 'set a = [c]'));
    out.push(instr(0x0B, V_A, 70, 'set a = a + 070'));
    out.push(instr(0x18, V_H, V_A, 'if h < [a] then'));
    out.push(instr(0x07, modeIdx, 0, `set ${modeLetter} = 000`));
    out.push(instr(0x25, slotIdx, 0, `sprite ${spriteNum} movement speed=000`));
    out.push(instr(0x55, 0, 0, 'endif'));

    out.push(instr(0x55, 0, 0, 'endif'));  // close: mode = 2

    // -----------------------------------------------------------------
    // MODE 0 (in formation)
    // -----------------------------------------------------------------
    out.push(instr(0x13, modeIdx, 0, `if ${modeLetter} = 000 then`));

    // (a) SAUCER SPAWN — per-slot roll gated by the GLOBAL saucer-active
    //     flag x. Each cleared slot rolls ~1/1000 per frame (via two
    //     nested rnd 0..30; 31² = 961), but only if x == 0 (no saucer
    //     currently in-flight). Effective global rate ~ N/1000 with N
    //     cleared slots; at 60fps that's ~15s per slot, or ~3s with all
    //     5 cleared. Feels progressive as you clear the formation.
    out.push(instr(0x13, varIdx, 8, `if ${varLetter} = 008 then`));
    out.push(instr(0x13, V_X, 0, 'if x = 000 then'));                          // no saucer active
    out.push(instr(0x09, V_H, 30, 'set h = rnd number 0 to 030'));
    out.push(instr(0x13, V_H, 0, 'if h = 000 then'));
    out.push(instr(0x09, V_H, 30, 'set h = rnd number 0 to 030'));
    out.push(instr(0x13, V_H, 0, 'if h = 000 then'));
    // Off-screen top first (defensive against residual position from clear)
    out.push(instr(0x21, slotIdx, 30, `sprite ${spriteNum} y position =030`));
    out.push(instr(0x27, slotIdx, idxSaucer, `sprite ${spriteNum} is saucer`));
    out.push(instr(0x1F, slotIdx, 0, `sprite ${spriteNum} x position =000`));    // off-screen left
    out.push(instr(0x21, slotIdx, 55, `sprite ${spriteNum} y position =055`));   // visible top
    out.push(instr(0x23, slotIdx, 64, `sprite ${spriteNum} dir =064  right`));
    out.push(instr(0x25, slotIdx, 30, `sprite ${spriteNum} movement speed=030`));
    out.push(instr(0x07, modeIdx, 3, `set ${modeLetter} = 003`));
    out.push(instr(0x07, V_X, 1, 'set x = 001'));                              // mark saucer active
    out.push(instr(0x55, 0, 0, 'endif'));   // close inner rnd
    out.push(instr(0x55, 0, 0, 'endif'));   // close outer rnd
    out.push(instr(0x55, 0, 0, 'endif'));   // close: x = 0
    out.push(instr(0x55, 0, 0, 'endif'));   // close: state = 8

    // (b) RE-DIVE — if only one alien alive (state 5 or 7), per-frame
    //     chance to send it back out. 1/~500 composed via two rnd 0..21
    //     rolls (22² = 484). At 60fps ~one re-dive per 8 seconds while a
    //     slot sits in this state.
    for (const st of [5, 7]) {
        out.push(instr(0x13, varIdx, st, `if ${varLetter} = ${String(st).padStart(3,'0')} then`));
        out.push(instr(0x09, V_H, 21, 'set h = rnd number 0 to 021'));
        out.push(instr(0x13, V_H, 0, 'if h = 000 then'));
        out.push(instr(0x09, V_H, 21, 'set h = rnd number 0 to 021'));
        out.push(instr(0x13, V_H, 0, 'if h = 000 then'));
        out.push(instr(0x07, modeIdx, 1, `set ${modeLetter} = 001`));
        out.push(instr(0x23, slotIdx, 128, `sprite ${spriteNum} dir =128  down`));
        out.push(instr(0x25, slotIdx, 40,  `sprite ${spriteNum} movement speed=040`));
        out.push(instr(0x55, 0, 0, 'endif'));    // close inner rnd
        out.push(instr(0x55, 0, 0, 'endif'));    // close outer rnd
        out.push(instr(0x55, 0, 0, 'endif'));    // close: state = st
    }
    out.push(instr(0x55, 0, 0, 'endif'));   // close: mode = 0

    // -----------------------------------------------------------------
    // MODE 3: saucer drift
    // -----------------------------------------------------------------
    // Clear when sprite is fully off-screen right. Playfield ends at
    // GM X=171; sprite is 24 fat pixels wide with xDouble; so left-edge
    // > 175 means it's completely past visible. Also release the global
    // saucer-active flag so another cleared slot can spawn the next one.
    out.push(instr(0x13, modeIdx, 3, `if ${modeLetter} = 003 then`));
    out.push(instr(0x2C, V_H, slotIdx, `set h =sprite ${spriteNum} x position`));
    out.push(instr(0x15, V_H, 175, 'if h > 175 then'));
    out.push(instr(0x67, 0, slotIdx, `clear sprite ${spriteNum}`));
    out.push(instr(0x07, modeIdx, 0, `set ${modeLetter} = 000`));
    out.push(instr(0x07, V_X, 0, 'set x = 000'));                              // release global flag
    out.push(instr(0x55, 0, 0, 'endif'));
    out.push(instr(0x55, 0, 0, 'endif'));

    return out;
}

// Shared game-over prep block. Sits at label l004 — reached only via explicit
// `jump to l004` from a dive-collision check. Runs the same visual freeze as
// the original game-over triggers, then falls through to l003.
function buildGameOverLabelBlock() {
    const out = [];
    // First instruction carries the l004 label.
    out.push(instr(0x33, 0, 2, 'scene 1 background=red', LABEL_GAMEOVER));
    out.push(instr(0x25, 0, 0, 'sprite 1 movement speed=000'));
    out.push(instr(0x25, 1, 0, 'sprite 2 movement speed=000'));
    out.push(instr(0x21, 1, 30, 'sprite 2 y position =030'));
    out.push(instr(0x25, 2, 0, 'sprite 3 movement speed=000'));
    out.push(instr(0x21, 2, 30, 'sprite 3 y position =030'));
    // Stop BOTH movement AND animation for alien slots — otherwise divers /
    // returning aliens / saucers keep flying (they use GM's built-in movement
    // via speed+direction which is independent of animation).
    for (let s = 3; s <= 7; s++) {
        out.push(instr(0x25, s, 0, `sprite ${s+1} movement speed=000`));
        out.push(instr(0x29, s, 0, `sprite ${s+1} animation spd =000`));
    }
    out.push(instr(0x07, 17, 1, 'set q = 001'));
    out.push(instr(0x01, 0, 3, 'jump to label l003'));
    return out;
}

// Position update block for one slot, wrapped in the mode gate.
//   if <slotvar> < 8 then
//     if <modevar> = 0 then
//       set a = [b]; set a = a + <offset>; sprite N x = [a]
//       set a = [c]; set a = a + 70;       sprite N y = [a]
//     endif
//   endif
function buildPositionUpdateBlock({ slotIdx, varIdx, varLetter, modeIdx, modeLetter, offset }) {
    const spriteNum = slotIdx + 1;
    return [
        instr(0x17, varIdx, 8, `if ${varLetter} < 008 then`),
        instr(0x13, modeIdx, 0, `if ${modeLetter} = 000 then`),
        instr(0x08, V_A, 2, 'set a = [b]'),
        instr(0x0B, V_A, offset, `set a = a + ${String(offset).padStart(3,'0')}`),
        instr(0x20, slotIdx, V_A, `sprite ${spriteNum} x position =[a]`),
        instr(0x08, V_A, 3, 'set a = [c]'),
        instr(0x0B, V_A, 70, 'set a = a + 070'),
        instr(0x22, slotIdx, V_A, `sprite ${spriteNum} y position =[a]`),
        instr(0x55, 0, 0, 'endif'),
        instr(0x55, 0, 0, 'endif'),
    ];
}

// ============================================================================
// STEP 4: Walk AST
// ============================================================================
// Two-pass approach doesn't work cleanly — inline detection is easier for
// a single walk. We look for pattern signatures and rewrite in-place.

const OP_IF_SET = new Set([0x13,0x14,0x15,0x16,0x17,0x18,0x19,0x1A,0x1B,0x4A,0x4B,0x4C]);
const oldInstrs = pd.instructions;
const newInstrs = [];

// Recognize the ORIGINAL position update start (unwidened):
//   [i] = if <slotvar> < 3      (opcode 0x17, arg1 in SLOT_VARS, arg2 = 3)
//   [i+1] = set a = [b]         (opcode 0x08, arg1 = 1, arg2 = 2)
// The 8-instruction block runs through the matching endif.
function isPositionUpdateStart(idx) {
    const a = oldInstrs[idx], b = oldInstrs[idx + 1];
    if (!a || !b) return false;
    return a.opcode === 0x17 && SLOT_VARS.has(a.arg1) && a.arg2 === 3
        && b.opcode === 0x08 && b.arg1 === 1 && b.arg2 === 2;
}

// Recognize the ORIGINAL enemy fire alive-gate:
//   [i] = if <slotvar> < 3      (opcode 0x17, arg1 in SLOT_VARS, arg2 = 3)
//   [i+1] = set a = sprite N x  (opcode 0x2C, arg1 = 1)
function isEnemyFireGate(idx) {
    const a = oldInstrs[idx], b = oldInstrs[idx + 1];
    if (!a || !b) return false;
    return a.opcode === 0x17 && SLOT_VARS.has(a.arg1) && a.arg2 === 3
        && b.opcode === 0x2C && b.arg1 === 1;
}

// Recognize the initial `set <slotvar> = 000` block — insert mode-init
// alongside. Only emit mode inits once per program (right after the FIRST
// slot-var init).
let modeInitEmitted = false;

// Detect the last `jump to l001` before the labeled instruction with label=3.
// We do a preliminary scan to find its index.
let lastJumpToL001BeforeL003 = -1;
{
    let seenL003 = false;
    for (let idx = oldInstrs.length - 1; idx >= 0; idx--) {
        const cur = oldInstrs[idx];
        if (cur.label === 3) seenL003 = true;
        if (seenL003 === false && cur.opcode === 0x01 && cur.arg2 === 1) {
            // this is a jump-to-l001 that appears after l003
        }
    }
    // Simpler forward scan: find the index of the labeled=3 instruction,
    // then find the immediately preceding `jump l001`.
    const l003Idx = oldInstrs.findIndex(x => x.label === 3);
    for (let idx = l003Idx - 1; idx >= 0; idx--) {
        if (oldInstrs[idx].opcode === 0x01 && oldInstrs[idx].arg2 === 1) {
            lastJumpToL001BeforeL003 = idx;
            break;
        }
    }
}
console.log(`  lastJumpToL001BeforeL003: ${lastJumpToL001BeforeL003}`);

let widenedGates = 0;
let positionUpdatesReplaced = 0;
let collisionBlocksReplaced = 0;
let inlineGameOversReplaced = 0;

let i = 0;
while (i < oldInstrs.length) {
    const cur = oldInstrs[i];

    // Sprite N is pair → sprite N is quad
    if (cur.opcode === 0x27 && cur.arg2 === idxPair && cur.arg1 >= 3 && cur.arg1 <= 7) {
        newInstrs.push({ ...cur, arg2: stateSpriteIdx[0], instructionName: `sprite ${cur.arg1+1} is quad` });
        i++;
        continue;
    }

    // set o = 010 → set o = 020 (kills-to-win)
    if (cur.opcode === 0x07 && cur.arg1 === V_O && cur.arg2 === 10) {
        newInstrs.push({ ...cur, arg2: 20, instructionName: 'set o = 020' });
        i++;
        continue;
    }

    // Formation march right-edge check: `if b > 028` → `if b > 020`.
    // The original allowed b=0..28 which fit slot 8 at old offset 118 within
    // the 12..171 playfield. Our +2 spacing puts slot 8 at offset 126, so
    // capping b at 020 keeps slot 8's rightmost extent at 146 (same as
    // original) — no more armada wandering off the right side.
    if (cur.opcode === 0x15 && cur.arg1 === 2 && cur.arg2 === 28) {
        newInstrs.push({ ...cur, arg2: 20, instructionName: 'if b > 020 then' });
        i++;
        continue;
    }

    // Initial `set i = 000` — emit mode inits right after this + the other
    // 4 slot-var inits, plus the global saucer-active flag x=0.
    if (!modeInitEmitted && cur.opcode === 0x07 && SLOT_VARS.has(cur.arg1) && cur.arg2 === 0) {
        newInstrs.push(cur);
        for (const s of SLOTS) {
            newInstrs.push(instr(0x07, s.modeIdx, 0, `set ${s.modeLetter} = 000`));
        }
        newInstrs.push(instr(0x07, V_X, 0, 'set x = 000'));   // saucer-active flag
        modeInitEmitted = true;
        i++;
        continue;
    }

    // Position update — replace whole 8-instruction block with 10-instruction
    // mode-gated version.
    if (isPositionUpdateStart(i)) {
        const slotVarIdx = cur.arg1;
        const slot = SLOTS.find(s => s.varIdx === slotVarIdx);
        // Walk through the block to find its endif.
        let depth = 1, j = i + 1;
        while (j < oldInstrs.length && depth > 0) {
            const op = oldInstrs[j].opcode;
            if (OP_IF_SET.has(op)) depth++;
            else if (op === 0x55) depth--;
            j++;
        }
        newInstrs.push(...buildPositionUpdateBlock(slot));
        positionUpdatesReplaced++;
        i = j;
        continue;
    }

    // Enemy fire alive-gate: widen `<3` → `<8`; add mode gating.
    if (isEnemyFireGate(i)) {
        const slotVarIdx = cur.arg1;
        const slot = SLOTS.find(s => s.varIdx === slotVarIdx);
        // Replace `if <slotvar> < 3` with `if <slotvar> < 8`, and wrap the
        // body in `if <modevar> = 0` so diving/saucer slots don't fire.
        newInstrs.push(instr(0x17, slot.varIdx, 8, `if ${slot.varLetter} < 008 then`));
        newInstrs.push(instr(0x13, slot.modeIdx, 0, `if ${slot.modeLetter} = 000 then`));
        widenedGates++;
        i++;   // consumed the widened if
        // Copy through the body until we reach the endif (depth 0).
        let depth = 1;
        while (i < oldInstrs.length && depth > 0) {
            const op = oldInstrs[i].opcode;
            if (op === 0x55 && depth === 1) {
                // This is the closing endif for the outer if — insert our extra endif
                // for the mode gate BEFORE the original endif.
                newInstrs.push(instr(0x55, 0, 0, 'endif'));
                newInstrs.push(oldInstrs[i]);
                i++;
                depth--;
                break;
            }
            if (OP_IF_SET.has(op)) depth++;
            else if (op === 0x55) depth--;
            newInstrs.push(oldInstrs[i]);
            i++;
        }
        continue;
    }

    // Full replacement of the 5 collision blocks + append the slot behavior
    // block right after.
    if (cur.opcode === 0x1B && cur.arg1 === 1 && cur.arg2 >= 3 && cur.arg2 <= 7) {
        const slotIdx = cur.arg2;
        const slot = SLOTS.find(s => s.slotIdx === slotIdx);
        let depth = 1, j = i + 1;
        while (j < oldInstrs.length && depth > 0) {
            const op = oldInstrs[j].opcode;
            if (OP_IF_SET.has(op)) depth++;
            else if (op === 0x55) depth--;
            j++;
        }
        newInstrs.push(...buildQuadHitBlock(slot));
        newInstrs.push(...buildSlotBehaviorBlock(slot));
        collisionBlocksReplaced++;
        i = j;
        continue;
    }

    // Replace the two existing inline game-over blocks with a jump to l004
    // so the shared freeze runs (and stops slot 4-8 movement, which the
    // original inline blocks did NOT — that's what let diving aliens keep
    // flying after game over).

    // "if sprite 1 hit sprite 3" — player hit by enemy bullet
    if (cur.opcode === 0x1B && cur.arg1 === 0 && cur.arg2 === 2) {
        let depth = 1, j = i + 1;
        while (j < oldInstrs.length && depth > 0) {
            const op = oldInstrs[j].opcode;
            if (OP_IF_SET.has(op)) depth++;
            else if (op === 0x55) depth--;
            j++;
        }
        newInstrs.push(cur);
        newInstrs.push(instr(0x01, 0, LABEL_GAMEOVER, `jump to label l${String(LABEL_GAMEOVER).padStart(3,'0')}`));
        newInstrs.push(instr(0x55, 0, 0, 'endif'));
        inlineGameOversReplaced++;
        i = j;
        continue;
    }
    // "if c > 100" — formation reached bottom
    if (cur.opcode === 0x15 && cur.arg1 === 3 && cur.arg2 === 100) {
        let depth = 1, j = i + 1;
        while (j < oldInstrs.length && depth > 0) {
            const op = oldInstrs[j].opcode;
            if (OP_IF_SET.has(op)) depth++;
            else if (op === 0x55) depth--;
            j++;
        }
        newInstrs.push(cur);
        newInstrs.push(instr(0x01, 0, LABEL_GAMEOVER, `jump to label l${String(LABEL_GAMEOVER).padStart(3,'0')}`));
        newInstrs.push(instr(0x55, 0, 0, 'endif'));
        inlineGameOversReplaced++;
        i = j;
        continue;
    }

    // Insert the game-over label block right after the last `jump to l001`
    // before l003.
    if (i === lastJumpToL001BeforeL003) {
        newInstrs.push(cur);
        newInstrs.push(...buildGameOverLabelBlock());
        i++;
        continue;
    }

    newInstrs.push(cur);
    i++;
}

console.log(`rewrite: ${oldInstrs.length} → ${newInstrs.length} (net ${newInstrs.length - oldInstrs.length})`);
console.log(`  position updates replaced:   ${positionUpdatesReplaced}`);
console.log(`  enemy-fire gates widened:    ${widenedGates}`);
console.log(`  collision blocks replaced:   ${collisionBlocksReplaced}`);
console.log(`  inline game-overs → jump l4: ${inlineGameOversReplaced}`);
console.log(`  labels present: ${newInstrs.filter(x => x.label > 0).map(x => 'l'+String(x.label).padStart(3,'0')).sort().join(', ')}`);

pd.instructions = newInstrs;

// ============================================================================
// STEP 5: Serialize + write
// ============================================================================
const newPrg = serializeProgram(pd);
console.log(`new PRG: ${newPrg.length} bytes`);
newDisk.writeFile('ALIENS/PRG', newPrg, D64.FILE_TYPE_PRG);
writeFileSync(NEW_PATH, Buffer.from(newDisk.getData()));
console.log(`saved: ${NEW_PATH}`);
console.log(`  free blocks after: ${newDisk.getFreeBlocks()}`);

// Round-trip verify
const rtDisk = new D64(new Uint8Array(readFileSync(NEW_PATH)));
globalThis.currentDisk = rtDisk;
globalThis.loadFileByName = (n) => rtDisk.readFile(n);
const rtPd = parseProgramData(rtDisk.readFile('ALIENS/PRG'));
console.log(`round-trip: ${rtPd.instructions.length} instructions, ${rtPd.mediaStore.filter(x=>x).length} media entries`);
