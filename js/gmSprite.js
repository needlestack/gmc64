// gmSprite.js — Reads and displays GMC64 sprites
//
// === ARCHITECTURE: PER-SLOT SPRITE INSTANCES ===
// Each sprite slot in the runtime gets its own gmSprite instance, created when
// a "sprite X is name" instruction executes. This matches real C64 hardware
// behavior where each hardware sprite has independent color registers.
//
// Why per-slot instances instead of shared instances?
//   - Programs often use the same sprite image in multiple slots with
//     different colors (e.g., player vs enemy variants of the same shape)
//   - On the real C64, each sprite slot has its own color 1 register
//   - Sharing instances would cause color changes to affect all slots using
//     that sprite, which breaks games that rely on per-slot colors
//
// === COLOR SYSTEM: SPRITE-WIDE PALETTE, LAZY RGB RESOLUTION ===
// Each sprite has a single 4-slot palette that applies to every quad
// (matching the C64 VIC's one-palette-per-sprite hardware behaviour).
// Consumers go through the public API:
//   - getColor(slot) / setColor(slot, c64Index)  — single slot
//   - getPalette() / setPalette([bg, c1, c2, c3]) — bulk
// Slot indices follow GM's UI:
//   0 = bg (transparent in-game), 1 = "Color 1" (unique), 2 = "Color 2" (shared),
//   3 = "Color 3" (shared). See setColor() for the slot↔file-byte mapping.
//
// The underlying _bgColor / _gmColor1/2/3 fields back this API. Each quad
// also carries copies (the file format stores them per-subheader), but the
// quad copies are never consulted at render time — decodeSpriteData
// normalizes them to the main palette on parse, and serialize replicates
// the main palette into every subheader on save.
//
// RGB values are resolved lazily at render time via _getCurrentPalette().
// This matches gmScene's approach and allows efficient palette changes:
//   - setColor() just updates the index and sets the dirty flag
//   - Multiple color changes before next frame = single re-render
//   - Sprites that aren't drawn don't waste time re-rendering
//
// === COORDINATE SYSTEM (320×200 NATIVE RESOLUTION) ===
// This version renders at the C64's true 320×200 resolution, with CSS handling
// final scale-up to display size. This eliminates coordinate mismatches that
// caused collision detection bugs in the original gmSprite.js.
//
// Key insight: The C64 has two pixel modes:
//   - Hi-res mode: 320×200, each pixel is 1×1
//   - Multicolor mode: 160×200, but displayed as 320×200 with "fat pixels" that are 2×1
//
// By working in 320×200 space internally:
//   - Multicolor pixels become 2×1 blocks
//   - Hi-res pixels become 1×1 blocks
//   - All coordinates are in the same space (no more scaling confusion)
//   - Collision detection is trivial (same coords everywhere)
//
// === POSITION NORMALIZATION (December 2025) ===
// The GM file format stores X position in hi-res screen coordinates (0-319)
// for BOTH multicolor and hi-res sprites. This was discovered through hex
// analysis of sprite files created in real GameMaker.
//
// To simplify all downstream code, we normalize xPosition to "fat pixels"
// at load time by dividing by 2. This means:
//   - All code (editor, runtime, display) uses the same coordinate system
//   - No scattered if(isMultiColor) branches for coordinate conversion
//   - serializeSprite() converts back by multiplying by 2 when saving
//
// This architectural decision eliminated ~40 lines of redundant branching
// code that was causing bugs in hi-res sprite handling.
//
// === SPRITE FILE FORMAT ===
// GameMaker sprites have a 37-byte main header, followed by frame data.
// Multi-sprite ("quad") sprites have additional 32-byte subheaders.
// Each frame is 64 bytes (63 bytes of pixel data + 1 padding byte).
// A C64 hardware sprite is 24×21 pixels (12×21 in multicolor fat pixels).
//
// Main Header (37 bytes):
//   [0-4]   Magic number: 1D 60 47 45 4B
//   [5-10]  Sprite name (6 PETSCII characters)
//   [11]    X position (GM coordinate space)
//   [12]    Y position (GM coordinate space)
//   [13]    Color 1 (C64 palette index 0-15, unique per sprite)
//   [14]    Color 2 (C64 palette index 0-15, shared)
//   [15]    Color 3 (C64 palette index 0-15, shared)
//   [16]    Background color (C64 palette index 0-15)
//   [17]    Flags byte 1: bit 7 = X-double, bit 6 = Y-double
//   [18]    Flags byte 2: bit 7 = multicolor mode, bit 6 = overlay
//   [19]    Number of frames
//   [20]    Number of additional sprites (quads: 0-3)
//   [21-36] Reserved/padding
//
// Subheader (32 bytes, for each additional quad sprite):
//   [0-5]   Sprite name (6 PETSCII characters, no magic number)
//   [6]     X offset from main sprite
//   [7]     Y offset from main sprite
//   [8]     Color 1
//   [9]     Color 2
//   [10]    Color 3
//   [11]    Background color
//   [12]    Flags byte 1
//   [13]    Flags byte 2
//   [14]    Number of frames
//   [15-31] Reserved/padding
//
// Frame Data (64 bytes per frame):
//   [0-62]  Pixel data: 21 rows × 3 bytes per row = 63 bytes
//           Each byte contains 4 pixels (2 bits each) in multicolor mode
//           or 8 pixels (1 bit each) in hi-res mode
//   [63]    Padding byte
//
// === MULTI-PART SPRITE CONVENTION ===
// ONE gmSprite object manages ALL quads. Whether loaded from .SPR file or PRG,
// the gmSprite parses all quads into this.sprite[0..3]. The mediaStore has
// empty "marker" entries for subsprites (sprite: null, quadIndex > 0).
//
// DO NOT create separate gmSprite instances for each quad.
// See CLAUDE.md "Multi-Part Sprites" for full documentation.
//
// === WHY PIXEL ARRAYS INSTEAD OF CANVAS ===
// The old gmSprite.js used fillRect() to draw to canvas elements at scaled
// resolution (72×84 per frame). This had several problems:
//   1. Required coordinate conversion everywhere
//   2. Collision detection needed separate "screen space" calculations
//   3. Multiple scale factors to track (6×4 for multicolor, 3×4 for hi-res)
//
// gmSprite stores frames as raw RGBA pixel arrays at 320×200 resolution.
// These get blitted to a composite buffer (c64Screen.pixels), then one
// putImageData() call displays the result. CSS handles final display scaling.

class gmSprite {

    // === NATIVE SPRITE DIMENSIONS ===
    // A C64 hardware sprite is always 24×21 pixels in 320×200 space.
    // In multicolor mode, that's 12 "fat pixels" wide (each 2 pixels).
    // In hi-res mode, that's 24 thin pixels.
    // The xDouble/yDouble flags can double these dimensions.
    static SPRITE_WIDTH = 24;
    static SPRITE_HEIGHT = 21;

