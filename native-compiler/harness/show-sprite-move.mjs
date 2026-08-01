// show-sprite-move.mjs — stage 2b: a GKGM sprite moving by speed/direction.
//
// Adds the per-frame movement runtime: 8.8 fixed-point position (GKGM movement
// is fractional px/frame), a signed 16-bit velocity from GKGM's speed formula
// (X: speed/46, Y: speed/31.5 px/frame), frame-synced to the raster, bouncing
// off the screen edges so the demo stays on screen.
//
// Usage: node show-sprite-move.mjs <disk.d64> <SCENE/PIC> <SPRITE/SPR> <out.prg> [speed]

import { readFileSync, writeFileSync } from 'fs';
import { assemble } from '../asm6502.mjs';

const B = '../../js/';
for (const m of ['d64lib','c64lib','gmOpcodes','gmSprite','gmScene','gmSound','gmMusic','gmCharset','gmParser'])
  await import(B + m + '.js');
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

const [,, diskPath, picName, sprName, outPath, speedArg] = process.argv;
const disk = new globalThis.D64(new Uint8Array(readFileSync(diskPath)));

const scene = new globalThis.gmScene(disk.readFile(picName));
const bitmap = scene.rawImageData;
const screenByte = (((scene.color1 & 0xf) << 4) | (scene.color2 & 0xf));

const spr = new globalThis.gmSprite(disk.readFile(sprName));
const h = spr.sprite[0];
const frame = spr.sprite[0].imageData[0].slice(0, 63);
const mc = h.isMultiColor;

// GKGM movement: X speed/46, Y speed/31.5 px/frame -> 8.8 fixed velocity
const speed = speedArg ? +speedArg : 50;
const velX = Math.round((speed / 46) * 256);
const velY = Math.round((speed / 31.5) * 256);
const SPRPTR = 0x3F40 / 64;   // sprite data at $3F40

console.log(`"${scene.name}" + "${h.spriteName}" mc=${mc}  speed=${speed} -> vel ${(velX/256).toFixed(2)},${(velY/256).toFixed(2)} px/frame`);

const byteRows = arr => {
  const out = [];
  for (let i = 0; i < arr.length; i += 32) out.push('        !byte ' + Array.from(arr.slice(i, i + 32)).join(','));
  return out.join('\n');
};

const asm = `; auto-generated from ${picName} + ${sprName} by show-sprite-move.mjs
posXlo = $10
posXhi = $11
posYlo = $12
posYhi = $13
velXlo = $14
velXhi = $15
velYlo = $16
velYhi = $17

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
        ; --- sprite 0 setup ---
        lda #${SPRPTR}
        sta $07f8
        lda #${h._gmColor1}
        sta $d027
${mc ? `        lda #$01
        sta $d01c
        lda #${h._gmColor2}
        sta $d025
        lda #${h._gmColor3}
        sta $d026` : `        lda #$00
        sta $d01c`}
        lda #$00
        sta $d010               ; X stays < 256 (bounce range 24..250)
        lda #$01
        sta $d015
        ; --- init position + velocity (moving down-right) ---
        lda #60
        sta posXhi
        lda #70
        sta posYhi
        lda #$00
        sta posXlo
        sta posYlo
        lda #<${velX}
        sta velXlo
        lda #>${velX}
        sta velXhi
        lda #<${velY}
        sta velYlo
        lda #>${velY}
        sta velYhi

main:
wf:     lda $d012
        cmp #250
        bne wf                  ; frame sync
        ; posX += velX
        clc
        lda posXlo
        adc velXlo
        sta posXlo
        lda posXhi
        adc velXhi
        sta posXhi
        lda posXhi
        cmp #24
        bcs xhi
        lda #24
        sta posXhi
        jsr negX
        jmp xdone
xhi:    lda posXhi
        cmp #251
        bcc xdone
        lda #250
        sta posXhi
        jsr negX
xdone:
        ; posY += velY
        clc
        lda posYlo
        adc velYlo
        sta posYlo
        lda posYhi
        adc velYhi
        sta posYhi
        lda posYhi
        cmp #50
        bcs yhi
        lda #50
        sta posYhi
        jsr negY
        jmp ydone
yhi:    lda posYhi
        cmp #230
        bcc ydone
        lda #229
        sta posYhi
        jsr negY
ydone:
        lda posXhi
        sta $d000
        lda posYhi
        sta $d001
        jmp main

negX:   sec
        lda #$00
        sbc velXlo
        sta velXlo
        lda #$00
        sbc velXhi
        sta velXhi
        rts
negY:   sec
        lda #$00
        sbc velYlo
        sta velYlo
        lda #$00
        sbc velYhi
        sta velYhi
        rts

        * = $2000
${byteRows(bitmap)}
${byteRows(frame)}
`;

writeFileSync(outPath.replace(/\.prg$/, '.asm'), asm);
const r = assemble(asm);
writeFileSync(outPath, Buffer.from(r.prg));
console.log(`  -> ${outPath}  (${r.bytes.length} bytes)`);
