/*
 * gmCharset - GameMaker Character Set Handler
 *
 * Embedded bitmap data for 64 characters (8x8 pixels each).
 * No external files needed - works from file:// URLs (e.g., USB drive).
 * Bitmap data extracted pixel-perfect from gmCharset.png using extract-charset.py.
 *
 * GM uses its own character indices (0-63) which map directly to the raw
 * bytes stored in print statements. No conversion needed!
 *
 * GM Index layout (64 characters):
 *   0:  Space
 *   1-26: A-Z
 *   27: [   28: =   29: ]   30: >   31: <
 *   32: Space (duplicate)
 *   33: × (times)   34: .   35: top bar   36: right bar   37: open box
 *   38: ?   39: '
 *   40: filled box   41: full block   42: °   43: +   44: ↑   45: -   46: ↓   47: /
 *   48-57: 0-9
 *   58: left bar   59: _   60-63: corner pixels/dots
 *
 * Usage:
 *   const charset = new gmCharset();
 *   charset.drawCharToScene(scene, 1, x, y, fgColor, bgColor);    // Draw 'A' by GM index
 *   charset.drawBytesToScene(scene, rawBytes, x, y, fg, bg);      // Draw from raw GM data
 *   charset.drawStringToScene(scene, "HELLO", x, y, fg, bg);      // Draw JS string (for scores)
 */

class gmCharset {
    constructor() {
        // Character dimensions in pixels
        this.charWidth = 8;
        this.charHeight = 8;

        // Always loaded (no async needed)
        this.loaded = true;
    }

    /**
     * Embedded bitmap data for 64 characters, indexed by GM's internal order.
     * Each character is 8 bytes (one byte per row, LSB = leftmost pixel).
     * Extracted pixel-perfect from gmCharset.png using extract-charset.py
     */
    static CHAR_DATA = [
        '0000000000000000', // 0: Space
        '00183C667E666666', // 1: A
        '003E66663E66663E', // 2: B
        '003C66060606663C', // 3: C
        '001E36666666361E', // 4: D
        '007E06061E06067E', // 5: E
        '007E06061E060606', // 6: F
        '003C66067666663C', // 7: G
        '006666667E666666', // 8: H
        '003C18181818183C', // 9: I
        '007830303030361C', // 10: J
        '0066361E0E1E3666', // 11: K
        '000606060606067E', // 12: L
        '00C6EEFED6C6C6C6', // 13: M
        '00666E7E7E766666', // 14: N
        '003C66666666663C', // 15: O
        '003E66663E060606', // 16: P
        '003C666666663C70', // 17: Q
        '003E66663E1E3666', // 18: R
        '003C66063C60663C', // 19: S
        '007E181818181818', // 20: T
        '006666666666663C', // 21: U
        '0066666666663C18', // 22: V
        '00C6C6C6D6FEEEC6', // 23: W
        '0066663C183C6666', // 24: X
        '006666663C181818', // 25: Y
        '007E6030180C067E', // 26: Z
        '003C0C0C0C0C0C3C', // 27: [
        '0000007E007E0000', // 28: =
        '003C30303030303C', // 29: ]
        '000E18306030180E', // 30: >
        '0070180C060C1870', // 31: <
        '0000000000000000', // 32: Space (duplicate)
        '0000331E0C1E3300', // 33: × (times/multiplication)
        '0000000000001818', // 34: .
        '00FFFF0000000000', // 35: top bar
        '4040404040404040', // 36: right bar
        '00FFC3818181C3FF', // 37: open box
        '003C666030180018', // 38: ?
        '0018181800000000', // 39: '
        '007F7F7F7F7F7F7F', // 40: filled box
        '00FFFFFFFFFFFFFF', // 41: full block
        '0038444438000000', // 42: ° (degree symbol)
        '00000C0C3F0C0C00', // 43: +
        '0000182442FFFF00', // 44: up arrow
        '000000003F000000', // 45: -
        '0000FFFF42241800', // 46: down arrow
        '000030180C060300', // 47: /
        '003C66666666663C', // 48: 0
        '00181C181818183C', // 49: 1
        '003C66603C06067E', // 50: 2
        '003C66603860663C', // 51: 3
        '003636367E303030', // 52: 4
        '007E06063E60663C', // 53: 5
        '003C66063E66663C', // 54: 6
        '007E666030181818', // 55: 7
        '003C66663C66663C', // 56: 8
        '003C66667C60663C', // 57: 9
        '0606060606060606', // 58: left bar
        '00000000000000FF', // 59: _ (underscore)
        '0000000000000040', // 60: bottom right pixel
        '0000000000000002', // 61: bottom left pixel
        '4040000000000000', // 62: top right dots
        '0606060000000000', // 63: top left dots
    ];

