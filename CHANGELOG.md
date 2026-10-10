# Changelog

## 1.1.0 — 2026-10-10

### Added
- **Export Game Assets to New Disk**: turns a program back into separate
  GameMaker files on a new disk. Brings standalone games found without their
  source disk back into every editor.
- Community disk archive page.
- Top navigation bar with an Editors menu on every page.
- Scene maker: a compact proportional font for the text tool, alongside
  GameMaker's 8×8 font.
- Sprite maker: undo/redo (Cmd/Ctrl+Z; Cmd/Ctrl+Shift+Z or Ctrl+Y to redo).
- Volume slider on the mute button (tap to open on touch screens).
- Loading a file meant for another editor opens it there, disk and file
  ready; browser Back returns to your work.

### Changed
- All editors share one working disk, like a single 1541 drive: insert a
  disk anywhere and every editor sees it.
- "Editor" is now the **program editor** (`program-editor.html`); old links
  redirect.
- The disk window lists every file: other GameMaker types dimmed, standalone
  games grouped, non-GameMaker files last. Dropping a `.d64` always opens it.
- "Export Game" is now **Export Game to HTML**.
- A halted program leaves sprites moving and animating, as on real hardware.
- Comment lines hang their "/" into the margin, as in GameMaker's listing.
- Edit-mode fullscreen button is phone-only.
- Sprite maker: arrow keys step through frames, plus many small usability
  improvements.

### Fixed
- Labels can be placed again
  ([#6](https://github.com/needlestack/gmc64/issues/6)).
- Saved files match GameMaker byte-for-byte: every sprite, scene, sound and
  song re-saves identically, and disks follow the real 1541 format (checked
  against VICE). Disks saved by older versions still load.
- Edited or newly inserted print statements now show their new text when run.
- `if score2 > …` compared score1 instead.
- A jump to its own label now stops in place, as in GameMaker.
- A sprite swapped in after an "animates once" run stays frozen, as in
  GameMaker.
- Arrow keys could stick on macOS while Cmd was held to fire.
- Quadropus demo: aliens flashed when respawning, laser hits at the top edge
  were missed, and stray sparks stayed after game over.

## 1.0.0 — 2026-07-11
Initial public release.
