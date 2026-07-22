// build-shooter.mjs — stage 3 integration demo ("archer"): scene + multiple
// sprites + joystick control + shooting + sprite animation. No collision/sound.
//
// Loads a GKGM .PIC background, positions a player ship (multicolor, VIC slot 0)
// you move 8-way with the joystick, 4 animated aliens (slots 2-5, cycling all 8
// frames), and a laser (slot 1) fired upward with the button.
//
// Joystick 1 ($DC01), active-low: bit0 up, 1 down, 2 left, 3 right, 4 fire.
// (GKGM uses joystick port 1.)
//
// Sprite data lives at $0C00 (below the $1000-$1FFF char-ROM shadow):
//   $0C00 ship (ptr 48), $0C40 laser (49), $0C80-$0E7F alien frames 0-7 (50-57).
//
// mode: live (reads $DC01) | attract (scripted right+fire for headless verify)
// Usage: node build-shooter.mjs <disk.d64> <SCENE/PIC> <out.prg> [live|attract]

import { readFileSync, writeFileSync } from 'fs';
import { assemble } from '../asm6502.mjs';

const B = '/Users/jfield/GMC64/code/js/';
for (const m of ['d64lib','c64lib','gmOpcodes','gmSprite','gmScene','gmSound','gmMusic','gmCharset','gmParser'])
  await import(B + m + '.js');
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

const [,, diskPath, picName, outPath, modeArg] = process.argv;
const mode = modeArg || 'live';
const disk = new globalThis.D64(new Uint8Array(readFileSync(diskPath)));

const scene = new globalThis.gmScene(disk.readFile(picName));
const bitmap = scene.rawImageData;
const screenByte = (((scene.color1 & 0xf) << 4) | (scene.color2 & 0xf));

const ship  = new globalThis.gmSprite(disk.readFile('SHIP  /SPR'));
const laser = new globalThis.gmSprite(disk.readFile('LASER /SPR'));
const alien = new globalThis.gmSprite(disk.readFile('ALIEN /SPR'));
// Pad each frame to exactly 64 bytes: GKGM's LAST/only frame is 63 bytes (no
// trailing pad), which would push every following sprite's data 1 byte out of
// its 64-byte alignment and cyclically shift it. See CLAUDE.md .SPR notes.
const pad64 = a => { const r = Array.from(a).slice(0, 64); while (r.length < 64) r.push(0); return r; };
const shipData  = pad64(ship.sprite[0].imageData[0]);
const laserData = pad64(laser.sprite[0].imageData[0]);
const nAlien = alien.sprite[0].totalFrames;                       // 8
const alienFrames = [];
for (let i = 0; i < nAlien; i++) alienFrames.push(...pad64(alien.sprite[0].imageData[i]));

const byteRows = arr => {
  const out = [];
  for (let i = 0; i < arr.length; i += 32) out.push('        !byte ' + Array.from(arr.slice(i, i + 32)).join(','));
  return out.join('\n');
};

const readInput = mode === 'attract'
  ? `        lda #$eb
        sta joy                 ; attract: hold left + fire (sweeps the aliens)`
  : `        lda $dc01
        sta joy                 ; joystick 1 (GKGM's port)`;

console.log(`shooter (${mode}) over "${scene.name}"  ${nAlien}-frame alien anim, joystick ${mode==='attract'?'scripted':'1'}`);

