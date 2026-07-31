// compile-game.mjs — GKGM program -> native C64 6502 (the real thing).
//
// Compiles a full GKGM game (ARCHER/CHOPER/PITFAL) to a standalone .prg: scene
// backgrounds, hardware sprites with GKGM 256-direction movement + animation,
// joystick/button, sprite-sprite + background collision, score, SID sound + music,
// text printing, and scene pixel plotting.
//
// TWO LAYOUT MODES (5th arg, default 'twobank'):
//   twobank — two resident VIC banks (scene 1 bitmap $6000, scene 2 $a000); scene
//             switch = instant $DD00 bank flip. Sprites: master frame library +
//             copy-into-slot. Adaptive layout: code+data $0801.., and for big games
//             (PITFAL) an auto code-splitter across the bank gaps + data relocated to
//             VIC-invisible RAM. Faithful to GKGM's persistent-scene semantics.
//   roomy   — single VIC bank; scenes RLE-compressed in the recovered space,
//             decompressed into $6000 on switch (~few-frame cost, not instant).
//             Sprites: whole frame library resident in-bank, pointer-swap (no copy).
//             Non-persistent scenes (fresh scene each flip) — for NEW GMC64+ games,
//             not old-game compatibility. Frees bank 2 + master for code + more scenes.
//
// Both modes bank BASIC ROM out at init (twobank) so $a000-$bfff is CPU-readable RAM.
// Usage: node compile-game.mjs <disk.d64> <NAME/PRG> <out.prg> [twobank|roomy]

import { readFileSync, writeFileSync } from 'fs';
import { assemble } from '../asm6502.mjs';

const B = '/Users/jfield/GMC64/code/js/';
for (const m of ['d64lib','c64lib','gmOpcodes','gmSprite','gmScene','gmSound','gmMusic','gmCharset','gmParser'])
  await import(B + m + '.js');
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

const [,, diskPath, prgName, outPath] = process.argv;
const disk = new globalThis.D64(new Uint8Array(readFileSync(diskPath)));
globalThis.loadFileByName = (name) => disk.readFile(name);
const pd = globalThis.parseProgramData(disk.readFile(prgName));
const ins = pd.instructions;
const MODE = process.argv[5] || 'twobank';
const roomy = MODE === 'roomy';
const usesPlot = ins.some(op => op.opcode === 0x4d || op.opcode === 0x4e || op.opcode === 0x4f || op.opcode === 0x50);

// bytecode execution throttle: ~ops per frame (approximates GKGM's interpreter rate).
// GKGM free-runs at ~50-65 ops/frame; native would run ~13x faster unthrottled, so we
// pace the compiled bytecode to this budget. Tunable now, per-game / GMC64+ later.
const OPS_PER_FRAME = 50;
// Execution model. DEFAULT = free-run native: the bytecode runs as fast as the 6502 allows;
// only the 60Hz housekeeping (sprite move, sound, music, pause, collision latch) is frame-locked
// to the raster. THROTTLE (6th CLI arg, ~ops/frame) re-imposes a GKGM-style op cap for testing
// games whose timing relies on interpreter speed (e.g. CHOPER's gas). 0 = free-run.
const THROTTLE = process.argv[6] ? parseInt(process.argv[6], 10) : 0;
const OPTICK_EVERY = 8;   // checkpoint at least every N ops (+ at every loop head) so the frame
                          // boundary is always caught and loops stay live
const THROTTLE_REFILL = THROTTLE ? Math.max(1, Math.round(THROTTLE / OPTICK_EVERY)) : 0;

// ---- bundle media ----
let scene = null;
const sceneMedia = {};   // mediaIndex -> gmScene (resolved to slots below)
const spriteMeta = {};   // mediaIndex -> {base, num, mc, c1, c2, c3}
const frameBytes = [];   // concatenated 64-byte frames
const soundMeta = {};    // mediaIndex -> {base, num, rep} into the SID frame tables
const sndFL = [], sndFH = [], sndPL = [], sndPH = [], sndCT = [], sndAD = [], sndSR = [], sndDU = [], sndSL = [], sndSH = [];
const songMeta = {};     // mediaIndex -> {ch:[{base,num,ctl,ad,sr,pulLo,pulHi} x3]}
const mFreqLo = [], mFreqHi = [], mDur = [], mFlag = [];   // note tables (all channels concatenated)
const WAVEBIT = { triangle: 0x10, sawtooth: 0x20, square: 0x40, noise: 0x80 };
const pad64 = a => { const r = Array.from(a).slice(0, 64); while (r.length < 64) r.push(0); return r; };
for (const [i, m] of pd.mediaStore.entries()) {
  if (!m) continue;
  if (m.type === 'scene') { sceneMedia[i] = m.scene; scene = m.scene; }
  else if (m.type === 'sprite' && m.sprite) {   // m.sprite===null are multi-quad markers -> skip
    const s = m.sprite, h = s.sprite[0], F = h.totalFrames, Q = s.sprite.length;
    // bundle every quad's frames back-to-back; each quad gets its own frame base.
    // quad 0 offset is (0,0); quads 1+ carry a relative offset from the parent.
    const quads = [];
    for (let q = 0; q < Q; q++) {
      const base = frameBytes.length / 64;
      for (let f = 0; f < F; f++) frameBytes.push(...pad64(s.sprite[q].imageData[f]));
      quads.push({ base, xoff: q === 0 ? 0 : s.sprite[q].xPosition, yoff: q === 0 ? 0 : s.sprite[q].yPosition });
    }
    spriteMeta[i] = { base: quads[0].base, num: F, quads, mc: h.isMultiColor ? 1 : 0, c1: h._gmColor1, c2: h._gmColor2, c3: h._gmColor3, xd: h.xDouble ? 1 : 0, yd: h.yDouble ? 1 : 0 };
  }
  else if (m.type === 'sound' && m.soundFileData) {
    const s = new globalThis.gmSound(m.soundFileData);
    const sm = s.speed > 0 ? 254 / s.speed : 254;        // global speed -> duration scale
    soundMeta[i] = { base: sndFL.length, num: s.frames.length, rep: s.repeatCount };
    for (const f of s.frames) {
      const sw = s._decodeSpeed(f.spd);                  // software pitch sweep
      const swd = sw.active ? sw.direction * sw.steps : 0; // ~per-frame freq-register delta
      sndFL.push(f.freqLo); sndFH.push(f.freqHi); sndPL.push(f.pulseLo); sndPH.push(f.pulseHi);
      sndCT.push((f.wave | 0x01) & 0xff); sndAD.push(((f.att << 4) | f.dec) & 0xff);
      sndSR.push(((f.sus << 4) | f.rel) & 0xff); sndDU.push(Math.max(1, Math.round(f.dur * sm)));
      sndSL.push(swd & 0xff); sndSH.push((swd >> 8) & 0xff);
    }
  }
}
if (sndFL.length === 0) { sndFL.push(0); sndFH.push(0); sndPL.push(0); sndPH.push(0); sndCT.push(0); sndAD.push(0); sndSR.push(0); sndDU.push(1); sndSL.push(0); sndSH.push(0); }

// bundle songs: GKGM instrument index -> SID (waveform+ADSR+pulse+transpose),
// notes -> per-channel (freq, duration in frames, rest/tie flags)
for (const [i, m] of pd.mediaStore.entries()) {
  if (!m || m.type !== 'song' || !m.songFileData) continue;
  const sg = new globalThis.gmMusic(m.songFileData);
  const bpm = sg.bpm, ch = [];
  for (let c = 0; c < 3; c++) {
    const inst = globalThis.gmMusic.INSTRUMENTS[sg.instruments[c]] || globalThis.gmMusic.INSTRUMENTS[0];
    const base = mFreqLo.length;
    for (const n of sg.channels[c]) {
      let freq = 0;
      if (!n.isRest) { const hz = 440 * Math.pow(2, (n.pitch + inst.transpose - 38) / 12); freq = Math.min(65535, Math.max(0, Math.round(hz / 0.06097))); }
      mFreqLo.push(freq & 0xff); mFreqHi.push((freq >> 8) & 0xff);
      mDur.push(Math.max(1, Math.min(255, Math.round(n.duration * 60 / bpm * 59.94))));
      mFlag.push((n.isRest ? 1 : 0) | (n.isTied ? 2 : 0));
    }
    ch.push({ base, num: sg.channels[c].length, ctl: WAVEBIT[inst.wave] || 0x10,
      ad: ((inst.att << 4) | inst.dec) & 0xff, sr: ((inst.sus << 4) | inst.rel) & 0xff,
      pulLo: inst.pulseWidth & 0xff, pulHi: (inst.pulseWidth >> 8) & 0x0f });
  }
  songMeta[i] = { ch };
}
if (mFreqLo.length === 0) { mFreqLo.push(0); mFreqHi.push(0); mDur.push(1); mFlag.push(1); }

// resolve scene SLOTS: "scene N is X" (0x28: arg1 = slot 0/1, arg2 = media index).
// slot 0 -> VIC bank 1 ($6000 bitmap), slot 1 -> VIC bank 2 ($A000 bitmap).
const sceneSlotMedia = {};
for (const op of ins) if (op.opcode === 0x28) sceneSlotMedia[op.arg1] = op.arg2;
// twobank uses slots 0/1 (VIC banks 1/2); roomy supports N slots (all decompressed on demand).
const maxSceneSlot = Object.keys(sceneSlotMedia).length ? Math.max(...Object.keys(sceneSlotMedia).map(Number)) : 1;
const sceneByBank = [];
for (let s = 0; s <= Math.max(1, maxSceneSlot); s++) sceneByBank[s] = sceneMedia[sceneSlotMedia[s]];
if (!sceneByBank[0]) sceneByBank[0] = scene;
const numScenes = sceneByBank.filter(Boolean).length;
scene = sceneByBank[0];                                  // primary scene (score pos, name, etc.)
const sbyte = sc => ((((sc.color1 & 0xf) << 4) | (sc.color2 & 0xf)) & 0xff);
const bitmap = scene.rawImageData;                        // bank1 bitmap ($6000)
const screenByte = sbyte(scene);
const bitmap2 = sceneByBank[1] ? sceneByBank[1].rawImageData : null;   // bank2 bitmap ($A000)
const screenByte2 = sceneByBank[1] ? sbyte(sceneByBank[1]) : 0;

