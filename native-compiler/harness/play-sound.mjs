// play-sound.mjs — SID sound-effect player test. Bundles a GKGM .SND (from a
// game's embedded sound) and plays it on SID voice 1 in a loop, so we can
// verify GKGM .SND -> SID works (audio captured via VICE -soundrecdev).
//
// .SND frame -> SID voice registers ($D400+V*7): freqLo/Hi, pulseLo/Hi,
// control (waveform|gate), AD (att<<4|dec), SR (sus<<4|rel). Hold `dur` frames.
//
// Usage: node play-sound.mjs <disk.d64> <PROG/PRG> <soundName> <out.prg>

import { readFileSync, writeFileSync } from 'fs';
import { assemble } from '../asm6502.mjs';
const B = '../../js/';
for (const m of ['d64lib','c64lib','gmOpcodes','gmSprite','gmScene','gmSound','gmMusic','gmCharset','gmParser'])
  await import(B + m + '.js');
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

const [,, diskPath, prgName, sndName, outPath] = process.argv;
const disk = new globalThis.D64(new Uint8Array(readFileSync(diskPath)));
globalThis.loadFileByName = (n) => disk.readFile(n);
const pd = globalThis.parseProgramData(disk.readFile(prgName));
const entry = pd.mediaStore.find(m => m && m.type === 'sound' && m.name.trim() === sndName.trim());
const snd = new globalThis.gmSound(entry.soundFileData);

// bundle frames: freqLo,freqHi,pulLo,pulHi,ctl,ad,sr,dur
const fL = [], fH = [], pL = [], pH = [], ctl = [], ad = [], sr = [], dur = [];
for (const f of snd.frames) {
  fL.push(f.freqLo); fH.push(f.freqHi); pL.push(f.pulseLo); pH.push(f.pulseHi);
  ctl.push((f.wave | 0x01) & 0xff); ad.push(((f.att << 4) | f.dec) & 0xff);
  sr.push(((f.sus << 4) | f.rel) & 0xff); dur.push(Math.max(1, f.dur));
}
const N = snd.frames.length;
console.log(`${sndName}: ${N} frames -> SID voice 1`);
const row = a => '        !byte ' + a.join(',');

const asm = `; SID sound test for ${sndName}
durc = $f0
        * = $0801
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00
        sei
        lda #$0f
        sta $d418               ; SID master volume
main:   ldx #$00
pf:     lda sndFL,x
        sta $d400
        lda sndFH,x
        sta $d401
        lda sndPL,x
        sta $d402
        lda sndPH,x
        sta $d403
        lda sndAD,x
        sta $d405
        lda sndSR,x
        sta $d406
        lda sndCT,x
        sta $d404               ; waveform | gate
        lda sndDU,x
        sta durc
hold:   jsr wframe
        dec durc
        bne hold
        inx
        cpx #${N}
        bne pf
        lda sndCT
        and #$fe
        sta $d404               ; gate off (release)
        ldy #60
gap:    jsr wframe
        dey
        bne gap
        jmp main
wframe: lda $d012
        cmp #250
        bne wframe
w2:     lda $d012
        cmp #250
        beq w2
        rts
sndFL:  ${row(fL)}
sndFH:  ${row(fH)}
sndPL:  ${row(pL)}
sndPH:  ${row(pH)}
sndCT:  ${row(ctl)}
sndAD:  ${row(ad)}
sndSR:  ${row(sr)}
sndDU:  ${row(dur)}
`;
writeFileSync(outPath.replace(/\.prg$/, '.asm'), asm);
const r = assemble(asm);
writeFileSync(outPath, Buffer.from(r.prg));
console.log(`  -> ${outPath} (${r.bytes.length} bytes)`);
