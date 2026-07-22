// build-shooter.mjs — stage 3 integration demo ("archer"): scene + multiple
// sprites + joystick control + shooting. No collision/sound (yet).
//
// Puts the pieces together: loads a GKGM .PIC background, positions a player
// ship (multicolor sprite, VIC slot 0) you move 8-way with the joystick, 4
// static aliens (slots 2-5), and a laser (slot 1) fired upward with the button.
//
// Joystick 2 ($DC00), active-low: bit0 up, 1 down, 2 left, 3 right, 4 fire.
//
// mode:
//   live    — reads $DC00 (play it yourself)
//   attract — scripted input (right+fire held) so it's verifiable headless
//
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
const shipData  = Array.from(ship.sprite[0].imageData[0].slice(0, 64));
const laserData = Array.from(laser.sprite[0].imageData[0].slice(0, 64));
const alienData = Array.from(alien.sprite[0].imageData[0].slice(0, 64));

const byteRows = arr => {
  const out = [];
  for (let i = 0; i < arr.length; i += 32) out.push('        !byte ' + Array.from(arr.slice(i, i + 32)).join(','));
  return out.join('\n');
};

// input: live reads $DC00; attract feeds a constant "right + fire" value ($E7)
const readInput = mode === 'attract'
  ? `        lda #$e7
        sta joy                 ; attract: hold right + fire`
  : `        lda $dc00
        sta joy                 ; joystick 2`;

console.log(`shooter (${mode}) over "${scene.name}"  ship=mc laser/alien=hires`);

const asm = `; auto-generated shooter demo by build-shooter.mjs (${mode})
shipX  = $10
shipY  = $11
laserX = $12
laserY = $13
lactive = $14
joy    = $15
SHIPCOL = ${ship.sprite[0]._gmColor1}
SHIPC2  = ${ship.sprite[0]._gmColor2}
SHIPC3  = ${ship.sprite[0]._gmColor3}
LASCOL  = ${laser.sprite[0]._gmColor1}
ALICOL  = ${alien.sprite[0]._gmColor1}

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

        ; --- sprite pointers: ship=$3F40, laser=$3F80, alien=$3FC0 ---
        ; (data lives after the bitmap; $1000-$1FFF is the char-ROM shadow)
        lda #$fd
        sta $07f8               ; slot 0 = ship
        lda #$fe
        sta $07f9               ; slot 1 = laser
        lda #$ff
        sta $07fa               ; slots 2-5 = alien
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
        sta $d01c               ; only ship (slot 0) is multicolor
        lda #SHIPC2
        sta $d025               ; shared mc0
        lda #SHIPC3
        sta $d026               ; shared mc1
        lda #$00
        sta $d010               ; all X < 256
        sta $d017
        sta $d01d               ; no expansion

        ; --- alien positions (static, across the top) ---
        lda #70
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

        ; --- ship start + laser off ---
        lda #170
        sta shipX
        lda #200
        sta shipY
        lda #$00
        sta lactive

        lda #$3d
        sta $d015               ; enable ship (0) + aliens (2-5)

main:
wf:     lda $d012
        cmp #250
        bne wf

${readInput}

        ; --- movement (speed 3, active-low bits) ---
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
        ; --- fire (activate laser if idle) ---
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
        sta $d015               ; enable laser sprite
nofire:
        ; --- laser flight ---
        lda lactive
        beq laserdone
        lda laserY
        sec
        sbc #5
        sta laserY
        cmp #52
        bcs laserfly            ; still on screen
        lda #$00
        sta lactive
        lda $d015
        and #$fd
        sta $d015               ; retire laser
        jmp laserdone
laserfly:
        lda laserX
        sta $d002
        lda laserY
        sta $d003
laserdone:
        ; --- write ship position ---
        lda shipX
        sta $d000
        lda shipY
        sta $d001
        jmp main

        * = $2000
${byteRows(bitmap)}
        ; sprite data follows the 8000-byte bitmap at $3F40 / $3F80 / $3FC0
${byteRows(shipData)}
${byteRows(laserData)}
${byteRows(alienData)}
`;

writeFileSync(outPath.replace(/\.prg$/, '.asm'), asm);
const r = assemble(asm);
writeFileSync(outPath, Buffer.from(r.prg));
console.log(`  -> ${outPath}  (${r.bytes.length} bytes)`);