// ---- roomy mode: RLE-compress each scene bitmap (decompress-on-switch) ----
// Byte-oriented variable-offset LZ packer for roomy scenes (optimal parse; fast byte-copy decode,
// no bit-stream). Byte tokens: 0x00 end (decoder actually stops at known outlen); 0x01-0x7f =
// literal run of that many bytes (bytes follow); 0x80-0xff = match — bit6 = offset size (0:1-byte
// 1..255, 1:2-byte LE), bits5-0 = len field: len = field+3, or if field==63 read 255-chained
// extension bytes added to 66. Then the offset; copy len bytes from (dest-offset). ~2.4-2.6x on
// dense scenes, 9-11x on flat, 30x on trivial — a hair below the bit-stream but ~3-5x faster decode.
let rmScenes = [], rles = [];
if (roomy) {
  const lzEncode = (data) => {
    const n = data.length, head = new Int32Array(65536).fill(-1), prev = new Int32Array(n).fill(-1);
    const ml = new Int32Array(n), mo = new Int32Array(n);
    const h3 = p => ((data[p] << 8) ^ (data[p + 1] << 4) ^ data[p + 2]) & 0xffff;
    for (let i = 0; i < n; i++) { let bl = 0, bo = 0;
      if (i + 2 < n) { let j = head[h3(i)], ch = 0;
        while (j >= 0 && ch < 2048) { if (data[j + bl] === data[i + bl]) { let l = 0; while (l < 65535 && i + l < n && data[j + l] === data[i + l]) l++; if (l > bl) { bl = l; bo = i - j; } } j = prev[j]; ch++; }
        const hh = h3(i); prev[i] = head[hh]; head[hh] = i; }
      ml[i] = bl; mo[i] = bo; }
    // optimal parse in BYTES. mcost = token(1) + offset(1|2) + length-extension bytes.
    const mcost = (l, o) => 1 + (o < 256 ? 1 : 2) + (l < 66 ? 0 : Math.floor((l - 66) / 255) + 1);
    const cost = new Float64Array(n + 1).fill(1e18), act = new Int32Array(n + 1); cost[n] = 0;  // act: +k literal run, -l match
    for (let i = n - 1; i >= 0; i--) { let best = 1e18, ba = 0;
      for (let k = 1; k <= 127 && i + k <= n; k++) { const c = 1 + k + cost[i + k]; if (c < best) { best = c; ba = k; } }   // literal run of k (token + k bytes)
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
    return out;
  };
  rmScenes = sceneByBank.map(sc => sc || sceneByBank[0]);   // one entry per slot (gaps -> scene 0)
  rles = rmScenes.map(sc => lzEncode(sc.rawImageData));
  const NFRAMES = frameBytes.length / 64;
  if (NFRAMES > 112) throw new Error(`roomy: ${NFRAMES} sprite frames exceed the 112 that fit in a bank`);
  const totC = rles.reduce((n, r) => n + r.length, 0);
  console.log(`  roomy: ${rmScenes.length} scenes, ` + rles.map((r, i) => `s${i} ${rmScenes[i].rawImageData.length}->${r.length}`).join(' ') + `B (tot ${totC}B); ${NFRAMES} frames resident`);
}

// score display position: GKGM "row (0-24) column (0-19)". Columns are 0-19 =
// 20 across a 160-mc-px screen => each column is 8 mc px = 16 hires px = 2 cells
// (double-wide, since the scene is multicolor). Byte offset = row*320 + col*16.
const sc46 = ins.find(op => op.opcode === 0x46);
const scoreRow = sc46 ? sc46.arg1 : 1;
const scoreCol = sc46 ? sc46.arg2 : 7;
const scoreOff = scoreRow * 320 + scoreCol * 16;

// ---- movement magnitude tables (8.8 fixed): speed/46 (X), speed/31.5 (Y) ----
// GKGM movement is full 256-direction, angle-based: velocity = cos/sin(dir) * speed, with
// C64-aspect divisors X/46, Y/31.5 (gmRuntime.updateSpritePositions). We fold the divisor +
// an 8x scale into signed per-direction component tables; runtime does component*speed>>3 =
// velocity in 8.8 fixed. Replaces the old 4-cardinal xmag/ymag path (this is why PITFAL's
// angled/arc jumps froze — non-cardinal directions produced zero movement).
const cosk = [], sink = [];
for (let d = 0; d < 256; d++) {
  const rad = ((d / 256) * 360 - 90) * Math.PI / 180;
  cosk.push(Math.round(Math.cos(rad) * (256 / 46) * 8) & 0xff);   // ~cos*44.5, signed byte
  sink.push(Math.round(Math.sin(rad) * (256 / 31.5) * 8) & 0xff); // ~sin*65.0, signed byte
}

// score color-expansion table: expandTab[(fg*4+bg)*16 + nibble] -> a bitmap byte
// where each of the nibble's 4 bits becomes a 2-bit mc pixel (fg if set, bg if clear)
const expandTab = [];
for (let fg = 0; fg < 4; fg++) for (let bg = 0; bg < 4; bg++) for (let n = 0; n < 16; n++) {
  let b = 0;
  for (let sb = 0; sb < 4; sb++) { const val = ((n >> sb) & 1) ? fg : bg; b |= val << (sb * 2); }
  expandTab.push(b);
}

// ---- PRINT subsystem tables ----
// GMC64 font: 64 glyphs x 8 bytes. gmCharset stores LSB=leftmost; our blitter is
// MSB=leftmost (like digfont), so bit-reverse each byte.
const bitrev = b => { let r = 0; for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i); return r; };
const printFont = [];
for (const hex of globalThis.gmCharset.CHAR_DATA)
  for (const b of hex.match(/../g).map(h => parseInt(h, 16))) printFont.push(bitrev(b));
// bitmap byte offset = row*320 + col*16  (row 0-24 char rows, col 0-19 = 2 cells each)
const prowLo = [], prowHi = [], pcolLo = [], pcolHi = [];
for (let r = 0; r < 25; r++) { const v = r * 320; prowLo.push(v & 0xff); prowHi.push((v >> 8) & 0xff); }
for (let c2 = 0; c2 < 20; c2++) { const v = c2 * 16; pcolLo.push(v & 0xff); pcolHi.push((v >> 8) & 0xff); }
// bundle each print string's GM indices into prnStr; tag the op with its base/len
const prnStr = [];
for (const op of ins) if (op.opcode === 0x3b && op.printBytes) {
  op._strBase = prnStr.length; op._strLen = op.printBytes.length; prnStr.push(...op.printBytes);
}
if (prnStr.length === 0) prnStr.push(0);

// data tables: 0x1d "data values" -> flat DATA array; a labeled 0x1d marks a table
// start, so 0x1c "data table at lN" can point at it. (arg1,arg2) = two bytes each.
const DATA = [];
const dataLabelOffset = {};   // GKGM label number -> byte offset in DATA
for (const op of ins) if (op.opcode === 0x1d) {
  if (op.label) dataLabelOffset[op.label] = DATA.length;
  DATA.push(op.arg1 & 0xff, op.arg2 & 0xff);
}
if (DATA.length === 0) DATA.push(0);

// ---- codegen ----
const L = [];
const c = s => L.push(s);
let uid = 0;
const ifStack = [];
const V = n => '$' + (0x40 + (n - 1)).toString(16);   // GKGM var n -> ZP
const slotAddr = (arr, gmSlot) => `${arr}+${gmSlot - 1}`; // GKGM sprite 1..8 -> vic slot 0..7

// score threshold parse from instructionName (e.g. "if score1 > 002000 then")
const numFrom = s => { const m = (s || '').match(/(\d{3,})/); return m ? parseInt(m[1], 10) : 0; };

const INV = { bne: 'beq', beq: 'bne', bcc: 'bcs', bcs: 'bcc' };
function fbr(cc, target) {           // far branch: take `cc` to target, any distance
  const s = `fb_${++uid}`;
  c(`  ${INV[cc]} ${s}`); c(`  jmp ${target}`); c(`${s}:`);
}
function emitIfHead(op) {
  // emits condition; branch to elseL when the condition is FALSE
  const n = ++uid, elseL = `else_${n}`, endL = `end_${n}`;
  ifStack.push({ elseL, endL, hasElse: false });
  const a1 = op.arg1, a2 = op.arg2;
  switch (op.opcode) {
    case 0x13: c(`  lda ${V(a1)}`); c(`  cmp #${a2}`); fbr('bne', elseL); break;         // if var = const
    case 0x15: c(`  lda ${V(a1)}`); c(`  cmp #${a2 + 1}`); fbr('bcc', elseL); break;      // if var > const
    case 0x17: c(`  lda ${V(a1)}`); c(`  cmp #${a2}`); fbr('bcs', elseL); break;          // if var < const
    case 0x19: {                                                                          // if joystick N is dir
      const port = a1 === 0 ? '$dc01' : '$dc00';   // GKGM joystick/button N is 0-based: js2->port2($dc00)
      if (a2 === 4) { c(`  lda ${port}`); c(`  and #$0f`); c(`  cmp #$0f`); fbr('bne', elseL); }
      else { c(`  lda ${port}`); c(`  and #${1 << a2}`); fbr('bne', elseL); }
      break;
    }
    case 0x1a: {                                                                          // if button N is on/off
      const port = a1 === 0 ? '$dc01' : '$dc00';   // GKGM joystick/button N is 0-based: js2->port2($dc00)
      c(`  lda ${port}`); c(`  and #$10`);
      if (a2 === 0 || /is on/.test(op.instructionName)) fbr('bne', elseL);   // "on" => bit clear
      else fbr('beq', elseL);
      break;
    }
    case 0x1b: {                                                                          // if sprite A hit <target>
      // Mirrors GKGM's own runtime (disassembled from the ALIENS standalone):
      // $d01e/$d01f are latched once/frame; A's bit must be set, and for a
      // specific sprite B, B's bit too, then a bounding-box test disambiguates.
      // GKGM widens the box for hardware-expanded sprites ($d01d x / $d017 y:
      // 12->24, 21->42) using the LEFT/UPPER sprite's expansion. arg2: 0-7 =
      // sprite B, 8 = "hit anyone", 9 = "hit background" (scene colors 2/3 =
      // the VIC's sprite-background collision).
      const A = a1, maskA = (1 << A) & 0xff;
      if (a2 === 8) { c(`  lda collFlags`); c(`  and #${maskA}`); fbr('beq', elseL); break; }  // hit anyone
      if (a2 === 9) { c(`  lda bgFlags`);   c(`  and #${maskA}`); fbr('beq', elseL); break; }  // hit background
      const Bx = a2, maskB = (1 << Bx) & 0xff;
      const both = (maskA | maskB) & 0xff;
      c(`  lda collFlags`); c(`  and #${both}`); c(`  cmp #${both}`); fbr('bne', elseL);  // both must be colliding
      // ALWAYS run the box (like GKGM) — never shortcut on "only these two bits".
      // collFlags lags the displayed sprites by a frame, so right after a hit
      // hides/moves a sprite the register still reports the collision for one
      // more frame; the box re-checks LIVE positions and rejects that stale hit.
      // (Shortcutting here double-counted every hit.)
      // X box: |A.x-B.x| vs 12 (24 if the left sprite is x-expanded)
      c(`  lda sPosXhi+${A}`); c(`  sec`); c(`  sbc sPosXhi+${Bx}`); c(`  bcs xge_${n}`);
      c(`  eor #$ff`); c(`  clc`); c(`  adc #1`); c(`  ldx #${maskA}`); c(`  jmp xhv_${n}`);  // A<B: left=A
      c(`xge_${n}:`); c(`  ldx #${maskB}`);                                                   // A>=B: left=B
      c(`xhv_${n}:`); c(`  sta tmp`); c(`  txa`); c(`  and $d01d`); c(`  beq xnr_${n}`);
      c(`  lda #24`); c(`  bne xcm_${n}`); c(`xnr_${n}:`); c(`  lda #12`);
      c(`xcm_${n}:`); c(`  sta sval`); c(`  lda tmp`); c(`  cmp sval`); fbr('bcs', elseL);
      // Y box: |A.y-B.y| vs 21 (42 if the upper sprite is y-expanded)
      c(`  lda sPosYhi+${A}`); c(`  sec`); c(`  sbc sPosYhi+${Bx}`); c(`  bcs yge_${n}`);
      c(`  eor #$ff`); c(`  clc`); c(`  adc #1`); c(`  ldx #${maskA}`); c(`  jmp yhv_${n}`);
      c(`yge_${n}:`); c(`  ldx #${maskB}`);
      c(`yhv_${n}:`); c(`  sta tmp`); c(`  txa`); c(`  and $d017`); c(`  beq ynr_${n}`);
      c(`  lda #42`); c(`  bne ycm_${n}`); c(`ynr_${n}:`); c(`  lda #21`);
      c(`ycm_${n}:`); c(`  sta sval`); c(`  lda tmp`); c(`  cmp sval`); fbr('bcs', elseL);
      break;
    }
    case 0x14: c(`  lda ${V(a1)}`); c(`  cmp ${V(a2)}`); fbr('bne', elseL); break;        // if var = var
    case 0x16: c(`  lda ${V(a2)}`); c(`  cmp ${V(a1)}`); fbr('bcs', elseL); break;        // if var > var (a1>a2 <=> a2<a1)
    case 0x18: c(`  lda ${V(a1)}`); c(`  cmp ${V(a2)}`); fbr('bcs', elseL); break;        // if var < var
    case 0x4a: {                                                                          // if score1 > N
      const N = numFrom(op.instructionName);
      c(`  lda scoreHi`); c(`  cmp #>${N + 1}`); fbr('bcc', elseL); c(`  bne sk_${n}`);
      c(`  lda scoreLo`); c(`  cmp #<${N + 1}`); fbr('bcc', elseL); c(`sk_${n}:`);
      break;
    }
    default: throw new Error(`if-head: unhandled opcode 0x${op.opcode.toString(16)}`);
  }
}

