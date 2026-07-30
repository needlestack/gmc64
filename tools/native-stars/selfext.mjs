// selfext.mjs — wrap a compiled game .prg into a SELF-EXTRACTING .prg.
//
// Motivation: a .prg loads contiguously, and the KERNAL LOAD writes each byte
// with default banking, so a load that crosses $d000-$dfff corrupts itself on
// the I/O registers — capping a single-file load well below 64KB. Solution:
// ship the program COMPRESSED (small file, loads low & clear of $d000), then
// expand it in place at boot.
//
// Method — FORWARD in-place decompression (the textbook Exomizer/ZX0 trick):
//   * compress the whole image D ($0801..OUTTOP) with the same byte-LZ packer
//     compile-game uses for scenes.
//   * stage the compressed stream C HIGH, ending at OUTTOP+gap, so it overlaps
//     the TOP of the output region. Decode forward: read ptr src ascends from
//     the bottom of C, write ptr dst ascends from $0801. dst only reaches C's
//     region after producing ~all of D, by which point src has long since read
//     those bytes — so the read pointer always stays ahead. (A backward decode
//     from the top clobbers: dst outruns src on the first long match. Verified.)
//   * the required `gap` is found by exact simulation (usually 1 byte).
//
// Boot layout of the emitted file (loads contiguously at $0801):
//   $0801  BASIC stub (SYS 2061)
//   $080d  relocator: sei; $01=$36; copy decoder -> $0400; copy C -> Csrc0; jmp $0400
//   ...    decoder bytes (assembled for $0400)
//   ...    compressed C
// The decoder lives at $0400 (screen RAM, below the $0801 image, never written
// by dst) and ends with `jmp $080d` into the freshly-expanded game.
//
// Usage: node selfext.mjs <game.prg> <out.prg>

import { readFileSync, writeFileSync } from 'fs';
import { assemble } from '../asm6502.mjs';

const B = '/Users/jfield/GMC64/code/js/';
for (const m of ['d64lib']) await import(B + m + '.js');

// ---- the byte-LZ encoder (identical token format to compile-game's lzdec) ----
// token: $00 end; $01-$7f literal run of N bytes (bytes follow);
// $80-$ff match: bit6=offset size (0:1-byte 1..255, 1:2-byte LE), bits5-0=len
// field (len=field+3, or field==63 -> 66 + chained ext bytes, a 255 continues).
const lzEncode = (data) => {
  const n = data.length, head = new Int32Array(65536).fill(-1), prev = new Int32Array(n).fill(-1);
  const ml = new Int32Array(n), mo = new Int32Array(n);
  const h3 = p => ((data[p] << 8) ^ (data[p + 1] << 4) ^ data[p + 2]) & 0xffff;
  for (let i = 0; i < n; i++) { let bl = 0, bo = 0;
    if (i + 2 < n) { let j = head[h3(i)], ch = 0;
      while (j >= 0 && ch < 2048) { if (data[j + bl] === data[i + bl]) { let l = 0; while (l < 65535 && i + l < n && data[j + l] === data[i + l]) l++; if (l > bl) { bl = l; bo = i - j; } } j = prev[j]; ch++; }
      const hh = h3(i); prev[i] = head[hh]; head[hh] = i; }
    ml[i] = bl; mo[i] = bo; }
  const mcost = (l, o) => 1 + (o < 256 ? 1 : 2) + (l < 66 ? 0 : Math.floor((l - 66) / 255) + 1);
  const cost = new Float64Array(n + 1).fill(1e18), act = new Int32Array(n + 1); cost[n] = 0;
  for (let i = n - 1; i >= 0; i--) { let best = 1e18, ba = 0;
    for (let k = 1; k <= 127 && i + k <= n; k++) { const c = 1 + k + cost[i + k]; if (c < best) { best = c; ba = k; } }
    const mx = Math.min(ml[i], n - i);
    for (let l = 3; l <= mx; l++) { const c = mcost(l, mo[i]) + cost[i + l]; if (c < best) { best = c; ba = -l; } }
    cost[i] = best; act[i] = ba; }
  const out = []; let i = 0;
  while (i < n) { const a = act[i];
    if (a > 0) { out.push(a); for (let k = 0; k < a; k++) out.push(data[i + k]); i += a; }
    else { const l = -a, o = mo[i], os = o < 256 ? 0 : 1, lf = Math.min(l - 3, 63);
      out.push(0x80 | (os << 6) | lf);
      if (l - 3 >= 63) { let e = l - 66; while (e >= 255) { out.push(255); e -= 255; } out.push(e); }
      if (os === 0) out.push(o); else out.push(o & 0xff, (o >> 8) & 0xff);
      i += l; } }
  out.push(0);
  return Uint8Array.from(out);
};

