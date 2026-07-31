// selfext.mjs — wrap a compiled game .prg into a SELF-EXTRACTING .prg.
//
// Motivation: a .prg loads contiguously, and the KERNAL LOAD writes each byte
// with default banking, so a load that crosses $d000-$dfff corrupts itself on
// the I/O registers — capping a single-file load well below 64KB. Solution:
// ship the program COMPRESSED (small file, loads low & clear of $d000), then
// expand it in place at boot.
//
// Method — FORWARD in-place decompression (the Exomizer/ZX0 trick): compress a
// region with the same byte-LZ packer compile-game uses for scenes; stage the
// compressed stream HIGH, ending just above the region's top so it overlaps the
// top of the output. Decode forward: read ptr ascends from the bottom of C,
// write ptr ascends from the region start. dst only reaches C's staged region
// after producing ~all of the output, by which point src has read those bytes —
// so the read pointer stays ahead. (A backward decode from the top clobbers:
// dst outruns src on the first long match.) The safe `gap` is found by exact
// simulation (1 byte in practice).
//
// The I/O hole ($d000-$dfff): if the decompressed image extends past $d000, it
// is split into TWO segments — seg1 ($0801..<$d000) and seg2 ($e000..top) — each
// compressed and decoded as an INDEPENDENT stream. Separate streams mean no LZ
// match ever straddles the hole, so the decoder needs no per-byte hole test: it
// just runs twice, writing seg1 below the hole and seg2 above it, and never
// touches $d000-$dfff. KERNAL is banked out ($01=$35) so $e000+ reads/writes RAM.
//
// Boot layout ($0801 contiguous): BASIC stub -> relocator (set $01; copy decoder
// to $0400; copy each staged stream up) -> forward decoder at $0400 -> jmp $080d.
//
// Usage: node selfext.mjs <game.prg> <out.prg>

import { readFileSync, writeFileSync } from 'fs';
import { assemble } from '../asm6502.mjs';

const B = '/Users/jfield/GMC64/code/js/';
for (const m of ['d64lib']) await import(B + m + '.js');

const IO_LO = 0xd000, IO_HI = 0xe000;    // the $d000-$dfff I/O hole
const ORG = 0x0801, GAME = 0x080d, DEC = 0x0400;

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

// ---- exact forward in-place simulation for one segment ----
// data decoded to [dstStart..dstStart+len-1]; C staged ending at (top+gap).
function simulate(data, C, dstStart, gap) {
  const U = data.length, OUTTOP = dstStart + U - 1;
  const Ctop = OUTTOP + gap, Csrc0 = Ctop - (C.length - 1);
  const mem = new Uint8Array(65536);
  for (let k = 0; k < C.length; k++) mem[Csrc0 + k] = C[k];
  const readT = new Int32Array(65536).fill(-1);
  let src = Csrc0, dst = dstStart, t = 0, produced = 0, clob = false;
  const rd = () => { if (readT[src] < 0) readT[src] = t; return mem[src++]; };
  const wr = (v) => { if (dst >= Csrc0 && dst <= Ctop && readT[dst] < 0) clob = true; mem[dst++] = v; produced++; };
  while (produced < U) {
    t++; const tok = rd(); if (tok === 0) break;
    if (tok < 0x80) { for (let k = 0; k < tok; k++) wr(rd()); }
    else { let len, lf = tok & 0x3f; if (lf === 63) { len = 66; let e; do { e = rd(); len += e; } while (e === 255); } else len = lf + 3;
      let off; if (tok & 0x40) { const lo = rd(), hi = rd(); off = lo | (hi << 8); } else off = rd();
      for (let k = 0; k < len; k++) { const v = mem[dst - off]; wr(v); } }
  }
  let ok = produced === U; if (ok) for (let j = 0; j < U; j++) if (mem[dstStart + j] !== data[j]) { ok = false; break; }
  return { clob, ok, Csrc0, Ctop };
}
// Stage the compressed stream C so it ends at OUTTOP+gap. `floor` is the lowest address the
// staged stream may start at (Csrc0 >= floor). Below the segment's own start lies either the
// I/O hole (seg2) or the zero-page/stack (seg1); and Csrc0 must also stay above the loaded
// file's top (the compressed bytes live IN the file, and are copied UP to Csrc0 — the copy
// must not overlap its own source). A barely-compressible stream would otherwise stage low.
function packSeg(data, C, dstStart, floor, barrier) {
  for (let gap = 1; gap <= 16384; gap++) {
    const r = simulate(data, C, dstStart, gap);
    if (r.Ctop >= barrier) throw new Error(`segment ($${dstStart.toString(16)}, ${C.length}B packed) can't stage in [$${floor.toString(16)}..$${barrier.toString(16)})`);
    if (r.Csrc0 >= floor && !r.clob && r.ok) return { C, gap, dstStart, len: data.length, Csrc0: r.Csrc0, Ctop: r.Ctop };
  }
  throw new Error('no safe staging gap');
}