function emitOp(op) {
  const a1 = op.arg1, a2 = op.arg2;
  switch (op.opcode) {
    case 0x2b: break;                                                // comment: discarded
    case 0x28: {                                                     // scene N is X -> set up slot N's bank matrix
      if (roomy) break;   // scene N is X: roomy sets matrix/colors inside display_scene (one shared matrix)
      const slot = a1, sc = sceneByBank[slot];
      if (!sc) break;
      const mx = slot === 0 ? 0x4000 : 0x8000, h = a => '$' + a.toString(16), u = ++uid;
      c(`  lda #${sbyte(sc)}`); c(`  ldx #0`); c(`ssm_${u}:`);                     // fill screen matrix (colors 1/2)
      c(`  sta ${h(mx)},x`); c(`  sta ${h(mx + 0x100)},x`); c(`  sta ${h(mx + 0x200)},x`); c(`  sta ${h(mx + 0x300)},x`);
      c(`  inx`); c(`  bne ssm_${u}`);
      c(`  lda #${sc.color3}`); c(`  ldx #0`); c(`scr_${u}:`);                     // fill color RAM (color 3, shared)
      c(`  sta $d800,x`); c(`  sta $d900,x`); c(`  sta $da00,x`); c(`  sta $db00,x`);
      c(`  inx`); c(`  bne scr_${u}`);
      c(`  lda #${sc.bgColor}`); c(`  sta $d021`); c(`  sta $d020`);               // background/border
      break;
    }
    case 0x2e: c(`  lda #${a1}`); c(`  sta activeScene`); c(`  jsr display_scene`); break;                 // display scene N
    case 0x56:                                                       // display other scene
      if (roomy && rmScenes.length > 2) {                            // cycle: activeScene = (activeScene+1) mod N
        const u = ++uid;
        c(`  lda activeScene`); c(`  clc`); c(`  adc #1`); c(`  cmp #${rmScenes.length}`); c(`  bcc scyc_${u}`); c(`  lda #0`); c(`scyc_${u}:`); c(`  sta activeScene`); c(`  jsr display_scene`);
      } else {
        c(`  lda activeScene`); c(`  eor #1`); c(`  sta activeScene`); c(`  jsr display_scene`);
      }
      break;
    case 0x39: c(`  lda #${a1}`); c(`  sta printRow`); c(`  lda #${a2}`); c(`  sta printCol`); break;   // print at row/col
    case 0x3e: c(`  lda #${(a1 & 3) * 4 + (a2 & 3)}`); c(`  sta printColByte`); break;                  // print color fg on bg
    case 0x5c: c(`  lda #${a2}`); c(`  sta printTarget`); break;                                        // print on scene(s)
    case 0x5b: break;   // scoreN on scene(s): score currently renders to scene1 only (target TODO)
    case 0x3d: c(`  lda ${V(a2)}`); c(`  jsr print_value`); break;                                      // print value of [var]
    case 0x3c: c(`  lda ${V(a2)}`); c(`  jsr print_char`); c(`  inc printCol`); break;                  // print char of [var]
    case 0x3b: {                                                                                        // print literal string
      const b = op._strBase ?? 0, l = op._strLen ?? 0;
      c(`  lda #<prnStr+${b}`); c(`  sta pcl`); c(`  lda #>prnStr+${b}`); c(`  sta pch`);
      c(`  lda #${l}`); c(`  jsr print_string`); break;
    }
    case 0x60: {                                                     // song is <media>
      const meta = songMeta[a2];
      if (!meta) break;
      for (let k = 0; k < 3; k++) {
        const cm = meta.ch[k];
        c(`  lda #${cm.base}`); c(`  sta mBase+${k}`);
        c(`  lda #${cm.num}`); c(`  sta mNum+${k}`);
        c(`  lda #${cm.ctl}`); c(`  sta mCtl+${k}`);
        c(`  lda #${cm.ad}`); c(`  sta mAD+${k}`);
        c(`  lda #${cm.sr}`); c(`  sta mSR+${k}`);
        c(`  lda #${cm.pulLo}`); c(`  sta mPulLo+${k}`);
        c(`  lda #${cm.pulHi}`); c(`  sta mPulHi+${k}`);
        c(`  lda #$ff`); c(`  sta mPtr+${k}`);        // -1 so first tick loads note 0
        c(`  lda #1`); c(`  sta mTmr+${k}`); c(`  sta mAct+${k}`);
      }
      break;
    }
    case 0x40: {                                                      // sound channel(arg1) = sound(arg2)
      const v = a1, meta = soundMeta[a2];
      if (!meta) break;
      c(`  lda #${meta.base}`); c(`  sta vBase+${v}`);
      c(`  lda #${meta.num}`); c(`  sta vNum+${v}`);
      c(`  lda #${meta.rep}`); c(`  sta vRep+${v}`);
      c(`  lda #0`); c(`  sta vFrm+${v}`);
      c(`  lda #1`); c(`  sta vAct+${v}`);
      c(`  lda #${v}`); c(`  sta curv`);
      c(`  ldx #${meta.base}`); c(`  jsr loadframe`);
      break;
    }
    case 0x41: {                                                      // sound channel(arg2) off
      const v = a2;
      c(`  lda $d404+${v * 7}`); c(`  and #$fe`); c(`  sta $d404+${v * 7}`);
      c(`  lda #0`); c(`  sta vAct+${v}`);
      break;
    }
    case 0x07: c(`  lda #${a2}`); c(`  sta ${V(a1)}`); break;
    case 0x01: c(`  jmp LBL_${a2}`); break;
    case 0x27: {                                                       // sprite N is <media>
      const meta = spriteMeta[a2];
      if (!meta) break;   // multi-quad marker (e.g. "sprite 2 is -ctitl") -> already set up by the main
      const quads = meta.quads || [{ base: meta.base, xoff: 0, yoff: 0 }];
      for (let q = 0; q < quads.length; q++) {           // multi-quad -> occupy adjacent slots
        const sl = a1 + q, u = ++uid;
        // GKGM isNewSprite: only reset the frame + force a re-copy when assigning a
        // DIFFERENT sprite. Re-issuing the same sprite (games do this per-frame for
        // facing) must preserve the animation frame AND the position (incl. the 8.8
        // fractional accumulator) — else animation restarts and sub-pixel speeds never
        // accumulate ("can't move" + erratic anim).
        c(`  lda #${quads[q].base}`); c(`  cmp sBase+${sl}`); c(`  beq sk_${u}`);
        c(`  lda #0`); c(`  sta sFrame+${sl}`);
        if (!roomy) { c(`  lda #$ff`); c(`  sta sLoad+${sl}`); }
        c(`sk_${u}:`);
        c(`  lda #${quads[q].base}`); c(`  sta sBase+${sl}`);
        c(`  lda #${meta.num}`); c(`  sta sNum+${sl}`);
        if (q === 0) { c(`  lda #$ff`); c(`  sta sParent+${sl}`); }    // main = independent (position preserved)
        else { c(`  lda #${a1}`); c(`  sta sParent+${sl}`);           // sub-quad -> tracks parent
               c(`  lda #${quads[q].xoff}`); c(`  sta sQXoff+${sl}`);
               c(`  lda #${quads[q].yoff}`); c(`  sta sQYoff+${sl}`); }
        c(`  lda #${meta.c1}`); c(`  sta $d027+${sl}`);
        if (meta.mc) { c(`  lda $d01c`); c(`  ora #${1 << sl}`); c(`  sta $d01c`);
                       c(`  lda #${meta.c2}`); c(`  sta $d025`); c(`  lda #${meta.c3}`); c(`  sta $d026`); }
        else { c(`  lda $d01c`); c(`  and #${(~(1 << sl)) & 0xff}`); c(`  sta $d01c`); }
        // hardware sprite expansion (x/y double) — scales the sprite AND widens its collision box
        if (meta.xd) { c(`  lda $d01d`); c(`  ora #${1 << sl}`); c(`  sta $d01d`); }
        else { c(`  lda $d01d`); c(`  and #${(~(1 << sl)) & 0xff}`); c(`  sta $d01d`); }
        if (meta.yd) { c(`  lda $d017`); c(`  ora #${1 << sl}`); c(`  sta $d017`); }
        else { c(`  lda $d017`); c(`  and #${(~(1 << sl)) & 0xff}`); c(`  sta $d017`); }
        c(`  lda $d015`); c(`  ora #${1 << sl}`); c(`  sta $d015`);
      }
      break;
    }
    case 0x1f: c(`  lda #${a2}`); c(`  sta sPosXhi+${a1}`); c(`  lda #0`); c(`  sta sPosXlo+${a1}`); break;
    case 0x21: c(`  lda #${a2}`); c(`  sta sPosYhi+${a1}`); c(`  lda #0`); c(`  sta sPosYlo+${a1}`); break;
    case 0x20: c(`  lda ${V(a2)}`); c(`  sta sPosXhi+${a1}`); c(`  lda #0`); c(`  sta sPosXlo+${a1}`); break;
    case 0x22: c(`  lda ${V(a2)}`); c(`  sta sPosYhi+${a1}`); c(`  lda #0`); c(`  sta sPosYlo+${a1}`); break;
    case 0x2c: c(`  lda sPosXhi+${a2}`); c(`  sta ${V(a1)}`); break;   // set var = sprite x
    case 0x2d: c(`  lda sPosYhi+${a2}`); c(`  sta ${V(a1)}`); break;   // set var = sprite y
    case 0x25: c(`  lda #${a2}`); c(`  sta sSpeed+${a1}`); break;      // movement speed
    case 0x23: c(`  lda #${a2}`); c(`  sta sDir+${a1}`); break;        // direction
    case 0x29: c(`  lda #${a2}`); c(`  sta sAnimSpd+${a1}`);
               c(`  lda #0`); c(`  sta sAnimTmr+${a1}`); break;        // animation speed
    case 0x44: { const N = numFrom(op.instructionName);                   // add N to score
      c(`  clc`); c(`  lda scoreLo`); c(`  adc #<${N}`); c(`  sta scoreLo`);
      c(`  lda scoreHi`); c(`  adc #>${N}`); c(`  sta scoreHi`); c(`  jsr score_show`); break; }
    case 0x48: c(`  lda #0`); c(`  sta scoreLo`); c(`  sta scoreHi`); c(`  jsr score_show`); break;  // clear score
    case 0x46: {                                                          // score at row(arg1) column(arg2)
      const addr = 0x6000 + a1 * 320 + a2 * 16;
      c(`  lda #<${addr}`); c(`  sta scorePtrLo`); c(`  lda #>${addr}`); c(`  sta scorePtrHi`);
      break;
    }
    case 0x42: c(`  lda #${(a1 & 3) * 4 + (a2 & 3)}`); c(`  sta scoreColByte`); break;  // score color = fg(arg1) on bg(arg2)
    case 0x57: c(`  jsr pause_${++uid}`); pauseStubs.push(uid);           // pause for arg2/10 seconds
      pauseFrames.push(Math.max(1, Math.round(a2 / 10 * 59.94)));
      break;
    case 0x03: c(`  jsr LBL_${a2}`); break;                          // jump to subroutine at label
    case 0x05: c(`  rts`); break;                                    // return from subroutine
    case 0x06: c(`  jmp gmstop`); break;                             // stop program (halt)
    case 0x08: c(`  lda ${V(a2)}`); c(`  sta ${V(a1)}`); break;      // set var = var
    case 0x0b: c(`  clc`); c(`  lda ${V(a1)}`); c(`  adc #${a2}`); c(`  sta ${V(a1)}`); break;   // var += const
    case 0x0c: c(`  clc`); c(`  lda ${V(a1)}`); c(`  adc ${V(a2)}`); c(`  sta ${V(a1)}`); break; // var += var
    case 0x0d: c(`  sec`); c(`  lda ${V(a1)}`); c(`  sbc #${a2}`); c(`  sta ${V(a1)}`); break;   // var -= const
    case 0x0e: c(`  sec`); c(`  lda ${V(a1)}`); c(`  sbc ${V(a2)}`); c(`  sta ${V(a1)}`); break; // var -= var
    case 0x11: {                                                     // var /= const (power of 2)
      let sh = 0, t = a2; while (t > 1) { if (t & 1) throw new Error(`0x11 divide by non-power-of-2: ${a2}`); t >>= 1; sh++; }
      c(`  lda ${V(a1)}`); for (let k = 0; k < sh; k++) c(`  lsr`); c(`  sta ${V(a1)}`); break;
    }
    case 0x24: c(`  lda ${V(a2)}`); c(`  sta sDir+${a1}`); break;    // sprite dir = var
    case 0x26: c(`  lda ${V(a2)}`); c(`  sta sSpeed+${a1}`); break;  // sprite movement speed = var
    case 0x2f: c(`  lda #${a2}`); c(`  sta $d027+${a1}`); break;     // sprite color1 = const
    case 0x33: c(`  lda #${a2}`); c(`  sta $d021`); c(`  sta $d020`); break;    // scene background = const
    case 0x34: c(`  lda ${V(a2)}`); c(`  sta $d021`); c(`  sta $d020`); break;  // scene background = var
    case 0x0f: {                                                                // var *= const (power of 2)
      let sh = 0, t = a2; while (t > 1) { if (t & 1) throw new Error(`0x0f mul by non-power-of-2: ${a2}`); t >>= 1; sh++; }
      c(`  lda ${V(a1)}`); for (let k = 0; k < sh; k++) c(`  asl`); c(`  sta ${V(a1)}`); break;
    }
    case 0x67: c(`  lda $d015`); c(`  and #${(~(1 << a2)) & 0xff}`); c(`  sta $d015`);   // clear sprite (disable + unassign)
               c(`  lda #$ff`); c(`  sta sBase+${a2}`); break;
    case 0x66: break;   // screen update on/off: no-op for now (pairs with plotting, next pass)
    case 0x3a: {                                                                // print at row[var] col[var] (clamp 0-24/0-19)
      const u = ++uid;
      c(`  lda ${V(a1)}`); c(`  cmp #25`); c(`  bcc pr_${u}`); c(`  lda #24`); c(`pr_${u}:`); c(`  sta printRow`);
      c(`  lda ${V(a2)}`); c(`  cmp #20`); c(`  bcc pcc_${u}`); c(`  lda #19`); c(`pcc_${u}:`); c(`  sta printCol`);
      break;
    }
    case 0x37: {                                                                // scene 1 colorN = const (a1: 0=col1,1=col2,2=col3)
      const sc = sceneByBank[0]; if (!sc) break;
      const u = ++uid;
      if (a1 === 2) {                                                           // color3 -> color RAM
        c(`  lda #${a2}`); c(`  ldx #0`); c(`c37_${u}:`);
        c(`  sta $d800,x`); c(`  sta $d900,x`); c(`  sta $da00,x`); c(`  sta $db00,x`);
        c(`  inx`); c(`  bne c37_${u}`);
      } else {                                                                  // color1/2 -> matrix nibble (other from compile-time scene)
        const sb = a1 === 0 ? (((a2 & 0xf) << 4) | (sc.color2 & 0xf)) : (((sc.color1 & 0xf) << 4) | (a2 & 0xf));
        c(`  lda #${sb}`); c(`  ldx #0`); c(`c37_${u}:`);
        c(`  sta $4000,x`); c(`  sta $4100,x`); c(`  sta $4200,x`); c(`  sta $4300,x`);
        c(`  inx`); c(`  bne c37_${u}`);
      }
      break;
    }
    case 0x1d: break;   // data value: collected into DATA (label handled by the driver)
    case 0x5d: c(`  ldx ${V(a2)}`); c(`  lda RAM,x`); c(`  sta ${V(a1)}`); break;    // var = ram[var]
    case 0x5e: c(`  ldx ${V(a1)}`); c(`  lda ${V(a2)}`); c(`  sta RAM,x`); break;    // ram[var] = var
    case 0x5f: c(`  ldx ${V(a1)}`); c(`  lda #${a2}`); c(`  sta RAM,x`); break;      // ram[var] = const
    case 0x1c: {                                                                    // select data table (by label)
      const off = dataLabelOffset[a2] ?? 0;
      c(`  lda #<DATA+${off}`); c(`  sta dtabLo`); c(`  lda #>DATA+${off}`); c(`  sta dtabHi`); break;
    }
    case 0x0a: c(`  ldy ${V(a2)}`); c(`  lda (dtabLo),y`); c(`  sta ${V(a1)}`); break;  // var = current-data[var]
    case 0x02: c(`  ldx ${V(a2)}`); c(`  lda jmptabLo,x`); c(`  sta jv`);            // jump to label [var]
               c(`  lda jmptabHi,x`); c(`  sta jv+1`); c(`  jmp (jv)`); break;
    case 0x04: c(`  ldx ${V(a2)}`); c(`  lda jmptabLo,x`); c(`  sta jv`);            // jsr to label [var]
               c(`  lda jmptabHi,x`); c(`  sta jv+1`); c(`  jsr jindir`); break;
    case 0x4d: c(`  lda #${a1 & 3}`); c(`  sta pbits`); c(`  lda #${a2 & 1}`); c(`  sta pscene`); break;              // plot color=const to scene (pscene unused in roomy)
    case 0x4e: c(`  lda ${V(a1)}`); c(`  and #3`); c(`  sta pbits`); c(`  lda #${a2 & 1}`); c(`  sta pscene`); break;  // plot color=var to scene
    case 0x4f: c(`  lda #${a1}`); c(`  sta pgx`); c(`  lda #${a2}`); c(`  sta pgy`); c(`  jsr rt_plot`); break;         // plot dot at const x,y
    case 0x50: c(`  lda ${V(a1)}`); c(`  sta pgx`); c(`  lda ${V(a2)}`); c(`  sta pgy`); c(`  jsr rt_plot`); break;     // plot dot at var x,y
    // if-family handled by the driver loop
    default: throw new Error(`emitOp: unhandled opcode 0x${op.opcode.toString(16)} (${op.instructionName})`);
  }
}

