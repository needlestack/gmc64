# native-compiler (experimental)

Ahead-of-time compiler from GKGM / GMC64 bytecode to **native C64 6502**, plus a
dependency-free 6502 assembler. GMC64 *interprets* GKGM programs; this *compiles*
them to real 6502 that runs on actual C64 hardware at native speed — unshackled
from the interpreter's per-frame op budget.

It reuses the core parser in `../js/` (`gmParser`, `gmSprite`, `gmScene`,
`d64lib`, …) **read-only** to read `.d64` / `.PRG` / `.SPR` / `.PIC` games, then
emits a standalone `.prg`. Nothing here modifies the GMC64 app.

Lives on the `native-compiler` branch, off `main`, so the GMC64 platform ships
independently while this matures.

## Where this fits with GMC64+

GMC64+ (the enhanced authoring mode — new opcodes, a faster ops/sec setting, a
few behavioral changes like a non-persistent scene background) will be a **mode
of the existing GMC64 editor/runtime**, not a separate system: ~90% shared code.
This folder is the one genuinely separate piece — the **native backend** that
compiles a GKGM(+) game to a real `.prg`. When the `+` opcodes exist, the same
`../js/` parser reads them and this compiler targets them.

## Layout

```
native-compiler/
  compile-game.mjs   the AOT compiler: GKGM .PRG -> native 6502 .prg
  asm6502.mjs        dependency-free 6502 assembler (2-pass, labels, expr, !byte/!fill)
  selfext.mjs        wraps a .prg into a self-extracting image (forward LZ, I/O-hole hop)
  make-cycler.mjs    author a minimal N-scene roomy cycler (isolation test)
  make-bigpitfall.mjs author extra Pitfall scenes -> a roomy multi-scene build
  MEMORY-MAP.md      the canonical memory map + allocation rules (READ THIS)
  harness/           VICE dev-preview tools (show-sprite/scene/-move, play-sound)
  poc/               the STARS proof-of-concept + early experiments (historical)
```

## Two output modes

- **twobank** — keeps KERNAL mapped; two static scene bitmaps (`$6000` / `$a000`),
  instant `$dd00` bank flip. Faithful to stock GKGM (≤ 2 scenes).
- **roomy** — banks KERNAL out too; one live bitmap at `$6000`, **N compressed
  scenes** decompressed on demand (more scenes + RAM than stock GKGM allows).
  Big images self-extract across the I/O hole.

## Execution model (the important bit)

The bytecode **free-runs** at native speed; a **raster IRQ** at line 250 runs the
60 Hz housekeeping (`frame_work`: movement, animation, sprite draw, SID, music)
exactly once per frame. So the program is effectively **two clocks** — fast logic
+ a locked 60 Hz presentation layer. That split is the source of both the power
and the subtle ordering hazards; `MEMORY-MAP.md` documents the memory rules and
the reentrancy guards. An opt-in throttle (`ops/frame`, 5th CLI arg) restores
stock GKGM op-rate pacing for games whose timing depends on it.

## Build & run

```
# compile a game (from this folder). 4th arg: twobank | roomy. optional 5th: throttle ops/frame.
node compile-game.mjs ../GameMaker-S1.d64 "ARCHER/PRG" archer.prg twobank
node compile-game.mjs ../GameMaker-S1.d64 "ARCHER/PRG" archer.prg roomy

# make it self-extracting (required if the roomy image crosses $d000)
node selfext.mjs archer.prg archer_se.prg

# assemble a hand-written source
node asm6502.mjs poc/stars.asm stars.prg
```

Run a `.prg` in VICE (NTSC), headless with a screenshot:

```
x64sc -ntsc -warp -autostartprgmode 1 -autostart archer.prg \
      -limitcycles 30000000 -exitscreenshot out.png -jamaction 5
```

## Status

Compiles full games — **ARCHER, CHOPER, PITFAL** — in both modes, with hardware
sprites (incl. multi-quad), GKGM speed/direction movement + animation, joystick /
button, sprite-sprite + background collision, score, SID sound + 3-voice music,
scene switching, and self-extraction. Roomy PITFAL runs **5 complex scenes**
(3 more than stock GKGM). Measured native throughput ≈ **13×** the interpreter.

Known **free-run tradeoffs** (understood, not bugs): anything a game counts
per-bytecode-iteration (fuel/level timers, bytecode-moved projectiles) runs at
CPU speed rather than frame rate. Throttle plays those faithfully today; the
clean long-term answer is designer-facing frame primitives in the GMC64+ mode
(a frame counter, an "every N frames" gate, an explicit motion-freeze) so an
author pins what is a clock and lets everything else run free.
