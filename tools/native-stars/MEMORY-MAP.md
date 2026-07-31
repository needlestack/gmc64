# GMC64 native compiler — memory map (source of truth)

This document is the **single authority** for where every byte lives in a compiled
native game. The rule it exists to enforce:

> **Every runtime address comes from a named symbol defined in one allocation block.
> No routine writes a hardcoded address that isn't on this map.**

The ARCHER "target flicker" bug (2026-07) is the cautionary tale: GKGM variables were
hardcoded to ZP `$40+` and a later state-relocation put sprite positions on top of them.
Nothing caught it because the two owners never appeared in the same place. This map is
that place. See [Enforcement](#enforcement).

Two build modes share almost everything:
- **twobank** — keeps KERNAL mapped (`$01=$36`); two static scene bitmaps (`$6000`, `$a000`),
  bank flip via `$dd00`. Faithful to original games (ARCHER, CHOPER, PITFAL-classic).
- **roomy** — banks KERNAL out too (`$01=$35`); one live bitmap at `$6000`, N compressed
  scenes decompressed on demand. More RAM, native-only games.

---

## 1. Hard constraints (immovable — hardware/loader dictates these)

| Range | Owner | Notes |
|---|---|---|
| `$0000–$0001` | 6510 CPU port | `$01` bank control. Never touch as storage. |
| `$0100–$01ff` | CPU stack | |
| `$d000–$dfff` | I/O (VIC/SID/CIA/color) | Present in both modes (`$01` keeps I/O in). A contiguous LOAD **cannot cross this hole** — origin of the self-extractor. |
| `$fffa/$fffb` | NMI vector | twobank: KERNAL's. roomy: our `roomy_int` (RTI) in RAM under KERNAL. |
| `$fffc/$fffd` | RESET vector | |
| `$fffe/$ffff` | IRQ vector | Masked all-game (`sei`, never `cli`; `$d01a=0`). |
| VIC bank `$4000–$7fff` | VIC-II | Bank 1 (`$dd00` bits). Matrix, sprite frames, live bitmap must sit here. |

**Interrupt posture (why nothing but our code runs):** init does `sei` once and never `cli`;
`$d01a=0` disables VIC IRQ; no CIA2 NMI is programmed. So no KERNAL/BASIC/IRQ/NMI code
executes during play — **every write to RAM/ZP is ours**. (compile-game.mjs entry ~L1106.)

---

## 2. Zero page (`$00–$ff`)

ZP is the scarce, valuable resource: `zp,x` is 2 bytes/4 cycles vs `abs,x` 3 bytes/4–5.
Everything indexed per-frame wants to live here.

### Current allocation

| Range | Size | Owner | Defined at |
|---|---|---|---|
| `$00–$01` | 2 | CPU port | hardware |
| `$02–$3f` | 62 | **FREE** | — |
| `$40–$59` | 26 | **GKGM variables a–z** (`V(n)=$40+n-1`) | compile-game.mjs:245 |
| `$5a–$df` | 134 | **FREE** | — |
| `$e0–$ff` | 32 | runtime scratch & pointers | compile-game.mjs:673–708 (roomy) / 712–742 (twobank) |

Scratch (`$e0–$ff`) is densely packed and **mode-specific** (roomy reuses `$e4–$ea` across
LZ-decode / movement / plot since those never run concurrently; twobank spreads plot/movement
across `$e4–$ef`). Key fixed ones both modes: `collFlags=$fd bgFlags=$fe bankEor=$ff
opbudget=$ee ptr=$fb pcl/pch=$f0/$f1 sval/sval1=$f2/$f3 animtog=$f8`.

**Runtime state currently is NOT in ZP** — it lives at `$c000` (see §3). An earlier attempt to
move it into ZP collided with the variable block; reverted.

### Free ZP budget

`$02–$3f` (62) + `$5a–$df` (134) = **196 free bytes**. Plenty for the full hot-state block
(88 B) plus headroom — *if* placed so it dodges `$40–$59`.

---

## 3. Runtime state block — currently `$c000–$c0e2` (227 B)

All defined compile-game.mjs:1051–1103. Two tiers:

**Hot** (touched every frame in `frame_work`, ×8 slots — the ZP candidates):
`sBase $c000, sNum $c008, sFrame $c010, sAnimTmr $c018, sAnimSpd $c020, sSpeed $c028,
sDir $c030, sPosXlo $c038, sPosXhi $c040, sPosYlo $c048, sPosYhi $c050` — 11 arrays × 8 = **88 B**.

**Cold** (score / sound `v*` / music `m*` / print / multi-quad `sParent/sQXoff/sQYoff/sLoad` /
`activeScene`): `$c060–$c0e2` — ~**130 B**.

This block forces a **hole** in the roomy scene RAM (region A stops at `$c000`, region B
resumes at `$c100`). Closing it is the biggest fragmentation win available (§6).

---

## 4. Main memory — data & graphics

### Reclaimable low RAM `$0200–$07ff` (1.5 KB) — *currently unused at runtime*

- `$0200–$03ff` — free (KERNAL's input/tape buffers; KERNAL isn't executing).
- `$0400–$07ff` — the **self-extract decoder** runs here transiently during boot only
  (`DEC=$0400`, selfext.mjs:38). Once the game starts (`jmp $080d`) it's dead. VIC bank is
  `$4000`, so the default screen at `$0400` is never used. **Verified: 0 runtime references to
  `$0200–$07ff` in the compiled game.** → fully reclaimable post-boot.

### Program image `$0801+`

- Self-extract file layout: `[BASIC stub + relocator][decoder][C1][C2…]` at `$0801`
  (selfext.mjs:26,330). Relocator sets `$01`, copies decoder to `$0400`, stages streams,
  decodes forward in place, `jmp $080d`. After boot the game image occupies `$0801+`.
- Non-self-extract (small games that don't cross a hole): raw `.prg` loads at `$0801`.

### twobank layout

| Range | Contents |
|---|---|
| `$0801 …` | code (`execStream`) + data tables (`tablesText`) |
| `$4000` | `SCREEN` video matrix (`!fill $400`; sprite pointers at `$43f8`) |
| `$4400` | `SPR` sprite-frame library |
| `$6000` | `BITMAP` scene-1 bitmap |
| `$a000` | scene-2 bitmap (`bitmap2`, if present; BASIC banked out makes it CPU-RAM) |
| `$c000–$c0e2` | runtime state (§3) |
| `$c100 …` | `master` sprite-frame source library |

*Split fallback* (code+data overflow `$4000`): code seg1 `$0801–<$3ff0`, `jmp` to seg2
`$4600–$5fff`; `master`+some tables `$8600–<$a000`; rest of tables `$c100–<$d000`.
(compile-game.mjs `bigLayout`, ~L1839.)

### roomy layout

| Range | Contents |
|---|---|
| `$0801 …` | code seg A |
| `$4000` | `SCREEN` matrix · `$4400` `SPR` frames (resident) · `$6000` `BITMAP` live scene |
| `$8000 …` | code seg B (if split) + data tables (`roomyData`) + compressed scenes |
| **region A** `… → $c000` | compressed scenes |
| `$c000–$c0ff` | **RESERVED** runtime state (the hole) |
| **region B** `$c100 → $cf00` | compressed scenes |
| `$d000–$dfff` | **RESERVED** I/O |
| **region C** `$e000 → $fc00` | compressed scenes |
| `$fc00–$fff9` | self-extract C2 staging + vectors |

`REGIONS = [[null,0xc000],[0xc100,0xcf00],[0xe000,0xfc00]]` (compile-game.mjs:1945).

### The two movable data tables everyone forgets

- `RAM: !fill 256` — GKGM `ram[]` (opcodes `0x5d/0x5e/0x5f`). Currently rides along in the
  data-table region (under `$4000`, or `$8600`/`$c100` when split).
- `DATA: !byte …` — GKGM data tables (opcodes `0x1c/0x0a/0x1d`). Same.

Both are prime candidates to move into reclaimed `$0400–$07ff` (§6).

---

## 5. Fragmentation inventory

Holes that break otherwise-contiguous RAM (worst for roomy scene capacity):

1. **`$c000–$c0ff` state** — *closeable* (move state to ZP + reclaimed low RAM).
2. **`$d000–$dfff` I/O** — immovable.
3. **VIC bank `$4000–$7fff`** — matrix/sprites/bitmap; forces the twobank/roomy code split.
   Movable only by choosing a different VIC bank (see §6, open question).
4. **`$fc00+`** — self-extract staging + vectors; small, immovable.

---

## 6. Target layout (proposal — the four directions you asked for)

### (a) Hot state → ZP, dodging the variable block
Keep variables at `$40–$59`. Place the 88-byte hot block at **`$60–$b7`** (no overlap with
vars `$40–$59` or scratch `$e0–$ff`). Result — a clean, documented ZP:

```
$02–$3f  free (62)          $b8–$df  free (40)
$40–$59  GKGM variables      $e0–$ff  scratch/pointers
$60–$b7  hot sprite state (sBase…sPosYhi)
```

This recovers the full size/speed win that broke ARCHER, *safely*, because the owners now
coexist on one map. (Optional later: compact per-game to only the `a–z` actually used, freeing
the tail of `$40–$59` — ARCHER uses a scattered subset but reaches var 26, so compaction must
be per-game, not assumed.)

### (b) Reclaim `$0400–$07ff` (decoder/loader space) for cold state + `ram[]`
Post-boot that KB is dead. Put there:
```
$0400–$048x  cold state (score/sound/music/print/multi-quad, ~130 B)
$0500–$05ff  RAM   (ram[], 256 B)
$0600–$06ff  DATA  (GKGM data tables, if they fit; else leave in the data region)
```
Init must populate these *after* the self-extractor finishes (it does — game init runs at
`$080d` after `jmp`). For non-self-extract builds the region is simply free.

### (c) Move `ram[]`/`DATA` out of mid-upper RAM
Consequence of (b): the data-table region shrinks, so fewer/no tables spill to `$8600`/`$c100`,
and the split layouts get simpler.

### (d) Close the `$c000` hole
With state gone from `$c000` (→ ZP + `$0400`), roomy region A extends **`start → $d000`**
uninterrupted (only the I/O hole remains below `$e000`). Bigger contiguous scene runs, fewer
`* =` origin jumps in the packed image.

### Resulting canonical map (target)
```
ZP        $40–$59 vars · $60–$b7 hot state · $e0–$ff scratch   (rest free)
$0400–$06ff  cold state + ram[] + data tables (reclaimed)
$0801–…      code + remaining tables
$4000/$4400/$6000  VIC matrix / sprites / bitmap  (+ $a000 scene2, twobank)
region A  …→$d000 contiguous scenes (roomy)   [$c000 hole CLOSED]
$d000–$dfff  I/O
$e000–$fbff  region C scenes (roomy) / free (twobank)
$fc00–$ffff  self-extract staging + vectors
```

### Open question (not decided — needs your call)
**VIC bank `$4000` vs `$8000`.** Moving the VIC bank to `$8000` would give a contiguous
`$0801–$7fff` (~30 KB) low region for code (no split needed for most games) and push all
graphics high (`$8000` matrix, `$8400` sprites, `$a000` bitmap). Trade-off: reshuffles the
roomy scene regions and the twobank second bitmap. Flagged for discussion — everything above
assumes the current `$4000` bank.

---

## Enforcement

1. **Symbols only.** Every state/var/table/buffer address is a named `=` symbol in the ZP
   block, the state block, or the `tableDefs`/`REGIONS` lists. Emitted code references the
   symbol, never a literal (the one legitimate literals are hardware regs `$d0xx`/`$dc/dd`
   and the fixed VIC bank origins `$4000/$4400/$6000/$a000`).
2. **No overlapping owners.** Before adding or moving any block, check it against §2–§4 here
   and update this file in the same change. If two owners would share a range, that's the bug.
3. **Regression gate.** ZP/state moves must pass the multi-frame flicker detector
   (`/tmp/tgt.mjs`-style: decode the VICE screenshot and scan many frames, not one) — single
   screenshots hid the ARCHER flicker for many iterations.
4. **A future lint** could assert no `sta/lda $xx` literal falls inside a reserved range from
   this map. Cheap insurance; would have caught the var collision at build time.
```
