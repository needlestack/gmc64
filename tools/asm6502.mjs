// asm6502.mjs — a tiny, dependency-free 6502 assembler.
//
// Purpose: this is the seed of GMC64's native-6502 codegen backend. Today it
// assembles hand-written .asm (e.g. the native STARS demo); the eventual
// GKGM+ → 6502 compiler will emit into the same opcode tables directly instead
// of going through text. Kept pure-JS / zero-dependency to match GMC64's ethos.
//
// Supported syntax (ACME-flavored, deliberately minimal):
//   * = $0302            set origin (program counter)
//   name = expr          define a constant/symbol
//   label:               define a label at the current PC (also `label: LDA ...`)
//   LDA #$00  STA $D020  STA $2000,X  LDA ($fb),Y  JMP ($fffc) ...
//   !byte 1,$02,%011     emit bytes
//   !word $1234, label   emit little-endian words
//   !fill count, value   emit `count` copies of `value` (default 0)
//   ; comment            (also whole-line comments)
// Expressions: + - , unary <lo/>hi byte, `*` = current PC, $hex %bin decimal,
//   symbols. Left-to-right, no precedence needed for this use.
//
// assemble(source, {origin}) -> { prg, bytes, org, end, labels, listing }
//   prg   : Uint8Array with the 2-byte little-endian load address prepended
//   bytes : Uint8Array of just the assembled code
//   org   : load address; end : one past last byte

const OPCODES = {
  ADC:{imm:0x69,zp:0x65,zpx:0x75,abs:0x6D,absx:0x7D,absy:0x79,indx:0x61,indy:0x71},
  AND:{imm:0x29,zp:0x25,zpx:0x35,abs:0x2D,absx:0x3D,absy:0x39,indx:0x21,indy:0x31},
  ASL:{acc:0x0A,zp:0x06,zpx:0x16,abs:0x0E,absx:0x1E},
  BCC:{rel:0x90}, BCS:{rel:0xB0}, BEQ:{rel:0xF0}, BMI:{rel:0x30},
  BNE:{rel:0xD0}, BPL:{rel:0x10}, BVC:{rel:0x50}, BVS:{rel:0x70},
  BIT:{zp:0x24,abs:0x2C}, BRK:{imp:0x00},
  CLC:{imp:0x18}, CLD:{imp:0xD8}, CLI:{imp:0x58}, CLV:{imp:0xB8},
  CMP:{imm:0xC9,zp:0xC5,zpx:0xD5,abs:0xCD,absx:0xDD,absy:0xD9,indx:0xC1,indy:0xD1},
  CPX:{imm:0xE0,zp:0xE4,abs:0xEC}, CPY:{imm:0xC0,zp:0xC4,abs:0xCC},
  DEC:{zp:0xC6,zpx:0xD6,abs:0xCE,absx:0xDE}, DEX:{imp:0xCA}, DEY:{imp:0x88},
  EOR:{imm:0x49,zp:0x45,zpx:0x55,abs:0x4D,absx:0x5D,absy:0x59,indx:0x41,indy:0x51},
  INC:{zp:0xE6,zpx:0xF6,abs:0xEE,absx:0xFE}, INX:{imp:0xE8}, INY:{imp:0xC8},
  JMP:{abs:0x4C,ind:0x6C}, JSR:{abs:0x20},
  LDA:{imm:0xA9,zp:0xA5,zpx:0xB5,abs:0xAD,absx:0xBD,absy:0xB9,indx:0xA1,indy:0xB1},
  LDX:{imm:0xA2,zp:0xA6,zpy:0xB6,abs:0xAE,absy:0xBE},
  LDY:{imm:0xA0,zp:0xA4,zpx:0xB4,abs:0xAC,absx:0xBC},
  LSR:{acc:0x4A,zp:0x46,zpx:0x56,abs:0x4E,absx:0x5E}, NOP:{imp:0xEA},
  ORA:{imm:0x09,zp:0x05,zpx:0x15,abs:0x0D,absx:0x1D,absy:0x19,indx:0x01,indy:0x11},
  PHA:{imp:0x48}, PHP:{imp:0x08}, PLA:{imp:0x68}, PLP:{imp:0x28},
  ROL:{acc:0x2A,zp:0x26,zpx:0x36,abs:0x2E,absx:0x3E},
  ROR:{acc:0x6A,zp:0x66,zpx:0x76,abs:0x6E,absx:0x7E},
  RTI:{imp:0x40}, RTS:{imp:0x60},
  SBC:{imm:0xE9,zp:0xE5,zpx:0xF5,abs:0xED,absx:0xFD,absy:0xF9,indx:0xE1,indy:0xF1},
  SEC:{imp:0x38}, SED:{imp:0xF8}, SEI:{imp:0x78},
  STA:{zp:0x85,zpx:0x95,abs:0x8D,absx:0x9D,absy:0x99,indx:0x81,indy:0x91},
  STX:{zp:0x86,zpy:0x96,abs:0x8E}, STY:{zp:0x84,zpx:0x94,abs:0x8C},
  TAX:{imp:0xAA}, TAY:{imp:0xA8}, TSX:{imp:0xBA}, TXA:{imp:0x8A},
  TXS:{imp:0x9A}, TYA:{imp:0x98},
};