const IF_OPS = new Set([0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x4a]);
const pauseStubs = [], pauseFrames = [];

// loop heads = labels that are targets of a backward jump; one frame tick per pass
const labelIndex = {};
ins.forEach((op, i) => { if (op.label) labelIndex[op.label] = i; });
const loopHeads = new Set();
ins.forEach((op, i) => { if (op.opcode === 0x01 && labelIndex[op.arg2] !== undefined && labelIndex[op.arg2] <= i) loopHeads.add(op.arg2); });

let pendingSkip = null;   // skip-next (0x62/63/64): label to emit AFTER the next op
let mk = 0;               // split-point markers: safe instruction boundaries for the big-game code splitter
let sinceOptick = OPTICK_EVERY;   // force a checkpoint on the first op
for (const op of ins) {
  if (op.opcode === 0x1d) { if (op.label) c(`LBL_${op.label}:`); continue; }  // data value: label only, no code
  if (op.label) { c(`LBL_${op.label}:`); }
  c(`__M${mk++}:`);    // split-safe boundary (start of an op) — both modes
  // Checkpoint (raster frame-poll in free-run, or op throttle) at every loop head and at least
  // every OPTICK_EVERY ops — enough to always catch the frame boundary and keep loops ticking,
  // without a `jsr optick` on every single op (that was ~4KB of calls).
  if ((op.label && loopHeads.has(op.label)) || sinceOptick >= OPTICK_EVERY) { c(`  jsr optick`); sinceOptick = 0; }
  sinceOptick++;
  // skip-next: emit the test (branch OVER the next op when the condition holds)
  if (op.opcode === 0x62 || op.opcode === 0x63 || op.opcode === 0x64) {
    const n = ++uid, sk = `SKIP_${n}`;
    c(`  lda ${V(op.arg1)}`);
    if (op.opcode === 0x62) { c(`  cmp #${op.arg2}`); c(`  beq ${sk}`); }          // skip if var = const
    else if (op.opcode === 0x63) { c(`  cmp #${(op.arg2 + 1) & 0xff}`); c(`  bcs ${sk}`); } // skip if var > const
    else { c(`  cmp #${op.arg2}`); c(`  bcc ${sk}`); }                             // skip if var < const
    pendingSkip = sk; continue;
  }
  if (IF_OPS.has(op.opcode)) emitIfHead(op);
  else if (op.opcode === 0x54) {                              // otherwise
    const f = ifStack[ifStack.length - 1]; f.hasElse = true;
    c(`  jmp ${f.endL}`); c(`${f.elseL}:`);
  }
  else if (op.opcode === 0x55) {                              // endif
    const f = ifStack.pop(); c(`${f.hasElse ? f.endL : f.elseL}:`);
  }
  else emitOp(op);
  if (pendingSkip) { c(`${pendingSkip}:`); pendingSkip = null; }  // close a pending skip-next
}
const codeBody = L.join('\n');

// pause subroutines (each waits secs*~50 frames, running the frame update)
const pauseSubs = pauseStubs.map((id, k) => {
  const frames = pauseFrames[k];
  return `pause_${id}:
        lda #<${frames}
        sta pcl
        lda #>${frames}
        sta pch
pl_${id}: jsr waitframe
        lda pcl
        bne pd_${id}
        lda pch
        beq px_${id}
        dec pch
pd_${id}: dec pcl
        jmp pl_${id}
px_${id}: rts`;
}).join('\n');

const byteRows = arr => {
  const out = [];
  for (let i = 0; i < arr.length; i += 32) out.push('        !byte ' + Array.from(arr.slice(i, i + 32)).join(','));
  return out.join('\n');
};

// digit font (8x8) for score, reused from starsbench
const digitfont = [
  0x3c,0x66,0x6e,0x76,0x66,0x66,0x3c,0, 0x18,0x38,0x18,0x18,0x18,0x18,0x7e,0,
  0x3c,0x66,0x06,0x0c,0x30,0x60,0x7e,0, 0x3c,0x66,0x06,0x1c,0x06,0x66,0x3c,0,
  0x06,0x0e,0x1e,0x66,0x7f,0x06,0x06,0, 0x7e,0x60,0x7c,0x06,0x06,0x66,0x3c,0,
  0x3c,0x66,0x60,0x7c,0x66,0x66,0x3c,0, 0x7e,0x66,0x0c,0x18,0x18,0x18,0x18,0,
  0x3c,0x66,0x66,0x3c,0x66,0x66,0x3c,0, 0x3c,0x66,0x66,0x3e,0x06,0x66,0x3c,0];

console.log(`compiling ${prgName}: ${ins.length} instrs, ${Object.keys(spriteMeta).length} sprites (${frameBytes.length/64} frames), scene "${scene.name}"`);

// rt_plot: only emitted when the game plots (keeps non-plotting games off the split layout).
const plotRt = !usesPlot ? '' : `
; rt_plot: plot one mc dot at GKGM coords (pgx,pgy), color pbits, into scene pscene's
; bitmap ($6000 or $a000). GM x 12..171 -> mc 0..159, GM y 50..249 -> mc 0..199;
; out-of-range coords are skipped (no memory clobber). Read-modify-write one pixel-pair.
rt_plot:
        lda pgx
        sec
        sbc #12
        bcc rp_out
        cmp #160
        bcs rp_out
        sta px
        lda pgy
        sec
        sbc #50
        bcc rp_out
        cmp #200
        bcs rp_out
        sta py
        ldx py
        lda plotYlo,x
        sta ptr
        lda plotYhi,x
        sta ptr+1               ; ptr = row byte (base $6000)
        ldx px
        lda plotXlo,x
        clc
        adc ptr
        sta ptr
        lda plotXhi,x
        adc ptr+1
        sta ptr+1               ; ptr += column byte offset
${roomy ? '' : `        lda pscene
        beq rp_s0
        lda ptr+1               ; scene 1 -> bitmap2 at $a000 (+$4000)
        clc
        adc #$40
        sta ptr+1`}
rp_s0:  lda px
        and #$03
        asl
        asl
        ora pbits
        tax
        lda valtab,x            ; color bits pre-shifted to this pixel-pair's position
        sta pmval
        lda px
        and #$03
        tax
        lda maskt,x             ; mask clearing that pixel-pair
        sta pmask
        ldy #$00
        lda (ptr),y             ; RMW reads RAM ($6000 in roomy; $a000 in twobank w/ BASIC banked out)
        and pmask
        ora pmval
        sta (ptr),y
rp_out: rts`;

// ---- divergent runtime chunks (mode-specific verbatim reproductions) ----
const zpBlock = roomy ? `; auto-generated from ${prgName} by compile-game-roomy.mjs (ROOMY / single-bank mode)
; VIC stays on bank 1 ($4000-$7FFF): matrix $4000, sprite frames $4400 (pointer-swap,
; whole library resident, up to 112 frames), bitmap $6000 (filled at runtime by RLE
; decompress). Bank 2 ($8000+) is VIC-invisible RAM holding the compressed scenes.
; Scene switch = decompress-into-$6000 (~few frames), not an instant bank flip.
SCREEN = $4000
SPR    = $4400          ; sprite frame library (pointer-swap): frame i at SPR+i*64, pointer=16+i
BITMAP = $6000
; --- zero page ---
ptr    = $fb
pcl    = $f0
pch    = $f1
sval   = $f2
sval1  = $f3
dcol   = $f4
tmp    = $f5
fptr   = $f6
curv   = $f7
animtog = $f8
ptr2   = $f9
nidx   = $fa
collFlags = $fd
bgFlags = $fe
bankEor = $ff           ; 0=bank1 active, $c0=bank2 (XOR onto slot/matrix high bytes)
opbudget = $ee          ; bytecode ops left this frame (throttle)
OPS_PER_FRAME = ${OPS_PER_FRAME}
dtabLo   = $e0          ; current data-table pointer (0x1c/0x0a)
dtabHi   = $e1
jv       = $e2          ; indirect jump target (0x02/0x04)
rlsrc    = $e4          ; LZ decompress: compressed source pointer (roomy scene switch)
msrc     = $e6          ; LZ decompress: match source pointer (dest - offset)
btmp     = $e8          ; LZ: saved command byte (reuses movement zp — lzdec runs only in display_scene)
lzlo     = $e9          ; LZ: match/run length (16-bit, lzlo/lzhi)
lzhi     = $ea
mspeed   = $e8          ; movement: speed (multiplier)
mfac     = $e9          ; movement: |direction component|
msign    = $ea          ; movement: sign of the component (1=negative)
pbits    = $eb          ; plot: color (0-3)  [dedicated: movement uses $e8-$ea, rledec $e4-$e7]
pscene   = $ec          ; plot: scene (set but unused in roomy — one live bitmap at $6000)
px       = $ed          ; plot: mc x
py       = $ef          ; plot: mc y
pgx      = $e4          ; plot: GM x input  (reuses rledec zp; rledec never runs during rt_plot)
pgy      = $e5          ; plot: GM y input
pmval    = $e6          ; plot: color bits pre-shifted
pmask    = $e7          ; plot: pixel-pair clear mask` : `; auto-generated from ${prgName} by compile-game.mjs
SCREEN = $4000
BITMAP = $6000
; --- zero page ---
ptr    = $fb
pcl    = $f0
pch    = $f1
sval   = $f2
sval1  = $f3
dcol   = $f4
tmp    = $f5
fptr   = $f6
curv   = $f7
animtog = $f8
ptr2   = $f9
nidx   = $fa
collFlags = $fd
bgFlags = $fe
bankEor = $ff           ; 0=bank1 active, $c0=bank2 (XOR onto slot/matrix high bytes)
opbudget = $ee          ; bytecode ops left this frame (throttle)
OPS_PER_FRAME = ${OPS_PER_FRAME}
dtabLo   = $e0          ; current data-table pointer (0x1c/0x0a)
dtabHi   = $e1
jv       = $e2          ; indirect jump target (0x02/0x04) -- OCCUPIES $e2 AND $e3
pbits    = $e4          ; plot: current color (0-3)  [must dodge jv+1=$e3]
pscene   = $e5          ; plot: target scene (0=$6000 bitmap, 1=$a000 bitmap)
px       = $e6          ; plot: mc x (0-159)
py       = $e7          ; plot: mc y (0-199)
pmval    = $e8          ; plot: color bits pre-shifted
pmask    = $e9          ; plot: pixel-pair clear mask
pgx      = $ea          ; plot: GM x input
pgy      = $eb          ; plot: GM y input
mspeed   = $ec          ; movement: speed (multiplier)
mfac     = $ed          ; movement: |direction component| (multiplicand/shift reg)
msign    = $ef          ; movement: sign of the component (1=negative; $ee is opbudget)`;

