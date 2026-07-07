# gmc64

gmc64 is a reimplementation of Garry Kitchen’s GameMaker for the Commodore 64. This project documents the graphic and sound formats, virtual machine, instruction set and runtime behavior, and includes a browser-based version that works with original GameMaker projects.

<table>
  <tr>
    <td align="center"><a href="https://gmc64.com/editor.html?play_demo=1"><img src="docs/screenshots/01-intro.png" width="320"></a><br><sub>Intro Demo</sub></td>
    <td align="center"><a href="https://gmc64.com/sprite-maker.html"><img src="docs/screenshots/02-sprite-maker.png" width="320"></a><br><sub>Sprite Maker</sub></td>
    <td align="center"><a href="https://gmc64.com/scene-maker.html"><img src="docs/screenshots/03-scene-maker.png" width="320"></a><br><sub>Scene Maker</sub></td>
  </tr>
  <tr>
    <td align="center"><a href="https://gmc64.com/sound-maker.html"><img src="docs/screenshots/04-sound-maker.png" width="320"></a><br><sub>Sound Maker</sub></td>
    <td align="center"><a href="https://gmc64.com/music-maker.html"><img src="docs/screenshots/05-music-maker.png" width="320"></a><br><sub>Music Maker</sub></td>
    <td align="center"><a href="https://gmc64.com/editor.html"><img src="docs/screenshots/06-editor.png" width="320"></a><br><sub>Program Editor</sub></td>
  </tr>
</table>

---

## If you used GameMaker back then

You probably remember the fun of animating sprites pixel by pixel, drawing
background scenes, coding up little games and demos, tweaking SID sounds, and
writing music.

If you tried to relive that fun on a C64 emulator, you probably noticed the
joystick based UI on the original is a tough sell today, and the slow disk
operations are a drag.

gmc64 solves this. It's a fully modern JavaScript recreation of GameMaker with
modern convenience: use your mouse or trackpad, instantly preview, load, and
save files, copy, paste, undo, and more. Import and export GIF, PNG, and MIDI
files.

It's not an emulator, it's a recreation, with the stumbling blocks gone.

## If you have your original work

Do you have your original work on a disk? gmc64 reads `.d64` disk images and all
GameMaker file formats. Drag and drop a disk or use the built-in file browser.
gmc64 can save files back to disk as well, and you can even import them back to the
original GameMaker.

Drop your `.d64` on to gmc64, pick your program, click run. It just plays.

Then you can open the editor, add a sprite, change the music, and save it back
to the disk image. You can even export your creations as a single self-contained
HTML file that you can post online and embed anywhere. Send your game to a friend
the way you wish you could in 1985.

## If you're new to GameMaker

GameMaker was a game-creation tool for the Commodore 64 created by Garry
Kitchen and published by Activision in 1985. It let users build real, runnable
C64 games without learning assembly or having to hand code graphics and sounds.
An early graphical development environment, you drew sprites and
backgrounds, composed music, recorded sound effects, and wrote game logic from
a list of plain-English instructions.

```
sprite 1 is player
sprite 1 x position = 160
sprite 1 y position = 100
if joystick 1 is left then
    sprite 1 direction = left
endif
```

Many people who grew up to be game developers got their start here. It's been
largely inaccessible in the modern age, and even through emulation the usability
suffers from the limitations of the original C64.

gmc64 brings it back — same sprites, same instructions, same sound, in your browser.

## Two-way compatibility

gmc64 doesn't just open old files. It implements the same formats: `/PRG`,
`/SPR`, `/PIC`, `/SND`, and `/SNG` — and they round-trip cleanly in both
directions.

A game built here saves to a real disk image that loads on an actual Commodore
64 running the original 1985 GameMaker disk. Anything authored on that hardware
loads here without translation. New creations can ship to a 1541. Old creations
can ship to social media.

## Quick start

Click any of the image links at the top of this page to dive in. That's it.

Then:

- **Try the demos** - `disks/gmc64-demo.d64` ships with the project and
  includes runnable programs and editable sprites, scenes, sounds, and songs
- **Start from scratch** — author sprites, scenes, sounds, and music, of your
  own
- **Drop a `.d64` into any gmc64 tool** - editor, sprite-maker, scene-maker,
  sound-maker, and music-maker will all open a pop-up file picker.
- **Host a `.d64`** - you can point to an online `d64` as
  well: `editor.html?disk=https://your-host/game.d64` opens the same file picker

When your game is ready, hit **Export Game** to get a single HTML file that boots straight into your creation, embeddable anywhere.

## Sharing your creations

Every editor takes URL parameters, so you can hand someone a direct link to a
specific program or drop the player into a page you're building. And every
editor accepts a `.d64` dropped onto its window — the file picker will open
filtered to that tool's file type (`.PRG` in the editor, `.SPR` in
sprite-maker, etc.).

### Player (`play.html`) — chrome-free, iframe-friendly

| Param | Purpose |
|-------|---------|
| `disk` | `.d64` URL, or the magic value `demo` for the bundled demo disk |
| `file` | Program name on the disk (case-insensitive) |
| `nocredit=1` | Hide the `gmc64.com` corner link |
| `poster_seconds` | How many seconds to simulate the game for the preview frame behind the play button. Default `2`, max `10`, `0` skips the poster entirely. Decimals allowed. |

Example — direct link:

```
https://gmc64.com/play.html?disk=demo&file=aliens/prg&nocredit=1
```

### Editor (`editor.html`) — loads into the editor, optionally plays

