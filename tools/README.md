# tools/

Dev utilities. Each script is standalone — none are wired into the test
suite or CI.

## Bundling / regen (touched after specific edits)

| Script | Regenerates | Re-run after |
|--------|-------------|-------------|
| `bundle-standalone.js` | `js/standalone-source.js` (play.html + inlined JS) | editing `play.html` or any `js/` file it loads |
| `bundle-demo-disk.js`  | `js/demo-disk-source.js` (base64 of the demo disk) | editing `disks/gmc64-demo.d64` |
| `render-test-frames.js` | `tools/test-frame-*.png` (full-res golden frame images) | when you want to *see* what the runtime frame goldens are checking |
| `build-demo.js`        | `disks/gmc64-demo.d64` (from scratch)             | **rarely** — historical artifact; the demo disk is now hand-edited |
| `build-aliens-quad.mjs` | `disks/aliens-quad.d64` (extended ALIENS variant) | after editing this file; see `ALIENS.md` |

## Programmatic PRG / sprite building — reusable libraries

These are the ones you `import` from other scripts (not standalone CLIs).
They exist so scripts that generate or modify GameMaker content don't have
to rewrite the same 40-line boilerplate every time.

| Module | Purpose |
|--------|---------|
| `node-bootstrap.mjs` | Import order + mocks needed before `parseProgramData`, `gmSprite`, `gmVM` will work in Node. Handles the `globalThis.decode16bit` injection and the `MockAudioContext` boilerplate. Returns commonly-used constructors. |
| `prg-patch.mjs`      | AST-mutation helpers: `walkAndTransform`, `findFirst`, `findAll`, `findBlockEnd`, `instr`, `addSprite`, `findMediaIdx`, `varIndex`/`varLetter`. |
| `spr-from-ascii.mjs` | Author sprites as ASCII bitmap arrays (using `'.'`, `'a'`, `'B'`, `'c'` for the multicolor palette values). Round-trip via `asciiFromFrame` for inspecting existing sprites. |

### Minimal example — modify a program

```js
import { readFileSync, writeFileSync } from 'fs';
import { bootstrap, loadProgram } from './tools/node-bootstrap.mjs';
import { walkAndTransform, findMediaIdx } from './tools/prg-patch.mjs';

const gm = await bootstrap();
const disk = new gm.D64(new Uint8Array(readFileSync('game.d64')));
const pd = loadProgram(disk, 'MYGAME/PRG');

// Rewrite every "sprite N is OLD" to "sprite N is NEW"
const oldIdx = findMediaIdx(pd, 'sprite', 'OLD');
const newIdx = findMediaIdx(pd, 'sprite', 'NEW');
walkAndTransform(pd, [
    {
        describe: 'swap OLD → NEW',
        match: { opcode: 0x27, arg2: oldIdx },
        action: (inst) => ({ ...inst, arg2: newIdx }),
    },
], { verbose: true });

const bytes = gm.serializeProgram(pd);
disk.deleteFile('MYGAME/PRG');
disk.writeFile('MYGAME/PRG', bytes, gm.D64.FILE_TYPE_PRG);
writeFileSync('game.d64', Buffer.from(disk.getData()));
```

### Minimal example — author a sprite in text

```js
import { bootstrap } from './tools/node-bootstrap.mjs';
import { spriteFromAscii } from './tools/spr-from-ascii.mjs';

await bootstrap();  // populates globalThis.gmSprite

const ALIEN = [
    '.B.B.',
    '.B.B.',
    'aaaaa',
    'acaca',
    'aaaaa',
    '.aaa.',
    'a.a.a',
];

const bytes = spriteFromAscii({
    name: 'MYALIEN',
    multicolor: true,
    xDouble: true,
    palette: { bg: 0, c1: 1, c2: 13, c3: 2 },
    position: { x: 86, y: 100 },
    frames: [
        [{ x: 0, y: 0, art: ALIEN }, { x: 7, y: 0, art: ALIEN }],
    ],
});
// bytes is a valid .SPR file, ready to write to a D64
```

## Utilities (standalone CLIs)

| Script | Purpose |
|--------|---------|
| `screenshot.js`  | Puppeteer-driven screenshot (`node tools/screenshot.js music-maker.html`) |
| `hex-viewer.html` | Browser hex viewer for `.d64` / `.prg` inspection |
| `scale-font.py`  | Horizontally compress a font to match C64's non-square pixel aspect ratio (one-shot; used when generating `css/fonts/*.woff2`) |
