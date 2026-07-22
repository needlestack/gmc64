# native-compiler (experimental)

Ahead-of-time compiler from GKGM / GMC64 bytecode to **native C64 6502**, plus a
dependency-free 6502 assembler. This is the "backward-compiling" line of work:
GMC64 interprets GKGM programs; this compiles them to real 6502 that runs on
actual C64 hardware at native speed, unshackled from the interpreter's
per-frame op budget.

Lives on the `native-compiler` branch, kept off `main` so the GMC64 platform
(play/edit GKGM) can ship independently.

## Pieces

| File | What |
|------|------|
| `../asm6502.mjs` | Dependency-free JS 6502 assembler (full official opcode set, 2-pass labels, expr eval, `!byte`/`!word`/`!fill`). The seed of the compiler's codegen backend. |
| `compile-stars.mjs` | The compiler: parses a GKGM `.PRG` via `gmParser` → AST, emits 6502 (one template per opcode) against a reusable runtime lib, assembles → `.prg`. |
| `show-scene.mjs` | Stage 1 of scene support: parses a GKGM `.PIC` via `gmScene` and emits a native program that displays it as a C64 multicolor bitmap. The `.PIC` raw bytes are already in VIC bitmap order, so they embed straight at `$2000` (bundled into the program, like a GKGM standalone — no runtime disk load). |
| `stars.asm` | Hand-written reference reimplementation of GKGM's STARS parallax starfield (multicolor bitmap, table-driven plot). |
| `starsbench.asm` | STARS + raster-IRQ frame tick + on-screen "updates/frame" readout (bitmap decimal printer). |
| `stars30.asm` / `starsbench10.asm` | 30-star (10/layer) variants. |

## Build & run

```
# compile the real GKGM STARS bytecode to native 6502
node compile-stars.mjs <disk.d64> "STARS /PRG" stars_compiled.prg

# assemble a hand-written source
node ../asm6502.mjs stars.asm stars.prg
```

Run a `.prg` in VICE (NTSC), headless with a screenshot:

```
x64sc -ntsc -warp -autostartprgmode 1 -autostart stars.prg \
      -limitcycles 6000000 -exitscreenshot out.png -jamaction 5
```

## Status

STARS compiles and runs: the auto-generated program produces a **byte-identical
star layout** to the hand-written reference (all 15 stars at matching X-columns,
3 grays, correct motion). Measured native throughput ≈ 60 star-updates/frame
(NTSC) vs GKGM's ~4–5 — roughly an order of magnitude, with headroom to spare.

Next: extend codegen toward sprites / background PIC load / joystick / sound /
collision — the road to compiling a full game (ARCHER as the north star; ALIENS
on the IP-clean test disk as the committable integration target).