// fdraw sprite-pointer write: twobank fixed pointer (16+slot) mirrored to both banks + loadslot copy;
// roomy pointer-swap (16+base+frame), no copy, no $83f8 mirror.
const fdrawPtr = roomy ? `        lda sBase,x             ; pointer-swap: pointer = 16 + (base+frame), frame resident at SPR
        clc
        adc sFrame,x
        adc #16
        sta $43f8,x` : `        txa                     ; fixed sprite pointer = 16+slot (mirror to both banks)
        clc
        adc #16
        sta $43f8,x
        sta $83f8,x
        lda sBase,x             ; current master frame index = base + frame
        clc
        adc sFrame,x
        jsr loadslot            ; copy it into the slot's 64 bytes (only if changed)`;

// fsub (sub-quad) sprite-pointer write: same divergence as fdraw.
const fsubPtr = roomy ? `        lda sBase,x             ; pointer-swap: pointer = 16 + (sub base + parent frame)
        clc
        adc tmp
        adc #16
        sta $43f8,x
        jmp fnext` : `        txa                     ; fixed pointer = 16+slot (mirror to both banks)
        clc
        adc #16
        sta $43f8,x
        sta $83f8,x
        lda sBase,x             ; sub-quad master frame = sub base + parent frame
        clc
        adc tmp
        jsr loadslot
        jmp fnext`;

// twobank: loadslot (copy master frame into the slot's 64 bytes on change).
// roomy: rledec (decompress the pair-RLE scene stream into $6000).
const loadslotOrRledec = roomy ? `; lzdec: decompress the byte-LZ stream at (rlsrc) into BITMAP ($6000). Byte-oriented -> fast (no bit
; reader). token: $01-$7f = literal run (that many bytes follow); $80-$ff = match: bit6 = offset size
; (0:1-byte 1..255, 1:2-byte LE), bits5-0 = len field (len = field+3, or field==63 -> +255-chained
; extension bytes added to 66); then the offset; copy len bytes from (dest-offset). Stops at
; BITMAP+8000 ($7f40). Forward copy so an offset-1 match propagates like an RLE run.
lzdec:
        lda #<BITMAP
        sta ptr
        lda #>BITMAP
        sta ptr+1
        ldy #0                  ; Y stays 0 for all (rlsrc)/(ptr)/(msrc) accesses
lz_next:
        lda ptr+1               ; done when ptr == BITMAP+8000 = $7f40
        cmp #$7f
        bne lz_go
        lda ptr
        cmp #$40
        beq lz_done
lz_go:  lda (rlsrc),y           ; command byte
        jsr incsrc
        cmp #$80
        bcs lz_match
        tax                     ; literal run: X = count (1-127)
lz_lit: lda (rlsrc),y
        jsr incsrc
        sta (ptr),y
        jsr incdst
        dex
        bne lz_lit
        jmp lz_next
lz_match:
        sta btmp                ; command byte
        and #$3f
        cmp #$3f
        beq lz_extlen
        clc
        adc #3                  ; len = field + 3  (3..65)
        sta lzlo
        lda #0
        sta lzhi
        jmp lz_getoff
lz_extlen:
        lda #66                 ; len = 66 + sum of 255-chained extension bytes
        sta lzlo
        lda #0
        sta lzhi
lz_el:  lda (rlsrc),y
        jsr incsrc
        pha
        clc
        adc lzlo
        sta lzlo
        bcc lz_el2
        inc lzhi
lz_el2: pla
        cmp #255
        beq lz_el
lz_getoff:
        lda btmp
        and #$40                ; offset size bit
        beq lz_1b
        lda (rlsrc),y           ; 2-byte offset (LE)
        jsr incsrc
        sta msrc
        lda (rlsrc),y
        jsr incsrc
        sta msrc+1
        jmp lz_off
lz_1b:  lda (rlsrc),y           ; 1-byte offset (1..255)
        jsr incsrc
        sta msrc
        lda #0
        sta msrc+1
lz_off: sec                     ; msrc = ptr - offset
        lda ptr
        sbc msrc
        sta msrc
        lda ptr+1
        sbc msrc+1
        sta msrc+1
lz_cp:  lda (msrc),y
        sta (ptr),y
        inc msrc
        bne lz_c2
        inc msrc+1
lz_c2:  jsr incdst
        lda lzlo                ; 16-bit length--
        bne lz_c3
        dec lzhi
lz_c3:  dec lzlo
        lda lzlo
        ora lzhi
        bne lz_cp
        jmp lz_next
lz_done:
        rts
incsrc: inc rlsrc
        bne is_r
        inc rlsrc+1
is_r:   rts
incdst: inc ptr
        bne id_r
        inc ptr+1
id_r:   rts
roomy_int: rti                  ; NMI(RESTORE)/IRQ handler for KERNAL-banked-out roomy: ignore + return` : `loadslot:                       ; X=slot, A=master frame index -> copy into this slot (on change)
        cmp sLoad,x
        beq lsret               ; same frame already resident -> skip the copy
        sta sLoad,x
        tay
        lda frameLo,y
        sta ptr2
        lda frameHi,y
        sta ptr2+1              ; ptr2 = master + idx*64  (source)
        lda slotLo,x
        sta ptr
        lda slotHi,x
        eor bankEor             ; bank1 ^$00 -> $44/$45, bank2 ^$c0 -> $84/$85
        sta ptr+1               ; ptr = active-bank slot (+$400 + slot*64)  (dest)
        ldy #63
lscp:   lda (ptr2),y
        sta (ptr),y
        dey
        bpl lscp
lsret:  rts`;

// display_scene diverges entirely: twobank flips the $dd00 VIC bank + marks slots stale;
// roomy decompresses the active RLE scene into $6000, repaints matrix/color/bg, rebuilds pointers.
const displaySceneChunk = roomy ? `; display_scene: roomy single-bank switch. activeScene (0..N-1) already set by the caller.
; Index the per-scene tables (sceneLo/Hi = compressed-stream ptr; sceneMat/Col/Bg = colors),
; decompress that scene's bitmap into $6000, repaint the shared matrix/colorRAM/bg, then refresh
; the sprite pointers (the matrix fill overwrites $43F8-$43FF). This is where the ~few-frame
; switch cost lives (vs the two-bank build's instant $DD00 flip).
display_scene:
        ldx activeScene
        lda sceneLo,x
        sta rlsrc
        lda sceneHi,x
        sta rlsrc+1
        jsr lzdec
        ldx activeScene
        lda sceneMat,x
        jsr ds_matrix
        ldx activeScene
        lda sceneCol,x
        jsr ds_color
        ldx activeScene
        lda sceneBg,x
        sta $d021
        sta $d020
        ldx #7                  ; matrix fill clobbered $43F8-$43FF -> rebuild sprite pointers
dsp:    lda sBase,x
        cmp #$ff
        beq dsp2
        clc
        adc sFrame,x
        adc #16
        sta $43f8,x
dsp2:   dex
        bpl dsp
        rts
ds_matrix:                      ; A = matrix byte -> fill $4000-$43FF (colors 1/2)
        ldx #0
dsm:    sta $4000,x
        sta $4100,x
        sta $4200,x
        sta $4300,x
        inx
        bne dsm
        rts
ds_color:                       ; A = color3 -> fill color RAM
        ldx #0
dscr:   sta $d800,x
        sta $d900,x
        sta $da00,x
        sta $db00,x
        inx
        bne dscr
        rts` : `; display_scene: point the VIC at activeScene's bank (bank1/$4000 or bank2/$8000),
; set bankEor for the sprite copies, and force all sprite slots to re-copy into the
; now-active bank (its slots hold stale frames from when it was last shown).
display_scene:
        lda activeScene
        bne dsB
        lda #$00
        sta bankEor
        lda $dd00
        and #$fc
        ora #$02                ; VIC bank 1 ($4000): scene 1 bitmap $6000
        sta $dd00
        jmp dsC
dsB:    lda #$c0
        sta bankEor
        lda $dd00
        and #$fc
        ora #$01                ; VIC bank 2 ($8000): scene 2 bitmap $a000
        sta $dd00
dsC:    ldx #7
dsL:    lda #$ff
        sta sLoad,x
        dex
        bpl dsL
        rts`;

// print_char scene targeting: twobank renders to $6000 and/or $a000 per printTarget; roomy always $6000.
const printCharChunk = roomy ? `; print_char: A = gm char index. Render at (printRow,printCol) to target bitmap(s).
print_char:
        and #$3f
        tay
        lda fontLo,y
        sta fptr
        lda fontHi,y
        sta fptr+1              ; fptr = printFont + index*8
        ldx printRow            ; sval/sval1 = row*320 + col*16
        lda prowLo,x
        sta sval
        lda prowHi,x
        sta sval1
        ldx printCol
        clc
        lda sval
        adc pcolLo,x
        sta sval
        lda sval1
        adc pcolHi,x
        sta sval1
        lda printColByte
        sta gcol
        lda #$60
        jsr pc_render           ; roomy: one live bitmap at $6000
        rts` : `; print_char: A = gm char index. Render at (printRow,printCol) to target bitmap(s).
print_char:
        and #$3f
        tay
        lda fontLo,y
        sta fptr
        lda fontHi,y
        sta fptr+1              ; fptr = printFont + index*8
        ldx printRow            ; sval/sval1 = row*320 + col*16
        lda prowLo,x
        sta sval
        lda prowHi,x
        sta sval1
        ldx printCol
        clc
        lda sval
        adc pcolLo,x
        sta sval
        lda sval1
        adc pcolHi,x
        sta sval1
        lda printColByte
        sta gcol
        lda printTarget
        cmp #1
        beq pc_s2               ; target 1 -> scene 2 only
        lda #$60
        jsr pc_render           ; scene 1 ($6000 + offset)
        lda printTarget
        cmp #2
        bne pc_ret              ; target 0 -> done
pc_s2:  lda #$a0
        jsr pc_render           ; scene 2 ($a000 + offset)
pc_ret: rts`;