const asm = `; auto-generated shooter demo by build-shooter.mjs (${mode})
shipX  = $10
shipY  = $11
laserX = $12
laserY = $13
lactive = $14
joy    = $15
animtmr = $16
animidx = $17
coll   = $18
tmp    = $19
SHIPCOL = ${ship.sprite[0]._gmColor1}
SHIPC2  = ${ship.sprite[0]._gmColor2}
SHIPC3  = ${ship.sprite[0]._gmColor3}
LASCOL  = ${laser.sprite[0]._gmColor1}
ALICOL  = ${alien.sprite[0]._gmColor1}
ALIBASE = 50                     ; alien frame 0 sprite pointer ($0C80/64)

        * = $0801
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00
entry:
        sei
        lda #$00
        sta $d01a
        lda $dd00
        ora #$03
        sta $dd00
        lda #$3b
        sta $d011
        lda #$18
        sta $d016
        lda #$18
        sta $d018
        lda #${scene.bgColor}
        sta $d021
        lda #$00
        sta $d020
        lda #$${screenByte.toString(16).padStart(2,'0')}
        ldx #$00
sfill:  sta $0400,x
        sta $0500,x
        sta $0600,x
        sta $0700,x
        inx
        bne sfill
        lda #${scene.color3}
        ldx #$00
cfill:  sta $d800,x
        sta $d900,x
        sta $da00,x
        sta $db00,x
        inx
        bne cfill

        ; --- sprite pointers ---
        lda #48
        sta $07f8               ; slot 0 = ship ($0C00)
        lda #49
        sta $07f9               ; slot 1 = laser ($0C40)
        lda #ALIBASE
        sta $07fa               ; slots 2-5 = alien frame 0 ($0C80)
        sta $07fb
        sta $07fc
        sta $07fd

        ; --- sprite colors ---
        lda #SHIPCOL
        sta $d027
        lda #LASCOL
        sta $d028
        lda #ALICOL
        sta $d029
        sta $d02a
        sta $d02b
        sta $d02c
        lda #$01
        sta $d01c               ; only ship (slot 0) multicolor
        lda #SHIPC2
        sta $d025
        lda #SHIPC3
        sta $d026
        lda #$00
        sta $d010
        sta $d017
        sta $d01d

        ; --- alien positions (row across the top, clear of scene text) ---
        lda #90
        sta $d005
        sta $d007
        sta $d009
        sta $d00b
        lda #60
        sta $d004
        lda #110
        sta $d006
        lda #160
        sta $d008
        lda #210
        sta $d00a

        lda #170
        sta shipX
        lda #200
        sta shipY
        lda #$00
        sta lactive
        sta animtmr
        sta animidx

        lda #$3d
        sta $d015               ; enable ship + aliens

main:
wf:     lda $d012
        cmp #250
        bne wf

        ; --- hardware sprite collision ($d01e, cleared on read) ---
        lda $d01e
        sta coll
        lda lactive
        beq nocoll
        lda coll
        and #$02
        beq nocoll              ; laser (bit1) not in a collision
        lda coll
        and #$3c                ; alien bits (slots 2-5) it hit
        beq nocoll
        eor #$ff
        sta tmp
        lda $d015
        and tmp
        sta $d015               ; kill the hit alien(s)
        lda #$00
        sta lactive
        lda $d015
        and #$fd
        sta $d015               ; retire the laser
nocoll:
        lda $d015
        and #$3c
        bne havealiens
        lda $d015
        ora #$3c
        sta $d015               ; all cleared -> respawn the wave
havealiens:

        ; --- alien animation (advance frame every 8 ticks) ---
        inc animtmr
        lda animtmr
        cmp #8
        bcc noanim
        lda #$00
        sta animtmr
        lda animidx
        clc
        adc #1
        cmp #${nAlien}
        bcc animok
        lda #$00
animok: sta animidx
        clc
        adc #ALIBASE
        sta $07fa
        sta $07fb
        sta $07fc
        sta $07fd
noanim:

${readInput}

        ; --- movement (speed 3, active-low) ---
        lda joy
        and #$01
        bne notup
        lda shipY
        sec
        sbc #3
        cmp #55
        bcc notup
        sta shipY
notup:  lda joy
        and #$02
        bne notdn
        lda shipY
        clc
        adc #3
        cmp #211
        bcs notdn
        sta shipY
notdn:  lda joy
        and #$04
        bne notlf
        lda shipX
        sec
        sbc #3
        cmp #30
        bcc notlf
        sta shipX
notlf:  lda joy
        and #$08
        bne notrt
        lda shipX
        clc
        adc #3
        cmp #250
        bcs notrt
        sta shipX
notrt:
        ; --- fire ---
        lda joy
        and #$10
        bne nofire
        lda lactive
        bne nofire
        lda #$01
        sta lactive
        lda shipX
        sta laserX
        lda shipY
        sec
        sbc #10
        sta laserY
        lda $d015
        ora #$02
        sta $d015
nofire:
        ; --- laser flight ---
        lda lactive
        beq laserdone
        lda laserY
        sec
        sbc #5
        sta laserY
        cmp #52
        bcs laserfly
        lda #$00
        sta lactive
        lda $d015
        and #$fd
        sta $d015
        jmp laserdone
laserfly:
        lda laserX
        sta $d002
        lda laserY
        sta $d003
laserdone:
        lda shipX
        sta $d000
        lda shipY
        sta $d001
        jmp main

        * = $0c00
${byteRows(shipData)}
${byteRows(laserData)}
${byteRows(alienFrames)}

        * = $2000
${byteRows(bitmap)}
`;

writeFileSync(outPath.replace(/\.prg$/, '.asm'), asm);
const r = assemble(asm);
writeFileSync(outPath, Buffer.from(r.prg));
console.log(`  -> ${outPath}  (${r.bytes.length} bytes)`);
