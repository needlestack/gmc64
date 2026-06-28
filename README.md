# GMC64

A faithful, browser-based recreation of the 1985 Commodore 64 game-creation tool by Garry Kitchen.

---

## If you used GameMaker back then

You probably remember the joy of stitching a game together from sprites and scenes you drew pixel by pixel, the BASIC-adjacent instruction list, the SID sounds you tweaked for hours, the comments scrolling under your title screen.

If you ever burned your work to a `.d64` and spent an afternoon trying to coax it back to life in VICE — only to wrestle with disk drive autoboot, joystick mapping, and emulator timing — this is for you.

Drop your old disk in. Pick your program. Click run. It just plays.

You can also open it up, edit it, change the music, add a sprite, save it back to the disk image, and export it as a single self-contained HTML file you can email to someone or post on a forum. Send your game to a friend the way you wish you could in 1986.

## If you're new to GameMaker

GameMaker was a game-creation tool for the Commodore 64, published by Activision in 1985 and written by Garry Kitchen. It let kids build real, runnable C64 games without learning assembly. You drew sprites and backgrounds, composed music, recorded sound effects, and wrote game logic as a list of plain-English instructions:

```
sprite 1 is PLAYER
sprite 1 x position = 160
sprite 1 y position = 100
if joystick 1 is left then sprite 1 direction = left
```

Many people who grew up to be game developers got their start here. It's been mostly inaccessible since.

GMC64 brings it back — same sprites, same instructions, same sound, in your browser.

## Two-way compatibility

GMC64 isn't only an emulator for old files. It implements the same on-disk formats — `.D64`, `.PRG`, `.SPR`, `.PIC`, `.SND`, `.SNG` — and they round-trip cleanly in both directions.

A game built here saves to a real disk image that loads on an actual Commodore 64 running the original 1985 GameMaker disk. Anything authored on that hardware loads here without translation. New creations can ship to a 1541. Old creations can ship to a tweet.

## Quick start

Open `editor.html` in any modern browser. That's it. No install.

Then either:

- **Load a `.d64`** you already have, pick a `.PRG`, and hit run
- **Try the demos** — `disks/GMC64-DEMO.d64` ships with the project and includes runnable programs and editable sprites, scenes, and songs
- **Start from scratch** — author sprites, scenes, music, and a program from blank

When your game is ready, hit **Download Game** to get a single HTML file that boots straight into your creation, embeddable anywhere.

## What's included

| File | What it edits |
|------|---------------|
| `editor.html` | Program instructions + runtime + asset assignment |
| `sprite-maker.html` | Sprites (multi-frame, multi-color, multi-quad) |
| `scene-maker.html` | Backgrounds (160×200 indexed-color scenes) |
| `sound-maker.html` | Sound effects (SID-style) |
| `music-maker.html` | Songs (3 channels, score-style staff editor) |

All five editors read and write to the same in-browser `.d64` image, so your sprites flow into scenes flow into programs the same way they did on the C64.

## Dependencies

**To play and edit: none.** It's static HTML and JavaScript. No build step, no server, no npm. Open the files in a browser and use them. They also run from `file://` (just double-click).

**To rebuild the runtime bundle:** Node.js. Pure built-ins, no `npm install` needed. After editing any file in `js/`, run:

```
node tools/bundle-runtime.js
```

This regenerates `js/runtime-source.js`, which is what the "Download Game" export inlines into the standalone HTML.

**To run the test suite:** `npm install` once, then `npm test`. This pulls in vitest (test runner) and puppeteer (headless browser). Only contributors need this.

## Status

Version 1.0. Real period games run faithfully — sprites, scenes, sound effects, music, and program logic all reproduce the original behavior. Reports of edge cases are welcome.

The editor is past the point where I find it more comfortable than the original.

**Honest limitations:**

- **Instruction-loop timing is close, not cycle-accurate.** The JavaScript runtime executes program steps in batches per frame rather than at a fixed C64 clock rate, so games whose visuals are choreographed against the exact duration of a tight instruction loop may drift slightly. None of the period games tested so far — including the original GM intro, which leans on this — drift far enough to look wrong. Programs driven by input, movement, collisions, and `pause for X.X` (which is wall-clock) play indistinguishably from the original.
- **Music-maker instrument sounds aren't fine-tuned to the original GM voices.** Each instrument plays the right notes at the right times, but the timbres are approximations rather than careful matches to the C64 SID presets the original tool shipped. A song composed in real GM will play recognizably here; one composed here and re-loaded into real GM will sound a little different. Polish target, not a structural issue.
- **Music and sound effects don't steal voices from each other.** The C64's SID has exactly three voices total, so when a sound effect plays during music, it interrupts whichever music channel it lands on for the duration of the effect. We use Web Audio, which has effectively unlimited concurrency, so music and sound effects layer freely. Programs sound *fuller* here than on real hardware — every note plays through. If your music and effects were designed around the original interruption behavior (some games used it for percussive accents during music), the interaction will feel different.

## Technical notes

- File format details (`.PRG`, `.SPR`, `.SND`, `.SNG`, `.PIC`, `.D64`)
- Architecture decisions
- Coordinate system, timing formulas, multi-part sprites

All documented in [`CLAUDE.md`](CLAUDE.md) — written for both AI coding assistants and humans who want to dig in.

## Disclaimer

GMC64 is an independent, unaffiliated, clean-room re-implementation made for preservation, education, and fun. It is not affiliated with, endorsed by, or connected to Activision, Activision Blizzard, Microsoft, or any other rights holder. "GameMaker" and any related marks are property of their respective owners. None of the original 1985 code is used or included.

The repository does not contain any commercial disk images or programs. If you have an original GameMaker disk, you can use it with GMC64 yourself; obtain disk images through legal channels.

## License

[MIT](LICENSE). Do what you like with the engine and editors.

The included demos (`disks/GMC64-DEMO.d64`) are original work, also under MIT.