const execStream = `${zpBlock}
; --- slot state arrays (8 slots) ---
; The hot per-frame arrays live in ZERO PAGE ($02-$59): with BASIC+KERNAL banked
; out, ZP $02-$8f is free, so the movement/animation/draw loop gets zp,x access
; (2 bytes, 4 cycles, no page-cross) instead of abs,x. Touched every frame x8 slots.
sBase    = $02
sNum     = $0a
sFrame   = $12
sAnimTmr = $1a
sAnimSpd = $22
sSpeed   = $2a
sDir     = $32
sPosXlo  = $3a
sPosXhi  = $42
sPosYlo  = $4a
sPosYhi  = $52
; --- colder state also in ZERO PAGE ($5a-$dc) — sound/music/print/multi-quad.
; Moving it here (from the old $c060 block) empties the whole $c000 page, so the
; scene layout no longer has to reserve/skip it. ZP map: hot state $02-$59,
; cold state $5a-$dc, our pointer/scratch $e0-$ff. ($00/$01 = CPU port.) ---
scoreLo  = $5a
scoreHi  = $5b
vAct     = $5e
vBase    = $62
vNum     = $66
vFrm     = $6a
vTmr     = $6e
vRep     = $72
vFreqLo  = $76
vFreqHi  = $7a
vSwLo    = $7e
vSwHi    = $82
mAct     = $86
mBase    = $8a
mNum     = $8e
mPtr     = $92
mTmr     = $96
mCtl     = $9a
mAD      = $9e
mSR      = $a2
mPulLo   = $a6
mPulHi   = $aa
scorePtrLo = $ae
scorePtrHi = $af
scoreColByte = $b0
sParent  = $b2          ; multi-quad: parent slot of a sub-quad ($ff = independent)
sQXoff   = $ba          ; sub-quad gmX offset from parent
sQYoff   = $c2          ; sub-quad gmY offset from parent
sLoad    = $ca          ; master frame index currently copied into this slot ($ff=none)
activeScene = $d2       ; which scene is displayed
printRow = $d3          ; print cursor row (0-24)
printCol = $d4          ; print cursor column (0-19)
printColByte = $d5      ; print color: fg*4 + bg
printTarget = $d6       ; 0=scene1 bitmap, 1=scene2, 2=both
gcol     = $d8          ; putglyph color-byte parameter
strlen   = $da          ; print_string length / index / value scratch
stridx   = $db
pvtmp    = $dc

        * = $0801
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00
entry:
        sei
${roomy ? `        lda #<roomy_int         ; roomy banks out KERNAL too, so first install our own NMI + IRQ
        sta $fffa               ; vectors in the RAM under KERNAL (writes hit RAM even while KERNAL
        sta $fffe               ; ROM is still mapped). NMI = RESTORE key -> our handler (just RTI),
        lda #>roomy_int         ; so banking KERNAL out below can't crash on a RESTORE press. (IRQ is
        sta $fffb               ; masked by SEI but we point it safe too. RESET re-maps KERNAL itself
        sta $ffff               ; before reading $fffc, so it stays safe without our help.)
        lda #$35                ; bank BASIC + KERNAL out: RAM at $a000-$bfff AND $e000-$ffff, keep
        sta $01                 ; I/O ($d000). ~30KB of code/data/scene room in a pure-RAM program.` : `        lda #$36                ; bank BASIC ROM out for good: $a000-$bfff becomes plain RAM for the
        sta $01                 ; CPU (we don't use BASIC). Keeps KERNAL ($e000, for the NMI/reset
                                ; vectors) + I/O ($d000). Lets the scene-2 bitmap at $a000 be read
                                ; (plot RMW) instead of hitting ROM.`}
        lda #$00
        sta $d01a
        lda $dd00
        and #$fc
        ora #$02
        sta $dd00               ; VIC bank 1 ($4000-$7FFF)
        lda #$3b
        sta $d011
        lda #$18
        sta $d016
        lda #$08
        sta $d018               ; screen $4000, bitmap $6000
        ; (scene colors/matrix are set by the "scene is" opcode -> scene_show)
        ; Zero the ZP runtime-state block ($02-$dc). All state lives in ZP now, and ZP is DIRTY
        ; at boot (BASIC/KERNAL/the self-extract loader leave garbage there) — unlike the old
        ; $c000 block, which was clean zero-padded image RAM. Without this, uncleared vars
        ; (sPosXhi/Yhi, sFrame, sNum, sound/music state, activeScene...) start as garbage:
        ; sprites flicker at random positions, garbage SFX, timers/counters mis-fire.
        lda #$00
        ldx #$00
clrst:  sta $02,x
        inx
        cpx #$db                ; $02..$dc inclusive (219 bytes); $e0+ is pointer/scratch, leave it
        bne clrst
        ; init slots: base=$ff (unassigned)
        ldx #$00
islot:  lda #$ff
        sta sBase,x
        sta sParent,x
${roomy ? '' : `        sta sLoad,x
`}        lda #$00
        sta sSpeed,x
        sta sAnimSpd,x
        sta sDir,x              ; init once; 0x27 preserves these across sprite swaps
        sta sAnimTmr,x
        sta sPosXlo,x           ; 8.8 fractional position (0x27 preserves it; games set hi via position ops)
        sta sPosYlo,x
        inx
        cpx #8
        bne islot
        lda #$00
        sta $d015
        sta $d01c
        sta $d010
        sta $d017
        sta $d01d
        sta $d01b               ; all sprites in front of the bitmap
        sta collFlags
        sta bgFlags
${roomy ? '' : `        sta bankEor             ; start on bank 1 (scene 1)
`}        sta activeScene
        lda #${THROTTLE ? THROTTLE_REFILL : 0}
        sta opbudget            ; prime the checkpoint counter (budget in throttle; frame-flag in free-run)
        lda #0
        sta scoreLo
        sta scoreHi
        sta vAct+0
        sta vAct+1
        sta vAct+2
        sta mAct+0
        sta mAct+1
        sta mAct+2
        lda #$0f
        sta $d418               ; SID master volume
        lda #<SCOREHOME         ; default score position/color (opcodes override)
        sta scorePtrLo
        lda #>SCOREHOME
        sta scorePtrHi
        lda #4
        sta scoreColByte        ; fg color 1 on bg 0
${roomy ? `        lda #0                  ; roomy: decompress + show scene 0 at startup, so games that
        sta activeScene         ; set up the scene with 0x28 only (no explicit 0x2e, e.g. ARCHER)
        jsr display_scene       ; still get a background (twobank shows the embedded bitmap for free)` : ''}

${codeBody}

; ===================== runtime =====================
${THROTTLE ? `; optick (THROTTLE=${THROTTLE}): op cap for testing GKGM-timed games. Each checkpoint
; decrements the budget; when spent, block for the next frame and refill (~${THROTTLE} ops/frame).
optick:
        dec opbudget
        bne otr
        jsr waitframe
        lda #${THROTTLE_REFILL}
        sta opbudget
otr:    rts` : `; optick (free-run, DEFAULT): non-blocking frame poll. The bytecode runs at full native
; speed; once per real frame (raster crossing line 250) we do the 60Hz housekeeping, then return
; immediately. The opbudget byte is reused here as a 'ticked-this-frame' flag (bit7).
optick:
        lda $d012
        cmp #250
        bcc ot_lo
        bit opbudget
        bmi ot_ret
        lda #$80
        sta opbudget
        jmp frame_work          ; do housekeeping; its rts returns to optick's caller
ot_lo:  lda #0
        sta opbudget
