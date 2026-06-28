/*

General Purpose c64 utilities

*/


// RGB values from VICE, names from GameMaker
// Access by index: c64Palette[0x05] or c64Palette[5]
// Access by name:  c64Palette.green or c64Palette['green']
const c64Palette = {
    // By index
    0x00: [0, 0, 0, 255],        // black
    0x01: [255, 255, 255, 255],  // white
    0x02: [169, 71, 100, 255],   // red
    0x03: [138, 230, 203, 255],  // cyan
    0x04: [154, 88, 185, 255],   // purple
    0x05: [114, 189, 103, 255],  // green
    0x06: [25, 73, 180, 255],    // blue
    0x07: [255, 248, 141, 255],  // yellow
    0x08: [196, 98, 65, 255],    // orange
    0x09: [151, 64, 0, 255],     // brown
    0x0A: [230, 134, 163, 255],  // lt red
    0x0B: [98, 98, 98, 255],     // gray 1
    0x0C: [148, 148, 148, 255],  // gray 2
    0x0D: [198, 255, 186, 255],  // lt green
    0x0E: [98, 145, 251, 255],   // lt blue
    0x0F: [205, 205, 205, 255],  // gray 3
};
// By name (references same arrays)
c64Palette.black   = c64Palette[0x00];
c64Palette.white   = c64Palette[0x01];
c64Palette.red     = c64Palette[0x02];
c64Palette.cyan    = c64Palette[0x03];
c64Palette.purple  = c64Palette[0x04];
c64Palette.green   = c64Palette[0x05];
c64Palette.blue    = c64Palette[0x06];
c64Palette.yellow  = c64Palette[0x07];
c64Palette.orange  = c64Palette[0x08];
c64Palette.brown   = c64Palette[0x09];
c64Palette.ltRed   = c64Palette[0x0A];
c64Palette.gray1   = c64Palette[0x0B];
c64Palette.gray2   = c64Palette[0x0C];
c64Palette.ltGreen = c64Palette[0x0D];
c64Palette.ltBlue  = c64Palette[0x0E];
c64Palette.gray3   = c64Palette[0x0F];

// color names as shown in GameMaker
const c64ColorNames = {
    0x00: "black",
    0x01: "white",
    0x02: "red",
    0x03: "cyan",
    0x04: "purple",
    0x05: "green",
    0x06: "blue",
    0x07: "yellow",
    0x08: "orange",
    0x09: "brown",
    0x0A: "lt red",
    0x0B: "gray 1",
    0x0C: "gray 2",
    0x0D: "lt grn",
    0x0E: "lt blu",
    0x0F: "gray 3",
};

// Convert C64/Gamemaker char to ASCII
const decodeChar = (byte) => {
    if (0x30 <= byte && byte <= 0x39) // digits
        return String.fromCharCode(byte);
    if (0x01 <= byte && byte <= 0x1A) // lowercase letters
        return String.fromCharCode(byte - 1 + 'a'.charCodeAt(0));
    if (byte === 0x2F) return '/';
    if (byte === 0x2D) return '-';
    if (byte === 0x2B) return '+';
    if (byte === 0x1C) return '=';
    if (byte === 0x20) return ' ';
    // PRINT STRING PADDING CHARACTER (0x3B / 59):
    // Print statements are always 20 bytes in the binary format. The actual text
    // content is followed by 0x3B bytes as padding. When displayed in the editor,
    // these decode to underscores '_' so you see "hello_______________". But when
    // the string is printed to a scene at runtime (see gmCharset.drawBytesToScene),
    // 0x3B bytes are skipped entirely - nothing is drawn for those positions.
    // This allows variable-length strings without leaving visible padding on screen.
    if (byte === 0x3B) return '_';
    if (byte === 0x22) return '.';
    if (byte === 0x1E) return '>';
    if (byte === 0x27) return "'";  // apostrophe (GM index 39)
    if (byte === 0x26) return '?';  // question mark (GM index 38)
    if (byte === 0x1B) return '[';
    if (byte === 0x1D) return ']';
    if (byte === 0x1F) return '<';
    return '�'; // Unknown byte
};

function decodeString(bytes) {
    return Array.from( bytes ).map(decodeChar).join('');
}

// Convert ASCII character to C64/GameMaker byte (inverse of decodeChar)
const encodeChar = (char) => {
    const code = char.charCodeAt(0);
    // Lowercase letters a-z → 0x01-0x1A
    if (code >= 0x61 && code <= 0x7A) return code - 0x60;
    // Uppercase letters A-Z → also 0x01-0x1A (treat as lowercase)
    if (code >= 0x41 && code <= 0x5A) return code - 0x40;
    // Digits 0-9 → 0x30-0x39 (same as ASCII)
    if (code >= 0x30 && code <= 0x39) return code;
    // Special characters
    if (char === '/') return 0x2F;
    if (char === '-') return 0x2D;
    if (char === '+') return 0x2B;
    if (char === '=') return 0x1C;
    if (char === ' ') return 0x20;
    if (char === '_') return 0x3B;  // Padding character
    if (char === '.') return 0x22;
    if (char === '>') return 0x1E;
    if (char === "'") return 0x27;
    if (char === '?') return 0x26;
    if (char === '[') return 0x1B;
    if (char === ']') return 0x1D;
    if (char === '<') return 0x1F;
    return 0x20;  // Default to space for unknown chars
};

function encodeString(str, length) {
    const bytes = [];
    for (let i = 0; i < length; i++) {
        if (i < str.length) {
            bytes.push(encodeChar(str[i]));
        } else {
            bytes.push(0x20);  // Pad with spaces
        }
    }
    return bytes;
}

// Make available globally for browser and Node.js testing
if (typeof globalThis !== 'undefined') {
    globalThis.c64Palette = c64Palette;
    globalThis.c64ColorNames = c64ColorNames;
    globalThis.decodeString = decodeString;
    globalThis.encodeString = encodeString;
    globalThis.decodeChar = decodeChar;
    globalThis.encodeChar = encodeChar;
}

