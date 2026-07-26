// compile-game.mjs — GKGM program -> native C64 6502 (the real thing).
//
// Compiles a full GKGM game (ARCHER) to a standalone .prg: scene background,
// hardware sprites with GKGM speed/direction movement + animation, joystick,
// button, sprite-sprite collision, and score. Sound opcodes are no-ops for now.
//
// Uses VIC bank 1 ($4000-$7FFF): screen $4000, sprite frames $4400+, bitmap
// $6000 — no char-ROM shadow to dodge, plenty of room. Coordinates: VIC_X =
// 2*gmX (9th bit when gmX>=128), VIC_Y = gmY (verified from gmRuntime).
//
// Usage: node compile-game.mjs <disk.d64> <NAME/PRG> <out.prg>

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
const sceneByBank = [sceneMedia[sceneSlotMedia[0]] || scene, sceneMedia[sceneSlotMedia[1]]];
const numScenes = sceneByBank.filter(Boolean).length;
scene = sceneByBank[0];                                  // primary scene (score pos, name, etc.)
const sbyte = sc => ((((sc.color1 & 0xf) << 4) | (sc.color2 & 0xf)) & 0xff);
const bitmap = scene.rawImageData;                        // bank1 bitmap ($6000)
const screenByte = sbyte(scene);
const bitmap2 = sceneByBank[1] ? sceneByBank[1].rawImageData : null;   // bank2 bitmap ($A000)
const screenByte2 = sceneByBank[1] ? sbyte(sceneByBank[1]) : 0;

// score display position: GKGM "row (0-24) column (0-19)". Columns are 0-19 =
// 20 across a 160-mc-px screen => each column is 8 mc px = 16 hires px = 2 cells
// (double-wide, since the scene is multicolor). Byte offset = row*320 + col*16.
const sc46 = ins.find(op => op.opcode === 0x46);
const scoreRow = sc46 ? sc46.arg1 : 1;
const scoreCol = sc46 ? sc46.arg2 : 7;
const scoreOff = scoreRow * 320 + scoreCol * 16;

// ---- movement magnitude tables (8.8 fixed): speed/46 (X), speed/31.5 (Y) ----
const xmagLo = [], xmagHi = [], ymagLo = [], ymagHi = [];
for (let s = 0; s < 256; s++) {
  const xv = Math.round((s / 46) * 256), yv = Math.round((s / 31.5) * 256);
  xmagLo.push(xv & 0xff); xmagHi.push((xv >> 8) & 0xff);
  ymagLo.push(yv & 0xff); ymagHi.push((yv >> 8) & 0xff);
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
    case 0x56: c(`  lda activeScene`); c(`  eor #1`); c(`  sta activeScene`); c(`  jsr display_scene`); break; // display other scene
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
        const sl = a1 + q;
        c(`  lda #${quads[q].base}`); c(`  sta sBase+${sl}`);
        c(`  lda #${meta.num}`); c(`  sta sNum+${sl}`);
        c(`  lda #$00`); c(`  sta sFrame+${sl}`);     // reset frame only; GKGM keeps speed/dir/animSpeed across swaps
        c(`  lda #$ff`); c(`  sta sLoad+${sl}`);      // new sprite -> force frame (re)copy into the slot
        if (q === 0) { c(`  lda #$ff`); c(`  sta sParent+${sl}`);      // main = independent
                       c(`  lda #0`); c(`  sta sPosXlo+${sl}`); c(`  sta sPosYlo+${sl}`); }
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
    // if-family handled by the driver loop
    default: throw new Error(`emitOp: unhandled opcode 0x${op.opcode.toString(16)} (${op.instructionName})`);
  }
}

const IF_OPS = new Set([0x13, 0x15, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x4a]);
const pauseStubs = [], pauseFrames = [];

// loop heads = labels that are targets of a backward jump; one frame tick per pass
const labelIndex = {};
ins.forEach((op, i) => { if (op.label) labelIndex[op.label] = i; });
const loopHeads = new Set();
ins.forEach((op, i) => { if (op.opcode === 0x01 && labelIndex[op.arg2] !== undefined && labelIndex[op.arg2] <= i) loopHeads.add(op.arg2); });