ot_ret: rts`}

; waitframe: BLOCK until the frame boundary (raster line 250), then do housekeeping. Used by
; pause (real-time seconds) and, in throttle mode, by the op-cap checkpoint.
waitframe:
fw:     lda $d012
        cmp #250
        bne fw
        lda #$80
        sta opbudget            ; mark 'ticked' so a following free-run poll won't double-tick
; frame_work: the 60Hz housekeeping — collision latch, sprite move/animate/draw, SID, music.
; In free-run this runs once per real frame; it does NOT wait, so the bytecode keeps running.
frame_work:
        lda $d01e               ; latch sprite-sprite collisions once/frame (reading clears)
        sta collFlags
        lda $d01f               ; latch sprite-background collisions likewise
        sta bgFlags
        inc animtog             ; animation ticks at 30fps (every other frame)
        ldx #$00
fsl:    lda sBase,x
        cmp #$ff
        bne fp0
        jmp fnext
fp0:    lda sParent,x           ; sub-quad? -> relative positioning (skip move/anim)
        cmp #$ff
        beq fpind
        jmp fsub
fpind:  ; --- movement: general 256-direction (velocity = cos/sin(dir)*speed, GKGM) ---
        lda sSpeed,x
        bne fmv
        jmp fnomove
fmv:    sta mspeed
        ldy sDir,x
        lda cosk,y              ; X component (signed) -> delta in sval/sval1
        jsr axisdelta
        lda msign
        bne fxsub
        clc                     ; cos>=0 -> move right (+X)
        lda sPosXlo,x
        adc sval
        sta sPosXlo,x
        lda sPosXhi,x
        adc sval1
        sta sPosXhi,x
        jmp fyax
fxsub:  sec                     ; cos<0 -> move left (-X)
        lda sPosXlo,x
        sbc sval
        sta sPosXlo,x
        lda sPosXhi,x
        sbc sval1
        sta sPosXhi,x
fyax:   ldy sDir,x
        lda sink,y              ; Y component (signed)
        jsr axisdelta
        lda msign
        bne fysub
        clc                     ; sin>=0 -> move down (+Y)
        lda sPosYlo,x
        adc sval
        sta sPosYlo,x
        lda sPosYhi,x
        adc sval1
        sta sPosYhi,x
        jmp fnomove
fysub:  sec                     ; sin<0 -> move up (-Y)
        lda sPosYlo,x
        sbc sval
        sta sPosYlo,x
        lda sPosYhi,x
        sbc sval1
        sta sPosYhi,x
fnomove:
        ; --- animation (animspd>0, advanced only on 30fps ticks) ---
        lda animtog
        and #$01
        beq fdraw
        lda sAnimSpd,x
        bne fp2
        jmp fdraw
fp2:    lda sAnimTmr,x
        beq fadv
        dec sAnimTmr,x
        jmp fdraw
fadv:   lda sFrame,x
        clc
        adc #1
        cmp sNum,x
        bcc fsf
        lda #0
fsf:    sta sFrame,x
        lda #32
        sec
        sbc sAnimSpd,x
        sta sAnimTmr,x
fdraw:
        ; --- write VIC regs ---
        txa
        asl
        tay                     ; y = 2*slot
        lda sPosXhi,x
        asl                     ; A = low(2*gmX), C = 9th bit
        sta $d000,y
        bcc fxl
        lda $d010
        ora bit8,x
        sta $d010
        jmp fxd
fxl:    lda $d010
        and bit8i,x
        sta $d010
fxd:    lda sPosYhi,x
        sta $d001,y
${fdrawPtr}
fnext:  inx
        cpx #8
        beq fret
        jmp fsl
fsub:   ; --- sub-quad: position = parent pos + offset, frame = parent frame ---
        ldy sParent,x
        lda sPosXhi,y
        clc
        adc sQXoff,x
        sta sval                ; sub gmX
        sta sPosXhi,x           ; keep sub position current (for collision bbox)
        lda sPosYhi,y
        clc
        adc sQYoff,x
        sta sval1               ; sub gmY
        sta sPosYhi,x
        lda sFrame,y
        sta tmp                 ; parent frame index
        txa
        asl
        tay                     ; y = 2*subslot
        lda sval
        asl                     ; 2*gmX, C = 9th bit
        sta $d000,y
        bcc fsl2
        lda $d010
        ora bit8,x
        sta $d010
        jmp fsd
fsl2:   lda $d010
        and bit8i,x
        sta $d010
fsd:    lda sval1
        sta $d001,y
${fsubPtr}
fret:
        ; --- advance the 3 SID sound voices (sweep + repeat) ---
        ldx #0
svl:    stx curv
        lda vAct,x
        bne svgo
        jmp svn
svgo:   ldy v7,x                ; sweep: vFreq += vSw, write to SID
        clc
        lda vFreqLo,x
        adc vSwLo,x
        sta vFreqLo,x
        sta $d400,y
        lda vFreqHi,x
        adc vSwHi,x
        sta vFreqHi,x
        sta $d401,y
        dec vTmr,x
        beq svadv
        jmp svn
svadv:  inc vFrm,x
        lda vFrm,x
        cmp vNum,x
        bcc svload
        lda vRep,x              ; frames done -> repeat, or gate off
        bne svrep
        ldy v7,x
        lda $d404,y
        and #$fe
        sta $d404,y
        lda #0
        sta vAct,x
        jmp svn
svrep:  dec vRep,x
        lda #0
        sta vFrm,x
svload: lda vBase,x
        clc
        adc vFrm,x
        tax
        jsr loadframe
svn:    ldx curv
        inx
        cpx #3
        bne svl
        ; --- music: step 3 channels (voices stolen while an SFX is active) ---
        ldx #0
mvl:    stx curv
        lda mAct,x
        beq mvn
        dec mTmr,x
        bne mvn
        inc mPtr,x
        lda mPtr,x
        cmp mNum,x
        bcc mld
        lda #0                  ; end of channel -> stop (song plays once, no loop)
        sta mAct,x
        lda vAct,x              ; SFX owns this voice? leave the gate to the SFX
        bne mvn
        ldy v7,x
        lda $d404,y
        and #$fe                ; gate off -> last note releases
        sta $d404,y
        jmp mvn
mld:    lda mBase,x
        clc
        adc mPtr,x
        sta nidx
        tay
        lda mDur,y
        sta mTmr,x
        lda vAct,x              ; SFX owns this voice? keep music in sync, skip SID
        bne mvn
        jsr mplaynote
mvn:    ldx curv
        inx
        cpx #3
        bne mvl
        rts

; axisdelta: A = signed direction component (cosk/sink); mspeed = speed. Returns
; sval/sval1 = (|A| * speed) >> 3 as an unsigned 8.8 delta, msign = 1 if A was negative.
; Preserves X (the sprite slot). 8x8 shift-add multiply, then >>3.
axisdelta:
        cmp #$80
        bcc ad_pos
        eor #$ff
        clc
        adc #1                  ; A = -A (magnitude of a negative component)
        ldy #1
        sty msign
        jmp ad_mul
ad_pos: ldy #0
        sty msign
ad_mul: sta mfac
        lda #0
        sta sval
        sta sval1
        ldy #8
ad_lp:  asl sval
        rol sval1
        asl mfac
        bcc ad_no
        clc
        lda sval
        adc mspeed
        sta sval
        lda sval1
        adc #0
        sta sval1
ad_no:  dey
        bne ad_lp
        ldy #3                  ; >> 3 (undo the x8 baked into the tables)
ad_sh:  lsr sval1
        ror sval
        dey
        bne ad_sh
        rts

${loadslotOrRledec}

mplaynote:                      ; curv = channel/voice, nidx = note index
        ldy curv
        lda v7,y
        tay                     ; Y = voice*7
        ldx nidx
        lda mFlag,x
        and #$01
        beq mpnote
        ldx curv                ; rest -> gate off
        lda mCtl,x
        sta $d404,y
        rts
mpnote: lda mFlag,x
        and #$02
        bne mptied
        ldx curv                ; non-tied -> retrigger the envelope
        lda mCtl,x
        sta $d404,y
        lda mAD,x
        sta $d405,y
        lda mSR,x
        sta $d406,y
        lda mPulLo,x
        sta $d402,y
        lda mPulHi,x
        sta $d403,y
        ldx nidx
        lda mFreqLo,x
        sta $d400,y
        lda mFreqHi,x
        sta $d401,y
        ldx curv
        lda mCtl,x
        ora #$01
        sta $d404,y
        rts
mptied: ldx nidx                ; tied -> change frequency only (legato)
        lda mFreqLo,x
        sta $d400,y
        lda mFreqHi,x
        sta $d401,y
        rts

loadframe:                      ; X = sound frame index, curv = voice
        ldy curv
        lda v7,y
        tay                     ; Y = voice*7
        lda sndFL,x
        sta $d400,y
        lda sndFH,x
        sta $d401,y
        lda sndPL,x
        sta $d402,y
        lda sndPH,x
        sta $d403,y
        lda sndAD,x
        sta $d405,y
        lda sndSR,x
        sta $d406,y
        lda sndSL,x             ; melody frame (no sweep) -> retrigger the envelope,
        ora sndSH,x             ; so each note re-attacks from 0 (a rest sets sustain=0;
        bne lf_on               ; without a retrigger the next note would stay stuck at 0).
        lda sndCT,x             ; sweep sounds keep a continuous gate (skip the off).
        and #$fe
        sta $d404,y             ; gate off ...
lf_on:  lda sndCT,x
        sta $d404,y             ; ... then gate on -> rising edge retriggers ADSR
        ldy curv
        lda sndFL,x
        sta vFreqLo,y
        lda sndFH,x
        sta vFreqHi,y
        lda sndSL,x
        sta vSwLo,y
        lda sndSH,x
        sta vSwHi,y
        lda sndDU,x
        sta vTmr,y
        rts

${displaySceneChunk}

; ---- PRINT subsystem (text onto the multicolor bitmap) ----
; putglyph: blit an 8x8 font glyph -> 2 cells. fptr=font src, ptr=left cell,
; ptr2=right cell, gcol=color byte (fg*4+bg). Each font bit -> a 2-bit mc pixel.
putglyph:
        ldy #0
pg_lp:  lda (fptr),y
        pha
        lsr
        lsr
        lsr
        lsr
        sta tmp
        lda gcol
        asl
        asl
        asl
        asl
        ora tmp
        tax
        lda expandTab,x
        sta (ptr),y
        pla
        and #$0f
        sta tmp
        lda gcol
        asl
        asl
        asl
        asl
        ora tmp
        tax
        lda expandTab,x
        sta (ptr2),y
        iny
        cpy #8
        bne pg_lp
        rts

${printCharChunk}
pc_render:                      ; A = bitmap base high byte
        sta tmp
        clc
        lda sval
        sta ptr                 ; base low = 0
        lda sval1
        adc tmp
        sta ptr+1               ; ptr = base + offset (left cell)
        clc
        lda ptr
        adc #8
        sta ptr2
        lda ptr+1
        adc #0
        sta ptr2+1              ; ptr2 = ptr + 8 (right cell)
        jsr putglyph
        rts

; print_string: pcl/pch = string addr (GM indices), A = length. Advances printCol
; per char, then printRow++ (GM prints a whole row then drops down).
print_string:
        sta strlen
        lda #0
        sta stridx
ps_lp:  lda stridx
        cmp strlen
        bcs ps_done
        ldy stridx
        lda (pcl),y
        cmp #59                 ; 0x3B = GKGM print-string padding -> transparent (skip, advance only)
        beq ps_skip
        jsr print_char
ps_skip: inc printCol
        inc stridx
        jmp ps_lp
ps_done: inc printRow
        rts

; print_value: A = value (0-255) -> 3 zero-padded decimal digits at printCol.
print_value:
        ldx #0                  ; hundreds
pv_h:   cmp #100
        bcc pv_hd
        sec
        sbc #100
        inx
        jmp pv_h
pv_hd:  sta pvtmp
        txa
        clc
        adc #48
        jsr print_char
        inc printCol
        lda pvtmp
        ldx #0                  ; tens
pv_t:   cmp #10
        bcc pv_td
        sec
        sbc #10
        inx
        jmp pv_t
pv_td:  sta pvtmp
        txa
        clc
        adc #48
        jsr print_char
        inc printCol
        lda pvtmp               ; ones
        clc
        adc #48
        jsr print_char
        inc printCol
        rts

SCOREHOME = BITMAP + ${scoreOff}   ; default score position (row ${scoreRow}, col ${scoreCol})
; score_show: print scoreLo/Hi as 5 decimal digits at scorePtr, in scoreColByte
score_show:
        lda scoreLo
        sta sval
        lda scoreHi
        sta sval1
        lda #0
        sta dcol
ss_lp:  lda #0
        sta tmp
        ldx dcol
ss_sub: lda sval1
        cmp powhi,x
        bcc ss_done
        bne ss_do
        lda sval
        cmp powlo,x
        bcc ss_done
ss_do:  sec
        lda sval
        sbc powlo,x
        sta sval
        lda sval1
        sbc powhi,x
        sta sval1
        inc tmp
        ldx dcol
        jmp ss_sub
ss_done:
        lda dcol                ; dest = SCOREBASE + dcol*16 (2 mc cells per digit)
        asl
        asl
        asl
        asl
        clc
        adc scorePtrLo
        sta ptr
        lda scorePtrHi
        adc #0
        sta ptr+1
        clc                     ; ptr2 = ptr + 8 (right cell)
        lda ptr
        adc #8
        sta ptr2
        lda ptr+1
        adc #0
        sta ptr2+1
        lda tmp                 ; digit -> charset glyph 48+digit (screen code '0'), matches print value
        clc
        adc #48
        tax
        lda fontLo,x
        sta fptr
        lda fontHi,x
        sta fptr+1
        ldy #0
sd_row: lda (fptr),y            ; each font bit -> a 2-bit mc pixel (fg/bg per scoreColByte)
        pha
        lsr
        lsr
        lsr
        lsr
        sta tmp
        lda scoreColByte
        asl
        asl
        asl
        asl
        ora tmp
        tax
        lda expandTab,x
        sta (ptr),y
        pla
        and #$0f
        sta tmp
        lda scoreColByte
        asl
        asl
        asl
        asl
        ora tmp
        tax
        lda expandTab,x
        sta (ptr2),y
        iny
        cpy #8
        bne sd_row
        inc dcol
        lda dcol
        cmp #5
        bne ss_lp
        rts
${plotRt}
${pauseSubs}

gmstop: jmp gmstop              ; "stop program" halts here
jindir: jmp (jv)                ; computed jsr (0x04): jsr jindir -> jmp (jv); callee rts returns here
`;

// ---- data tables (pulled out of the exec stream; the big-game layout relocates them to
// VIC-invisible RAM). Each is [label, body]; single-line !byte or a multi-line block. ----
// plot lookup tables (computed): mc row byte-address (base $6000) + column byte-offset
const plotYlo = [], plotYhi = [], plotXlo = [], plotXhi = [];
for (let y = 0; y < 200; y++) { const a = 0x6000 + (y >> 3) * 320 + (y & 7); plotYlo.push(a & 0xff); plotYhi.push(a >> 8); }
for (let x = 0; x < 160; x++) { const o = (x >> 2) * 8; plotXlo.push(o & 0xff); plotXhi.push(o >> 8); }

const tableDefs = [
  ['bit8',   '!byte 1,2,4,8,16,32,64,128'],
  ...(usesPlot ? [
    ['valtab', '!byte 0,64,128,192,0,16,32,48,0,4,8,12,0,1,2,3'],
    ['maskt',  '!byte 63,207,243,252'],
    ['plotYlo', `!byte ${plotYlo.join(',')}`],
    ['plotYhi', `!byte ${plotYhi.join(',')}`],
    ['plotXlo', `!byte ${plotXlo.join(',')}`],
    ['plotXhi', `!byte ${plotXhi.join(',')}`],
  ] : []),
  ['bit8i',  '!byte 254,253,251,247,239,223,191,127'],
  ['v7',     '!byte 0,7,14'],
  ['expandTab', `!byte ${expandTab.join(',')}`],
  ['printFont', `!byte ${printFont.join(',')}`],
  ['fontLo', `!byte ${Array.from({length: 64}, (_, i) => `<printFont+${i * 8}`).join(',')}`],
  ['fontHi', `!byte ${Array.from({length: 64}, (_, i) => `>printFont+${i * 8}`).join(',')}`],
  ['prowLo', `!byte ${prowLo.join(',')}`],
  ['prowHi', `!byte ${prowHi.join(',')}`],
  ['pcolLo', `!byte ${pcolLo.join(',')}`],
  ['pcolHi', `!byte ${pcolHi.join(',')}`],
  ['prnStr', `!byte ${prnStr.join(',')}`],
  ['DATA',   `!byte ${DATA.join(',')}`],
  ['RAM',    '!fill 256'],
  ['jmptabLo', `!byte ${Array.from({length: 256}, (_, n) => labelIndex[n] !== undefined ? `<LBL_${n}` : `<gmstop`).join(',')}`],
  ['jmptabHi', `!byte ${Array.from({length: 256}, (_, n) => labelIndex[n] !== undefined ? `>LBL_${n}` : `>gmstop`).join(',')}`],
  ['sndFL', `!byte ${sndFL.join(',')}`], ['sndFH', `!byte ${sndFH.join(',')}`],
  ['sndPL', `!byte ${sndPL.join(',')}`], ['sndPH', `!byte ${sndPH.join(',')}`],
  ['sndCT', `!byte ${sndCT.join(',')}`], ['sndAD', `!byte ${sndAD.join(',')}`],
  ['sndSR', `!byte ${sndSR.join(',')}`], ['sndDU', `!byte ${sndDU.join(',')}`],
  ['sndSL', `!byte ${sndSL.join(',')}`], ['sndSH', `!byte ${sndSH.join(',')}`],
  ['mFreqLo', `!byte ${mFreqLo.join(',')}`], ['mFreqHi', `!byte ${mFreqHi.join(',')}`],
  ['mDur', `!byte ${mDur.join(',')}`], ['mFlag', `!byte ${mFlag.join(',')}`],
  ['powlo', '!byte <10000,<1000,<100,<10,<1'],
  ['powhi', '!byte >10000,>1000,>100,>10,>1'],
  ['digfont', byteRows(digitfont)],
  ['cosk', `!byte ${cosk.join(',')}`],
  ['sink', `!byte ${sink.join(',')}`],
  ['frameLo', `!byte ${Array.from({length: frameBytes.length / 64}, (_, i) => `<master+${i * 64}`).join(',')}`],
  ['frameHi', `!byte ${Array.from({length: frameBytes.length / 64}, (_, i) => `>master+${i * 64}`).join(',')}`],
  ['slotLo', '!byte 0,64,128,192,0,64,128,192'],
  ['slotHi', '!byte $44,$44,$44,$44,$45,$45,$45,$45'],
];
const tblText = t => t[1].startsWith('!byte') ? `${t[0]}: ${t[1]}` : `${t[0]}:\n${t[1]}`;
const tablesText = tableDefs.map(tblText).join('\n');
const masterText = `master:\n${byteRows(frameBytes)}`;
const bitmap2Text = bitmap2 ? `        * = $a000\n${byteRows(bitmap2)}\n` : '';