    // === SPRITE FILE STRUCTURE ===
    // Main header: 37 bytes (includes 5-byte "magic number" file signature)
    // Subheader: 32 bytes (no magic number, shorter name field)
    // Frame data: 64 bytes per frame (63 pixels + 1 padding)
    //   - 21 rows × 3 bytes per row = 63 bytes of actual pixel data
    static HEADER_DATA_SIZE = 37;
    static SUBHEADER_DATA_SIZE = 32;
    static SPRITE_DATA_SIZE = 64;

    // Creates a new blank sprite for the editor.
    // options: { name, isMultiColor, xDouble, yDouble, numFrames, bgColor, color1, color2, color3 }
    static createBlank(options = {}) {
        const name = (options.name || 'NEW').padEnd(6, ' ').substring(0, 6);
        const isMultiColor = options.isMultiColor !== undefined ? options.isMultiColor : true;
        const xDouble = options.xDouble || false;
        const yDouble = options.yDouble || false;
        const numFrames = options.numFrames || 1;
        const bgColor = options.bgColor !== undefined ? options.bgColor : 0;
        const gmColor1 = options.gmColor1 !== undefined ? options.gmColor1 : 2;  // unique sprite color
        const gmColor2 = options.gmColor2 !== undefined ? options.gmColor2 : 1;  // shared
        const gmColor3 = options.gmColor3 !== undefined ? options.gmColor3 : 3;  // shared

        // Create instance without calling constructor's fileData parsing
        const sprite = Object.create(gmSprite.prototype);

        sprite.fileData = null;
        sprite.animSpeed = 30;
        sprite.currentFrame = 0;
        sprite.dirty = true;

        // Set colors at instance level (names match GM's UI terminology)
        sprite._bgColor = bgColor;
        sprite._gmColor1 = gmColor1;
        sprite._gmColor2 = gmColor2;
        sprite._gmColor3 = gmColor3;

        // Create the sprite data structure (array of quads)
        // Default position: bottom-right area where preview background is
        // Screen-relative coords: X in fat pixels (0-159), Y in pixels (0-199)
        sprite.sprite = [{
            spriteName: name,
            isMultiColor: isMultiColor,
            numFrames: numFrames,       // animation frame count
            totalFrames: numFrames,     // total frames (same as numFrames for new sprites)
            numSprites: 1,
            xDouble: xDouble,
            yDouble: yDouble,
            xPosition: options.xPosition !== undefined ? options.xPosition : 100,  // Right side of screen
            yPosition: options.yPosition !== undefined ? options.yPosition : 100,  // Lower area
            spriteNum: 1,
            _bgColor: bgColor,
            _gmColor1: gmColor1,
            _gmColor2: gmColor2,
            _gmColor3: gmColor3,
            imageData: [],
            frames: []
        }];

        // Initialize blank frames
        for (let f = 0; f < numFrames; f++) {
            sprite.sprite[0].imageData.push(new Uint8Array(gmSprite.SPRITE_DATA_SIZE));
        }

        sprite.sizeInBytes = gmSprite.HEADER_DATA_SIZE + (numFrames * gmSprite.SPRITE_DATA_SIZE);

        return sprite;
    }

    // Creates a new sprite instance from raw file data.
    // Called by gmRuntime when executing "sprite X is name" - each slot gets
    // its own instance so colors can be changed independently per slot.
    constructor(fileData) {
        this.fileData = fileData;
        this.decodeSpriteData();
        this.animSpeed = 30;
        this.currentFrame = 0;

        // === PALETTE: SEED FROM MAIN HEADER ===
        // Promote the parsed main header's palette to instance-level fields
        // so each sprite instance has its own independent palette (slots can
        // recolour the same sprite differently). Public access is through
        // getColor/setColor/getPalette/setPalette — see the class-level doc.
        const header = this.sprite[0];
        this._bgColor = header._bgColor;
        this._gmColor1 = header._gmColor1;
        this._gmColor2 = header._gmColor2;
        this._gmColor3 = header._gmColor3;

        // === LAZY RENDERING ===
        // Frames are rendered on-demand when getFrame() is called.
        // The dirty flag triggers re-rendering after color changes.
        // This avoids wasting cycles rendering sprites that aren't visible,
        // and batches multiple color changes into a single re-render.
        this.dirty = true;

        this.calculateSizeInBytes();
    }

    // Subsprite positions use signed bytes (-128 to 127) for relative offsets.
    // Negative values position subsprites to the left/above the main sprite.
    signedByte(byte) {
        return byte < 128 ? byte : byte - 256;
    }

    // Calculate total byte size of sprite data in memory.
    // Used by the game editor to find where the next sprite starts in
    // a concatenated data stream (e.g., when sprites are embedded in game files).
    //
    // NOTE: This calculates size for ALL quads in a standalone .SPR file.
    // For PRG-embedded sprites, each quad is a separate data page entry,
    // so use quadSizeInBytes() instead to get individual quad sizes.
    //
    // Subtracts 5 because the file "magic number" exists in standalone
    // .SPR files but not when sprites are embedded in game data.
    // Uses totalFrames (not numFrames) to account for hidden frames beyond animation.
    calculateSizeInBytes() {
        // Each quad has its own totalFrames count from its header
        let sizeInBytes = gmSprite.HEADER_DATA_SIZE;
        sizeInBytes += gmSprite.SPRITE_DATA_SIZE * this.sprite[0].totalFrames;
        for (let q = 1; q < this.sprite.length; q++) {
            sizeInBytes += gmSprite.SUBHEADER_DATA_SIZE;
            sizeInBytes += gmSprite.SPRITE_DATA_SIZE * this.sprite[q].totalFrames;
        }
        sizeInBytes -= 5; // magic number not in embedded sprites
        this.sizeInBytes = sizeInBytes;
    }

    // Calculate byte size of a single quad for PRG serialization.
    // In PRG files, each quad is stored as a separate data page entry with its own
    // pointer, unlike standalone .SPR files where all quads are contiguous.
    // Formula: header (32 bytes, no magic) + totalFrames * 64 bytes per frame
    quadSizeInBytes(quadIndex = 0) {
        if (quadIndex >= this.sprite.length) return 0;
        const totalFrames = this.sprite[quadIndex].totalFrames || 1;
        // Quad 0 uses full main header (37 bytes), other quads use subheader (32 bytes)
        const headerSize = quadIndex === 0 ? gmSprite.HEADER_DATA_SIZE : gmSprite.SUBHEADER_DATA_SIZE;
        return headerSize + totalFrames * gmSprite.SPRITE_DATA_SIZE;
    }