for (const op of ins) {
  if (op.label) { c(`LBL_${op.label}:`); if (loopHeads.has(op.label)) c(`  jsr frame`); }
  if (IF_OPS.has(op.opcode)) { emitIfHead(op); continue; }
  if (op.opcode === 0x54) {                                    // otherwise
    const f = ifStack[ifStack.length - 1]; f.hasElse = true;
    c(`  jmp ${f.endL}`); c(`${f.elseL}:`); continue;
  }
  if (op.opcode === 0x55) {                                    // endif
    const f = ifStack.pop(); c(`${f.hasElse ? f.endL : f.elseL}:`); continue;
  }
  emitOp(op);
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
pl_${id}: jsr frame
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

const asm = `; auto-generated from ${prgName} by compile-game.mjs
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
; --- slot state arrays (8 slots) in RAM ---
sBase    = $c000
sNum     = $c008
sFrame   = $c010
sAnimTmr = $c018
sAnimSpd = $c020
sSpeed   = $c028
sDir     = $c030
sPosXlo  = $c038
sPosXhi  = $c040
sPosYlo  = $c048
sPosYhi  = $c050
scoreLo  = $c060
scoreHi  = $c061
vAct     = $c064
vBase    = $c068
vNum     = $c06c
vFrm     = $c070
vTmr     = $c074
vRep     = $c078
vFreqLo  = $c07c
vFreqHi  = $c080
vSwLo    = $c084
vSwHi    = $c088
mAct     = $c08c
mBase    = $c090
mNum     = $c094
mPtr     = $c098
mTmr     = $c09c
mCtl     = $c0a0
mAD      = $c0a4
mSR      = $c0a8
mPulLo   = $c0ac
mPulHi   = $c0b0
scorePtrLo = $c0b4
scorePtrHi = $c0b5
scoreColByte = $c0b6
sParent  = $c0b8        ; multi-quad: parent slot of a sub-quad ($ff = independent)
sQXoff   = $c0c0        ; sub-quad gmX offset from parent
sQYoff   = $c0c8        ; sub-quad gmY offset from parent
sLoad    = $c0d0        ; master frame index currently copied into this slot ($ff=none)
activeScene = $c0d8     ; 0 or 1 (which scene/bank is displayed)
printRow = $c0d9        ; print cursor row (0-24)
printCol = $c0da        ; print cursor column (0-19)
printColByte = $c0db    ; print color: fg*4 + bg
printTarget = $c0dc     ; 0=scene1 bitmap, 1=scene2, 2=both
gcol     = $c0de        ; putglyph color-byte parameter
strlen   = $c0e0        ; print_string length / index / value scratch
stridx   = $c0e1
pvtmp    = $c0e2

        * = $0801
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00
entry:
        sei
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
        ; init slots: base=$ff (unassigned)
        ldx #$00
islot:  lda #$ff
        sta sBase,x
        sta sParent,x
        sta sLoad,x
        lda #$00
        sta sSpeed,x
        sta sAnimSpd,x
        sta sDir,x              ; init once; 0x27 preserves these across sprite swaps
        sta sAnimTmr,x
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
        sta bankEor             ; start on bank 1 (scene 1)
        sta activeScene
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

${codeBody}

; ===================== runtime =====================
; frame: wait for raster, then move+animate+draw every assigned sprite
frame:
fw:     lda $d012
        cmp #250
        bne fw
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
fpind:  ; --- movement (speed>0) ---
        ldy sSpeed,x
        bne fp1
        jmp fnomove
fp1:    lda sDir,x
        cmp #64
        beq fright
        cmp #192
        beq fleft
        cmp #0
        beq fup
        cmp #128
        beq fdown
        jmp fnomove
fup:    sec
        lda sPosYlo,x
        sbc ymagLo,y
        sta sPosYlo,x
        lda sPosYhi,x
        sbc ymagHi,y
        sta sPosYhi,x
        jmp fnomove
fdown:  clc
        lda sPosYlo,x
        adc ymagLo,y
        sta sPosYlo,x
        lda sPosYhi,x
        adc ymagHi,y
        sta sPosYhi,x
        jmp fnomove
fright: clc
        lda sPosXlo,x
        adc xmagLo,y
        sta sPosXlo,x
        lda sPosXhi,x
        adc xmagHi,y
        sta sPosXhi,x
        jmp fnomove
fleft:  sec
        lda sPosXlo,x
        sbc xmagLo,y
        sta sPosXlo,x
        lda sPosXhi,x
        sbc xmagHi,y
        sta sPosXhi,x
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
        txa                     ; fixed sprite pointer = 16+slot (mirror to both banks)
        clc
        adc #16
        sta $43f8,x
        sta $83f8,x
        lda sBase,x             ; current master frame index = base + frame
        clc
        adc sFrame,x
        jsr loadslot            ; copy it into the slot's 64 bytes (only if changed)
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
        txa                     ; fixed pointer = 16+slot (mirror to both banks)
        clc
        adc #16
        sta $43f8,x
        sta $83f8,x
        lda sBase,x             ; sub-quad master frame = sub base + parent frame
        clc
        adc tmp
        jsr loadslot
        jmp fnext
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

loadslot:                       ; X=slot, A=master frame index -> copy into this slot (on change)
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
lsret:  rts

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

; display_scene: point the VIC at activeScene's bank (bank1/$4000 or bank2/$8000),
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
        rts

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

; print_char: A = gm char index. Render at (printRow,printCol) to target bitmap(s).
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
pc_ret: rts
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
        jsr print_char
        inc printCol
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
        lda tmp                 ; font src = digfont + digit*8
        asl
        asl
        asl
        clc
        adc #<digfont
        sta fptr
        lda #0
        adc #>digfont
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

${pauseSubs}

gmstop: jmp gmstop              ; "stop program" halts here

; ---- data ----
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
xmagLo: !byte ${xmagLo.join(',')}
xmagHi: !byte ${xmagHi.join(',')}
ymagLo: !byte ${ymagLo.join(',')}
ymagHi: !byte ${ymagHi.join(',')}
; --- sprite frame MASTER: all frames, kept below $4000 (VIC-invisible in banks 1/2).
; the frame tick copies the current frame of each active sprite into that slot's
; 64-byte area in the ACTIVE bank (copy-on-change), like the GKGM runtime does.
master:
${byteRows(frameBytes)}
frameLo: !byte ${Array.from({length: frameBytes.length / 64}, (_, i) => `<master+${i * 64}`).join(',')}
frameHi: !byte ${Array.from({length: frameBytes.length / 64}, (_, i) => `>master+${i * 64}`).join(',')}
slotLo:  !byte 0,64,128,192,0,64,128,192       ; slot s within a bank: +$400 + s*64
slotHi:  !byte $44,$44,$44,$44,$45,$45,$45,$45 ; bank1 (bank2 = ^ $c0 -> $84/$85)

        * = SCREEN
        !fill $400
        * = BITMAP
${byteRows(bitmap)}
${bitmap2 ? `        * = $a000\n${byteRows(bitmap2)}\n` : ''}`;

writeFileSync(outPath.replace(/\.prg$/, '.asm'), asm);
const r = assemble(asm);
writeFileSync(outPath, Buffer.from(r.prg));
console.log(`  -> ${outPath}  (${r.bytes.length} bytes, org=$${r.org.toString(16)} end=$${r.end.toString(16)})`);

// also emit a runnable .d64 (wrap the .prg) so the two never drift out of sync
const gameName = prgName.split('/')[0].trim().slice(0, 16) || 'GAME';
const d64 = globalThis.D64.createEmpty(gameName, '01');
d64.writeFile(gameName, r.prg, globalThis.D64.FILE_TYPE_PRG);
const d64Path = outPath.replace(/\.prg$/, '.d64');
writeFileSync(d64Path, Buffer.from(d64.getData()));
console.log(`  -> ${d64Path}  (disk "${gameName}", file "${gameName}")`);