// ---- layout: try the simple contiguous layout; on $4000 overflow, split code across the two
// VIC-bank gaps and relocate data/master to VIC-invisible RAM (the "reorg"). ----
const graphicsSimple =
`        * = SCREEN
        !fill $400
        * = BITMAP
${byteRows(bitmap)}
${bitmap2Text}        * = $c100
${masterText}`;

function bigLayout() {
  // (a) size-probe: park data (master+tables) high so every symbol resolves, read addresses.
  const probe = assemble(`${execStream}\n        * = BITMAP\n${byteRows(bitmap)}\n        * = $8600\n${masterText}\n${tablesText}`);
  const P = probe.labels, codeEndFlat = P['jindir'] + 3;
  // (b) code split: last op boundary under $3FF0 becomes the seam into island 2 ($4600-$5FFF).
  const marks = Object.keys(P).filter(k => /^__M\d+$/.test(k)).sort((a, b) => P[a] - P[b]);
  let split = null;
  for (const m of marks) { if (P[m] < 0x3ff0) split = m; else break; }
  if (!split) throw new Error('splitter: no code boundary under $4000');
  const seg2 = codeEndFlat - P[split];
  if (0x4600 + seg2 > 0x6000) throw new Error(`splitter: island-2 code ${seg2}B overflows $4600-$5FFF (2nd split not yet implemented)`);
  const execSplit = execStream.replace(`${split}:`, `        jmp ${split}\n        * = $4600\n${split}:`);
  // (c) data split: contiguous master + as many tables as fit $8600-$9FFF, rest to $C100-$CFFF.
  const avail1 = 0xa000 - (0x8600 + frameBytes.length);
  let used = 0, cut = tableDefs.length;
  for (let i = 0; i < tableDefs.length; i++) {
    const sz = (i + 1 < tableDefs.length ? P[tableDefs[i + 1][0]] : probe.end) - P[tableDefs[i][0]];
    if (used + sz > avail1) { cut = i; break; }
    used += sz;
  }
  const part1 = tableDefs.slice(0, cut).map(tblText).join('\n');
  const part2 = tableDefs.slice(cut).map(tblText).join('\n');
  const part2Size = probe.end - (cut < tableDefs.length ? P[tableDefs[cut][0]] : probe.end);
  if (0xc100 + part2Size > 0xd000) throw new Error(`splitter: data ${part2Size}B overflows $C100-$CFFF`);
  const graphicsSplit =
`        * = BITMAP
${byteRows(bitmap)}
        * = $8600
${masterText}
${part1}
${bitmap2Text}        * = $c100
${part2}`;
  const out = `${execSplit}\n${graphicsSplit}`, rr = assemble(out);
  console.log(`  layout: SPLIT — seg1 $0801-$${P[split].toString(16)} / seg2 $4600-$${(0x4600 + seg2).toString(16)}; data $8600 (${cut} tbls) + $c100 (${tableDefs.length - cut} tbls), master $8600`);
  return { asm: out, r: rr };
}

let asm, r;
if (roomy) {
  // roomy single-bank layout. Data tables + compressed scenes live in VIC-invisible RAM;
  // sprite frames are resident in the VIC bank at SPR ($4400); the bitmap ($6000) is filled
  // at runtime by RLE decompress. Small games fit code+data under $4000 (simple). Big games
  // (PITFAL) get a code splitter that bridges over the VIC bank ($4000-$7FFF) into $8000, with
  // data+scenes trailing through $a000-$cfff (BASIC banked out at init makes that CPU-readable).
  const roomyData = `; ---- data ----
bit8:   !byte 1,2,4,8,16,32,64,128
bit8i:  !byte 254,253,251,247,239,223,191,127
v7:     !byte 0,7,14
expandTab: !byte ${expandTab.join(',')}
printFont: !byte ${printFont.join(',')}
fontLo: !byte ${Array.from({length: 64}, (_, i) => `<printFont+${i * 8}`).join(',')}
fontHi: !byte ${Array.from({length: 64}, (_, i) => `>printFont+${i * 8}`).join(',')}
prowLo: !byte ${prowLo.join(',')}
prowHi: !byte ${prowHi.join(',')}
pcolLo: !byte ${pcolLo.join(',')}
pcolHi: !byte ${pcolHi.join(',')}
prnStr: !byte ${prnStr.join(',')}
DATA:   !byte ${DATA.join(',')}
RAM:    !fill 256
jmptabLo: !byte ${Array.from({length: 256}, (_, n) => labelIndex[n] !== undefined ? `<LBL_${n}` : `<gmstop`).join(',')}
jmptabHi: !byte ${Array.from({length: 256}, (_, n) => labelIndex[n] !== undefined ? `>LBL_${n}` : `>gmstop`).join(',')}
sndFL:  !byte ${sndFL.join(',')}
sndFH:  !byte ${sndFH.join(',')}
sndPL:  !byte ${sndPL.join(',')}
sndPH:  !byte ${sndPH.join(',')}
sndCT:  !byte ${sndCT.join(',')}
sndAD:  !byte ${sndAD.join(',')}
sndSR:  !byte ${sndSR.join(',')}
sndDU:  !byte ${sndDU.join(',')}
sndSL:  !byte ${sndSL.join(',')}
sndSH:  !byte ${sndSH.join(',')}
mFreqLo: !byte ${mFreqLo.join(',')}
mFreqHi: !byte ${mFreqHi.join(',')}
mDur:   !byte ${mDur.join(',')}
mFlag:  !byte ${mFlag.join(',')}
powlo:  !byte <10000,<1000,<100,<10,<1
powhi:  !byte >10000,>1000,>100,>10,>1
digfont:
${byteRows(digitfont)}
cosk:   !byte ${cosk.join(',')}
sink:   !byte ${sink.join(',')}
${usesPlot ? `valtab: !byte 0,64,128,192,0,16,32,48,0,4,8,12,0,1,2,3
maskt:  !byte 63,207,243,252
plotYlo: !byte ${plotYlo.join(',')}
plotYhi: !byte ${plotYhi.join(',')}
plotXlo: !byte ${plotXlo.join(',')}
plotXhi: !byte ${plotXhi.join(',')}` : ''}
; per-scene tables (indexed by activeScene in display_scene)
sceneLo:  !byte ${rmScenes.map((_, i) => `<rle${i}`).join(',')}
sceneHi:  !byte ${rmScenes.map((_, i) => `>rle${i}`).join(',')}
sceneMat: !byte ${rmScenes.map(sc => sbyte(sc)).join(',')}
sceneCol: !byte ${rmScenes.map(sc => sc.color3).join(',')}
sceneBg:  !byte ${rmScenes.map(sc => sc.bgColor).join(',')}`;
  const roomyMatrixFrames = `        * = SCREEN
        !fill $400              ; video matrix (colors 1/2 + sprite pointers at +$3F8)
        * = SPR                 ; sprite frame library, pointer-swapped (frame i -> pointer 16+i)
sprdata:
${byteRows(frameBytes)}`;
  // Compressed scenes live in VIC-invisible RAM; display_scene decompresses one into $6000 at
  // runtime. They fill two usable regions, skipping the one reserved hole:
  //   A [start .. $cf00)   below the I/O hole (runtime state now lives in ZP, so nothing to skip)
  //   -- $d000-$dfff RESERVED: I/O --
  //   B [$e000 .. $fc00)   above the hole ($fc00 leaves room for the self-extractor's C2 staging
  //      + the $fffa vectors). Any blob in region B makes the image cross the hole -> self-extract.
  const REGIONS = [[null, 0xcf00], [0xe000, 0xfc00]];
  // greedily place blobs; return {jumps: {blobIdx -> newOrigin}, end}
  const placeScenes = start => {
    let pc = start, reg = 0; const jumps = {};
    for (let i = 0; i < rles.length; i++) {
      while (pc + rles[i].length > REGIONS[reg][1]) {
        if (++reg >= REGIONS.length) throw new Error(`roomy: compressed scenes (${rles.reduce((n, r) => n + r.length, 0)}B) don't fit the RAM map — use fewer/smaller scenes`);
        pc = REGIONS[reg][0]; jumps[i] = pc;
      }
      pc += rles[i].length;
    }
    return { jumps, end: pc };
  };
  const roomyScenes = (jumps = {}) => `; compressed scenes\n` +
    rles.map((r, i) => (jumps[i] !== undefined ? `        * = $${jumps[i].toString(16)}\n` : '') + `rle${i}:   !byte ${r.join(',')}`).join('\n');
  const spillNote = jumps => Object.keys(jumps).length ? ` (scenes spill ${Object.entries(jumps).map(([i, a]) => `#${i}@$${(+a).toString(16)}`).join(' ')} — crosses a hole, self-extract only)` : '';
  try {
    // simple: code+data under $4000, then matrix/frames ($4000/$4400), scenes from $8000
    const { jumps } = placeScenes(0x8000);
    asm = `${execStream}\n${roomyData}\n${roomyMatrixFrames}\n        * = $8000\n${roomyScenes(jumps)}`;
    r = assemble(asm);
    console.log(`  layout: roomy simple — $0801..$${r.end.toString(16)}${spillNote(jumps)}`);
  } catch (e) {
    if (!/moves backward/.test(e.message)) throw e;
    // roomy SPLIT: code seg A ($0801-$3FFF) bridges over the VIC bank to seg B ($8000); data
    // tables + compressed scenes trail seg B, filling the three regions above.
    const probe = assemble(`${execStream}\n        * = $8000\n${roomyData}\n${roomyScenes()}`);
    const P = probe.labels, codeEndFlat = P['jindir'] + 3;
    const marks = Object.keys(P).filter(k => /^__M\d+$/.test(k)).sort((a, b) => P[a] - P[b]);
    let split = null;
    for (const m of marks) { if (P[m] < 0x3ff0) split = m; else break; }
    if (!split) throw new Error('roomy splitter: no code boundary under $4000');
    const seg2 = codeEndFlat - P[split];
    // real address where the compressed scenes begin = $8000 + segB + (roomyData size)
    const sceneStart = 0x8000 + seg2 + (P['rle0'] - 0x8000);   // P['rle0'] is flat (data at $8000, no segB)
    const { jumps } = placeScenes(sceneStart);
    const idx = execStream.indexOf(`${split}:`);
    const segA = execStream.slice(0, idx), segB = execStream.slice(idx);
    asm = `${segA}        jmp ${split}
${roomyMatrixFrames}
        * = $8000
${segB}
${roomyData}
${roomyScenes(jumps)}`;
    r = assemble(asm);
    console.log(`  layout: roomy SPLIT — seg1 $0801-$${P[split].toString(16)} / seg2 $8000-$${(0x8000 + seg2).toString(16)}, data+scenes to $${r.end.toString(16)}${spillNote(jumps)}`);
  }
} else {
  try {
    asm = `${execStream}\n${tablesText}\n${graphicsSimple}`;
    r = assemble(asm);
    console.log(`  layout: simple — $0801..$${r.end.toString(16)} (code+data fit under $4000)`);
  } catch (e) {
    if (!/moves backward/.test(e.message)) throw e;
    ({ asm, r } = bigLayout());
  }
}

writeFileSync(outPath.replace(/\.prg$/, '.asm'), asm);
writeFileSync(outPath, Buffer.from(r.prg));
console.log(`  -> ${outPath}  (${r.bytes.length} bytes, org=$${r.org.toString(16)} end=$${r.end.toString(16)})`);

// also emit a runnable .d64 (wrap the .prg) so the two never drift out of sync
const gameName = prgName.split('/')[0].trim().slice(0, 16) || 'GAME';
const d64 = globalThis.D64.createEmpty(gameName, '01');
d64.writeFile(gameName, r.prg, globalThis.D64.FILE_TYPE_PRG);
const d64Path = outPath.replace(/\.prg$/, '.d64');
writeFileSync(d64Path, Buffer.from(d64.getData()));
console.log(`  -> ${d64Path}  (disk "${gameName}", file "${gameName}")`);