// ---- exact forward in-place simulation: does gap G decode cleanly with no
//      write-before-read into the staged compressed region? returns {clob,ok} ----
function simulate(D, C, org, gap) {
  const U = D.length, OUTTOP = org + U - 1;
  const Ctop = OUTTOP + gap, Csrc0 = Ctop - (C.length - 1);
  const mem = new Uint8Array(65536);
  for (let k = 0; k < C.length; k++) mem[Csrc0 + k] = C[k];
  const readT = new Int32Array(65536).fill(-1);
  let src = Csrc0, dst = org, t = 0, produced = 0, clob = false;
  const rd = () => { if (readT[src] < 0) readT[src] = t; return mem[src++]; };
  const wr = (v) => { if (dst >= Csrc0 && dst <= Ctop && readT[dst] < 0) clob = true; mem[dst++] = v; produced++; };
  while (produced < U) {
    t++; const tok = rd(); if (tok === 0) break;
    if (tok < 0x80) { for (let k = 0; k < tok; k++) wr(rd()); }
    else { let len, lf = tok & 0x3f; if (lf === 63) { len = 66; let e; do { e = rd(); len += e; } while (e === 255); } else len = lf + 3;
      let off; if (tok & 0x40) { const lo = rd(), hi = rd(); off = lo | (hi << 8); } else off = rd();
      for (let k = 0; k < len; k++) { const v = mem[dst - off]; wr(v); } }
  }
  let ok = produced === U; if (ok) for (let j = 0; j < U; j++) if (mem[org + j] !== D[j]) { ok = false; break; }
  return { clob, ok, Csrc0, Ctop };
}
function findGap(D, C, org) {
  for (let g = 1; g <= 4096; g++) { const r = simulate(D, C, org, g); if (!r.clob && r.ok) return g; }
  throw new Error('no safe gap found <=4096 (unexpected)');
}

// ==================== build ====================
const inPath = process.argv[2], outPath = process.argv[3];
if (!inPath || !outPath) { console.error('usage: node selfext.mjs <game.prg> <out.prg>'); process.exit(1); }

const file = readFileSync(inPath);
const org = file[0] | (file[1] << 8);
const D = file.slice(2);                 // the raw image bytes ($0801..OUTTOP)
const U = D.length, OUTTOP = org + U - 1;
if (org !== 0x0801) throw new Error(`expected game org $0801, got $${org.toString(16)}`);

const C = lzEncode(D);
const gap = findGap(D, C, org);
const Ctop = OUTTOP + gap;
const Csrc0 = Ctop - (C.length - 1);
if (Ctop >= 0xd000) throw new Error(`compressed top $${Ctop.toString(16)} collides with I/O ($d000)`);

const DEC = 0x0400;                      // decoder runs from screen RAM (below the image)
const GAME = 0x080d;                     // game entry (SYS 2061 target)

// ---- decoder, assembled for $0400 ----
// zp: rsrc/rdst = src/dst ptrs; len 16-bit; off 16-bit; mptr match-src; tok/tmp scratch
const decSrc = `
rsrc = $f0
rdst = $f2
len  = $f4
off  = $f6
mptr = $f8
tok  = $fa
tmp  = $fb
        * = $${DEC.toString(16)}
        lda #<$${Csrc0.toString(16)}
        sta rsrc
        lda #>$${Csrc0.toString(16)}
        sta rsrc+1
        lda #<$${org.toString(16)}
        sta rdst
        lda #>$${org.toString(16)}
        sta rdst+1
d_next:
        jsr d_get
        cmp #0
        beq d_end
        bmi d_match
        tax                     ; literal run of A (1..127) bytes
d_lit:
        jsr d_get
        jsr d_put
        dex
        bne d_lit
        jmp d_next
d_end:
        jmp $${GAME.toString(16)}
d_match:
        sta tok
        and #$3f
        cmp #$3f
        beq d_extlen
        clc
        adc #3
        sta len
        lda #0
        sta len+1
        jmp d_off
d_extlen:
        lda #66
        sta len
        lda #0
        sta len+1
d_ext:
        jsr d_get
        sta tmp
        clc
        adc len
        sta len
        lda len+1
        adc #0
        sta len+1
        lda tmp
        cmp #255
        beq d_ext
d_off:
        lda tok
        and #$40
        beq d_off1
        jsr d_get
        sta off
        jsr d_get
        sta off+1
        jmp d_domatch
d_off1:
        jsr d_get
        sta off
        lda #0
        sta off+1
d_domatch:
        sec                     ; mptr = dst - off
        lda rdst
        sbc off
        sta mptr
        lda rdst+1
        sbc off+1
        sta mptr+1
d_mloop:
        ldy #0
        lda (mptr),y
        sta (rdst),y
        inc mptr
        bne d_m1
        inc mptr+1
d_m1:
        inc rdst
        bne d_m2
        inc rdst+1
d_m2:
        lda len                 ; len -= 1 (16-bit), loop until 0
        sec
        sbc #1
        sta len
        lda len+1
        sbc #0
        sta len+1
        lda len
        ora len+1
        bne d_mloop
        jmp d_next
d_get:
        ldy #0
        lda (rsrc),y
        inc rsrc
        bne d_g1
        inc rsrc+1
d_g1:
        rts
d_put:
        ldy #0
        sta (rdst),y
        inc rdst
        bne d_p1
        inc rdst+1
d_p1:
        rts
`;
const decR = assemble(decSrc);
const DECB = decR.bytes;
const DECLEN = DECB.length;
if (DEC + DECLEN > 0x0800) throw new Error(`decoder ($${DEC.toString(16)}..$${(DEC+DECLEN-1).toString(16)}) overruns $0800`);

