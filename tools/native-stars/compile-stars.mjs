// compile-stars.mjs — first slice of the GKGM -> native 6502 compiler.
//
// Reads a GKGM .PRG, parses it to an AST via gmParser, and emits 6502 assembly
// (one template per opcode) against a small reusable runtime library, then
// assembles it with asm6502 into a runnable .prg. STARS is the first target:
// small opcode set, no input, no audio.
//
// Usage: node compile-stars.mjs <disk.d64> <FILE/PRG> <out.prg>

import { readFileSync, writeFileSync } from 'fs';
import { assemble } from '../asm6502.mjs';

const B = '/Users/jfield/GMC64/code/js/';
for (const m of ['d64lib','c64lib','gmOpcodes','gmSprite','gmScene','gmSound','gmMusic','gmCharset','gmParser'])
  await import(B + m + '.js');
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

const [,, diskPath, fileName, outPath] = process.argv;
const disk = new globalThis.D64(new Uint8Array(readFileSync(diskPath)));
const prg = disk.readFile(fileName);
const pd = globalThis.parseProgramData(prg);
const ins = pd.instructions;

// ---- collect the data table (0x1d "data values") into a flat byte array ----
const DATA = [];
for (const op of ins) if (op.opcode === 0x1d) { DATA.push(op.arg1 & 0xff, op.arg2 & 0xff); }

// ---- codegen ----
const V = n => '$' + (0x40 + (n - 1)).toString(16);   // GKGM var n (1='a') -> ZP addr
let uidN = 0; const uid = () => ++uidN;
const ifStack = [];
const L = [];
const c = s => L.push(s);

function emitOp(op) {
  const a1 = op.arg1, a2 = op.arg2;
  switch (op.opcode) {
    case 0x2b: case 0x1c: case 0x1d: break;              // comment / data decl / data — no code
    case 0x07: c(`  lda #${a2}`); c(`  sta ${V(a1)}`); break;               // var = const
    case 0x08: c(`  lda ${V(a2)}`); c(`  sta ${V(a1)}`); break;             // var = [var]
    case 0x0b: c(`  lda ${V(a1)}`); c(`  clc`); c(`  adc #${a2}`); c(`  sta ${V(a1)}`); break; // var += const
    case 0x0c: c(`  lda ${V(a1)}`); c(`  clc`); c(`  adc ${V(a2)}`); c(`  sta ${V(a1)}`); break; // var += [var]
    case 0x0d: c(`  lda ${V(a1)}`); c(`  sec`); c(`  sbc #${a2}`); c(`  sta ${V(a1)}`); break; // var -= const
    case 0x0a: c(`  ldx ${V(a2)}`); c(`  lda DATA,x`); c(`  sta ${V(a1)}`); break; // var = data[[var]]
    case 0x5d: c(`  ldx ${V(a2)}`); c(`  lda RAM,x`); c(`  sta ${V(a1)}`); break;  // var = ram[[var]]
    case 0x5e: c(`  ldx ${V(a1)}`); c(`  lda ${V(a2)}`); c(`  sta RAM,x`); break;  // ram[[var]] = [var]
    case 0x01: c(`  jmp LBL_${a2}`); break;              // jump to label
    case 0x03: c(`  jsr LBL_${a2}`); break;              // jump to subroutine
    case 0x05: c(`  rts`); break;                        // return
    case 0x00: c(`  jmp HALT_LOOP`); break;              // halt
    case 0x33: c(`  lda #${a2}`); c(`  sta scnbg`); break;       // scene bg = color
    case 0x37: c(`  lda #${a2}`); c(`  sta scnc${a1 + 1}`); break; // scene color slot = color
    case 0x2e: c(`  jsr rt_scene_show`); break;          // display scene
    case 0x4d: c(`  lda #${a1}`); c(`  sta pbits`); break;       // plot color = const
    case 0x4e: c(`  lda ${V(a1)}`); c(`  sta pbits`); break;     // plot color = [var]
    case 0x50: c(`  lda ${V(a1)}`); c(`  sta rt_gmx`);           // plot dot at x=[var] y=[var]
               c(`  lda ${V(a2)}`); c(`  sta rt_gmy`); c(`  jsr rt_plot`); break;
    case 0x15: {                                          // if var > const then
      const n = uid(); ifStack.push(n);
      c(`  lda ${V(a1)}`); c(`  cmp #${a2 + 1}`);
      c(`  bcs IFBODY_${n}`); c(`  jmp ENDIF_${n}`); c(`IFBODY_${n}:`); break;
    }
    case 0x55: { const n = ifStack.pop(); c(`ENDIF_${n}:`); break; } // endif
    default: throw new Error(`no codegen for opcode 0x${op.opcode.toString(16)} (${op.instructionName})`);
  }
}

