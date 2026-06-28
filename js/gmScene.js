// gmScene.js - GameMaker Scene (.PIC file) handler at 320×200 native resolution
//
// === SCENE FILE FORMAT ===
// GameMaker scenes are background images stored as .PIC files on disk.
// They use the C64's multicolor bitmap mode: 160×200 pixels with 4 colors.
//
// Header (6 bytes):
//   [0-4]   Magic number: 00 A0 47 45 4B
//   [5]     RLE flag: 0x00 = uncompressed, 0xFF = RLE compressed
//
// Image Data (8000 bytes uncompressed):
//   [6...8005] Pixel data, or RLE-compressed pairs if flag is 0xFF
//              Each byte contains 4 pixels (2 bits each):
//                bits 7-6 = pixel 0 (leftmost)
//                bits 5-4 = pixel 1
//                bits 3-2 = pixel 2
//                bits 1-0 = pixel 3 (rightmost)
//              Pixels are arranged in 4×8 tiles, filled top-to-bottom
//              within each tile, then left-to-right across the screen.
//
// Footer (10 bytes, after image data):
//   [0]     Colors 1 & 2: high nibble = color1, low nibble = color2
//   [1]     Color 3 in low nibble (high nibble unused)
//   [2]     Background color in low nibble (high nibble unused)
//   [3-8]   Scene name (6 PETSCII characters)
//   [9]     Padding
//
// RLE Compression (when flag = 0xFF):
//   Compressed data consists of pairs: (count-1, value)
//   Count byte 0x00 = repeat 1 time, 0xFF = repeat 256 times
//
// === 320×200 COORDINATE SYSTEM ===
// Like gmSprite, we work at the C64's true 320×200 resolution:
//   - Scene pixels are 160×200 "fat pixels" (multicolor mode)
//   - Each fat pixel becomes a 2×1 block in 320×200 space
//   - This matches how gmSprite renders multicolor sprites
//   - All coordinates align - no more scaling confusion
//
// === INDEXED PIXEL BUFFER ===
// We store pixels as color indices (0-3) rather than RGBA values.
// This allows efficient palette changes without re-parsing the file.
// At render time, indices are converted to actual colors.

class gmScene {

    // Scene dimensions
    static WIDTH = 160;    // Native multicolor width (fat pixels)
    static HEIGHT = 200;   // Native height (same as screen)

    // Tile dimensions for unpacking
    static TILE_WIDTH = 4;     // 4 fat pixels wide
    static TILE_HEIGHT = 8;    // 8 pixels tall
    static TILES_PER_ROW = 40; // 160 / 4 = 40 tiles across

    constructor(fileData) {
        this.name = "";

        // Palette colors (C64 color indices 0-15)
        this._bgColor = 0;
        this._color1 = 0;
        this._color2 = 0;
        this._color3 = 0;

        // Border color - used by runtime, defaults to black
        // Set via "scene X border = color" commands
        this.borderColor = 0;

        // === INDEXED PIXEL BUFFER ===
        // One byte per pixel, values 0-3 (color indices).
        // Stored in row-major order: buffer[y * 160 + x]
        // This is the "source of truth" for the scene's pixels.
        this.pixelBuffer = new Uint8Array(gmScene.WIDTH * gmScene.HEIGHT);

        // Dirty flag - tracks when re-rendering is needed
        // Set when pixels or palette colors change
        this.dirty = true;

        // === RGBA CACHE ===
        // Pre-rendered 320×200 RGBA pixel data for fast blitting.
        // Only regenerated when dirty=true.
        this.rgbaCache = new Uint8Array(320 * 200 * 4);

        // Parse file and populate pixelBuffer
        if (fileData) {
            this.parseSceneFile(fileData);
            this.unpackToBuffer();
        }
    }

    // === PALETTE PROPERTIES ===
    // Setters auto-mark dirty so render cache gets rebuilt
    get bgColor() { return this._bgColor; }
    set bgColor(v) { this._bgColor = v; this.dirty = true; }

    get color1() { return this._color1; }
    set color1(v) { this._color1 = v; this.dirty = true; }

    get color2() { return this._color2; }
    set color2(v) { this._color2 = v; this.dirty = true; }

    get color3() { return this._color3; }
    set color3(v) { this._color3 = v; this.dirty = true; }

    // For compatibility with code that calls this explicitly
    markColorsDirty() {
        this.dirty = true;
    }

    // Exposes the 160×200 palette-index buffer for consumers that need
    // pixel-level scene info beyond the rendered RGB. Returned array is
    // the live buffer — callers must not mutate it.
    getIndexBuffer() {
        return this.pixelBuffer;
    }

