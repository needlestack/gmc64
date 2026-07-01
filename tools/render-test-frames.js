// Runs the same VM setup as the runtime tests and dumps the full 320×200
// frame buffer to PNG — so you can see what the test code actually rendered
// before the sparse golden-sampling step throws most of the detail away.
//
// Run: `node tools/render-test-frames.js`
// Output: tools/test-frame-*.png

import { readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---- Mirror the gmRuntime test harness setup -------------------------------
await import(`${ROOT}/js/c64lib.js`);
await import(`${ROOT}/js/d64lib.js`);
await import(`${ROOT}/js/gmOpcodes.js`);
await import(`${ROOT}/js/gmSprite.js`);
await import(`${ROOT}/js/gmScene.js`);
globalThis.c64Screen = { WIDTH: 320, HEIGHT: 200 };
await import(`${ROOT}/js/gmSound.js`);
await import(`${ROOT}/js/gmMusic.js`);

let currentDisk = null;
globalThis.loadFileByName = (name) => currentDisk?.readFile(name);

await import(`${ROOT}/js/gmParser.js`);

globalThis.inputState = {
    joystick1: { up: false, down: false, left: false, right: false },
    joystick2: { up: false, down: false, left: false, right: false },
    button1: false, button2: false,
};
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);

class MockAudioParam {
    constructor(v = 1) { this.value = v; }
    setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {}
    cancelScheduledValues() {} setTargetAtTime() {}
}
class MockAudioContext {
    constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 44100; this.destination = {}; }
    createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: new MockAudioParam(440), type: 'square', setPeriodicWave() {} }; }
    createGain() { return { connect() {}, gain: new MockAudioParam(1) }; }
    createPeriodicWave() { return {}; }
    createBuffer() { return { getChannelData: () => new Float32Array(64) }; }
    createBufferSource() { return { connect() {}, start() {}, stop() {}, buffer: null }; }
    close() { return Promise.resolve(); }
}
globalThis.window = { AudioContext: MockAudioContext, webkitAudioContext: MockAudioContext };
globalThis.audioContext = new MockAudioContext();
globalThis.masterGain = { connect: () => {}, gain: { value: 1 } };
// Real charset — stubbing it out silently skips every runtime draw/print
// path (the runtime guards on charset.loaded), so we'd render frames that
// don't include any printed text. Load the real one.
await import(`${ROOT}/js/gmCharset.js`);
globalThis.charset = new globalThis.gmCharset();

class MockScreen {
    constructor() {
        this.width = 320;
        this.height = 200;
        this.pixels = new Uint8Array(320 * 200 * 4);
        this.ctx = { fillRect() {}, strokeRect() {}, fillText() {}, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '' };
    }
    clear() {}
    present() {}
    getContext() { return this.ctx; }
}

await import(`${ROOT}/js/gmRuntime.js`);
const { D64, parseProgramData, buildAST, gmVM } = globalThis;

function runSteps(vm, steps) {
    let remaining = steps;
    while (remaining > 0 && vm.running) {
        const batch = Math.min(remaining, 50);
        for (let i = 0; i < batch && vm.running; i++) vm.step();
        vm.updateSpritePositions();
        remaining -= batch;
    }
}

function resetInput() {
    globalThis.inputState = {
        joystick1: { up: false, down: false, left: false, right: false },
        joystick2: { up: false, down: false, left: false, right: false },
        button1: false, button2: false,
    };
}

function renderProgram(disk, name, steps, setup) {
    currentDisk = disk;
    resetInput();
    const fileData = disk.readFile(name);
    const pd = parseProgramData(fileData);
    const ast = buildAST(pd);
    const screen = new MockScreen();
    const vm = new gmVM(screen, { skipPauseInstructions: true });
    vm.loadProgram(ast, fileData);
    vm.running = true;
    runSteps(vm, steps);
    if (setup) setup(vm);
    vm.render(false);
    return screen.pixels;
}

// ---- The scenarios -------------------------------------------------------
// Scenarios match generate-golden-runtime.js. `setup` runs after init and
// receives the vm so it can hold inputs / advance more steps for input-
// driven scenarios.
const FRAMES = [
    { disk: 'tests/disks/gmc64-test.d64', prg: 'GMC64I/PRG', steps: 5000,
      out: 'test-frame-GMC64I-5000.png' },
    { disk: 'tests/disks/gmc64-test.d64', prg: 'ALIENS/PRG', steps: 100,
      out: 'test-frame-ALIENS-100.png' },
    { disk: 'tests/disks/gmc64-test.d64', prg: 'ALIENS/PRG', steps: 100,
      out: 'test-frame-ALIENS-combined.png',
      setup: (vm) => {
          globalThis.inputState.joystick1.right = true;
          runSteps(vm, 10);
          globalThis.inputState.button1 = true;
          let s = 0;
          while (s < 4000 && vm.score[0] === 0) { runSteps(vm, 100); s += 100; }
      } },
];

const browser = await puppeteer.launch({ headless: true });
try {
    for (const f of FRAMES) {
        const disk = new D64(new Uint8Array(readFileSync(resolve(ROOT, f.disk))));
        const pixels = renderProgram(disk, f.prg, f.steps, f.setup);
        const page = await browser.newPage();
        await page.setViewport({ width: 320, height: 200, deviceScaleFactor: 1 });
        await page.setContent(`<body style="margin:0"><canvas id="c" width="320" height="200" style="display:block"></canvas></body>`);
        await page.evaluate((pixelsArr) => {
            const ctx = document.getElementById('c').getContext('2d');
            const img = ctx.createImageData(320, 200);
            img.data.set(pixelsArr);
            ctx.putImageData(img, 0, 0);
        }, Array.from(pixels));
        const outPath = resolve(__dirname, f.out);
        const buf = await page.screenshot({ omitBackground: false });
        writeFileSync(outPath, buf);
        console.log(`wrote ${outPath}  (${f.prg} after ${f.steps} steps)`);
        await page.close();
    }
} finally {
    await browser.close();
}