// ==================== build ====================
const inPath = process.argv[2], outPath = process.argv[3];
if (!inPath || !outPath) { console.error('usage: node selfext.mjs <game.prg> <out.prg>'); process.exit(1); }

const file = readFileSync(inPath);
const org = file[0] | (file[1] << 8);
if (org !== ORG) throw new Error(`expected game org $0801, got $${org.toString(16)}`);
const D = file.slice(2);
const OUTTOP = org + D.length - 1;

// split at the I/O hole if the image reaches past it
let segs;
// The loaded file is [loader][decoder][C1][C2...] at $0801; its top must sit below the lowest
// staged-stream start. LOADER_MAX bounds loader+decoder size (both are tiny & address-independent),
// so we can require each segment's Csrc0 above the file top before choosing gaps.
const LOADER_MAX = 700;
if (OUTTOP < IO_LO) {
  const C = lzEncode(D);
  const fileFloor = ORG + LOADER_MAX + C.length;
  segs = [packSeg(D, C, ORG, Math.max(ORG, fileFloor), IO_LO)];
} else {
  if (OUTTOP >= 0xfffa) throw new Error(`image top $${OUTTOP.toString(16)} leaves no room for vectors/staging`);
  let s1 = D.slice(0, IO_LO - ORG);                 // $0801..$cfff
  let e1 = s1.length; while (e1 > 0 && s1[e1 - 1] === 0) e1--;   // trim hole zero-pad for C1 headroom
  s1 = s1.slice(0, e1);
  const s2 = D.slice(IO_HI - ORG);                  // $e000..OUTTOP
  const C1 = lzEncode(s1), C2 = lzEncode(s2);
  // The relocator copies the streams UP in reverse file order (C2 before C1), so C1's staging
  // only has to clear its OWN file position (C2's file bytes are already saved). seg1 floor =
  // end of C1's file chunk; seg2 stages at $e000 (its file chunk is far below).
  const seg1Floor = ORG + LOADER_MAX + C1.length;
  segs = [packSeg(s1, C1, ORG, Math.max(ORG, seg1Floor), IO_LO),
          packSeg(s2, C2, IO_HI, IO_HI, 0xfffa)];   // seg2 stays >= $e000 (never into I/O)
}
const twoSeg = segs.length > 1;
const bankByte = twoSeg ? 0x35 : 0x36;             // $35 = BASIC+KERNAL out (RAM at $e000); $36 = BASIC out only