    // Build a priority mask in the shape gmSprite.blitToBuffer expects.
    // skipIndices is a Set of palette indices (0-3) that should hide a
    // sprite drawn with this mask — the caller picks which ones based on
    // the platform semantic they're modelling (e.g. C64 VIC sprite-priority
    // hides under colors 2 and 3, so the runtime passes Set([2, 3])).
    getUnderMask(skipIndices) {
        return {
            indexBuffer: this.pixelBuffer,
            indexWidth:  gmScene.WIDTH,
            indexHeight: gmScene.HEIGHT,
            skipIndices
        };
    }

    // Clear the scene - fill all pixels with background color (palette index 0)
    clear() {
        // Fill the pixel buffer with 0s (background color index)
        this.pixelBuffer.fill(0);
        this.dirty = true;
    }

    // === FILE PARSING ===
    parseSceneFile(fileData) {
        const headerLength = 6;
        const footerLength = 10;
        const imageLength = (160 * 200) / 4; // 4 pixels per byte = 8000 bytes

        // Check RLE flag (byte 5): 0xFF means compressed
        if (fileData[5] === 0xFF) {
            fileData = this.decodeRLE(fileData, headerLength, imageLength, footerLength);
        }

        // === FOOTER (PALETTE + NAME) ===
        // Footer starts after image data
        const footerOffset = headerLength + imageLength;
        const footerBytes = fileData.slice(footerOffset);

        // Color encoding (GameMaker packs colors into nibbles):
        //   Byte 0: color1 (high nibble), color2 (low nibble)
        //   Byte 1: color3 (low nibble)
        //   Byte 2: background (low nibble)
        this._color1  = footerBytes[0] >> 4;   // First 4 bits of Byte 0
        this._color2  = footerBytes[0] & 0x0F; // Last 4 bits of Byte 0
        this._color3  = footerBytes[1] & 0x0F; // Last 4 bits of Byte 1
        this._bgColor = footerBytes[2] & 0x0F; // Last 4 bits of Byte 2

        // Scene name: 6 PETSCII characters starting at byte 3
        // We use this embedded name instead of the disk filename
        this.name = decodeString(footerBytes.slice(3, 9)).trim();

        // Store raw image data for unpacking
        this.rawImageData = fileData.slice(headerLength, headerLength + imageLength);
    }

    // === RLE DECOMPRESSION ===
    // Most scenes are RLE-compressed to save disk space.
    // Format: pairs of (count-1, value) bytes
    //   count byte 0x00 = repeat 1 time
    //   count byte 0xFF = repeat 256 times
    decodeRLE(compressedData, headerLength, imageLength, footerLength) {
        const expandedData = new Uint8Array(headerLength + imageLength + footerLength);

        // Header is not compressed - copy directly
        expandedData.set(compressedData.slice(0, headerLength));

        // Expand RLE pairs
        let writeIndex = headerLength;
        for (let i = headerLength; i < compressedData.length; i += 2) {
            const repeatCount = compressedData[i] + 1; // 0x00 = 1, 0xFF = 256
            for (let r = 0; r < repeatCount; r++) {
                expandedData[writeIndex++] = compressedData[i + 1];
            }
        }

        return expandedData;
    }

    // === TILE UNPACKING ===
    // GameMaker stores image data in 4×8 pixel tiles, filled column-by-column
    // (top-to-bottom within tile, then left-to-right across screen).
    // Each byte contains 4 pixels (2 bits each).
    //
    // Tile layout visualization (for a 160×200 image):
    //   Tile 0 at (0,0), Tile 1 at (4,0), ... Tile 39 at (156,0)
    //   Tile 40 at (0,8), Tile 41 at (4,8), ...
    //   ... and so on for 25 rows of tiles (200/8 = 25)
    //
    // Within each tile, bytes are ordered top-to-bottom (8 bytes per tile).
    unpackToBuffer() {
        let currentTileX = 0;
        let currentTileY = 0;
        let currentRowInTile = 0;
        let dataIndex = 0;

        while (dataIndex < this.rawImageData.length) {
            const byte = this.rawImageData[dataIndex++];

            // Decode 4 pixels from this byte (2 bits each, MSB first)
            // Bits 7-6 = pixel 0, bits 5-4 = pixel 1, bits 3-2 = pixel 2, bits 1-0 = pixel 3
            const pixels = [
                (byte >> 6) & 0x03,
                (byte >> 4) & 0x03,
                (byte >> 2) & 0x03,
                byte & 0x03
            ];

            // Calculate position in 160×200 buffer
            const baseX = currentTileX * gmScene.TILE_WIDTH;
            const baseY = currentTileY * gmScene.TILE_HEIGHT + currentRowInTile;

            // Write 4 pixels to buffer
            for (let i = 0; i < 4; i++) {
                const x = baseX + i;
                if (x < 160 && baseY < 200) {
                    this.pixelBuffer[baseY * 160 + x] = pixels[i];
                }
            }

            // Advance through tile structure
            currentRowInTile++;
            if (currentRowInTile >= gmScene.TILE_HEIGHT) {
                currentRowInTile = 0;
                currentTileX++;
                if (currentTileX >= gmScene.TILES_PER_ROW) {
                    currentTileX = 0;
                    currentTileY++;
                }
            }
        }
    }

