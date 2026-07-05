// tools/prg-patch.mjs
//
// AST-mutation helpers for GameMaker PRG files. Wraps the "walk the
// instructions list, apply transforms based on opcode+arg patterns"
// pattern that shows up in every scripted PRG modification.
//
// Typical usage:
//
//   import { bootstrap } from './tools/node-bootstrap.mjs';
//   import { walkAndTransform, instr, addSprite, findMediaIdx } from './tools/prg-patch.mjs';
//
//   const gm = await bootstrap();
//   const disk = new gm.D64(new Uint8Array(readFileSync('mygame.d64')));
//   globalThis.currentDisk = disk;
//   globalThis.loadFileByName = (n) => disk.readFile(n);
//   const pd = gm.parseProgramData(disk.readFile('MYGAME/PRG'));
//
//   // Add a sprite to mediaStore, get its index
//   const idx = addSprite(pd, 'NEW', spriteBytes);
//
//   // Rewrite the program in one pass
//   walkAndTransform(pd, [
//     {
//       // Replace every "sprite N is OLD" with "sprite N is NEW"
//       match: { opcode: 0x27, arg2: findMediaIdx(pd, 'sprite', 'OLD') },
//       action: (inst) => ({ ...inst, arg2: idx }),
//     },
//     {
//       // Widen "if <slotvar> < 3" to "if <slotvar> < 8"
//       match: { opcode: 0x17, arg1: [9,10,11,12,13], arg2: 3 },
//       action: (inst) => ({ ...inst, arg2: 8 }),
//     },
//   ]);
//
//   const bytes = gm.serializeProgram(pd);

// ============================================================================
// Instruction construction
// ============================================================================

/**
 * Build a fresh AST-instruction node. Every instruction the parser produces
 * has this shape; if you're inserting new ones, use this helper so you don't
 * forget the label or instructionName fields.
 */
export function instr(opcode, arg1 = 0, arg2 = 0, name = '', label = 0) {
    return { label, arg1, arg2, opcode, instructionName: name };
}

// ============================================================================
// Instruction matching
// ============================================================================

/**
 * matcher spec — an object where each field is optional and can be:
 *   - literal (number)       → must equal exactly
 *   - array of values        → must be one of them
 *   - function (v, inst)     → predicate; must return truthy
 *
 * Supported fields: opcode, arg1, arg2, label, instructionName.
 *
 * Example:
 *   { opcode: 0x27 }                          — exact opcode
 *   { opcode: [0x13, 0x15, 0x17] }            — any of these opcodes
 *   { arg1: v => v >= 3 && v <= 7 }           — predicate
 *   { opcode: 0x0B, arg1: 1, arg2: [40,66] }  — mixed
 */
export function matches(inst, spec) {
    if (!spec) return true;
    for (const key of Object.keys(spec)) {
        const expect = spec[key];
        const actual = inst[key];
        if (Array.isArray(expect)) {
            if (!expect.includes(actual)) return false;
        } else if (typeof expect === 'function') {
            if (!expect(actual, inst)) return false;
        } else {
            if (actual !== expect) return false;
        }
    }
    return true;
}

/**
 * Find the first instruction matching spec. Returns { idx, inst } or null.
 */
export function findFirst(instructions, spec) {
    for (let i = 0; i < instructions.length; i++) {
        if (matches(instructions[i], spec)) return { idx: i, inst: instructions[i] };
    }
    return null;
}

/**
 * Find all instructions matching spec.
 */
export function findAll(instructions, spec) {
    const out = [];
    for (let i = 0; i < instructions.length; i++) {
        if (matches(instructions[i], spec)) out.push({ idx: i, inst: instructions[i] });
    }
    return out;
}

// ============================================================================
// Block finding (if / endif matching)
// ============================================================================

/**
 * These opcodes open a new nesting level (mirrors what buildAST tracks).
 * If you're writing a program with a new "if" variant, add its opcode here.
 */
export const OP_IF_SET = new Set([
    0x13, 0x14, 0x15, 0x16, 0x17, 0x18,   // if var (=|<|>) (literal|var)
    0x19, 0x1A,                             // if joystick / button
    0x1B,                                   // if sprite hit sprite
    0x4A, 0x4B, 0x4C,                       // if score comparisons
]);

/**
 * Given the index of an "if" instruction, find the index of its matching
 * "endif" (opcode 0x55). Returns the endif's index, or -1 if not found.
 * Nested ifs are handled correctly.
 */