    // === HEADER DECODING ===
    // Decodes sprite header data. Main header (isSub=false) has a 5-byte magic
    // number prefix that subheaders lack, hence the offset adjustment.
    //
    // Header byte layout (offsets shown for main header; subtract 5 for subheader):
    //   [0-4]   Magic number (main only): identifies as GM sprite file
    //   [5-10]  Sprite name: 6 PETSCII characters (main) or 5 chars (sub)
    //   [12]    Color 1 (multicolor mode)
    //   [13]    Color 3 (multicolor mode)
    //   [14]    Mode: 0=hi-res, non-zero=multicolor
    //   [15]    Animation frame count (0-30, add 1 for actual count 1-31)
    //   [16]    X double: 0=normal, non-zero=2× width
    //   [17]    Y double: 0=normal, non-zero=2× height
    //   [18]    Background color
    //   [19]    Sprite count (0-3, add 1 for actual count 1-4)
    //   [20-21] Quad data size (little-endian): total bytes for this quad's frame data
    //           Formula: totalFrames = (dataSize - 32) / 64
    //           This may exceed numFrames when sprite has hidden frames beyond animation.
    //   [24]    X position (low byte)
    //   [25]    Y position (values 50-229 map to screen rows 0-179)
    //   [26]    X position high bit (bit 4 indicates +256 for far-right positions)
    //   [27]    Sprite number within quad (0-3, add 1 for 1-4)
    //   [28]    Color 2 (both modes)
    decodeHeader(fileData, isSub) {
        // Subheaders lack the 5-byte magic number, so all offsets shift
        let o = isSub ? -5 : 0;

        // Quad data size from bytes 20-21 (little-endian)
        // Formula: totalFrames = (dataSize - 32) / 64
        const quadDataSize = fileData[20 + o] + (fileData[21 + o] << 8);
        const totalFrames = (quadDataSize - 32) / 64;

        const sprite = {
            // Main header has 6-char name at bytes 5-10; subheader has 5-char at 1-5
            spriteName: o == 0
                ? decodeString(fileData.slice(5, 11))
                : decodeString(fileData.slice(1, 6)),
            isMultiColor: fileData[14 + o] !== 0,
            numFrames: fileData[15 + o] + 1,    // animation frame count (stored as 0-30, actual is 1-31)
            totalFrames: totalFrames,           // total frames including hidden frames beyond animation
            xDouble: fileData[16 + o] !== 0,
            yDouble: fileData[17 + o] !== 0,
            numSprites: fileData[19 + o] + 1,   // stored as 0-3, actual is 1-4 ("quads")
            spriteNum: fileData[27 + o] + 1,    // which sprite am I in the quad?
        };

        // === PALETTE ===
        // Store C64 color indices (0-15) as named properties.
        // RGB resolution happens lazily at render time via _getCurrentPalette().
        //
        // Variable names match GameMaker's UI terminology:
        //   _gmColor1 = GM "Color 1" = unique per sprite = file byte 28 = pixel value 10
        //   _gmColor2 = GM "Color 2" = shared color     = file byte 12 = pixel value 01
        //   _gmColor3 = GM "Color 3" = shared color     = file byte 13 = pixel value 11
        //
        // In hi-res mode, only _gmColor1 is used (the sole drawing color).
        // GM stores hi-res color at byte 28 (same as multicolor's unique color).
        //
        // The palette is sprite-wide: the VIC chip applies one palette to
        // every quad. The file format stores colour bytes on every subheader
        // too, but those are not honoured at render time. Subheader bytes
        // are read here so the per-quad fields exist (any consumer reading
        // them gets a sensible value), but decodeSpriteData overwrites the
        // subquad palette with the main header's straight after parsing so
        // the per-quad fields always agree with the canonical sprite palette.
        sprite._bgColor = fileData[18 + o];  // background (transparent in-game)
        sprite._gmColor1 = fileData[28 + o]; // GM "Color 1" - unique sprite color (always byte 28)
        if (sprite.isMultiColor) {
            sprite._gmColor2 = fileData[12 + o];  // GM "Color 2" - shared (byte 12)
            sprite._gmColor3 = fileData[13 + o];  // GM "Color 3" - shared (byte 13)
        } else {
            // Hi-res: only _gmColor1 is used
            sprite._gmColor2 = 0;  // unused in hi-res
            sprite._gmColor3 = 0;  // unused in hi-res
        }

        // === POSITIONING ===
        if (sprite.spriteNum === 1) {
            // Main sprite uses absolute screen coordinates

            // X position handling:
            // The file stores hi-res screen coordinates (0-319 range).
            // Byte 26's upper nibble bit 0 (tested via >> 4 & 1) indicates whether to
            // add 256 to reach positions on the far right side of the screen.
            // We subtract 24 (sprite width in hi-res pixels) because GM stores position of right edge.
            if ((fileData[26] >> 4) & 1) {
                // Upper nibble is odd (10, 30, 50, 70, 90, B0, D0, F0): far right
                sprite.xPosition = fileData[24] + 256 - 24;
            } else {
                // Upper nibble is even (00, 20, 40, 60, 80, A0, C0, E0): normal range
                sprite.xPosition = fileData[24] - 24;
            }

            // NORMALIZE TO FAT PIXELS:
            // File stores hi-res coords for BOTH multicolor and hi-res sprites.
            // We always convert to fat pixel space (divide by 2) so all downstream
            // code can use a single coordinate system. Convert back when saving.
            sprite.xPosition = sprite.xPosition / 2;

            // Y position: stored as 50-229 (180 visible rows), we normalize to 0-179
            sprite.yPosition = fileData[25] - 50;
        } else {
            // Subsprites use relative positioning (signed offsets from main sprite)
            // These are in "fat pixel" units for both multicolor and hi-res sprites
            sprite.xPosition = this.signedByte(fileData[17]);
            sprite.yPosition = this.signedByte(fileData[18]);
        }

        return sprite;
    }

    decodeSubHeader(subheader) {
        return this.decodeHeader(subheader, true);
    }