| Param | Purpose |
|-------|---------|
| `disk` | Same as above |
| `file` | Same as above |
| `play=1` | Show a play-button overlay with a poster preview when the page opens. Visitor clicks play to run, clicks the stop button to drop into the editor. Without this flag the file just opens for editing. |
| `poster_seconds` | Same as above; only meaningful with `play=1` |
| `play_demo=1` | Alias — expands to `disk=demo&file=gmc64i/prg&play=1&poster_seconds=8.5` |

Example — send someone a runnable link that still lets them peek behind the curtain:

```
https://gmc64.com/editor.html?disk=https://your-host.com/game.d64&file=GAME/PRG&play=1
```

The other editors (`sprite-maker.html`, `scene-maker.html`, `sound-maker.html`,
`music-maker.html`) accept `disk` and `file` too — deep-linking straight to a
specific asset for editing.

### Iframe embed

Two ways to get an embeddable game, depending on what you're willing to host.

**Option A — self-contained HTML.** Use the editor's **Export Game** button
under **file**. It downloads a single HTML file containing your program, the
disk image, and the runtime. Host it anywhere (GitHub Pages, Netlify, S3, your
own server), then embed it. The Export dialog also generates the iframe snippet
for you — just paste the URL where you'll host the file:

```html
<iframe src="https://your-site.com/mygame.html"
        width="640" height="500"
        allow="autoplay" loading="lazy"
        frameborder="0"></iframe>
```

**Option B — `play.html` + a hosted `.d64`.** Skip export. If your disk image
is already at a public URL, point `play.html` at it directly:

```html
<iframe src="https://gmc64.com/play.html?disk=https://your-host.com/game.d64&file=GAME/PRG"
        width="640" height="500"
        allow="autoplay" loading="lazy"
        frameborder="0"></iframe>
```

Note: disk=demo is a special case that loads from the bundled demo disk.

**Cross-origin disks:** for option B, if your `.d64` lives on a different
domain than the page hosting `play.html`, that origin needs to allow
cross-origin fetches (CORS). Option A avoids this entirely — the disk is inside
the HTML.

## What's included

| File | What it edits |
|------|---------------|
| `editor.html` | Program instructions + runtime + asset assignment |
| `sprite-maker.html` | Sprites (multi-color, multi-frame, multi-part) |
| `scene-maker.html` | Backgrounds (160×200 indexed-color scenes) |
| `sound-maker.html` | Sound effects (SID-style) |
| `music-maker.html` | Songs (3 channels, score-style staff editor) |

All five editors read and write to the same in-browser `.d64` image, so your
sprites flow into scenes flow into programs the same way they did on the C64.

## Dependencies

**To play and edit: none.** It's static HTML and JavaScript. No build step, no
server, no npm. Open the files in a browser and use them. They also run from
`file://` (just double-click).

**To rebuild the standalone bundle:** Node.js. Pure built-ins, no `npm install`
needed. After editing `play.html` or any file it loads from `js/`, run:

```
node tools/bundle-standalone.js
```

This regenerates `js/standalone-source.js` — a snapshot of `play.html` with
every `<script src>` inlined, used by the editor's "Export Game" flow to
produce a self-contained playable HTML file.

**To run the test suite:** the test tooling lives in `dev/` (kept out of the
project root so static hosts don't mistake this for a Node project). One-time
setup:

```
cd dev
npm install
```

Then from `dev/`:

```
npm test                 # run the full suite
npm run generate-golden  # regenerate golden files after intentional changes
```

This pulls in vitest (test runner) and puppeteer (headless browser). Only
contributors need this.

## Status

Ready for use. Most games run faithfully. Tested on GameMaker's included
demo games Archer, Chopper, and Pitfall. (Note: these are not included in
gmc64 for copyright reasons.) Sprites, scenes, sound effects, music, and
program logic all reproduce the original behavior. Reports of edge cases
are welcome.

The overall user experience should be significantly better than running
GameMaker under an emulator.

However, there is no mobile support. I have not implemented any touch controls.
gmc64 is currently desktop/laptop only. This will change in the future.

**Known limitations:**

- **Instruction timing is not cycle-accurate.** The JavaScript engine runs at
  60fps and executes 50 ops (GameMaker instructions) per frame. This is very
close to the original, but programs that rely on precise timing loops may have
some timing issues. 
- **Music-maker instrument sounds aren't fine-tuned.** The song instruments are
  very rough approximations of the original GameMaker tones. They sound similar
in most cases but songs will sound somewhat different.
- **Music and sound effects polyphony.** The original C64 could only generate 3
  voices at once, so sound effects would steal voices temporarily from music.
gmc64 does not emulate this and so you have three channels for music and three
more channels for sound.

## Technical notes

- File format details (`.PRG`, `.SPR`, `.SND`, `.SNG`, `.PIC`, `.D64`)
- Architecture decisions
- Coordinate system, timing formulas, multi-part sprites

All documented in [`CLAUDE.md`](CLAUDE.md) — written for both AI coding assistants and humans who want to dig in.

## Disclaimer

gmc64 is an independent, unaffiliated, re-implementation made for preservation,
education, and fun. It is not affiliated with, endorsed by, or connected to
Activision, Activision Blizzard, Microsoft, or any other rights holder.
"GameMaker" and any related marks are property of their respective owners. None
of the original 1985 code is used or included.

The repository does not contain any commercial disk images or programs. If you
have an original GameMaker disk, you can use it with gmc64 yourself; obtain
disk images through legal channels.

## License

[MIT](LICENSE). Do what you like with the engine and editors.

The included demos (`disks/gmc64-demo.d64`) are original work, also under MIT.