// ---- relocator + BASIC stub, assembled at $0801 (two JS passes to place data) ----
// P_dec/P_c are the load addresses (== file positions) of the decoder bytes and
// compressed stream, which follow the loader in the file. Loader size is address-
// independent, so assemble once with placeholders to size it, then for real.
function buildLoader(P_dec, P_c) {
  return `
rsrc = $f0
rdst = $f2
cnt  = $f4
        * = $0801
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00   ; SYS 2061
        sei
        lda #$36                ; BASIC out so reads of $a000-$bfff hit RAM (staged C)
        sta $01
        lda #<$${P_dec.toString(16)}   ; copy decoder -> $0400
        sta rsrc
        lda #>$${P_dec.toString(16)}
        sta rsrc+1
        lda #<$${DEC.toString(16)}
        sta rdst
        lda #>$${DEC.toString(16)}
        sta rdst+1
        lda #<$${DECLEN.toString(16)}
        sta cnt
        lda #>$${DECLEN.toString(16)}
        sta cnt+1
        jsr mcpy
        lda #<$${P_c.toString(16)}     ; copy compressed C -> Csrc0
        sta rsrc
        lda #>$${P_c.toString(16)}
        sta rsrc+1
        lda #<$${Csrc0.toString(16)}
        sta rdst
        lda #>$${Csrc0.toString(16)}
        sta rdst+1
        lda #<$${C.length.toString(16)}
        sta cnt
        lda #>$${C.length.toString(16)}
        sta cnt+1
        jsr mcpy
        jmp $${DEC.toString(16)}
mcpy:                           ; copy cnt bytes (rsrc)->(rdst), ascending, non-overlapping
        lda cnt
        ora cnt+1
        beq mcpy_done
        ldy #0
        lda (rsrc),y
        sta (rdst),y
        inc rsrc
        bne mc1
        inc rsrc+1
mc1:
        inc rdst
        bne mc2
        inc rdst+1
mc2:
        lda cnt
        sec
        sbc #1
        sta cnt
        lda cnt+1
        sbc #0
        sta cnt+1
        jmp mcpy
mcpy_done:
        rts
`;
}
let loaderBytes = assemble(buildLoader(0x1000, 0x2000)).bytes;   // size probe
const P_dec = 0x0801 + loaderBytes.length;
const P_c = P_dec + DECLEN;
loaderBytes = assemble(buildLoader(P_dec, P_c)).bytes;           // real
if (0x0801 + loaderBytes.length !== P_dec) throw new Error('loader size shifted between passes');

// ---- assemble the file image: [loader][decoder][C], load address $0801 ----
const payload = new Uint8Array(loaderBytes.length + DECLEN + C.length);
payload.set(loaderBytes, 0);
payload.set(DECB, loaderBytes.length);
payload.set(C, loaderBytes.length + DECLEN);
const prg = new Uint8Array(2 + payload.length);
prg[0] = 0x01; prg[1] = 0x08;
prg.set(payload, 2);

// sanity: the loaded file must not reach up into the staged-C destination
const fileTop = 0x0801 + payload.length - 1;
if (fileTop >= Csrc0) throw new Error(`loaded file top $${fileTop.toString(16)} overlaps staged C dest $${Csrc0.toString(16)} — relocation would self-corrupt`);

writeFileSync(outPath, Buffer.from(prg));
const name = (outPath.split('/').pop().replace(/\.prg$/i, '').toUpperCase() + '      ').slice(0, 6).trim();
const d64 = globalThis.D64.createEmpty(name || 'GAME', '01');
d64.writeFile(name || 'GAME', prg, globalThis.D64.FILE_TYPE_PRG);
writeFileSync(outPath.replace(/\.prg$/i, '.d64'), Buffer.from(d64.getData()));

console.log(`selfext ${inPath}:`);
console.log(`  image   $${org.toString(16)}..$${OUTTOP.toString(16)}  (${U} bytes)`);
console.log(`  packed  ${C.length} bytes (${(U / C.length).toFixed(2)}x), staged $${Csrc0.toString(16)}..$${Ctop.toString(16)} (gap ${gap})`);
console.log(`  decoder $${DEC.toString(16)}..$${(DEC + DECLEN - 1).toString(16)} (${DECLEN} B)`);
console.log(`  -> ${outPath}  (${prg.length} bytes total, ${(prg.length / file.length * 100).toFixed(1)}% of the ${file.length}-byte original)`);