    // === PIXEL ACCESS ===
    // For editing scenes (future feature) or collision detection

    // Set a pixel in the indexed buffer (x: 0-159, y: 0-199, colorIndex: 0-3)
    setPixel(x, y, colorIndex) {
        if (x >= 0 && x < 160 && y >= 0 && y < 200) {
            this.pixelBuffer[y * 160 + x] = colorIndex & 0x03;
            this.dirty = true;
        }
    }

    // Get a pixel's color index (0-3)
    getPixel(x, y) {
        if (x >= 0 && x < 160 && y >= 0 && y < 200) {
            return this.pixelBuffer[y * 160 + x];
        }
        return 0;
    }

    // === PALETTE ===
    // Build current palette as array of RGB arrays from c64Palette
    _getCurrentPalette() {
        return [
            c64Palette[this._bgColor],  // Index 0 = background
            c64Palette[this._color1],   // Index 1
            c64Palette[this._color2],   // Index 2
            c64Palette[this._color3]    // Index 3
        ];
    }

    // === RGBA CACHE RENDERING ===
    // Convert indexed 160×200 buffer to RGBA 320×200 buffer.
    // Each fat pixel becomes a 2×1 block (matching multicolor sprite rendering).
    _renderToRgbaCache() {
        const palette = this._getCurrentPalette();

        for (let y = 0; y < 200; y++) {
            for (let x = 0; x < 160; x++) {
                const colorIndex = this.pixelBuffer[y * 160 + x];
                const color = palette[colorIndex];

                // Each fat pixel (x) becomes two pixels in 320-wide space (x*2 and x*2+1)
                const x320 = x * 2;
                const idx1 = (y * 320 + x320) * 4;
                const idx2 = (y * 320 + x320 + 1) * 4;

                // Left pixel
                this.rgbaCache[idx1] = color[0];     // R
                this.rgbaCache[idx1 + 1] = color[1]; // G
                this.rgbaCache[idx1 + 2] = color[2]; // B
                this.rgbaCache[idx1 + 3] = 255;      // A

                // Right pixel (same color - fat pixel)
                this.rgbaCache[idx2] = color[0];
                this.rgbaCache[idx2 + 1] = color[1];
                this.rgbaCache[idx2 + 2] = color[2];
                this.rgbaCache[idx2 + 3] = 255;
            }
        }

        this.dirty = false;
    }

    // === BLITTING ===
    // Copy scene to a target pixel buffer (e.g., c64Screen.pixels).
    // Unlike sprites, scenes have no transparency - they fill the entire screen.
    blitToBuffer(target, targetWidth, targetHeight) {
        // Rebuild RGBA cache if needed
        if (this.dirty) {
            this._renderToRgbaCache();
        }

        // Copy entire scene to target buffer
        // Scene is always 320×200, same as screen, so direct copy works
        if (targetWidth === 320 && targetHeight === 200) {
            target.set(this.rgbaCache);
        } else {
            // Fallback: copy pixel by pixel (shouldn't normally happen)
            for (let y = 0; y < 200 && y < targetHeight; y++) {
                for (let x = 0; x < 320 && x < targetWidth; x++) {
                    const srcIdx = (y * 320 + x) * 4;
                    const dstIdx = (y * targetWidth + x) * 4;
                    target[dstIdx] = this.rgbaCache[srcIdx];
                    target[dstIdx + 1] = this.rgbaCache[srcIdx + 1];
                    target[dstIdx + 2] = this.rgbaCache[srcIdx + 2];
                    target[dstIdx + 3] = this.rgbaCache[srcIdx + 3];
                }
            }
        }
    }

    // === RLE COMPRESSION ===
    // Compress data using RLE format: pairs of (count-1, value) bytes.
    // Maximum run length is 256 (encoded as 0xFF).
    encodeRLE(uncompressedData) {
        const compressed = [];
        let i = 0;

        while (i < uncompressedData.length) {
            const value = uncompressedData[i];
            let runLength = 1;

            // Count consecutive identical bytes (max 256)
            while (i + runLength < uncompressedData.length &&
                   uncompressedData[i + runLength] === value &&
                   runLength < 256) {
                runLength++;
            }

            // Output (count-1, value) pair
            compressed.push(runLength - 1);
            compressed.push(value);
            i += runLength;
        }

        return new Uint8Array(compressed);
    }