    /**
     * Get the raw bitmap for a character (8x8 array of 0/1 values)
     */
    getCharBitmap(gmIndex) {
        if (gmIndex < 0 || gmIndex >= 64) return null;

        const hexData = gmCharset.CHAR_DATA[gmIndex];
        const bitmap = [];

        for (let row = 0; row < 8; row++) {
            const byteHex = hexData.substr(row * 2, 2);
            const byte = parseInt(byteHex, 16);
            const rowData = [];

            for (let col = 0; col < 8; col++) {
                // LSB is leftmost pixel
                rowData.push((byte >> col) & 1);
            }
            bitmap.push(rowData);
        }

        return bitmap;
    }

    /**
     * Draw a character to a gmScene instance via setPixel
     * x, y are in pixel coordinates (0-159, 0-199)
     * fgColorIndex, bgColorIndex are palette indices (0-3)
     */
    drawCharToScene(scene, gmIndex, x, y, fgColorIndex, bgColorIndex) {
        if (gmIndex < 0 || gmIndex >= 64) return;

        const bitmap = this.getCharBitmap(gmIndex);
        if (!bitmap) return;

        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const pixelX = x + col;
                const pixelY = y + row;
                const isForeground = bitmap[row][col] === 1;
                if (isForeground) {
                    scene.setPixel(pixelX, pixelY, fgColorIndex);
                } else if (bgColorIndex >= 0) {
                    // Only draw background if not transparent (-1)
                    scene.setPixel(pixelX, pixelY, bgColorIndex);
                }
            }
        }
    }

    /**
     * Draw raw GM bytes to a gmScene instance
     * Each byte is a GM character index (0-63)
     *
     * PRINT STRING PADDING (0x3B / 59):
     * Print strings are stored as fixed 20-byte arrays. Positions after the actual
     * text content are filled with 0x3B bytes. When displayed in the editor listing,
     * these show as underscores (see c64lib.js decodeChar). But here at render time,
     * we skip 0x3B bytes entirely - nothing is drawn, making the padding invisible.
     * This is how GM achieves variable-length print output from fixed-size storage.
     */
    drawBytesToScene(scene, bytes, x, y, fgColorIndex, bgColorIndex) {
        for (let i = 0; i < bytes.length; i++) {
            // 0x3B = padding byte, skip (see comment above)
            if (bytes[i] === 0x3B) continue;
            this.drawCharToScene(scene, bytes[i], x + (i * this.charWidth), y, fgColorIndex, bgColorIndex);
        }
    }

    /**
     * Draw a JavaScript string to a gmScene instance
     * Converts ASCII to GM indices automatically
     */
    drawStringToScene(scene, text, x, y, fgColorIndex, bgColorIndex) {
        for (let i = 0; i < text.length; i++) {
            const ascii = text.charCodeAt(i);
            let gmIndex;
            if (ascii === 0x20) gmIndex = 0;  // space -> 0
            else if (ascii >= 0x41 && ascii <= 0x5A) gmIndex = ascii - 0x40;  // A-Z -> 1-26
            else if (ascii >= 0x61 && ascii <= 0x7A) gmIndex = ascii - 0x60;  // a-z -> 1-26
            else if (ascii >= 0x30 && ascii <= 0x39) gmIndex = ascii - 0x30 + 48;  // 0-9 -> 48-57
            else continue;  // skip unknown chars
            this.drawCharToScene(scene, gmIndex, x + (i * this.charWidth), y, fgColorIndex, bgColorIndex);
        }
    }
}

// Make available globally for browser <script> loads and Node.js ESM imports.
if (typeof globalThis !== 'undefined') {
    globalThis.gmCharset = gmCharset;
}
