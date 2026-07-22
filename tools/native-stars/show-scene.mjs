// show-scene.mjs — stage 1 of the native-compiler's scene support.
//
// Parses a GKGM .PIC via gmScene and emits a native 6502 program that displays
// it as a C64 multicolor bitmap — the "load a background PIC into VIC memory"
// runtime that ARCHER (and any scene-using program) needs. The scene is BUNDLED
// into the program (like a GKGM standalone), not loaded from disk at runtime.
//
// The .PIC's raw image bytes are already in C64 VIC bitmap order (8-byte cells,
// 40 cells/row, MSB-first 2bpp), so they embed straight at $2000 with no
// conversion. Pixel value 0-3 maps directly to bg / color1 / color2 / color3.
//
// Usage: node show-scene.mjs <disk.d64> <NAME/PIC> <out.prg>

import { readFileSync, writeFileSync } from 'fs';
import { assemble } from '../asm6502.mjs';

const B = '/Users/jfield/GMC64/code/js/';
for (const m of ['d64lib','c64lib','gmOpcodes','gmSprite','gmScene','gmSound','gmMusic','gmCharset','gmParser'])
  await import(B + m + '.js');
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

const [,, diskPath, picName, outPath] = process.argv;
const disk = new globalThis.D64(new Uint8Array(readFileSync(diskPath)));
const picBytes = disk.readFile(picName);
if (!picBytes) throw new Error(`no such file: ${picName}`);

const scene = new globalThis.gmScene(picBytes);
const bitmap = scene.rawImageData;            // 8000 bytes, VIC bitmap order
const c1 = scene.color1, c2 = scene.color2, c3 = scene.color3, bg = scene.bgColor;
const screenByte = ((c1 & 0x0f) << 4) | (c2 & 0x0f);   // 01=color1, 10=color2

console.log(`scene "${scene.name}"  colors: bg=${bg} c1=${c1} c2=${c2} c3=${c3}  (${bitmap.length} bitmap bytes)`);

// chunk the bitmap into readable !byte lines
const rows = [];
for (let i = 0; i < bitmap.length; i += 32)
  rows.push('        !byte ' + Array.from(bitmap.slice(i, i + 32)).join(','));

const asm = `; auto-generated from ${picName} by show-scene.mjs
BITMAP  = $2000

        * = $0801
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00
entry:
        sei
        lda #$00
        sta $d01a
        lda $dd00
        ora #$03
        sta $dd00               ; VIC bank 0
        lda #$3b
        sta $d011               ; bitmap mode
        lda #$18
        sta $d016               ; multicolor
        lda #$18
        sta $d018               ; screen $0400, bitmap $2000
        lda #${bg}
        sta $d021               ; background = scene bg (bit-pair 00)
        lda #$00
        sta $d020               ; black border
        lda #$${screenByte.toString(16).padStart(2,'0')}
        ldx #$00
sfill:  sta $0400,x             ; screen matrix: hi=color1 (01), lo=color2 (10)
        sta $0500,x
        sta $0600,x
        sta $0700,x
        inx
        bne sfill
        lda #${c3}
        ldx #$00
cfill:  sta $d800,x             ; color RAM = color3 (bit-pair 11)
        sta $d900,x
        sta $da00,x
        sta $db00,x
        inx
        bne cfill
loop:   jmp loop

        * = BITMAP              ; bitmap loads straight into VIC memory
${rows.join('\n')}
`;

writeFileSync(outPath.replace(/\.prg$/, '.asm'), asm);
const r = assemble(asm);
writeFileSync(outPath, Buffer.from(r.prg));
console.log(`  -> ${outPath}  (org=$${r.org.toString(16)} end=$${r.end.toString(16)}, ${r.bytes.length} bytes)`);