    // === SPRITE DATA PARSING ===
    // A fully decoded sprite is an array of 1-4 "quad" elements.
    // Each quad contains:
    //   - Header data (name, colors, position, flags)
    //   - imageData: array of 1-31 frames (raw bytes from file)
    //   - frames: array of rendered pixel arrays (created by renderFrames())
    //
    // "Quad" terminology: GameMaker allows combining up to 4 C64 hardware sprites
    // into a single logical sprite. This enables larger sprites (up to 48×42 pixels
    // or 96×84 when doubled) by positioning subsprites adjacent to the main sprite.
    decodeSpriteData() {
        const header = this.decodeHeader(this.fileData);
        let readStart = gmSprite.HEADER_DATA_SIZE;

        this.sprite = [];
        for (let quad = 0; quad < header.numSprites; ++quad) {
            let quadHeader;
            if (quad == 0) {
                quadHeader = header;
            } else {
                quadHeader = this.decodeSubHeader(
                    this.fileData.slice(readStart, readStart + gmSprite.SUBHEADER_DATA_SIZE)
                );
                readStart += gmSprite.SUBHEADER_DATA_SIZE;
            }
            this.sprite[quad] = quadHeader;

            // Read frame data for this quad using totalFrames from header
            // (totalFrames may exceed numFrames when sprite has hidden frames beyond animation)
            this.sprite[quad].imageData = [];
            for (let frame = 0; frame < quadHeader.totalFrames; ++frame) {
                this.sprite[quad].imageData[frame] = this.fileData.slice(
                    readStart, readStart + gmSprite.SPRITE_DATA_SIZE
                );
                readStart += gmSprite.SPRITE_DATA_SIZE;
            }
        }

        // Normalize subquad palettes to the main header's. The palette is
        // sprite-wide (VIC applies one palette per sprite), so any divergence
        // in subheader colour bytes from the file is ignored — the main
        // header wins. This keeps the per-quad fields consistent with the
        // canonical palette without any consumer needing to remember which
        // one to read.
        const main = this.sprite[0];
        for (let q = 1; q < this.sprite.length; q++) {
            this.sprite[q]._bgColor  = main._bgColor;
            this.sprite[q]._gmColor1 = main._gmColor1;
            this.sprite[q]._gmColor2 = main._gmColor2;
            this.sprite[q]._gmColor3 = main._gmColor3;
        }
    }

    // === PALETTE RESOLUTION ===
    // Converts C64 color indices to RGB values at render time.
    // This lazy resolution approach (matching gmScene) means:
    //   - Color changes are cheap (just update index + set dirty)
    //   - Multiple changes before render = one re-render
    //   - No wasted work for off-screen sprites
    //
    // === PALETTE API ===
    // Sprite-wide colours, kept at the top level (the renderer reads them
    // here for every quad). The .SPR file format also has per-quad colour
    // fields in subheaders, but the C64 VIC chip applies one shared palette
    // per sprite — those per-quad fields are vestigial. We treat the palette
    // as global per sprite both for editing and on disk: parse ignores
    // per-quad colours, serialize replicates the top-level palette into
    // every subheader.
    //
    // Slot indices follow GM's UI: 0 = bg, 1 = gmColor1 (unique), 2 = gmColor2
    // (shared), 3 = gmColor3 (shared). These don't match the C64 pixel-value
    // ordering — see _getCurrentPalette for that mapping.
    getColor(slot) {
        switch (slot) {
            case 0: return this._bgColor;
            case 1: return this._gmColor1;
            case 2: return this._gmColor2;
            case 3: return this._gmColor3;
            default: return 0;
        }
    }
    // setColor(slot, value) is defined later in this class — it also masks
    // the value to a valid C64 colour index (& 0x0F) and sets the dirty flag.
    getPalette() {
        return [this._bgColor, this._gmColor1, this._gmColor2, this._gmColor3];
    }
    // === FRAME COUNT API ===
    // numFrames is the length of the animation loop (1..31). Each quad's
    // header stores its own copy in the .SPR file, but for multi-quad
    // sprites every quad MUST share the same animation length — they
    // animate in lockstep. We canonicalise on quad 0 for reads and
    // propagate writes to every quad so they can't drift.
    //
    // Distinct from totalFrames, which is the number of frame slots
    // actually stored (may exceed numFrames for hidden scratch frames).
    getNumFrames() {
        return this.sprite[0].numFrames;
    }
    setNumFrames(n) {
        const clamped = Math.max(1, Math.min(31, n | 0));
        for (const quad of this.sprite) {
            quad.numFrames = clamped;
        }
        this.dirty = true;
    }

    setPalette(palette) {
        this._bgColor  = palette[0];
        this._gmColor1 = palette[1];
        this._gmColor2 = palette[2];
        this._gmColor3 = palette[3];
        this.dirty = true;
    }

    // Palette indices map to C64 multicolor pixel values:
    //   [0] = pixel 00 = background (transparent)
    //   [1] = pixel 01 = _gmColor2 (GM "Color 2", shared) - multicolor only
    //   [2] = pixel 10 = _gmColor1 (GM "Color 1", unique)
    //   [3] = pixel 11 = _gmColor3 (GM "Color 3", shared) - multicolor only
    //
    // For hi-res sprites, pixel values are 0 or 1, so we put _gmColor1
    // in slot 1 (the rendering code uses palette[1] for set pixels).
    _getCurrentPalette() {
        const isMultiColor = this.sprite[0].isMultiColor;
        return [
            c64Palette[this._bgColor],   // Index 0 = background (transparent)
            isMultiColor ? c64Palette[this._gmColor2] : c64Palette[this._gmColor1],  // Index 1
            c64Palette[this._gmColor1],  // Index 2 = GM "Color 1" (unique sprite color)
            c64Palette[this._gmColor3]   // Index 3 = GM "Color 3" (shared)
        ];
    }

