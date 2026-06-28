// c64Screen.js - Manages a 320×200 pixel buffer for C64 GameMaker display
//
// === ARCHITECTURE ===
// This is a thin layer that provides:
//   1. A pixel buffer (this.pixels) - where gmSprite and gmScene blit their graphics
//   2. A canvas - where the final composited image is displayed
//
// === WHY A PIXEL BUFFER? ===
// Canvas's putImageData() doesn't alpha-composite - it replaces pixels entirely.
// If sprite A draws, then sprite B does putImageData, B's transparent pixels
// would overwrite A's visible pixels with transparency (punching holes).
//
// Solution: All sprites blit to a shared pixel buffer, manually skipping
// transparent pixels. Then one putImageData() call displays the result.
//
// Flow: clear() → blit sprite 1 → blit sprite 2 → ... → present()
//
// === 320×200 NATIVE RESOLUTION ===
// This is the C64's true screen resolution:
//   - Hi-res mode: 320×200, 1 pixel = 1 pixel
//   - Multicolor mode: 160×200, but fat pixels displayed as 2×1 blocks
//
// By working at native resolution internally, all coordinates align.
// CSS handles final scaling to display size (e.g., 480×400 or 960×800).
// The `image-rendering: pixelated` CSS property ensures crisp pixel scaling.
//
// === DISPLAY SCALING ===
// The canvas HTML attribute sets the internal resolution (320×200).
// CSS width/height sets the display size. Common configurations:
//   - 480×400 (1.5×2): Good balance of size and sharpness (current default)
//   - 960×800 (3×4): Pixel-perfect for both multicolor and hi-res
//   - On high-DPI displays, the browser may further scale for crisp rendering

class c64Screen {
    static WIDTH = 320;   // True C64 horizontal resolution
    static HEIGHT = 200;  // True C64 vertical resolution

    constructor(canvasId) {
        // Accept canvas ID string or canvas element directly
        if (typeof canvasId === 'string') {
            this.canvas = document.getElementById(canvasId);
        } else {
            this.canvas = canvasId;
        }

        // Force canvas to native resolution (CSS handles display scaling)
        this.canvas.width = c64Screen.WIDTH;
        this.canvas.height = c64Screen.HEIGHT;

        this.ctx = this.canvas.getContext('2d');
        this.ctx.imageSmoothingEnabled = false; // Keep pixels crisp when scaling

        // === THE PIXEL BUFFER ===
        // This is the composite surface. Sprites blit here, skipping transparent
        // pixels to achieve proper overlapping. RGBA format, 4 bytes per pixel.
        this.pixels = new Uint8Array(c64Screen.WIDTH * c64Screen.HEIGHT * 4);

        // Pre-create ImageData object for efficient putImageData calls
        this.imageData = this.ctx.createImageData(c64Screen.WIDTH, c64Screen.HEIGHT);
    }

    // === CLEARING ===
    // Fill the entire pixel buffer with a solid color.
    // Called at the start of each frame before blitting sprites.
    // Default is black (0, 0, 0). Alpha is always set to 255 (opaque).
    clear(r = 0, g = 0, b = 0) {
        for (let i = 0; i < this.pixels.length; i += 4) {
            this.pixels[i] = r;
            this.pixels[i + 1] = g;
            this.pixels[i + 2] = b;
            this.pixels[i + 3] = 255;
        }
    }

    // Clear to fully transparent (alpha=0).
    // Used when the canvas overlays other content and sprites should appear
    // without a background color (e.g., sprite editor preview overlay).
    clearTransparent() {
        for (let i = 0; i < this.pixels.length; i += 4) {
            this.pixels[i] = 0;
            this.pixels[i + 1] = 0;
            this.pixels[i + 2] = 0;
            this.pixels[i + 3] = 0;
        }
    }

    // === SINGLE PIXEL ACCESS ===
    // For simple drawing operations or debugging.
    // Most rendering should use blitToBuffer() in gmSprite/gmScene instead.
    setPixel(x, y, r, g, b) {
        if (x < 0 || x >= c64Screen.WIDTH || y < 0 || y >= c64Screen.HEIGHT) return;
        const idx = (y * c64Screen.WIDTH + x) * 4;
        this.pixels[idx] = r;
        this.pixels[idx + 1] = g;
        this.pixels[idx + 2] = b;
        this.pixels[idx + 3] = 255;
    }

    // === PRESENTATION ===
    // Copy the pixel buffer to the canvas for display.
    // This is the ONLY call that actually updates what the user sees.
    // Call once per frame after all sprites have been blitted.
    //
    // putImageData() is a raw pixel copy - no alpha blending, no transforms.
    // That's why we composite in the pixel buffer first.
    present() {
        this.imageData.data.set(this.pixels);
        this.ctx.putImageData(this.imageData, 0, 0);
    }

}