// ---- decoder, assembled for $0400 ----
// zp: rsrc/rdst = src/dst ptrs; len 16-bit; off 16-bit; mptr match-src; tok/tmp scratch.
// Top-level: init each segment's src/dst, jsr decode_seg (stops on its $00 token), then jmp game.
let decInit = '';
segs.forEach((s, i) => {
  decInit += `        lda #<$${s.Csrc0.toString(16)}\n        sta rsrc\n        lda #>$${s.Csrc0.toString(16)}\n        sta rsrc+1\n`;
  decInit += `        lda #<$${s.dstStart.toString(16)}\n        sta rdst\n        lda #>$${s.dstStart.toString(16)}\n        sta rdst+1\n`;
  decInit += `        jsr decode_seg\n`;
});
const decSrc = `
rsrc = $f0
rdst = $f2
len  = $f4
off  = $f6
mptr = $f8
tok  = $fa
tmp  = $fb
        * = $${DEC.toString(16)}
${decInit}        jmp $${GAME.toString(16)}
decode_seg:
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
        rts
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
const DECB = assemble(decSrc).bytes;
const DECLEN = DECB.length;
if (DEC + DECLEN > 0x0800) throw new Error(`decoder overruns $0800`);

// ---- relocator + BASIC stub at $0801 (two JS passes to place the trailing data) ----
// Trailing file bytes: [decoder][C1][C2...]. P_dec/P_c* are their load addresses.
function copyBlock(P, dst, len) {
  return `        lda #<$${P.toString(16)}\n        sta rsrc\n        lda #>$${P.toString(16)}\n        sta rsrc+1\n` +
         `        lda #<$${dst.toString(16)}\n        sta rdst\n        lda #>$${dst.toString(16)}\n        sta rdst+1\n` +
         `        lda #<$${len.toString(16)}\n        sta cnt\n        lda #>$${len.toString(16)}\n        sta cnt+1\n        jsr mcpy\n`;
}
function buildLoader(P_dec, P_cs) {
  let copies = copyBlock(P_dec, DEC, DECLEN);
  // Copy the compressed streams UP in REVERSE file order. A later stream's high staging area can
  // overlap an earlier stream's file position; copying the later one first saves it before the
  // earlier copy overwrites those file bytes. (Each stream's staging clears its own file chunk,
  // guaranteed by its floor.)
  for (let i = segs.length - 1; i >= 0; i--) copies += copyBlock(P_cs[i], segs[i].Csrc0, segs[i].C.length);
  return `
rsrc = $f0
rdst = $f2
cnt  = $f4
        * = $0801
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00   ; SYS 2061
        sei
        lda #$0b                ; blank the display (VIC DEN off) while decoding: the image is
        sta $d011               ; decoded across VIC-visible RAM ($0801+), so hide the churn.
        lda #$00                ; $01 is still $37 here (I/O mapped) so this reaches the VIC; the
        sta $d020               ; game's init re-enables ($d011=$3b). Border black = clean screen.
        lda #$${bankByte.toString(16)}   ; bank config for decode (RAM under BASIC${twoSeg ? '+KERNAL' : ''})
        sta $01
${copies}        jmp $${DEC.toString(16)}
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
let loaderBytes = assemble(buildLoader(0x1000, segs.map(() => 0x2000))).bytes;   // size probe
const P_dec = ORG + loaderBytes.length;
const P_cs = []; let p = P_dec + DECLEN;
for (const s of segs) { P_cs.push(p); p += s.C.length; }
loaderBytes = assemble(buildLoader(P_dec, P_cs)).bytes;                          // real
if (ORG + loaderBytes.length !== P_dec) throw new Error('loader size shifted between passes');

// ---- assemble the file image: [loader][decoder][C1][C2...] at $0801 ----
const chunks = [loaderBytes, DECB, ...segs.map(s => s.C)];
const payload = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
{ let o = 0; for (const c of chunks) { payload.set(c, o); o += c.length; } }
const prg = new Uint8Array(2 + payload.length);
prg[0] = ORG & 0xff; prg[1] = ORG >> 8; prg.set(payload, 2);

// sanity: each stream's high staging must clear its OWN file chunk (so the copy is disjoint);
// cross-stream overlap is handled by the reverse-order copy in buildLoader.
segs.forEach((s, i) => {
  const fileEnd = P_cs[i] + s.C.length - 1;
  if (s.Csrc0 <= fileEnd) throw new Error(`seg${i + 1} staging $${s.Csrc0.toString(16)} overlaps its own file chunk (ends $${fileEnd.toString(16)}) — segment too large to self-extract`);
});

writeFileSync(outPath, Buffer.from(prg));
const name = (outPath.split('/').pop().replace(/\.prg$/i, '').toUpperCase() + '      ').slice(0, 6).trim() || 'GAME';
const d64 = globalThis.D64.createEmpty(name, '01');
d64.writeFile(name, prg, globalThis.D64.FILE_TYPE_PRG);
writeFileSync(outPath.replace(/\.prg$/i, '.d64'), Buffer.from(d64.getData()));

console.log(`selfext ${inPath}:`);
console.log(`  image   $${org.toString(16)}..$${OUTTOP.toString(16)}  (${D.length} bytes)${twoSeg ? '  [spans I/O hole -> 2 segments]' : ''}`);
segs.forEach((s, i) => {
  console.log(`  seg${i + 1}   $${s.dstStart.toString(16)}..$${(s.dstStart + s.len - 1).toString(16)} (${s.len}B) -> packed ${s.C.length}B (${(s.len / s.C.length).toFixed(2)}x), staged $${s.Csrc0.toString(16)}..$${s.Ctop.toString(16)} gap ${s.gap}`);
});
console.log(`  decoder $${DEC.toString(16)}..$${(DEC + DECLEN - 1).toString(16)} (${DECLEN}B), bank $${bankByte.toString(16)}`);
console.log(`  -> ${outPath}  (${prg.length} bytes, ${(prg.length / file.length * 100).toFixed(1)}% of the ${file.length}-byte original)`);