    // === FRAME RENDERING ===
    // Converts raw sprite data (imageData) into pixel arrays ready for blitting.
    //
    // C64 sprite pixel encoding:
    //   - Each row is 3 bytes (24 bits)
    //   - Multicolor: 2 bits per pixel = 4 pixels per byte = 12 fat pixels per row
    //   - Hi-res: 1 bit per pixel = 8 pixels per byte = 24 thin pixels per row
    //
    // We render at 320×200 resolution:
    //   - Multicolor fat pixels become 2×1 blocks
    //   - Hi-res thin pixels become 1×1 blocks
    //   - xDouble/yDouble flags multiply dimensions by 2
    //
    // Color index meanings:
    //   - Multicolor: 0=transparent, 1/2/3=sprite colors from palette
    //   - Hi-res: 0=transparent, 1=foreground color
    //
    // Output: Each frame stored as { pixels: Uint8Array, width, height }
    // where pixels is RGBA data (4 bytes per pixel) with alpha=0 for transparent.
    _renderFrames() {
        const xDouble = this.sprite[0].xDouble ? 2 : 1;
        const yDouble = this.sprite[0].yDouble ? 2 : 1;
        const isMultiColor = this.sprite[0].isMultiColor;

        // Frame dimensions in 320×200 space
        // Base: 24×21 (or 12×21 fat pixels for multicolor, rendered as 24×21)
        // Doubled: 48×42 (or 24×21 fat pixels rendered as 48×42)
        const frameWidth = gmSprite.SPRITE_WIDTH * xDouble;
        const frameHeight = gmSprite.SPRITE_HEIGHT * yDouble;

        // Get palette once - same for all quads
        const palette = this._getCurrentPalette();

        for (let quad = 0; quad < this.sprite.length; quad++) {
            this.sprite[quad].frames = [];

            for (let frame = 0; frame < this.sprite[quad].totalFrames; frame++) {
                // Create pixel array (RGBA, 4 bytes per pixel)
                // Uint8Array is zero-initialized, so alpha starts at 0 (transparent)
                const pixels = new Uint8Array(frameWidth * frameHeight * 4);

                const imageData = this.sprite[quad].imageData[frame];

                // Process each of the 21 rows
                for (let row = 0; row < 21; row++) {
                    // Each row is 3 bytes
                    for (let col = 0; col < 3; col++) {
                        const byte = imageData[row * 3 + col];

                        if (isMultiColor) {
                            // === MULTICOLOR MODE ===
                            // 2 bits per pixel, 4 pixels per byte
                            // Bits 7-6 = pixel 0, bits 5-4 = pixel 1, etc.
                            // Each multicolor pixel spans 2 horizontal pixels in 320-wide space
                            for (let bitPair = 0; bitPair < 4; bitPair++) {
                                const colorIndex = (byte >> (6 - bitPair * 2)) & 0b11;
                                if (colorIndex === 0) continue; // transparent (background)

                                const color = palette[colorIndex];
                                // Calculate fat pixel X position (0-11 across sprite)
                                const fatPixelX = col * 4 + bitPair;

                                // Draw 2×1 block (each fat pixel = 2 horizontal pixels)
                                // If xDouble, draw 4×2; if yDouble, draw 2×2; if both, draw 4×4
                                for (let dy = 0; dy < yDouble; dy++) {
                                    for (let dx = 0; dx < 2 * xDouble; dx++) {
                                        const px = fatPixelX * 2 * xDouble + dx;
                                        const py = row * yDouble + dy;
                                        const idx = (py * frameWidth + px) * 4;
                                        pixels[idx] = color[0];     // R
                                        pixels[idx + 1] = color[1]; // G
                                        pixels[idx + 2] = color[2]; // B
                                        pixels[idx + 3] = 255;      // A (opaque)
                                    }
                                }
                            }
                        } else {
                            // === HI-RES MODE ===
                            // 1 bit per pixel, 8 pixels per byte
                            // Bit 7 = pixel 0 (leftmost), bit 0 = pixel 7 (rightmost)
                            // Each hi-res pixel is 1 pixel in 320-wide space
                            for (let bit = 0; bit < 8; bit++) {
                                const colorIndex = (byte >> (7 - bit)) & 0b1;
                                if (colorIndex === 0) continue; // transparent (background)

                                const color = palette[colorIndex];
                                // Calculate thin pixel X position (0-23 across sprite)
                                const pixelX = col * 8 + bit;

                                // Draw 1×1 block (each thin pixel = 1 pixel)
                                // If xDouble, draw 2×1; if yDouble, draw 1×2; if both, draw 2×2
                                for (let dy = 0; dy < yDouble; dy++) {
                                    for (let dx = 0; dx < xDouble; dx++) {
                                        const px = pixelX * xDouble + dx;
                                        const py = row * yDouble + dy;
                                        const idx = (py * frameWidth + px) * 4;
                                        pixels[idx] = color[0];     // R
                                        pixels[idx + 1] = color[1]; // G
                                        pixels[idx + 2] = color[2]; // B
                                        pixels[idx + 3] = 255;      // A (opaque)
                                    }
                                }
                            }
                        }
                    }
                }

                // Store rendered frame
                this.sprite[quad].frames[frame] = {
                    pixels: pixels,
                    width: frameWidth,
                    height: frameHeight
                };
            }
        }
    }

    // === ANIMATION SPEED ===
    // GameMaker animation speed ranges from 1-31 (slider shows 1-32 for UI).
    // At speed 31: frame advances every screen refresh (~30fps on NTSC C64)
    // At speed 30: frame advances every other refresh
    // At speed 29: frame advances every third refresh
    // Formula: framesToSkip = 32 - speed
    //
    // The caller controls the timing of animation calls (should be every ~33ms
    // to match NTSC C64 screen refresh), but the sprite uses skipFrameCounter
    // to throttle actual frame advances according to animSpeed.
    setAnimSpeed(speed) {
        if (speed >= 1 && speed <= 32) {
            this.animSpeed = speed;
            this.skipFrameCounter = undefined; // reset counter on speed change
        }
        return this.animSpeed;
    }

    // === RUNTIME COLOR CHANGES ===
    // Change a color in this sprite instance's palette.
    //
    // Because each sprite slot has its own gmSprite instance, this only affects
    // the slot that owns this instance. This is critical for programs that
    // use the same sprite image in multiple slots with different colors.
    //
    // colorSlot matches GM's terminology:
    //   0 = background
    //   1 = GM "Color 1" (unique sprite color, _gmColor1)
    //   2 = GM "Color 2" (shared, _gmColor2)
    //   3 = GM "Color 3" (shared, _gmColor3)
    //
    // c64ColorIndex: 0-15 (C64 palette index)
    //
    // Frames are NOT immediately re-rendered - just sets the dirty flag.
    // Actual re-render happens lazily when getFrame() is called.
    setColor(colorSlot, c64ColorIndex) {
        const color = c64ColorIndex & 0x0F;
        switch (colorSlot) {
            case 0: this._bgColor = color; break;
            case 1: this._gmColor1 = color; break;  // GM "Color 1"
            case 2: this._gmColor2 = color; break;  // GM "Color 2"
            case 3: this._gmColor3 = color; break;  // GM "Color 3"
            default: return; // invalid slot
        }
        this.dirty = true;
    }

    // Set shared colors (color 2 and 3).
    // On the real C64, colors 2 and 3 are shared across ALL hardware sprites.
    // The runtime (gmRuntime) handles this by calling setSharedColor on every
    // sprite slot's instance when a "sprite shared colrX" instruction executes.
    setSharedColor(colorSlot, c64ColorIndex) {
        // Only slots 2 and 3 are shared in multicolor mode
        if (colorSlot < 2 || colorSlot > 3) return;
        this.setColor(colorSlot, c64ColorIndex);
    }

    // Switch between multicolor and hi-res modes.
    // When switching modes, GameMaker swaps colors 1 and 2. From hex analysis:
    // multi→hi-res: the value at byte 12 (Color 2) moves to byte 28 (drawing color)
    // hi-res→multi: the drawing color becomes Color 2, old Color 2 becomes Color 1
    // This preserves the "main drawing color" semantic across mode changes.
    setMultiColorMode(isMultiColor) {
        const wasMultiColor = this.sprite[0].isMultiColor;
        if (wasMultiColor === isMultiColor) return; // No change

        // Swap colors 1 and 2 at instance level (sprite-wide palette)
        [this._gmColor1, this._gmColor2] = [this._gmColor2, this._gmColor1];

        // Propagate the mode flag to every quad. Per-quad colour fields are
        // not used at render time, so we don't swap them here.
        for (const quad of this.sprite) {
            quad.isMultiColor = isMultiColor;
        }

        this.dirty = true;
    }