const BRANCHES = new Set(['BCC','BCS','BEQ','BMI','BNE','BPL','BVC','BVS']);

// modes that take a 1-byte operand
const ONE_BYTE = new Set(['imm','zp','zpx','zpy','indx','indy','rel']);
// modes that take a 2-byte operand
const TWO_BYTE = new Set(['abs','absx','absy','ind']);

function strip(line) {
  // remove ; comments not inside... (no strings in our asm, so simple)
  const i = line.indexOf(';');
  return (i >= 0 ? line.slice(0, i) : line).trim();
}

// Tokenize an expression into numbers/symbols/operators and evaluate.
// Supports leading < (low byte) or > (high byte), then terms joined by + / -.
function evalExpr(expr, symbols, pc) {
  expr = expr.trim();
  let byteSel = null;
  if (expr[0] === '<') { byteSel = 'lo'; expr = expr.slice(1); }
  else if (expr[0] === '>') { byteSel = 'hi'; expr = expr.slice(1); }
  // split on + and - while keeping the operators
  const parts = expr.split(/([+\-])/).map(s => s.trim()).filter(s => s !== '');
  let acc = 0, op = '+';
  for (const p of parts) {
    if (p === '+' || p === '-') { op = p; continue; }
    let v;
    if (p === '*') v = pc;
    else if (p[0] === '$') v = parseInt(p.slice(1), 16);
    else if (p[0] === '%') v = parseInt(p.slice(1), 2);
    else if (/^[0-9]/.test(p)) v = parseInt(p, 10);
    else {
      if (!(p in symbols)) throw new Error(`undefined symbol: ${p}`);
      v = symbols[p];
    }
    if (Number.isNaN(v)) throw new Error(`bad number: ${p}`);
    acc = op === '+' ? acc + v : acc - v;
  }
  if (byteSel === 'lo') return acc & 0xFF;
  if (byteSel === 'hi') return (acc >> 8) & 0xFF;
  return acc;
}