export function findBlockEnd(instructions, startIdx) {
    if (!OP_IF_SET.has(instructions[startIdx].opcode)) return -1;
    let depth = 1;
    for (let j = startIdx + 1; j < instructions.length; j++) {
        const op = instructions[j].opcode;
        if (OP_IF_SET.has(op)) depth++;
        else if (op === 0x55) {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
}

// ============================================================================
// walkAndTransform — the workhorse
// ============================================================================

/**
 * Walk `pd.instructions` once, applying the first matching rule to each
 * instruction. Rules are checked in order; the first `match` that fits wins.
 *
 * Actions (returned by rule.action(inst, idx, ctx)):
 *   undefined | null        — keep the instruction as-is
 *   Instruction (object with opcode field)   — replace one-for-one
 *   Instruction[]           — replace this instruction with these
 *   { delete: true }        — remove this instruction
 *   { replaceBlock: Instruction[] } — replace this instruction AND everything
 *                                     through its matching endif with these.
 *                                     Only valid when this instr is an "if".
 *   { insertBefore: Instruction[], keep?: boolean } — insert before this
 *                             instruction; keep the original unless keep=false
 *   { insertAfter: Instruction[], keep?: boolean }  — insert after this
 *
 * Rules can carry a `describe` string for logging. Returns a stats object
 * counting how many times each rule fired.
 */
export function walkAndTransform(pd, rules, { verbose = false } = {}) {
    const oldInstrs = pd.instructions;
    const newInstrs = [];
    const stats = rules.map(r => ({ describe: r.describe || '(unnamed)', hits: 0 }));

    let i = 0;
    while (i < oldInstrs.length) {
        const cur = oldInstrs[i];
        let handled = false;

        for (let ri = 0; ri < rules.length; ri++) {
            const rule = rules[ri];
            if (!matches(cur, rule.match)) continue;
            stats[ri].hits++;

            const result = rule.action(cur, i, { oldInstrs, newInstrs });
            handled = true;

            if (result === undefined || result === null) {
                newInstrs.push(cur);
                i++;
            } else if (Array.isArray(result)) {
                newInstrs.push(...result);
                i++;
            } else if (result.delete === true) {
                i++;
            } else if (result.replaceBlock) {
                const endIdx = findBlockEnd(oldInstrs, i);
                if (endIdx < 0) throw new Error(`replaceBlock: no matching endif for instr at idx ${i}`);
                newInstrs.push(...result.replaceBlock);
                i = endIdx + 1;
            } else if (result.insertBefore) {
                newInstrs.push(...result.insertBefore);
                if (result.keep !== false) newInstrs.push(cur);
                i++;
            } else if (result.insertAfter) {
                if (result.keep !== false) newInstrs.push(cur);
                newInstrs.push(...result.insertAfter);
                i++;
            } else if (result.opcode !== undefined) {
                // Single instruction — replace one-for-one
                newInstrs.push(result);
                i++;
            } else {
                throw new Error('walkAndTransform: unrecognized action result: ' + JSON.stringify(result));
            }
            break; // First matching rule wins
        }

        if (!handled) {
            newInstrs.push(cur);
            i++;
        }
    }

    if (verbose) {
        console.log('walkAndTransform stats:');
        for (const s of stats) console.log(`  ${s.hits.toString().padStart(4)} — ${s.describe}`);
    }

    pd.instructions = newInstrs;
    return { stats, oldLength: oldInstrs.length, newLength: newInstrs.length };
}

// ============================================================================
// Media store helpers
// ============================================================================

/**
 * Find the media store index of an entry by type + case-insensitive name.
 * Returns -1 if not found.
 */
export function findMediaIdx(pd, type, name) {
    const target = name.toUpperCase().trim();
    for (let i = 0; i < pd.mediaStore.length; i++) {
        const e = pd.mediaStore[i];
        if (!e) continue;
        if (e.type === type && (e.name || '').toUpperCase().trim() === target) return i;
    }
    return -1;
}

/**
 * Add a sprite to the mediaStore. Constructs a gmSprite instance from the
 * bytes so the serializer knows how to emit it. Returns the assigned index.
 */
export function addSprite(pd, name, spriteFileData) {
    if (!globalThis.gmSprite) {
        throw new Error('addSprite: globalThis.gmSprite not loaded — call bootstrap() first');
    }
    const entry = {
        name: name.padEnd(6, ' ').substring(0, 6),
        type: 'sprite',
        sprite: new globalThis.gmSprite(spriteFileData),
        spriteFileData,
        quadIndex: 0,
    };
    pd.mediaStore.push(entry);
    return pd.mediaStore.length - 1;
}

/**
 * Add a sound to the mediaStore.
 */
export function addSound(pd, name, soundFileData) {
    const entry = {
        name: name.padEnd(6, ' ').substring(0, 6),
        type: 'sound',
        soundFileData,
    };
    pd.mediaStore.push(entry);
    return pd.mediaStore.length - 1;
}

// ============================================================================
// Convenience: variable-letter <-> 1-based index conversion
// ============================================================================

/**
 * GameMaker variables are 1-based: a=1, b=2, ..., z=26. Opcode arg values
 * use this convention.
 */
export function varIndex(letter) {
    const code = letter.toLowerCase().charCodeAt(0);
    if (code < 97 || code > 122) throw new Error(`varIndex: not a letter: ${letter}`);
    return code - 96;
}

export function varLetter(index) {
    if (index < 1 || index > 26) throw new Error(`varLetter: out of range: ${index}`);
    return String.fromCharCode(96 + index);
}