    // Get frame dimensions for this sprite (in 320×200 pixels)
    getFrameDimensions() {
        const xDouble = this.sprite[0].xDouble ? 2 : 1;
        const yDouble = this.sprite[0].yDouble ? 2 : 1;
        return {
            width: gmSprite.SPRITE_WIDTH * xDouble,
            height: gmSprite.SPRITE_HEIGHT * yDouble
        };
    }

    // Get pixel data for a specific quad and frame.
    // This is the main entry point for rendering - called by blitToBuffer() and hasPixelAt().
    //
    // Implements lazy rendering: if the dirty flag is set (due to color changes),
    // all frames are re-rendered before returning. This ensures:
    //   - Color changes via setColor() are reflected in the next draw
    //   - Multiple color changes before drawing = single re-render
    //   - Sprites that aren't drawn don't waste cycles re-rendering
    //
    // Returns { pixels: Uint8Array, width, height } or null if invalid indices.
    getFrame(quadIndex, frameIndex) {
        if (quadIndex >= this.sprite.length) return null;
        if (frameIndex >= this.sprite[quadIndex].totalFrames) return null;

        // Lazy render: if colors changed, re-render all frames before returning
        if (this.dirty) {
            this._renderFrames();
            this.dirty = false;
        }

        return this.sprite[quadIndex].frames[frameIndex];
    }

    // === QUAD POSITIONING ===
    // Get the position of a subsprite (quad) in 320×200 coordinates.
    //
    // IMPORTANT: Subsprite xPosition offsets are ALWAYS stored in "fat pixel" units,
    // even for hi-res sprites. This was a source of bugs in the original gmSprite.js
    // where hi-res subsprites overlapped incorrectly.
    //
    // The fix: Always multiply xPosition by 2 to convert to 320×200 space.
    // Y positions are already in 200-tall space (no conversion needed).
    getQuadPosition(quadIndex, baseX, baseY) {
        if (quadIndex === 0) {
            return { x: baseX, y: baseY };
        }

        const spriteData = this.sprite[quadIndex];
        // Subsprite xPosition is ALWAYS in fat pixel units (regardless of multicolor/hi-res)
        // Convert to 320×200 space by multiplying by 2
        const xOffset = spriteData.xPosition * 2;
        const yOffset = spriteData.yPosition;

        return {
            x: baseX + xOffset,
            y: baseY + yOffset
        };
    }

    // === BLITTING ===
    // Copy sprite frame to a composite pixel buffer.
    //
    // Why not just use canvas drawImage()?
    // - putImageData() doesn't alpha-composite; it replaces pixels
    // - To overlap sprites, we must composite manually by skipping alpha=0 pixels
    // - This gives us "alpha blending" by only writing non-transparent pixels
    //
    // The composite buffer (e.g., c64Screen.pixels) collects all sprites,
    // then one putImageData() call displays the final result.
    //
    // Z-order: Quads are drawn back-to-front (highest quad index first)
    // because GameMaker assigns higher z-index to lower-numbered subsprites.
    // skipQuads: optional Set of quad indices to skip (when subsprite slots are overwritten)
    //
    // === COORDINATE WRAPPING ===
    // GM sprite coordinates wrap at 0-255 in GM space. A sprite moving left past x=0
    // wraps to x=255 and continues. Visually, parts of the sprite that extend past
    // the edge appear on the opposite side of the screen.
    //
    // We handle this by:
    // 1. Taking GM coordinates (gmX, gmY) as input
    // 2. For each pixel, calculating its wrapped GM position
    // 3. Converting to screen coordinates and drawing if visible
    //
    // GM to screen conversion:
    //   screenX = (gmX - 12) * 2   (fat pixels, with left border offset)
    //   screenY = gmY - 50          (with top border offset)
    //
    // Visible screen range in GM coords: X=12-171 (160 fat pixels), Y=50-249 (200 pixels)
    //
    // === PRIORITY MASK (optional) ===
    // For "sprite under colors 2/3" semantics — when supplied, sprite pixels
    // are skipped at destinations whose scene palette index is one of the
    // values in mask.skipIndices. The mask gives us the scene's 160×200
    // index buffer (one byte per fat pixel) so we can sample what palette
    // index was painted at each destination before deciding to overwrite.
    //   mask = { indexBuffer, indexWidth, indexHeight, skipIndices: Set<number> }
    // Without mask, sprites render on top (default "over").
    blitToBuffer(target, targetWidth, targetHeight, gmX, gmY, frameIndex, skipQuads = null, mask = null) {
        const xDouble = this.sprite[0].xDouble ? 2 : 1;
        const yDouble = this.sprite[0].yDouble ? 2 : 1;

        // Draw all quads (back to front for correct z-order)
        for (let quad = this.sprite.length - 1; quad >= 0; quad--) {
            // Skip quads whose slots have been overwritten with different sprites
            if (skipQuads && skipQuads.has(quad)) continue;
            const frame = this.getFrame(quad, frameIndex);
            if (!frame) continue;

            // Get quad position offset (subsprites have position relative to main sprite)
            let quadGmX = gmX;
            let quadGmY = gmY;
            if (quad > 0) {
                const spriteData = this.sprite[quad];
                // Subsprite positions are in fat pixel units, same as GM coords
                quadGmX += spriteData.xPosition;
                quadGmY += spriteData.yPosition;
            }

            // Floor base position (sprite positions can be fractional due to velocity)
            quadGmX = Math.floor(quadGmX);
            quadGmY = Math.floor(quadGmY);

            // Frame dimensions in screen pixels (already accounts for doubling)
            // frame.width = 24 * xDouble (48 if doubled)
            // frame.height = 21 * yDouble (42 if doubled)

            // Sprite dimensions in GM units (fat pixels for X, regular pixels for Y)
            // A normal sprite is 12 fat pixels wide, 21 pixels tall
            // xDouble doubles the visual size but the GM coordinate space stays the same
            const spriteWidthGm = 12 * xDouble;   // GM units (fat pixels)
            const spriteHeightGm = 21 * yDouble;  // GM units

            // Blit with coordinate wrapping
            // We iterate over GM coordinate offsets, then map to frame pixels
            for (let gmOffsetY = 0; gmOffsetY < spriteHeightGm; gmOffsetY++) {
                // Calculate wrapped GM Y coordinate
                const pixelGmY = (quadGmY + gmOffsetY) & 0xFF;
                // Convert to screen Y
                const screenY = pixelGmY - 50;
                if (screenY < 0 || screenY >= targetHeight) continue;

                // Map GM Y offset to frame pixel row
                const frameY = gmOffsetY;

                for (let gmOffsetX = 0; gmOffsetX < spriteWidthGm; gmOffsetX++) {
                    // Calculate wrapped GM X coordinate
                    const pixelGmX = (quadGmX + gmOffsetX) & 0xFF;
                    // Convert to screen X (GM fat pixel * 2 = screen pixels)
                    const screenX = (pixelGmX - 12) * 2;

                    // Map GM X offset to frame pixel column
                    // Each GM unit (fat pixel) = 2 screen pixels in the frame
                    const frameX = gmOffsetX * 2;

                    // Priority mask: sample the scene's palette index for this
                    // fat pixel ONCE per outer loop iteration. The scene buffer
                    // is 160×200 (one byte per fat pixel) and screenX/2 gives
                    // the fat-pixel column. Both screen sub-pixels share it.
                    let maskedHere = false;
                    if (mask) {
                        const indexX = screenX >> 1;
                        if (indexX >= 0 && indexX < mask.indexWidth &&
                            screenY >= 0 && screenY < mask.indexHeight) {
                            const sceneIdx = mask.indexBuffer[screenY * mask.indexWidth + indexX];
                            if (mask.skipIndices.has(sceneIdx)) maskedHere = true;
                        }
                    }

                    // Draw the 2 screen pixels that make up this fat pixel
                    for (let dx = 0; dx < 2; dx++) {
                        const srcX = frameX + dx;
                        if (srcX >= frame.width) continue;

                        const srcIdx = (frameY * frame.width + srcX) * 4;
                        const alpha = frame.pixels[srcIdx + 3];
                        if (alpha === 0) continue; // skip transparent pixels

                        const finalX = screenX + dx;
                        if (finalX < 0 || finalX >= targetWidth) continue;

                        if (maskedHere) continue; // sprite is "under" this scene pixel

                        const dstIdx = (screenY * targetWidth + finalX) * 4;
                        target[dstIdx] = frame.pixels[srcIdx];         // R
                        target[dstIdx + 1] = frame.pixels[srcIdx + 1]; // G
                        target[dstIdx + 2] = frame.pixels[srcIdx + 2]; // B
                        target[dstIdx + 3] = 255;                      // A (opaque)
                    }
                }
            }
        }
    }

