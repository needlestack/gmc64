// tools/spr-from-ascii.mjs
//
// Author GameMaker sprites from ASCII bitmap arrays. Handles the byte-level
// encoding (multicolor 2bpp / hi-res 1bpp, MSB-first, 3 bytes per row,
// 64 bytes per frame with trailing padding) so callers work in a text
// representation that's readable and diffable.
//
// Usage:
//
//   import { bootstrap } from './tools/node-bootstrap.mjs';
//   import { spriteFromAscii } from './tools/spr-from-ascii.mjs';
//
//   const gm = await bootstrap();  // populates globalThis.gmSprite
//
//   // Design at the fat-pixel level (12 wide × 21 tall for multicolor):
//   const ALIEN = [
//     '.B.B.',
//     '.B.B.',
//     'aaaaa',
//     'acaca',
//     'aaaaa',
//     '.aaa.',
//     'a.a.a',
//   ];
//
//   const bytes = spriteFromAscii({
//     name: 'PAIR',
//     multicolor: true,
//     xDouble: true,
//     yDouble: false,
//     palette: { bg: 0, c1: 1, c2: 13, c3: 2 },
//     position: { x: 86, y: 100 },
//     frames: [
//       [{ x: 0, y: 0, art: ALIEN }, { x: 7, y: 0, art: ALIEN }],
//       // ... more frames
//     ],
//   });
//
//   writeFileSync('MYALIEN.SPR', Buffer.from(bytes));

// Character → pixel-value table.
//   '.' = background (transparent)
//   'a' = color 2 (shared)
//   'B' = color 1 (unique/main)  — capital B to visually distinguish from 'b'
//   'c' = color 3 (shared)
//
// Any other character is treated as background. For hi-res mode, only '.' and
// non-'.' matter (any non-'.' becomes a lit pixel).
export const ASCII_TO_VAL = { '.': 0, ' ': 0, 'a': 1, 'B': 2, 'c': 3 };

/**
 * Build a single 64-byte frame (63 pixel bytes + 1 padding) from a set of
 * cell stamps.
 *
 * @param cells    Array of { x, y, art } where art is an array of strings.
 *                 Each string is one row of pixels; characters use the
 *                 ASCII_TO_VAL mapping.
 * @param options.mode  'multicolor' (default) or 'hires'
 *
 * Multicolor: 12 fat pixels wide × 21 rows. Each fat pixel is 2 bits.
 * Hi-res:     24 hardware pixels wide × 21 rows. Each pixel is 1 bit.
 */
export function frameFromAscii(cells, { mode = 'multicolor' } = {}) {
    const width = mode === 'multicolor' ? 12 : 24;
    const bitsPerPixel = mode === 'multicolor' ? 2 : 1;
    const pixelsPerByte = 8 / bitsPerPixel;   // 4 for MC, 8 for hi-res

    // Rasterize: 21 rows × width pixels
    const pixels = Array.from({ length: 21 }, () => new Array(width).fill(0));
    for (const { x, y, art } of cells) {
        for (let r = 0; r < art.length; r++) {
            const dr = y + r;
            if (dr < 0 || dr > 20) continue;
            const rowStr = art[r];
            for (let c = 0; c < rowStr.length; c++) {
                const dc = x + c;
                if (dc < 0 || dc >= width) continue;
                const ch = rowStr[c];
                let val = ASCII_TO_VAL[ch] || 0;
                if (mode === 'hires' && val) val = 1;  // any non-bg → lit
                if (val) pixels[dr][dc] = val;
            }
        }
    }

    // Pack to bytes. Row layout: 3 bytes per row, MSB-first within each byte.
    const bytes = new Uint8Array(64);
    for (let r = 0; r < 21; r++) {
        for (let bi = 0; bi < 3; bi++) {
            let b = 0;
            for (let p = 0; p < pixelsPerByte; p++) {
                const shift = (pixelsPerByte - 1 - p) * bitsPerPixel;
                const pixelIdx = bi * pixelsPerByte + p;
                b |= (pixels[r][pixelIdx] & ((1 << bitsPerPixel) - 1)) << shift;
            }
            bytes[r * 3 + bi] = b;
        }
    }
    return bytes;
}

/**
 * Wrap frames into a complete .SPR file with the correct header, using
 * gmSprite.createBlank + serialize to guarantee the byte layout matches
 * what the loader expects.
 *
 * @param options.name       6-char sprite name (padded/truncated as needed)
 * @param options.multicolor true = multicolor, false = hi-res
 * @param options.xDouble    horizontal magnification
 * @param options.yDouble    vertical magnification
 * @param options.palette    { bg, c1, c2, c3 } — C64 palette indices 0-15
 * @param options.position   { x, y } — initial screen position (GM coords)
 * @param options.frames     Array of frame-cells arrays. Each element is a
 *                           cells array as passed to frameFromAscii().
 */
export function spriteFromAscii(options) {
    if (!globalThis.gmSprite) {
        throw new Error('spriteFromAscii: globalThis.gmSprite not loaded — call bootstrap() first');
    }
    const {
        name,
        multicolor = true,
        xDouble = false,
        yDouble = false,
        palette = { bg: 0, c1: 1, c2: 2, c3: 3 },
        position = { x: 100, y: 100 },
        frames,
    } = options;

    if (!Array.isArray(frames) || frames.length === 0) {
        throw new Error('spriteFromAscii: frames must be a non-empty array');
    }

    const s = globalThis.gmSprite.createBlank({
        name,
        isMultiColor: multicolor,
        xDouble,
        yDouble,
        numFrames: frames.length,
        bgColor: palette.bg ?? 0,
        gmColor1: palette.c1 ?? 1,
        gmColor2: palette.c2 ?? 2,
        gmColor3: palette.c3 ?? 3,
        xPosition: position.x ?? 100,
        yPosition: position.y ?? 100,
    });

    const mode = multicolor ? 'multicolor' : 'hires';
    for (let f = 0; f < frames.length; f++) {
        s.sprite[0].imageData[f] = frameFromAscii(frames[f], { mode });
    }
    return s.serialize();
}

/**
 * Reverse of frameFromAscii — decode a 64-byte frame back into an ASCII
 * bitmap array. Useful for inspecting existing sprites when designing new
 * ones in the same style.
 */
export function asciiFromFrame(frameBytes, { mode = 'multicolor' } = {}) {
    const width = mode === 'multicolor' ? 12 : 24;
    const bitsPerPixel = mode === 'multicolor' ? 2 : 1;
    const pixelsPerByte = 8 / bitsPerPixel;
    const valChars = mode === 'multicolor' ? ['.', 'a', 'B', 'c'] : ['.', '#'];

    const rows = [];
    for (let r = 0; r < 21; r++) {
        let row = '';
        for (let bi = 0; bi < 3; bi++) {
            const byte = frameBytes[r * 3 + bi];
            for (let p = 0; p < pixelsPerByte; p++) {
                const shift = (pixelsPerByte - 1 - p) * bitsPerPixel;
                const val = (byte >> shift) & ((1 << bitsPerPixel) - 1);
                row += valChars[val] || '?';
            }
        }
        rows.push(row);
    }
    return rows;
}