// Parse the operand text of an instruction into { mode, expr }.
// `known` (pass 2) lets us resolve zp-vs-abs by value; in pass 1 we size
// conservatively: numeric literal < $100 => zp, otherwise abs.
function parseOperand(mnem, operand, symbols, pc, resolve) {
  if (operand === '' || operand === undefined) {
    // bare mnemonic: implied, or accumulator for shift/rotate (ASL, LSR, ...)
    if ('imp' in OPCODES[mnem]) return { mode: 'imp' };
    if ('acc' in OPCODES[mnem]) return { mode: 'acc' };
    return { mode: 'imp' };
  }
  const o = operand.trim();
  if (o === 'A' || o === 'a')
    return { mode: 'acc' };
  if (o[0] === '#')
    return { mode: 'imm', expr: o.slice(1) };

  // indirect forms
  let m;
  if ((m = o.match(/^\(\s*(.+?)\s*,\s*[xX]\s*\)$/)))
    return { mode: 'indx', expr: m[1] };
  if ((m = o.match(/^\(\s*(.+?)\s*\)\s*,\s*[yY]$/)))
    return { mode: 'indy', expr: m[1] };
  if ((m = o.match(/^\(\s*(.+?)\s*\)$/)))
    return { mode: 'ind', expr: m[1] };

  // ,X / ,Y indexed
  if ((m = o.match(/^(.+?)\s*,\s*[xX]$/))) {
    const expr = m[1];
    const zpOk = 'zpx' in OPCODES[mnem];
    return { mode: sizeMode(expr, symbols, pc, resolve, zpOk, 'zpx', 'absx'), expr };
  }
  if ((m = o.match(/^(.+?)\s*,\s*[yY]$/))) {
    const expr = m[1];
    const zpOk = 'zpy' in OPCODES[mnem];
    return { mode: sizeMode(expr, symbols, pc, resolve, zpOk, 'zpy', 'absy'), expr };
  }

  // plain operand: branch (rel), else zp/abs
  if (BRANCHES.has(mnem))
    return { mode: 'rel', expr: o };
  const zpOk = 'zp' in OPCODES[mnem];
  return { mode: sizeMode(o, symbols, pc, resolve, zpOk, 'zp', 'abs'), expr: o };
}

function sizeMode(expr, symbols, pc, resolve, zpOk, zpMode, absMode) {
  if (!zpOk) return absMode;
  // Try to resolve the value; if it resolves and fits in a byte, use zp.
  try {
    const v = evalExpr(expr, symbols, pc);
    if (v >= 0 && v < 0x100) return zpMode;
    return absMode;
  } catch {
    // unresolved (forward label) — assume abs so sizing is stable across passes
    return resolve ? absMode : absMode;
  }
}