    // === COLLISION DETECTION HELPERS ===
    // These methods support pixel-perfect collision detection.
    // Since all coordinates are now in 320×200 space, collision is straightforward:
    // just check if non-transparent pixels overlap at the same screen position.

    // Check if a pixel in this sprite is non-transparent at the given local position
    // localX/localY are relative to the quad's frame (0,0 is top-left of frame)
    hasPixelAt(quadIndex, frameIndex, localX, localY) {
        const frame = this.getFrame(quadIndex, frameIndex);
        if (!frame) return false;

        // Floor coordinates to ensure integer pixel lookup
        const x = Math.floor(localX);
        const y = Math.floor(localY);

        if (x < 0 || x >= frame.width || y < 0 || y >= frame.height) {
            return false;
        }
        const idx = (y * frame.width + x) * 4 + 3; // alpha channel
        return frame.pixels[idx] > 0;
    }

    // Get bounding box (hitbox) for a quad in 320×200 coordinates
    // Used for fast AABB collision check before pixel-perfect check
    getHitbox(quadIndex, baseX, baseY) {
        const pos = this.getQuadPosition(quadIndex, baseX, baseY);
        const dims = this.getFrameDimensions();
        return {
            x: pos.x,
            y: pos.y,
            width: dims.width,
            height: dims.height,
            quadIndex: quadIndex
        };
    }

    // Get hitboxes for all quads (quadIndex=-1) or a specific quad
    // Returns array of hitbox objects in 320×200 coordinates
    getHitboxes(baseX, baseY, quadIndex = -1) {
        const hitboxes = [];
        const startQuad = quadIndex === -1 ? 0 : quadIndex;
        const endQuad = quadIndex === -1 ? this.sprite[0].numSprites - 1 : quadIndex;

        for (let q = startQuad; q <= endQuad && q < this.sprite.length; q++) {
            hitboxes.push(this.getHitbox(q, baseX, baseY));
        }
        return hitboxes;
    }

    // === SERIALIZATION ===
    // Serialize sprite back to GameMaker .SPR file format.
    // Returns Uint8Array that can be written to D64 disk.
    // True iff `imageData` (a 63/64-byte frame buffer) contains any non-zero bytes.
    static _frameHasData(imageData) {
        if (!imageData) return false;
        for (let i = 0; i < imageData.length; i++) {
            if (imageData[i] !== 0) return true;
        }
        return false;
    }

    // Number of frames to actually save for a quad: at least `numFrames` (the
    // animation count, so the loop has somewhere to land) but extended past
    // that to cover any painted scratch frames. Trailing blank frames beyond
    // both are dropped — matches real GM, and keeps middle blanks intact.
    static _framesToSaveForQuad(quad, numFrames) {
        if (!quad.imageData) return numFrames;
        let lastNonBlank = -1;
        for (let f = quad.imageData.length - 1; f >= 0; f--) {
            if (gmSprite._frameHasData(quad.imageData[f])) { lastNonBlank = f; break; }
        }
        return Math.max(numFrames, lastNonBlank + 1);
    }

