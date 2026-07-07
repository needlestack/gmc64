# GMC64 Technical Documentation

> A faithful, modern recreation of Garry Kitchen's GameMaker (Activision, 1985).

gmc64 lets you build, run, and edit C64-style games in the browser, with original-format .PRG, .SPR, .SND, .SNG, and .PIC files stored on D64 disk images. Files round-trip cleanly with the original 1985 GameMaker disk running on real C64 hardware.

This document is the internal engineering reference — architecture, file formats, gotchas, and recipes for working in the codebase. Reader-facing overview lives in `README.md`.

## Quick Reference

| Item | Value |
|------|-------|
| Music tempo | `gmMusic.BASE_BPM = 140` (tempo 80 = 140 BPM) |
| Screen resolution | 320×200 native, CSS scales to display |
| Coordinate system | GM fat pixels: X 12-171, Y 50-249 → 320×200: `(x-12)*2, y-50` |
| Movement formula | X: `speed / 46`, Y: `speed / 31.5` at 60fps (C64 pixels aren't square) |
| Animation formula | `frame_skip = 32 - animSpeed` |
| File separator | `/` not `.` (PETSCII): `PLAYER/SPR` not `PLAYER.SPR` |

## Project Structure

```
├── editor.html          Program editor/runner (AST-based VM)
├── sprite-maker.html    Sprite editor
├── scene-maker.html     Scene editor
├── sound-maker.html     Sound effect editor
├── music-maker.html     Music editor
├── js/
│   ├── gmRuntime.js     VM execution, sprites, collision
│   ├── gmParser.js      Bytecode → AST parsing
│   ├── gmSprite.js      Sprite parsing/rendering
│   ├── gmScene.js       Scene parsing (indexed pixel buffer)
│   ├── gmSound.js       Sound effects (Web Audio + SID emulation)
│   ├── gmMusic.js       Music playback (3-channel)
│   ├── gmDisk.js        D64 disk + localStorage persistence
│   ├── gmEditor.js      Instruction editor UI
│   ├── gmOpcodes.js     Opcode definitions
│   ├── gmCharset.js     C64 font rendering
│   ├── gmTools.js       Shared utilities
│   ├── d64lib.js        Pure D64/1541 disk parsing
│   ├── c64lib.js        C64 palette, PETSCII decoding
│   ├── c64Screen.js     320×200 canvas wrapper
│   ├── gif.js           GIF library (jnordberg/gif.js)
│   └── gifWorkerBlob.js GIF worker as inline blob (avoids file:// security restrictions)
├── css/
│   └── gm-ui.css        Master stylesheet (C64 colors, fonts, components)
├── tests/
│   ├── *.test.js        Vitest test files
│   ├── generate-golden-*.js  Golden file generators
│   ├── golden/          Golden snapshot files (JSON)
│   └── disks/           Test D64 disk images
├── tools/
│   ├── screenshot.js    Puppeteer screenshot utility
│   └── hex-viewer.html  Hex dump viewer
└── docs/
    ├── TODO.md          Future improvements
    └── references/      Reference materials
```

## Architecture Decisions

**Separate HTML pages (not SPA):** Each editor owns its state. Browser handles cleanup. Shared disk state via localStorage.

**AST execution with parent pointers:** Programs parsed into tree with `.parent` and `.parentIndex`. Jumps can target any label. No execution stack needed.

**Per-slot sprite instances:** 8 sprite slots, each gets own gmSprite instance. Critical for games where same sprite appears in multiple slots with different colors.

**Lazy palette resolution:** Sprites/scenes store C64 color indices (0-15), not RGB. Resolved at render time. Color changes just set dirty flag.

**Indexed pixel buffer:** Scenes use 160×200 Uint8Array of palette indices. Print/score writes to buffer. 16-30x faster than fillRect.

**320×200 native resolution:** All rendering at C64's true resolution. CSS scales to display. Simplifies coordinate math and collision detection.

## Data Architecture & Serialization

### Sources of Truth & Lifecycle

**LOADING (PRG → in-memory):**
1. PRG file (with binary data page) is the source of truth
2. `parseProgramData()` extracts: instructions (AST), mediaStore (JS objects)
3. After parsing, AST + mediaStore become the source of truth
4. Original PRG binary is no longer needed

**EDITING (in-memory):**
- AST: User edits instructions via editor UI
- mediaStore: User assigns sprites/sounds via editor UI
- Both are modified independently

**SAVING (in-memory → PRG):**
1. AST + mediaStore are the source of truth
2. `serializeProgram()` walks AST to find referenced media
3. Fresh binary data page is BUILT (output, not input)
4. Compact pointer table assigned (no gaps)
5. Result is a new PRG file

The editor maintains two sources of truth for program state:

1. **AST** (`currentProgramData.instructions`) - The instruction list, editable by the user
2. **Media Store** (`currentProgramData.mediaStore`) - JS array of media objects (gmSprite, gmSound, gmScene, gmMusic)

**IMPORTANT:** The JS property is `mediaStore`, NOT to be confused with "data page" which refers to raw binary data in PRG files. The mediaStore is a collection of JS objects, NOT raw binary data.

### Media Store Structure

```javascript
mediaStore[0] = null;  // Index 0 unused
mediaStore[1] = { name: "PLAYER", type: "sprite", sprite: gmSprite, spriteFileData: Uint8Array, ... }
mediaStore[2] = { name: "BOOM",   type: "sound", soundFileData: Uint8Array, ... }
mediaStore[3] = { name: "THEME",  type: "song",  songFileData: Uint8Array, ... }
// etc.
```

Instructions reference media by index: `sprite 0 is [1]` → use mediaStore[1].

### Serialization Architecture

The serializer (`serializeProgram` in gmParser.js) builds a PRG file from the sources of truth.

**8-Phase Process:**

1. **Walk AST to collect referenced media** - Scan instructions for media opcodes (0x27 sprite, 0x28 scene, 0x40 sound, 0x60 song), collect old mediaStore indices

2. **Build index remapping** - Assign fresh sequential indices starting from 1. Example: `{3→1, 7→2, 8→3}`. This creates a compact pointer table with no gaps.

3. **Serialize instructions with remapped arg2** - Write 4-byte instructions, but remap arg2 for media-referencing opcodes to use new compact indices

4. **Serialize referenced media** - Iterate referenced entries, serialize to binary, record offsets using NEW compact indices

5. **Build compact pointer table** - Sequential entries `[sentinel, entry1, entry2, ...]`, no placeholders needed

6. **Update string reference pointers** - Fix print/comment instruction pointers

7. **Assemble complete file** - Combine all sections into final byte array

8. **Write entry names region** - Last 79 bytes for editor state

**Key principles:**
- AST is source of truth for instructions
- Media store is source of truth for media objects
- Binary data page is an OUTPUT, built fresh each time
- Only referenced media is serialized (orphaned entries ignored)
- Fresh compact indices assigned at serialize time (no gaps in pointer table)

### PRG File Components

| Region | Bytes | Purpose |
|--------|-------|---------|
| Load address | 0-1 | C64 memory location ($0400) |
| Label table | 2-513 | Maps label numbers to instruction addresses |
| Program length | 514-515 | Size of instruction section |
| Data size | 516-517 | Size of data section |
| Reserved | 518-522 | Zeros |
| Instructions | 523+ | 4 bytes each: [label, arg1, opcode, arg2] |
| Data section | after instructions | Sprites, sounds, songs, strings, comments |
| Pointer table | end of file | 2-byte entries, read backwards from byte -81 |

### Label Table (bytes 2-513)

Maps label numbers (1-255) to instruction memory addresses:
- Label N low byte: `file[N + 2]`
- Label N high byte: `file[N + 258]`

The address is calculated from the instruction's position in the bytecode.

## File Formats

### .SND (Sound Effects)
- Bytes 0-4: Magic `00 A0 47 45 4B`
- Byte 12: Repeat count
- Byte 14: Speed (XOR'd with 128)
- Byte 17: Frame count
- Bytes 18+: Frame data (16 bytes each)

### .SNG (Music)
- Bytes 0-4: Load addr + "GEK"
- Byte 20: Tempo (80 = 140 BPM, linear scaling)
- Bytes 21-23: Instrument per channel (0-13)
- Bytes 34+: Note data by channel (`<duration> <pitch>` pairs, `FF FF` = end)
- Duration: 0x00=32nd, 0x07=quarter, 0x0F=half, 0x1F=whole. +0x20=tied, +0x40=rest
- Pitch: 0x26 = A440, +1 = semitone up

### .SPR (Sprites)
- 37-byte header with position, colors, flags, frame count
- Each frame: 64 bytes (24×21 pixels)
- Multicolor: 12 fat pixels wide, hi-res: 24 thin pixels

### .PIC (Scenes)
- 6-byte header (magic + RLE flag)
- 8000 bytes pixel data (160×200, 4 colors, 2 bits per pixel)
- 10-byte footer with colors and name

### .PRG (Programs)
- Bytes 0-513: Pre-header region (see "Open Questions" below)
- Bytes 514-515: Program length (little-endian, add to 514 to get PROGRAM_END)
- Bytes 516-517: Data size (little-endian, subtract from OFFSET 0x3D90 for DATA_END)
- Bytes 518-522: Reserved
- Bytes 523+: Program bytecode (4 bytes per instruction: label, arg1, opcode, arg2)
- After program: Embedded asset data (sprites, sounds, songs, comments, print strings)
- End of file: Pointer table (read backwards from byte -81)
- Total file size: `PROGRAM_END + DATA_END + 623` (623 = gap + pointer table + slot names)

### Standalone files (GameMaker "export to standalone" output)

A standalone is a full ~48KB C64 memory image ($0302..$BFFE) that boots
itself via the `LOAD ",8,1"` trick — load address $0302 overwrites the IRQ
vector so the next interrupt jumps into user code. The image bundles the
GameMaker runtime + a program together, so it plays without needing the
editor.

`standaloneToPRG(bytes)` in `gmParser.js` extracts an editor-format `.PRG`
from a standalone file. Once extracted, the result parses through
`parseProgramData` exactly like any editor-saved program.

Fixed offsets used by the extractor (verified against the demo disk's
ALIENS/PRG exported to standalone):

| standalone file | standalone memory | content |
|---|---|---|
| 0x8000–0x81FF | $8300–$84FF | label table (512 bytes) |
| 0x8200–0x8208 | $8500–$8508 | programLen, dataSize, 5 reserved |
| 0x8209–0x84FC | $8509–$87FC | bytecode HEAD (ins 0..188) |
| 0x05FD+       | $08FD+      | bytecode TAIL (ins 189..end, runtime working copy) |
| dataSize→$3D90 | $[dataSize]..$3D8F | data section content |
| $3F9C+        | $3F9C+      | pointer table (2-byte entries, sentinel 0x3D90) |
| $3FB0+        | $3FB0+      | slot names region (79 bytes editor state) |

Why the bytecode is split across two chunks: runtime machine code starts
at memory $8800 and clobbers the tail of the loaded PRG at $8509. Only
ins 0..188 survive there. The runtime keeps a working copy of the rest
at $08FD onward. The two chunks overlap at ~ins 127..188 (both valid);
the extractor splices at ins 189 for a clean boundary.

Header value quirk: `programLen` field's high byte is stored `+6` from
its true value. `parseProgramData` and `standaloneToPRG` both undo that
(`decode16bit(low, high - 6)`) when computing PROGRAM_END.

**Scene recovery** (`standaloneToScenes`): scenes are referenced by disk
filename (e.g. `STARS /PIC`) in the .PRG format, so `parseProgramData`
tries to load them via `loadFileByName`. Standalones don't ship with a
disk — but the runtime reserves TWO fixed scene slots in the C64 VIC-II
address space:

| slot | bitmap | footer | notes |
|---|---|---|---|
| 1 | $6000 | $7F40 | VIC bank 1 hi-res bitmap |
| 2 | $A000 | $BF40 | VIC bank 2 hi-res bitmap |

Both are always allocated (the 191-block standalone file size is fixed).
Each slot is 8000 pixel bytes + 10-byte palette+name footer.
`standaloneToScenes` probes both and returns whichever have valid names,
keyed by disk filename convention (`{NAME  }/PIC`). Games using one
scene return one entry; games using two return both.

Verified byte-perfect on ALIENS (one scene, STARS) and on multi-scene
game exports (both slots populated with distinct names). Single-scene
games return just one entry at $A000.

### PRG Multi-Part Sprite Parsing (CRITICAL)

**ARCHITECTURAL RULE: Multi-part sprites are ALWAYS a single gmSprite object.**

A multi-part sprite (1-4 quads) must be composed into ONE gmSprite instance with all quads in its internal array. Never treat quads as separate sprite objects. Why:
- Movement, animation, position, direction, speed all apply to the whole sprite
- Treating quads separately would require synchronizing these properties at dozens of places in the runtime code
- Edge cases with single-object approach are manageable; normal cases with separate-object approach are a nightmare
- The parent slot renders all quads; subsprite slots are just markers for override detection

**DO:** Compose multi-part sprites at parse time into one gmSprite buffer.
**DON'T:** Load each quad as a separate gmSprite and try to synchronize them at runtime.

PRG files store each quad of a multi-part sprite as a **separate data page entry** with its own pointer. The entries may be scattered in the pointer table (not necessarily consecutive). The parser must:

1. **Collect raw sprite data** from all referenced PRG indices, including header fields:
   - `spriteNum` (byte 22): Which quad this is (1=main, 2/3/4=subsprite)
   - `numSprites` (byte 14): Total quads in the multi-part sprite (1-4)

2. **Analyze instruction order** to find pairings. When program does:
   ```
   sprite 1 is SAUCER   // main sprite, numSprites=4
   sprite 2 is -SAUCE   // subsprite quad 2
   sprite 3 is -SAUCE   // subsprite quad 3
   sprite 4 is -SAUCE   // subsprite quad 4
   ```
   The parser looks for "slot 1 = main" followed by N-1 consecutive "slot N = sub" assignments.
   **IMPORTANT:** A 4-quad sprite needs 3 subsprite pairings, not just 1!

3. **Compose multi-part sprites** by concatenating main + all subsprite data into one gmSprite buffer.

4. **Build clean mediaStore** with new sequential indices (not PRG's scattered indices).

5. **Remap instruction args** to point to new mediaStore indices.

**Test cases:** Always verify with 1-quad, 2-quad, 3-quad, and 4-quad sprites — GMC64I/PRG embeds the 4-quad SAUCER which exercises the worst-case path.

Note: Sprites/sounds embedded in PRG files do NOT have the 5-byte magic header that standalone .SPR/.SND files have.

### PRG Parsing & Serialization (gmParser.js)

**Parsing:** `parseProgramData(fileData)` extracts:
- Instructions (the AST)
- Media store entries (sprites, sounds, songs parsed into JS objects)
- Label map, data tables

**Serializing:** `serializeProgram(programData)` builds a fresh PRG file:
- Walks AST to find referenced media
- Serializes only what's needed into fresh binary data page
- Builds pointer table and label table
- See "Data Architecture & Serialization" section above for details

**Pointer table formula:**
```javascript
dataPointer = (PROGRAM_END + DATA_END) - dataStart;
rawAddr = OFFSET - dataPointer;  // OFFSET = 0x3D90
```

## Writing programs programmatically

The parse → modify → serialize round-trip is stable enough to author or
mutate programs from Node scripts (headless generation, batch changes,
tests). The canonical pattern:

```js
const pd = parseProgramData(disk.readFile('MYGAME/PRG'));  // { instructions, mediaStore, labelMap, ... }
// ...mutate pd.instructions and/or pd.mediaStore...
const newBytes = serializeProgram(pd);
disk.deleteFile('MYGAME/PRG');
disk.writeFile('MYGAME/PRG', newBytes, D64.FILE_TYPE_PRG);
writeFileSync('mygame.d64', Buffer.from(disk.getData()));
```

**AST instruction shape:** each entry in `pd.instructions` is
```js
{ label: 0, arg1: 0, opcode: 0x??, arg2: 0, instructionName: '...' }
```
- `label` is 0 (no label) or 1–255 (labeled — jump target)
- `opcode` from `js/gmOpcodes.js`
- `arg1` and `arg2` are opcode-specific — check the template
- `instructionName` is human-readable ("if a > 000 then", "/ my comment"). For opcodes 0x2B (comment) and 0x3B (print), the serializer parses this back out. For all other opcodes it's advisory display text; the serializer only cares about opcode + arg1 + arg2.

**Inserting an instruction:** just splice a new node into `pd.instructions`.
Label bookkeeping is regenerated by `serializeProgram` from where each
labeled instruction ends up in the new bytecode, so nothing else needs
updating when you shift positions.

**Referencing media:** media-referencing opcodes (0x27 sprite, 0x28
scene, 0x40 sound, 0x60 song) put the mediaStore index in `arg2`. The
serializer remaps to compact indices automatically — you write the index
into `pd.mediaStore` where you want it, and reference that index by
number in the instruction. Orphaned mediaStore entries are ignored.

**Comments (opcode 0x2B):**
```js
{ label: 0, arg1: 0, arg2: 0, opcode: 0x2B, instructionName: '/ my comment' }
```
The `"/ "` prefix is mandatory — the serializer does `instructionName.slice(2)` to extract the string. Comment text caps at 25 bytes.

**Reference implementations (read, don't necessarily re-run):**

- `tools/build-demo.js` — synthesizes an entire disk from scratch (sprites, scenes, sounds, programs constructed in memory). Marked "historical artifact" because the demo disk is now hand-edited, but the code is a working end-to-end example of constructing sprites/scenes/programs and writing to a D64.
- Any node script that manipulates ALIENS/PRG comments (`git log`-searchable) — worked example of parse → splice AST → serialize round-trip.

## Loading libs from Node

The runtime and parser assume browser `<script>`-tag semantics where every
top-level declaration is a global. Node ES modules don't work that way, so
utility scripts need to (a) import in dependency order and (b) inject a
couple of symbols onto `globalThis` that the libs expect to find there.

Minimal boilerplate for anything that touches the parser and runtime:

```js
import { readFileSync } from 'fs';

// Load in dependency order — order matters because later files reference
// globals defined by earlier ones.
await import('./js/d64lib.js');
await import('./js/c64lib.js');
await import('./js/gmOpcodes.js');
await import('./js/gmSprite.js');
await import('./js/gmScene.js');
await import('./js/gmSound.js');
await import('./js/gmMusic.js');
await import('./js/gmCharset.js');
await import('./js/gmParser.js');
// gmRuntime is only needed if you plan to run the program (not just parse/edit)
// await import('./js/gmRuntime.js');

// Inject symbols the libs expect as globals but that aren't self-exported.
globalThis.charset = new globalThis.gmCharset();
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

// If you'll run the VM, also stub audio + input:
// globalThis.audioContext = ...
// globalThis.masterGain = ...
// globalThis.inputState = { joystick1: {...}, joystick2: {...}, button1: false, button2: false };
```

For a full working example with all stubs, see `tests/gmRuntime.test.js`
— its top matter is the canonical "run a program from Node" setup.

**Test dependencies live in `dev/`, not the repo root.** `puppeteer`,
`vitest`, and everything else are installed under `dev/node_modules`. If
you're writing a one-off script, either put it in `dev/` and run
`node yourscript.mjs` from there, or run from anywhere with
`node --experimental-vm-modules /absolute/path/to/script.mjs` and
absolute-path the `import`s.

## Multi-Part Sprites (CRITICAL - Read This!)

**This section documents a design pattern that has caused repeated confusion. READ CAREFULLY.**

GameMaker allows combining up to 4 C64 hardware sprites into one logical "multi-part" sprite (also called "quad sprites"). This enables larger sprites (up to 48×42 pixels).

### CRITICAL: Storage Format Difference (SPR vs PRG)

**This is the #1 source of bugs. Understand this completely.**

| Aspect | Standalone .SPR File | PRG Embedded Data |
|--------|---------------------|-------------------|
| Storage | All 4 quads in ONE contiguous file | Each quad is a SEPARATE data page entry |
| Pointers | N/A (single file) | 4 separate pointers in pointer table |
| Main header `numSprites` | 4 (matches actual data) | 4 (but only 1 quad of data at this pointer!) |
| Data at main pointer | All 4 quads (~1600 bytes) | Only quad 0 (~400 bytes) |

**Example from GMC64I/PRG (SAUCER sprite, 4 quads):**
```
Pointer table has 4 entries:
  → main sprite "SAUCER" (header says numSprites=4, but only one quad's bytes here)
  → subsprite "-SAUCE"
  → subsprite "-SAUCE"
  → subsprite "-SAUCE"

Each entry: 32-byte header + frames × 64 bytes
Total sprite data is split across all 4 entries.
```

**Why this matters:** If you create a gmSprite from just the main entry's bytes, the header says `numSprites=4` but there's only 1 quad of actual data. gmSprite will try to read 4 quads and either crash or read garbage.

### Two Entry Points → Same Normalized Structure

Sprites can be loaded from two different sources, each requiring different handling to produce the same normalized mediaStore structure:

| Aspect | Disk-Loaded (editor.html) | PRG-Loaded (gmParser.js) |
|--------|---------------------------|--------------------------|
| Source | .SPR file from D64 disk | Embedded in PRG binary data page |
| Input format | Single contiguous file | Separate entries per quad |
| Concatenation | Not needed | Required before parsing |
| Trigger | User picks sprite in editor | Parsing PRG at load time |
| Also creates | Instructions for subsprite slots | Nothing (instructions in PRG) |

**Both normalize to the same structure. Markers are identified by
`quadIndex > 0` (the main entry has `quadIndex: 0`):**
```
mediaStore[N]:   { sprite: gmSprite, quadIndex: 0 }  // ONE gmSprite with all quads
mediaStore[N+1]: { sprite: null, quadIndex: 1 }      // Empty marker
mediaStore[N+2]: { sprite: null, quadIndex: 2 }      // Empty marker
mediaStore[N+3]: { sprite: null, quadIndex: 3 }      // Empty marker
```

**Disk-loaded flow (editor.html):**
1. Load .SPR file (already contiguous with all quads)
2. Pass entire file to `new gmSprite(fileData)`
3. Store gmSprite in main entry, create empty markers for quads 1-3

**PRG-loaded flow (gmParser.js):**
1. Peek at header to get `numSprites`
2. If `numSprites > 1`, collect data from consecutive pointer table entries
3. Concatenate chunks into one buffer
4. Pass concatenated buffer to `new gmSprite(spriteFileData)`
5. Store gmSprite in main entry, mark subsprite indices as empty markers

The code is intentionally NOT deduplicated because the input formats and contexts are fundamentally different. Both flows achieve the same result: ONE gmSprite managing all quads, with empty markers for pointer table indexing.

### Standalone .SPR Files (Simple Case)

All quad data is contiguous in one file:
```
[5-byte magic][37-byte main header][quad0 frames][32-byte subheader][quad1 frames]...
```

Pass the entire file to gmSprite → it parses all quads automatically.

### CRITICAL: Header Size Difference (.SPR vs Data Page)

**This caused a 5-byte offset bug that broke multi-part sprite serialization. Understand this!**

| Format | Header Size | Structure |
|--------|-------------|-----------|
| .SPR main header | 37 bytes | `[6-char name][31 bytes header data]` |
| .SPR subheader | 32 bytes | `[byte 0 flag][5-char name][26 bytes header data]` |
| PRG data page entry | 32 bytes | `[6-char name][26 bytes header data]` |

**Key insight:** When parsing PRG files, we create `spriteFileData` by concatenating data page entries (each 32 bytes header). But `gmSprite.HEADER_DATA_SIZE = 37` is for .SPR files!

**During serialization of multi-part sprites:**
- DON'T use `HEADER_DATA_SIZE` (37) for offset calculations
- DO use 32 bytes (data page format) for both main and subsprite headers
- The serializer defines `DATA_PAGE_HEADER_SIZE = 32` for this reason

```javascript
// WRONG: Assumes .SPR format (37-byte header)
let fileOffset = 5 + gmSprite.HEADER_DATA_SIZE + frames * 64;  // Off by 5 bytes!

// CORRECT: Uses data page format (32-byte header)
const DATA_PAGE_HEADER_SIZE = 32;
let fileOffset = 5 + DATA_PAGE_HEADER_SIZE + frames * 64;
```

### Runtime Structure

**mediaStore entries:**
```
mediaStore[N]:   { sprite: gmSprite, spriteFileData: bytes, quadIndex: 0 }  // MAIN
mediaStore[N+1]: { sprite: null, spriteFileData: null, quadIndex: 1 }       // EMPTY marker
mediaStore[N+2]: { sprite: null, spriteFileData: null, quadIndex: 2 }       // EMPTY marker
mediaStore[N+3]: { sprite: null, spriteFileData: null, quadIndex: 3 }       // EMPTY marker
```

**CRITICAL:** Marker entries are EMPTY (sprite: null). Only the main entry has the gmSprite.
At runtime, marker slot assignments are no-ops - the parent slot already renders all quads.

**runtime slots:**
```
slot[N]:   { spriteInstance: gmSprite, isSubsprite: false }  // renders all 4 quads
slot[N+1]: { spriteInstance: null, isSubsprite: true, parentSlotIdx: N }  // empty
slot[N+2]: { spriteInstance: null, isSubsprite: true, parentSlotIdx: N }  // empty
slot[N+3]: { spriteInstance: null, isSubsprite: true, parentSlotIdx: N }  // empty
```

### Serialization (Back to PRG)

When saving to PRG format:
1. Iterate through mediaStore entries in index order
2. Skip marker entries (quadIndex > 0) - they're handled when processing main
3. For each main sprite entry with `numQuads > 1`:
   - Write quad 0 data at main entry's pointer
   - Look at consecutive mediaStore indices (idx+1, idx+2, idx+3)
   - Verify each is a marker (`quadIndex` matches 1, 2, 3)
   - Decompose the gmSprite: extract each quad's data and write at marker's pointer
4. Use `gmSprite.quadSizeInBytes(quadIndex)` for size, NOT `sizeInBytes`

**IMPORTANT:** Markers must be at consecutive mediaStore indices after the main entry.
Both disk-loaded and PRG-loaded paths guarantee this by design.

### Detecting Subsprites

Marker entries have:
- `quadIndex: 1, 2, or 3` (the canonical identifier — main entries have `quadIndex: 0`)
- `sprite: null` and `spriteFileData: null` (no data of their own)
- Name starting with '-' (e.g., "-SAUCE" vs "SAUCER") — convention only

### Common Mistakes (DON'T DO THESE)

❌ Passing only main entry's bytes to gmSprite (will fail for multi-quad)
❌ Creating separate gmSprite objects for each quad
❌ Storing sprite references in marker entries (markers are empty!)
❌ Using `sprite.sizeInBytes` for PRG serialization (sums all quads)
❌ Assuming PRG storage matches .SPR file storage

### Subsprite Override and Restoration

GMC64 allows temporarily replacing a subsprite quad with a different sprite, then restoring it later. This is used for effects like lasers appearing/disappearing from a spaceship.

**Override (assigning a different sprite to a subsprite slot):**
```
sprite 1 is ALIENS    ; Load 2-quad sprite into slots 1-2
sprite 2 is LASER     ; Override quad 1 with LASER sprite
```

What happens on override:
- Parent sprite (slot 1) stops rendering the overridden quad (`skipQuads` Set)
- Overriding sprite appears independently at the quad's current position
- Inherits: position, animation speed
- Does NOT inherit: movement (speed/direction default to 0), colors
- The slot becomes independent (`isSubsprite=false`) but preserves original parent info

**Restoration (reassigning the original marker):**
```
sprite 2 is -ALIEN    ; Restore original subsprite
```

What happens on restoration:
- Overriding sprite is cleared
- Slot reverts to subsprite mode (`isSubsprite=true`)
- Parent resumes rendering that quad (removed from `skipQuads`)
- Quad moves/animates with parent as before

**Restoration after clear:**
```
sprite 2 is LASER     ; Override
clear sprite 2        ; Clear the override
sprite 2 is -ZEPLI    ; Still restores correctly
```

The `originalParentSlotIdx` is preserved across clears, so restoration works even after the overriding sprite is cleared.

**Implementation details:**
- `originalParentSlotIdx` and `originalQuadIndex` preserve the original relationship across overrides and clears
- Restoration is detected when ALL of these are true:
  1. Slot was originally a subsprite (`originalParentSlotIdx >= 0`)
  2. Slot is not currently a subsprite (`!isSubsprite`)
  3. Entry has no sprite data (marker or invalid)
  4. Parent still has this quad in `skipQuads`
  5. Marker's `quadIndex` matches slot's `originalQuadIndex`
- If marker's quadIndex doesn't match (e.g., assigning quad 2's marker to a quad 1 slot), the quad is blanked
- This applies both to normal subsprite slots AND overridden/cleared slots
- Collision detection works correctly: parent only checks quad 0, overridden slot has its own hitbox

## Cross-editor conventions

Shared behaviors implemented in `js/gmTools.js` and `js/gmDiskPicker.js`
that every editor page hooks into.

### Auto-seed demo disk on first visit

`GMTools.ensureDemoDiskInPool(gmDisk)` seeds `disks/gmc64-demo.d64` into
the shared pool if and only if the pool is empty. Fire-and-forget from
each editor's init, right after `gmDisk.autoLoad()`. Rationale: a
first-time visitor with no localStorage would otherwise land on a truly
empty file menu with no way to explore. `addToPool` dedupes by SHA-256,
so a concurrent `?disk=demo` URL route can't create a duplicate entry.

Constant `GMTools.DEMO_DISK_FILENAME` (`'gmc64-demo.d64'`) is the display
name used when mounting — kept lowercase to match the on-disk filename
and the project's branding. Change in one place if you ever want to
restyle.

### Shared disk picker (`GMDiskPicker`)

`js/gmDiskPicker.js` is mounted on every editor and provides:

- Window-level drag-and-drop of `.d64` files (add to pool, select, dispatch)
- Multi-match fallback UI when a URL-loaded disk has 2+ matching files
- Configurable `showPicker` hook so hosts can route through their own file browser

Contracts differ slightly per editor:
- `editor.html`: on pick → `loadProgramData` + `saveProgram`. Multi-match hands off to `showFilePopup()`.
- `play.html`: bare visit shows the picker's drop-zone overlay (game-runner has no file menu of its own).
- Sprite/scene-maker: multi-match → `enterPreviewMode()` (browsable preview).
- Sound/music-maker: multi-match → `showFilePopup()` / `showDiskPopup()`.

### URL parameters

Reader-facing coverage of `?disk`, `?file`, `?play`, `?poster_seconds`,
`?nocredit`, and iframe embedding lives in README's "Sharing your creations"
section. Internal-only convenience worth calling out:

- `?play_demo=1` — editor.html alias for `?disk=demo&file=GMC64I/PRG&play=1&poster_seconds=8.5`. Kept as a short URL for the marketing site's "Try the demo" button; not documented for embedders.

## Critical Gotchas

**DO NOT USE requestAnimationFrame in game loop:** Causes severe CPU thrashing. Use `setTimeout` at ~16ms (60fps target — `FRAME_TIME = 16` in editor.html and play.html).

**Don't trim() filenames:** Spaces can be significant (e.g., `"STARS /PIC"`). GameMaker filenames are exactly 6 chars (space-padded if shorter) + `/` + 3-char extension. `disk.readFile` normalizes on lookup, but round-tripping and directory display are picky.

**Opcode 0x00 halts execution.** A "blank line" in the source *terminates the program* — it isn't a no-op or visual spacer. If you're inserting comments to break up a listing, use opcode 0x2B, not 0x00. The one legitimate blank line is at the very end of a program.

**Comment strings cap at 25 bytes.** The serializer (`packStringReferences` in gmParser.js) truncates silently. Print strings (opcode 0x3B) cap at 20 bytes similarly. Keep both short or you'll lose text without warning.

**Sprite transparency:** gmSprite doesn't fill background. Clear canvas before each frame.

**Print colors are palette indices:** `print "color 2"` means `scene.color2` (a C64 index), not C64 color 2.

**Sprite Z-order:** Lower slot = higher priority (slot 0 renders on top).

**Safari hard refresh:** Cmd+Shift+R triggers Reader Mode. Use Cmd+Option+R.

**Console.log in loops:** Will max CPU even on early-return paths.

**Node scripts need `globalThis.decode16bit` injected.** The parser and runtime rely on top-level function references that only become globals under `<script>`-tag semantics. See "Loading libs from Node" below for the boilerplate.

## Tools

Each script under `tools/` is a one-shot dev utility (none are wired into
the test suite or CI). Some need `npm install` in `tools/` first for
their own deps.

| Tool | Purpose |
|------|---------|
| `bundle-standalone.js` | Regenerates `js/standalone-source.js` — a snapshot of `play.html` with every `<script src>` inlined. The editor's "Export Game" patches two `EMBEDDED_` consts in this snapshot with base64-encoded game bytes to produce a self-contained playable HTML file. Re-run after editing `play.html` or any file it loads. |
| `bundle-demo-disk.js` | Regenerates `js/demo-disk-source.js` — `disks/gmc64-demo.d64` base64-encoded so the editor's first-visit demo auto-load works under `file://` (where `fetch` is CORS-blocked). Re-run after editing the demo disk. |
| `render-test-frames.js` | Renders the runtime frame goldens as full 320×200 PNGs (`tools/test-frame-*.png`). Useful when you want to *see* what the pixel-comparison tests are actually checking — the sparse 40×25 sampling in the golden throws away most of the detail. |
| `build-demo.js` | One-shot synthesizer that builds a demo disk from scratch (sprites, scenes, sounds, programs constructed in memory). Not the source of truth for the demo disk anymore — once a disk is hand-edited in the editor, `build-demo.js` is a historical artifact and rebuilding from it would clobber edits. |
| `screenshot.js` | Puppeteer-driven screenshot utility (`node tools/screenshot.js music-maker.html`). |
| `hex-viewer.html` | Browser-based hex viewer for inspecting `.d64`/`.prg` bytes. Loaded by `browser-load.test.js` as a smoke test. |
| `scale-font.py` | Python script to horizontally compress a font to match the C64's non-square pixel aspect ratio. One-shot — used when generating the woff2 files in `css/fonts/`. |

## Testing

Test tooling lives in `dev/` (kept out of the root so static hosts like
Cloudflare Pages don't auto-detect this as a Node project and try to
install dev deps). First time:

```
cd dev
npm install
```

Then from `dev/`:

```
npm test                 # run the full suite
npm run generate-golden  # regenerate golden files after intentional changes
```

### Test Files

Format / runtime tests (node, no browser):

| File | Purpose |
|------|---------|
| `d64lib.test.js` | D64 disk image parsing |
| `gmSprite.test.js` | Sprite parsing, multi-quad, colors |
| `gmScene.test.js` | Scene parsing, pixel buffer, serialization |
| `gmSound.test.js` | Sound effect parsing |
| `gmMusic.test.js` | Music parsing, note data |
| `gmParser.test.js` | PRG parsing, serialization round-trip, mediaStore shape |
| `gmRuntime.test.js` | VM execution, input simulation, frame goldens, collision |
| `standalone-bundle.test.js` | Asserts `js/standalone-source.js` is in sync with `play.html` + the runtime JS it inlines |
| `browser-load.test.js` | Loads each HTML page headlessly and asserts no script errors |

Editor UI tests (puppeteer):

| File | Purpose |
|------|---------|
| `editor-edit.test.js` | Editor: arg editing, copy/paste, find, multi-quad swap, save round-trip |
| `disk-popup.test.js` | Shared disk popup: save row, overwrite, prefill, directory listing, pool migration |
| `scene-preview.test.js` | Scene-maker: file menu + preview mode |
| `sprite-preview.test.js` | Sprite-maker: file menu + preview mode |
| `sprite-draw.test.js` | Sprite-maker: pixel drawing, tools, color slot selection |
| `sprite-frames.test.js` | Sprite-maker: frame management (add/del/copy/navigate) |
| `sprite-modes.test.js` | Sprite-maker: multicolor/hi-res mode toggle, x/y double |
| `sound-maker-edit.test.js` | Sound-maker: frame editing, copy/clear/delete confirmations |
| `touch-drag.test.js` | Touch/pointer drag drawing across drawing surfaces (fatbits grid, etc.) |

### Runtime Testing (gmRuntime.test.js)

Tests VM execution by running real programs and comparing state snapshots:

1. Load PRG from test disk
2. Run N steps with optional input simulation
3. Capture VM state (sprites, variables, scores, etc.)
4. Compare to golden snapshot

**Input simulation:**
```javascript
setJoystick(1, 'right');  // ALIENS uses joystick 1
setButton(1, true);
runSteps(vm, 100);
```

**Frame rendering test:** Compares 1000 pixel samples (40×25 grid, every 8th pixel).

### Testing Gotchas

**Joystick/button port varies by program.** GMC64I doesn't read input; ALIENS uses port 1. Check the program's opcodes before assuming.

**Call `updateSpritePositions()` after `step()` in tests.** Sprite movement based on speed/direction happens in `render()`, not `step()`. Tests must call it manually:
```javascript
for (let i = 0; i < steps; i++) {
    vm.step();
    vm.updateSpritePositions();  // Required for sprite movement!
}
```

**Some programs hide sprites by moving them to x=0 rather than setting `visible=false`.** Check position, not visibility.

**Golden files are in `tests/golden/`.** Regenerate with `cd dev && npm run generate-golden` after intentional changes.

## Test Programs

The IP-clean test disk is `tests/disks/gmc64-test.d64`. Its two programs:

- **GMC64I/PRG** — Intro demo: multi-quad sprites (including the 4-quad SAUCER with magnification), per-slot sprite color, scene plotting, character printing, subroutines, music.
- **ALIENS/PRG** — Shooter: 4-direction input, formation logic, data table reads, sprite swaps, scene bg mutation, sprite/sprite collision, hi-res sprites (PBULL, EBULL).

## Open Questions

**PRG pre-header region (bytes 0-513):** All PRG files have a 514-byte region before the program. Simple programs have mostly zeros with small amounts of data at bytes 0-7 and 256-263. Complex programs have ~350 bytes of data. We successfully zero this out during serialization — programs still work.

**3-byte DATA_END difference:** Serialized files are consistently 1-4 bytes smaller than originals. This is acceptable but the exact cause is unknown. Possibly padding/alignment differences.

**Slot assignment tracking:** The serializer doesn't yet track which sprites/sounds/songs are assigned to which runtime slots. The slot assignment region (bytes 256-511 in pre-header) gets zeroed. Programs work because they re-assign slots at runtime, but a full implementation might want to preserve this.

## Resolved Issues

**Multi-quad sprite snow-crash:** Fixed. Multi-quad sprites were being serialized with `sizeInBytes` (sum of all quads) instead of single-quad size. Added `gmSprite.quadSizeInBytes(quadIndex)` method. PRG files store each quad as separate data page entry.

**Comment corruption:** Fixed. Was caused by the multi-quad sprite bug — oversized sprite data overwrote subsequent entries including comments.

**Multi-part sprites not rendering on real C64:** Fixed. Serializer was using `.SPR file format constants` (37-byte header) instead of `data page format` (32-byte header) when calculating offsets within spriteFileData. This caused a 5-byte offset error: subsprite data was read starting from byte 5 (last char of name) instead of byte 0, corrupting the output. Fix: Use `DATA_PAGE_HEADER_SIZE = 32` for all offset calculations in multi-part sprite serialization.

## Music Editor (music-maker.html)

### UI Layout

- **Piano keyboard** at top (2.5 octaves, C3-C6)
- **Staff area** (left) - scrolling note display with playhead at 75% position
- **Controls panel** (right, 180px wide) - buttons, duration selector, tempo, channels

### Note Entry System

**GM-style two-click entry:**
1. First click places note at playhead (doesn't advance)
2. Second click on same note advances to next position
3. Different pitch/duration replaces the note

**Null slots for non-contiguous entry:**
- GM allows placing notes with gaps (doesn't require filling with rests)
- Gaps are filled with invisible 32nd-note "null slots"
- Null slots: `{ isNullSlot: true, pitch: 0x3C, durationByte: 0x40, duration: 0.125 }`
- Navigation buttons skip over null slots
- Placing a note into null slots consumes them

**Ghost note preview:**
- Hovering over existing note with different duration shows ghost preview
- Original note dims to 30% opacity
- Same duration = no preview (will advance on click)

### Drag Behavior

**Vertical dragging:** Changes pitch (snaps to staff lines)
**Horizontal dragging:** Moves note in time (snaps to 32nd-note positions)
**Drag threshold:** 5 pixels before drag starts (allows click-to-advance)

### Controls

| Button | Function |
|--------|----------|
| file | Load/save songs |
| midi | MIDI import/export |
| ins | Toggle insert mode |
| top | Go to beginning |
| del | Delete note(s) with count dialog |
| play | Play/stop toggle |
| clr | Clear song |
| undo | Undo last edit (Ctrl+Z) |
| < > | Navigate back/forward (stops playback) |

### Undo System

- 50-state history stack
- `saveUndoState()` called before edit operations
- Stores deep copy of channel data + playhead position
- Keyboard shortcut: Ctrl+Z / Cmd+Z

### Delete Dialog

- Number input (1-100) for multi-note deletion
- Deletes N real notes plus any null slots between them
- Also removes trailing null slots after last deleted note

### Playback

- Play/stop toggle button (shows "play" → "stop")
- Navigation buttons automatically stop playback
- Piano keys highlight during playback
- Stops at end of song (last note's end position)

### Known Issues / Gotchas

**Floating-point beat positions:** After playback, `playheadBeat` may have tiny drift. Use tolerance (`Math.abs(a - b) < 0.001`) for beat comparisons, not strict equality.

## D64 Disk Images

### Creating Blank Disks

```javascript
const disk = D64.createEmpty('MY DISK', 'AB');
// Returns properly formatted blank D64 with:
// - Initialized BAM on track 18
// - Free sector counts for all 35 tracks
// - Disk name and ID
// - Empty directory
```

Use `disk.writeFile(name, data, fileType)` to add files.

## Future Ideas

### Game Packaging / Export

Allow users to download a standalone HTML file that plays their game without the editors.

**Slim package approach:**
- Pre-parse PRG at package time, embed only:
  - **AST** - instruction tree (JSON-serializable)
  - **mediaStore** - parsed sprites/sounds/scenes/songs
  - **Runtime** - just gmRuntime.js for execution
- Skip entirely: gmParser.js, d64lib.js, gmDisk.js, PRG binary handling
- Single HTML file with inlined JS + embedded game data
- Minimal player UI: canvas + keyboard instructions + optional fullscreen

**Required runtime components:**
- c64lib.js (palette, PETSCII)
- c64Screen.js (320×200 canvas)
- gmRuntime.js (VM execution)
- gmSprite.js (sprite rendering, not parsing)
- gmScene.js (scene rendering)
- gmSound.js (sound playback)
- gmMusic.js (music playback)

### Mobile Support

**Editor UI:** Mostly works with touch, challenges are no hover states, smaller screens, precision.

**Game controls:** More problematic - C64 games expect 8-direction joystick + button.
- Virtual joystick overlay (left side d-pad, right side fire button)
- Gamepad API support for Bluetooth controllers
- Tilt controls as alternative option

### Scroll Wheel Support

For draggable fields and dropdowns:
- Use `wheel` event with `deltaY` for direction
- Normalize across devices (Windows wheel vs Mac trackpad momentum)
- Accumulate deltas with threshold to prevent over-rapid changes
