# Changelog

## Latest
- Scene-maker text tool can now switch fonts. A `font: gm ⇄ font: sm` toggle
  appears in the button slot right of "text" while the text tool is active. `gm`
  is the existing GameMaker 8×8 monospaced charset; `sm` is a compact
  **proportional** font (per-glyph width, ~40 chars/line vs 20) — the text tool
  went from a monospaced column grid to a caret model that walks per-glyph
  advance widths (type/backspace/arrows/click-hit-test all width-aware). A font
  is only an authoring brush: once stamped it's plain scene pixels, so the .PIC
  format and round-trip are unchanged. GM stays exactly 8px monospaced.
- A jump-to-self (`l001 jump to label l001`) now spins in place forever — the
  following line never runs — matching GKGM, which treats it as a stop. The VM
  used to decide "was this a jump?" by checking whether the PC had landed on a
  different instruction; a self-jump lands back on the same one, so it read as
  "no jump" and fell through. Control-flow opcodes now flag when they set the
  PC themselves, so a self-jump is unambiguous.
- Quadropus (bundled demo): aliens no longer flash for a frame at their death
  spot when respawning. The respawn moves the sprite off the top of the screen
  *before* swapping the ALIEN graphic back in, so on real hardware the raster
  can't catch a fresh alien at the old position in the gap between the
  sprite-pointer write and the position write.
- Quadropus: the player's laser now connects with aliens right at the top edge
  of the screen. Collision detection runs before the beam is retired — a shot
  that both overlapped an alien and crossed the top on the same frame used to be
  expired first, so the hit was missed. The bolt also now flies fully off the
  top before vanishing instead of popping out mid-air.
- Quadropus: the ship-death animation (SHIPDI) ends on a blank frame, so the
  game-over screen no longer leaves a few stray sparks where the ship was.
- When a program halts (opcode 0x00, or running off the end), sprites keep
  moving and animating on their last settings instead of freezing — matching
  real hardware, where the CPU stops but the VIC/IRQ carries on (some demos
  rely on this). A user-initiated stop still ends everything.
- `if scoreN > XXXX` (opcode 0x4A) now honors its score selector (0-based in
  bytecode: score1 = 0, score2 = 1). It previously ignored the arg and always
  compared score1, which silently broke any program testing score2.
- Sprite animation state now matches real GameMaker (verified against GKGM on
  VICE): when an "animates once" run completes, the slot's animation speed
  becomes 0 — so a later sprite swap (which carries over both the speed and the
  "animates once" flag) inherits speed 0 and stays frozen until a fresh
  "animation speed" is set. Previously a completed "once" left the speed
  untouched, letting a swapped-in sprite keep animating when it wouldn't on
  hardware.
- Comment lines now render with the "/" hanging one character into the left
  margin (the space after it aligns with every other line), matching GKGM's
  listing and giving comments a clear visual cue.
- Keyboard directions now use SOCD cleaning (pressing a direction releases
  its opposite — last direction wins), fixing a stuck-direction bug when a
  keyup is dropped. Most visible on macOS, where the browser swallows arrow
  keyups while Cmd is held to fire: releasing one arrow to press the other
  used to leave the ship stuck heading the old way.
- Sprite-maker now has undo/redo (Cmd/Ctrl+Z, and Cmd/Ctrl+Shift+Z or
  Ctrl+Y to redo).
- Numerous minor usability improvements (sprite-maker arrow-key frame
  stepping, and more).
- Fixed edited or newly inserted print statements not updating when the
  program runs. The editor changed the on-screen text but never refreshed
  the bytes the runtime renders, so edits ran the old text and freshly
  inserted prints showed nothing.
- Standalone exports in the disk popup are now dimmed everywhere except
  the program editor (the only editor that can load them). Load on a
  dimmed standalone dispatches to the program editor instead of erroring.
- Edit-mode fullscreen button is phone-only now, pinned bottom-right.
  Desktop/tablet get fullscreen only while running a program.
- Disk popup always shows every file on disk. Non-primary GM types are
  dimmed, standalones grouped separately, non-GameMaker files at the
  bottom. The "Show All File Types" toggle is gone.
- Dropping a `.d64` onto an editor always opens the disk popup — no
  more auto-loading when the disk has one matching file. Drop = Insert.
- Cross-editor dispatch: Load (or double-click) on a dimmed GM file
  navigates to the right editor for it, with the disk + file
  pre-loaded. Browser-back restores in-progress work.
- Community disk archive: new `community.html` listing page, `disks/community/`
  folder + manifest, and `tools/add-community-disk.mjs` for adding a
  disk with an auto-generated poster. Link added to the editor's
  quit-menu and the landing-page nav.
- Shared top-nav bar on every editor (injected by `js/gmTopbar.js`):
  gmc64 logo on the left, "editors" dropdown + community + github on
  the right. Current editor is marked in the dropdown. "editor" renamed
  to "program editor" everywhere it appears as a user-facing label.
- Same "Editors" dropdown added to the landing and community-page navs,
  styled to match those pages rather than the C64-themed editor topbar.
- Renamed `editor.html` → `program-editor.html` for filename consistency
  with the other four editors (sprite-maker, sound-maker, etc.). A
  redirect stub at the old `editor.html` path preserves existing
  bookmarks, iframe embeds, and shared `?play_demo=1` links.

## 1.0.0 — 2026-07-11
Initial public release.