    serialize() {
        const header = this.sprite[0];
        const numFrames = header.numFrames;
        const numQuads = header.numSprites;

        // Trim trailing blank frames per quad, but always keep at least the
        // anima range (numFrames) so the loop plays correctly even if those
        // frames are blank.
        const framesToSave = this.sprite.map(q => gmSprite._framesToSaveForQuad(q, numFrames));

        // Calculate total size
        // All frames are 64 bytes except the very last frame (63 bytes, no trailing padding)
        const totalFrameCount = framesToSave.reduce((a, b) => a + b, 0);
        let size = 37; // Main header
        size += framesToSave[0] * 64; // Main sprite frames
        for (let q = 1; q < numQuads; q++) {
            size += 32; // Subheader
            size += framesToSave[q] * 64; // Subsprite frames
        }
        size -= 1; // Last frame has no trailing padding byte

        const data = new Uint8Array(size);

        // Calculate X position for file format (hi-res coords, right edge + 24)
        // Parser normalizes ALL sprites to fat pixels (divides by 2), so we always multiply by 2
        let xPos = header.xPosition * 2; // Convert fat pixels back to hi-res coords
        xPos += 24; // GM stores position of right edge

        // Pre-calculate if any subsprite will have absolute X > 255
        const mainYFile = header.yPosition + 50;
        let anySubspriteExceedsX255 = false;
        for (let q = 1; q < numQuads; q++) {
            const subSprite = this.sprite[q];
            const subAbsX = xPos + (header.isMultiColor ? subSprite.xPosition * 2 : subSprite.xPosition);
            if (subAbsX > 255) {
                anySubspriteExceedsX255 = true;
                break;
            }
        }

        // === MAIN HEADER (37 bytes) ===

        // [0-4] Magic number
        data[0] = 0x1D;
        data[1] = 0x60;
        data[2] = 0x47;
        data[3] = 0x45;
        data[4] = 0x4B;

        // [5-10] Sprite name (6 chars, screen codes)
        const nameBytes = typeof encodeString === 'function'
            ? encodeString(header.spriteName, 6)
            : header.spriteName.padEnd(6, ' ').split('').map(c => c.charCodeAt(0));
        for (let i = 0; i < 6; i++) {
            data[5 + i] = nameBytes[i];
        }

        // [11] Unknown flag (always 0x01 in original files)
        data[11] = 0x01;

        // [12] GM Color 2 (shared)
        data[12] = this._gmColor2;

        // [13] GM Color 3 (shared)
        data[13] = this._gmColor3;

        // [14] Multicolor flag
        data[14] = header.isMultiColor ? 0x01 : 0x00;

        // [15] Number of frames (0-based)
        data[15] = numFrames - 1;

        // [16] X double flag
        data[16] = header.xDouble ? 0x01 : 0x00;

        // [17] Y double flag
        data[17] = header.yDouble ? 0x01 : 0x00;

        // [18] Background color
        data[18] = this._bgColor;

        // [19] Number of sprites/quads (0-based)
        data[19] = numQuads - 1;

        // [20-21] Quad data size (little-endian)
        const quadDataSize0 = 32 + framesToSave[0] * 64;
        data[20] = quadDataSize0 & 0xFF;
        data[21] = (quadDataSize0 >> 8) & 0xFF;

        // [22-23] Padding
        data[22] = 0x00;
        data[23] = 0x00;

        // [24] X position low byte
        data[24] = xPos & 0xFF;

        // [25] Y position (add 50 for GM screen offset)
        data[25] = header.yPosition + 50;

        // [26] X position high bit flags
        let byte26 = 0x00;
        if (xPos > 255) byte26 |= 0x10;
        if (anySubspriteExceedsX255) byte26 |= 0x80;
        data[26] = byte26;

        // [27] Sprite number (0 for main sprite)
        data[27] = 0;

        // [28] GM Color 1 (unique sprite color)
        data[28] = this._gmColor1;

        // [29-36] Padding
        for (let i = 29; i < 37; i++) {
            data[i] = 0x00;
        }

        let offset = 37;

        // Track total frames written to know when we're at the last one
        let framesWritten = 0;
        const totalFrames = framesToSave.reduce((a, b) => a + b, 0);

        // Write frame data for main sprite
        for (let f = 0; f < framesToSave[0]; f++) {
            const imgData = this.sprite[0].imageData[f];
            framesWritten++;
            const isLastFrame = framesWritten === totalFrames;
            const bytesToWrite = isLastFrame ? 63 : 64; // Last frame has no padding byte
            for (let i = 0; i < bytesToWrite; i++) {
                data[offset++] = imgData ? (imgData[i] || 0) : 0;
            }
        }

        // Write subsprites
        for (let q = 1; q < numQuads; q++) {
            const subSprite = this.sprite[q];
            const subHeaderStart = offset;

            // Byte 0 - marker
            data[offset++] = 0x2D;

            // Bytes 1-5 - Name (5 chars for subheader, screen codes)
            const subNameBytes = typeof encodeString === 'function'
                ? encodeString(subSprite.spriteName, 5)
                : subSprite.spriteName.padEnd(5, ' ').split('').map(c => c.charCodeAt(0));
            for (let i = 0; i < 5; i++) {
                data[offset++] = subNameBytes[i];
            }

            // Byte 6 - Unknown flag
            data[offset++] = 0x01;

            // Bytes 7-8 - Colors. We write the sprite-wide palette into
            // every subheader — the VIC applies one palette per sprite, so
            // per-quad colours would never have effect at render time.
            // (See "Palette API" above.)
            data[offset++] = this._gmColor2;
            data[offset++] = this._gmColor3;

            // Byte 9 - Mode
            data[offset++] = subSprite.isMultiColor ? 0x01 : 0x00;

            // Byte 10 - Num frames
            data[offset++] = numFrames - 1;

            // Bytes 11-12 - X/Y double
            data[offset++] = subSprite.xDouble ? 0x01 : 0x00;
            data[offset++] = subSprite.yDouble ? 0x01 : 0x00;

            // Byte 13 - Background (sprite-wide; see comment on bytes 7-8)
            data[offset++] = this._bgColor;

            // Byte 14 - num sprites
            data[offset++] = numQuads - 1;

            // Bytes 15-16 - Quad data size
            const quadDataSizeQ = 32 + framesToSave[q] * 64;
            data[offset++] = quadDataSizeQ & 0xFF;
            data[offset++] = (quadDataSizeQ >> 8) & 0xFF;

            // Bytes 17-18 - Position offsets (signed bytes)
            data[offset++] = subSprite.xPosition < 0 ? subSprite.xPosition + 256 : subSprite.xPosition;
            data[offset++] = subSprite.yPosition < 0 ? subSprite.yPosition + 256 : subSprite.yPosition;

            // Bytes 19-20 - Absolute position
            const subAbsX = xPos + (header.isMultiColor ? subSprite.xPosition * 2 : subSprite.xPosition);
            const subAbsY = mainYFile + subSprite.yPosition;
            data[offset++] = subAbsX & 0xFF;
            data[offset++] = subAbsY & 0xFF;

            // Byte 21 - padding
            data[offset++] = 0x00;

            // Byte 22 - Sprite number
            data[offset++] = q;

            // Byte 23 - Unique color (sprite-wide; see comment on bytes 7-8)
            data[offset++] = this._gmColor1;

            // Bytes 24-31 - padding to 32 bytes
            while (offset < subHeaderStart + 32) data[offset++] = 0x00;

            // Frame data for this subsprite
            for (let f = 0; f < framesToSave[q]; f++) {
                const imgData = subSprite.imageData[f];
                framesWritten++;
                const isLastFrame = framesWritten === totalFrames;
                const bytesToWrite = isLastFrame ? 63 : 64;
                for (let i = 0; i < bytesToWrite; i++) {
                    data[offset++] = imgData ? (imgData[i] || 0) : 0;
                }
            }
        }

        return data.slice(0, offset);
    }
}

// Make available globally for browser and Node.js testing
if (typeof globalThis !== 'undefined') {
    globalThis.gmSprite = gmSprite;
}