export function assemble(source, opts = {}) {
  const lines = source.split(/\r?\n/);
  const symbols = Object.create(null);

  // ---- structured parse (shared by both passes) ----
  const parsed = [];
  for (let ln = 0; ln < lines.length; ln++) {
    let text = strip(lines[ln]);
    if (text === '') continue;
    // leading label?  `foo:` or `foo: LDA ...`
    let m = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/);
    let label = null;
    if (m) { label = m[1]; text = m[2].trim(); }
    parsed.push({ ln: ln + 1, label, text });
  }

  // ---- pass 1: assign addresses to labels, size everything ----
  let pc = opts.origin ?? 0x0801;
  let originSet = opts.origin !== undefined;
  const sized = [];
  for (const item of parsed) {
    if (item.label) symbols[item.label] = pc;
    let t = item.text;
    if (t === '') { sized.push({ ...item, kind: 'none' }); continue; }

    // directives
    if (t[0] === '*') {
      const m = t.match(/^\*\s*=\s*(.+)$/);
      pc = evalExpr(m[1], symbols, pc);
      originSet = true;
      sized.push({ ...item, kind: 'org', pc });
      continue;
    }
    // constant assignment:  name = expr   (but not '==' etc.)
    let am = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (am) {
      symbols[am[1]] = evalExpr(am[2], symbols, pc);
      sized.push({ ...item, kind: 'equ' });
      continue;
    }
    if (t[0] === '!') {
      const [dir, ...rest] = t.slice(1).split(/\s+/);
      const argstr = t.slice(1 + dir.length).trim();
      let size = 0;
      if (dir === 'byte' || dir === 'byt') size = argstr.split(',').length;
      else if (dir === 'word') size = argstr.split(',').length * 2;
      else if (dir === 'fill') {
        const count = evalExpr(argstr.split(',')[0], symbols, pc);
        size = count;
      } else throw new Error(`line ${item.ln}: unknown directive !${dir}`);
      sized.push({ ...item, kind: 'data', dir, argstr, at: pc });
      pc += size;
      continue;
    }

    // instruction
    const sp = t.indexOf(' ');
    const mnem = (sp < 0 ? t : t.slice(0, sp)).toUpperCase();
    const operand = sp < 0 ? '' : t.slice(sp + 1).trim();
    if (!(mnem in OPCODES)) throw new Error(`line ${item.ln}: unknown mnemonic ${mnem}`);
    const { mode, expr } = parseOperand(mnem, operand, symbols, pc, false);
    if (!(mode in OPCODES[mnem]))
      throw new Error(`line ${item.ln}: ${mnem} has no ${mode} addressing mode`);
    const len = 1 + (ONE_BYTE.has(mode) ? 1 : TWO_BYTE.has(mode) ? 2 : 0);
    sized.push({ ...item, kind: 'insn', mnem, operand, mode, expr, at: pc, len });
    pc += len;
  }

  // ---- pass 2: emit bytes ----
  const org = opts.origin ?? (sized.find(s => s.kind === 'org')?.pc) ?? 0x0801;
  const out = [];
  const listing = [];
  const emitAt = new Map(); // pc -> index in out (contiguous assumed)
  let cur = org;
  const emit = (b) => { out.push(b & 0xFF); cur++; };

  for (const s of sized) {
    if (s.kind === 'org') { cur = s.pc; continue; }
    if (s.kind === 'equ' || s.kind === 'none') continue;
    if (s.kind === 'data') {
      const start = cur;
      if (s.dir === 'byte' || s.dir === 'byt') {
        for (const a of s.argstr.split(',')) emit(evalExpr(a, symbols, cur));
      } else if (s.dir === 'word') {
        for (const a of s.argstr.split(',')) {
          const v = evalExpr(a, symbols, cur);
          emit(v & 0xFF); emit((v >> 8) & 0xFF);
        }
      } else if (s.dir === 'fill') {
        const args = s.argstr.split(',');
        const count = evalExpr(args[0], symbols, cur);
        const val = args.length > 1 ? evalExpr(args[1], symbols, cur) : 0;
        for (let i = 0; i < count; i++) emit(val);
      }
      listing.push({ at: start, bytes: out.slice(start - org), src: s.text });
      continue;
    }
    // insn
    const op = OPCODES[s.mnem][s.mode];
    const startIdx = out.length;
    emit(op);
    if (s.mode === 'imp' || s.mode === 'acc') {
      // no operand
    } else if (s.mode === 'rel') {
      const target = evalExpr(s.expr, symbols, cur + 1); // rel is from next insn
      const rel = target - (cur + 1);
      if (rel < -128 || rel > 127)
        throw new Error(`line ${s.ln}: branch out of range (${rel})`);
      emit(rel & 0xFF);
    } else if (ONE_BYTE.has(s.mode)) {
      emit(evalExpr(s.expr, symbols, cur));
    } else {
      const v = evalExpr(s.expr, symbols, cur);
      emit(v & 0xFF); emit((v >> 8) & 0xFF);
    }
    listing.push({ at: s.at, bytes: out.slice(startIdx), src: `${s.mnem} ${s.operand}`.trim() });
  }

  const bytes = Uint8Array.from(out);
  const prg = new Uint8Array(bytes.length + 2);
  prg[0] = org & 0xFF; prg[1] = (org >> 8) & 0xFF;
  prg.set(bytes, 2);
  return { prg, bytes, org, end: org + bytes.length, labels: symbols, listing };
}

// Small CLI: node asm6502.mjs in.asm out.prg
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import('fs');
  const [, , inFile, outFile] = process.argv;
  const src = readFileSync(inFile, 'utf8');
  const r = assemble(src);
  writeFileSync(outFile, Buffer.from(r.prg));
  const hi = Math.max(...Object.values(r.labels));
  console.error(`assembled ${inFile}: org=$${r.org.toString(16)} end=$${r.end.toString(16)} ` +
    `(${r.bytes.length} bytes) -> ${outFile}`);
}
