// show-sprite.mjs — stage 2a of the native-compiler's sprite support.
//
// Displays a GKGM scene (.PIC) plus one GKGM hardware sprite (.SPR) as a real
// C64 VIC-II sprite over the multicolor-bitmap background. Proves sprite-data
// extraction + VIC sprite register setup. Movement comes in 2b.
//
// GKGM .SPR frames ARE native C64 sprite data (24x21, 63 bytes, MSB-first), so
// imageData[frame][0..62] embeds directly. Color mapping:
//   gmColor1 (unique) -> $D027+slot   (pixel-pair 10)
//   gmColor2 (shared) -> $D025 (mc0)  (pixel-pair 01)
//   gmColor3 (shared) -> $D026 (mc1)  (pixel-pair 11)   [multicolor only]
//
// Usage: node show-sprite.mjs <disk.d64> <SCENE/PIC> <SPRITE/SPR> <out.prg> [vicX] [vicY]

import { readFileSync, writeFileSync } from 'fs';
import { assemble } from '../asm6502.mjs';

const B = '../../js/';
for (const m of ['d64lib','c64lib','gmOpcodes','gmSprite','gmScene','gmSound','gmMusic','gmCharset','gmParser'])
  await import(B + m + '.js');
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

const [,, diskPath, picName, sprName, outPath, vxArg, vyArg] = process.argv;
const disk = new globalThis.D64(new Uint8Array(readFileSync(diskPath)));

const scene = new globalThis.gmScene(disk.readFile(picName));
const bitmap = scene.rawImageData;
const screenByte = (((scene.color1 & 0xf) << 4) | (scene.color2 & 0xf));

const spr = new globalThis.gmSprite(disk.readFile(sprName));
const h = spr.sprite[0];
const frame = spr.sprite[0].imageData[0].slice(0, 63);   // native C64 sprite bytes
const mc = h.isMultiColor;
const vicX = vxArg ? +vxArg : 170;
const vicY = vyArg ? +vyArg : 120;

// bank 0 layout: screen $0400, bitmap $2000-$3F3F, sprite data $3F40 (ptr 253)
const SPRPTR = 0x3F40 / 64;   // = 253

console.log(`scene "${scene.name}" + sprite "${h.spriteName}" mc=${mc} colors c1=${h._gmColor1} c2=${h._gmColor2} c3=${h._gmColor3} at VIC(${vicX},${vicY})`);

const byteRows = (arr, base = '        !byte ') => {
  const out = [];
  for (let i = 0; i < arr.length; i += 32) out.push(base + Array.from(arr.slice(i, i + 32)).join(','));
  return out.join('\n');
};

const asm = `; auto-generated from ${picName} + ${sprName} by show-sprite.mjs
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
        ; --- fill screen matrix (bitmap color source) ---
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
        sta $07f8               ; sprite 0 data pointer -> $3F40
        lda #${vicX & 0xff}
        sta $d000               ; sprite 0 X low
        lda #${vicY & 0xff}
        sta $d001               ; sprite 0 Y
        lda #$${(vicX > 255 ? 1 : 0).toString(16)}
        sta $d010               ; sprite 0 X high bit
        lda #${h._gmColor1}
        sta $d027               ; sprite 0 unique color
${mc ? `        lda #$01
        sta $d01c               ; sprite 0 multicolor
        lda #${h._gmColor2}
        sta $d025               ; shared mc0
        lda #${h._gmColor3}
        sta $d026               ; shared mc1` : `        lda #$00
        sta $d01c               ; sprite 0 hi-res`}
        lda #$01
        sta $d015               ; enable sprite 0
loop:   jmp loop

        * = $2000
${byteRows(bitmap)}
${byteRows(frame)}
`;

writeFileSync(outPath.replace(/\.prg$/, '.asm'), asm);
const r = assemble(asm);
writeFileSync(outPath, Buffer.from(r.prg));
console.log(`  -> ${outPath}  (org=$${r.org.toString(16)} end=$${r.end.toString(16)}, ${r.bytes.length} bytes)`);