    // === SAVING ===
    // Pack the pixel buffer back into GameMaker .PIC format.
    // Automatically chooses RLE or uncompressed based on which is smaller.
    // Returns a Uint8Array ready to be saved to disk.
    save() {
        const headerLength = 6;
        const imageLength = 8000; // 160*200/4 = 8000 bytes
        const footerLength = 10;

        // First, generate the image data + footer (without header)
        const imageAndFooter = new Uint8Array(imageLength + footerLength);

        // === IMAGE DATA ===
        // Pack pixels into tiles (4×8), 4 pixels per byte
        let dataIndex = 0;
        let currentTileX = 0;
        let currentTileY = 0;
        let currentRowInTile = 0;

        while (dataIndex < imageLength) {
            const baseX = currentTileX * gmScene.TILE_WIDTH;
            const baseY = currentTileY * gmScene.TILE_HEIGHT + currentRowInTile;

            // Pack 4 pixels into one byte (2 bits each, MSB first)
            let byte = 0;
            for (let i = 0; i < 4; i++) {
                const x = baseX + i;
                const colorIndex = (x < 160 && baseY < 200)
                    ? this.pixelBuffer[baseY * 160 + x]
                    : 0;
                byte |= (colorIndex & 0x03) << (6 - i * 2);
            }
            imageAndFooter[dataIndex++] = byte;

            // Advance through tile structure
            currentRowInTile++;
            if (currentRowInTile >= gmScene.TILE_HEIGHT) {
                currentRowInTile = 0;
                currentTileX++;
                if (currentTileX >= gmScene.TILES_PER_ROW) {
                    currentTileX = 0;
                    currentTileY++;
                }
            }
        }

        // === FOOTER ===
        const footerOffset = imageLength;

        // Color encoding (packed nibbles):
        //   Byte 0: color1 (high nibble), color2 (low nibble)
        //   Byte 1: color3 (low nibble)
        //   Byte 2: background (low nibble)
        imageAndFooter[footerOffset] = (this._color1 << 4) | (this._color2 & 0x0F);
        imageAndFooter[footerOffset + 1] = this._color3 & 0x0F;
        imageAndFooter[footerOffset + 2] = this._bgColor & 0x0F;

        // Scene name: 6 screen code characters
        const name = (this.name || 'SCENE').padEnd(6, ' ').substring(0, 6).toUpperCase();
        const encodedName = encodeString(name, 6);
        for (let i = 0; i < 6; i++) {
            imageAndFooter[footerOffset + 3 + i] = encodedName[i];
        }

        // Padding byte
        imageAndFooter[footerOffset + 9] = 0x00;

        // === COMPRESSION DECISION ===
        // Try RLE compression and compare sizes
        const rleData = this.encodeRLE(imageAndFooter);
        const uncompressedSize = headerLength + imageLength + footerLength;
        const compressedSize = headerLength + rleData.length;

        if (compressedSize < uncompressedSize) {
            // Use RLE compression
            const data = new Uint8Array(compressedSize);

            // Header with RLE flag
            data[0] = 0x00;
            data[1] = 0xA0;
            data[2] = 0x47;
            data[3] = 0x45;
            data[4] = 0x4B;
            data[5] = 0xFF; // RLE flag: 0xFF = compressed

            // Compressed data
            data.set(rleData, headerLength);

            return data;
        } else {
            // Use uncompressed format
            const data = new Uint8Array(uncompressedSize);

            // Header without RLE flag
            data[0] = 0x00;
            data[1] = 0xA0;
            data[2] = 0x47;
            data[3] = 0x45;
            data[4] = 0x4B;
            data[5] = 0x00; // RLE flag: 0x00 = uncompressed

            // Uncompressed data
            data.set(imageAndFooter, headerLength);

            return data;
        }
    }

    // Create a blank scene with specified colors
    static createBlank(bgColor = 6, color1 = 1, color2 = 9, color3 = 0) {
        const scene = new gmScene();
        scene._bgColor = bgColor;
        scene._color1 = color1;
        scene._color2 = color2;
        scene._color3 = color3;
        scene.clear();
        scene.name = 'SCENE';
        return scene;
    }
}

// Make available globally for browser and Node.js testing
if (typeof globalThis !== 'undefined') {
    globalThis.gmScene = gmScene;
}