// ---- walk the instruction stream ----
let i = 0;
while (i < ins.length) {
  const op = ins[i];
  if (op.label) c(`LBL_${op.label}:`);
  if (op.opcode === 0x63) {                              // skip next if var > const
    const n = uid();
    c(`  lda ${V(op.arg1)}`); c(`  cmp #${op.arg2 + 1}`);
    c(`  bcc NOSKIP_${n}`);                              // var<=const -> run next
    c(`  jmp AFTER_${n}`);                               // var>const  -> skip next
    c(`NOSKIP_${n}:`);
    const nxt = ins[i + 1];
    if (nxt.label) c(`LBL_${nxt.label}:`);
    emitOp(nxt);
    c(`AFTER_${n}:`);
    i += 2; continue;
  }
  emitOp(op);
  i++;
}
const codeBody = L.join('\n');

// ---- runtime library (hand-written once, reused by every compiled program) ----
const runtime = `
; ===== runtime library =====
rt_init:
        lda #<BITMAP
        sta ptr
        lda #>BITMAP
        sta ptr+1
        ldx #$00
byrow:  lda ptr
        sta ylo,x
        lda ptr+1
        sta yhi,x
        txa
        and #$07
        cmp #$07
        beq bycell
        clc
        lda ptr
        adc #$01
        sta ptr
        lda ptr+1
        adc #$00
        sta ptr+1
        jmp bynext
bycell: clc
        lda ptr
        adc #<313
        sta ptr
        lda ptr+1
        adc #>313
        sta ptr+1
bynext: inx
        cpx #200
        bne byrow
        ldx #$00
bxlp:   txa
        lsr
        lsr
        sta tmp
        lda #$00
        sta tmp+1
        asl tmp
        rol tmp+1
        asl tmp
        rol tmp+1
        asl tmp
        rol tmp+1
        lda tmp
        sta xoff_lo,x
        lda tmp+1
        sta xoff_hi,x
        inx
        cpx #160
        bne bxlp
        rts

rt_scene_show:
        lda $dd00
        ora #$03
        sta $dd00
        lda #$3b
        sta $d011
        lda #$18
        sta $d016
        lda #$18
        sta $d018
        lda scnbg
        sta $d020
        sta $d021
        lda scnc1               ; screen matrix = (color1<<4)|color2
        asl
        asl
        asl
        asl
        sta tmp
        lda scnc2
        and #$0f
        ora tmp
        ldx #$00
sfill:  sta $0400,x
        sta $0500,x
        sta $0600,x
        sta $0700,x
        inx
        bne sfill
        lda scnc3               ; color RAM = color3
        ldx #$00
cfill:  sta $d800,x
        sta $d900,x
        sta $da00,x
        sta $db00,x
        inx
        bne cfill
        lda #<BITMAP            ; clear 8K bitmap
        sta ptr
        lda #>BITMAP
        sta ptr+1
        ldx #$20
        lda #$00
clrpg:  ldy #$00
clrby:  sta (ptr),y
        iny
        bne clrby
        inc ptr+1
        dex
        bne clrpg
        rts

rt_plot:                        ; plot at GKGM coords (rt_gmx,rt_gmy) with pbits
        lda rt_gmx
        sec
        sbc #12                 ; GM x 12..171 -> mc 0..159
        sta px
        lda rt_gmy
        sec
        sbc #50                 ; GM y 50..249 -> mc 0..199
        sta py
        ldx py
        lda ylo,x
        sta ptr
        lda yhi,x
        sta ptr+1
        ldx px
        lda xoff_lo,x
        clc
        adc ptr
        sta ptr
        lda xoff_hi,x
        adc ptr+1
        sta ptr+1
        lda px
        and #$03
        asl
        asl
        ora pbits
        tax
        lda valtab,x
        sta tmpval
        lda px
        and #$03
        tax
        lda maskt,x
        sta tmpmask
        ldy #$00
        lda (ptr),y
        and tmpmask
        ora tmpval
        sta (ptr),y
        rts

HALT_LOOP: jmp HALT_LOOP

valtab: !byte $00,$40,$80,$c0
        !byte $00,$10,$20,$30
        !byte $00,$04,$08,$0c
        !byte $00,$01,$02,$03
maskt:  !byte $3f,$cf,$f3,$fc
DATA:   !byte ${DATA.join(',')}
RAM:      !fill 256
ylo:      !fill 200
yhi:      !fill 200
xoff_lo:  !fill 160
xoff_hi:  !fill 160
`;

const asm = `; auto-generated from ${fileName} by compile-stars.mjs — do not edit
BITMAP  = $2000
ptr     = $fb
px      = $10
py      = $11
pbits   = $12
tmpval  = $14
tmpmask = $15
rt_gmx  = $16
rt_gmy  = $17
tmp     = $1c
scnbg   = $30
scnc1   = $31
scnc2   = $32
scnc3   = $33

        * = $0801
        !byte $0c,$08, $0a,$00, $9e, $32,$30,$36,$31, $00, $00,$00
entry:
        sei
        lda #$00
        sta $d01a
        jsr rt_init
${codeBody}
${runtime}
`;

writeFileSync(outPath.replace(/\.prg$/, '.asm'), asm);
const r = assemble(asm);
writeFileSync(outPath, Buffer.from(r.prg));
console.log(`compiled ${fileName}: ${ins.length} AST instructions -> ${r.bytes.length} bytes 6502`);
console.log(`  org=$${r.org.toString(16)} end=$${r.end.toString(16)}  DATA=${DATA.length} bytes  -> ${outPath}`);
