#!/usr/bin/env node
/**
 * Generate golden files for gmRuntime state snapshot tests.
 *
 * Usage: node tests/generate-golden-runtime.js
 *
 * This creates JSON files in tests/golden/ with captured VM state
 * for comparison in the test suite.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock AudioParam for gain/frequency nodes
function createMockAudioParam(initialValue = 1) {
    return {
        value: initialValue,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
        cancelScheduledValues: () => {},
        setTargetAtTime: () => {}
    };
}

// Mock AudioContext class
class MockAudioContext {
    constructor() {
        this.currentTime = 0;
        this.state = 'running';
        this.sampleRate = 44100;
        this.destination = {};
    }
    createOscillator() {
        return {
            connect: () => {},
            start: () => {},
            stop: () => {},
            frequency: createMockAudioParam(440),
            type: 'square',
            setPeriodicWave: () => {}
        };
    }
    createGain() {
        return {
            connect: () => {},
            gain: createMockAudioParam(1)
        };
    }
    createPeriodicWave() { return {}; }
    createBuffer(channels, length, sampleRate) {
        return { getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
        return {
            connect: () => {},
            start: () => {},
            stop: () => {},
            buffer: null
        };
    }
    close() {
        return Promise.resolve();
    }
}

// Set up globals
globalThis.window = {
    AudioContext: MockAudioContext,
    webkitAudioContext: MockAudioContext
};
globalThis.audioContext = new MockAudioContext();
globalThis.masterGain = { connect: () => {}, gain: { value: 1 } };
// skipPauseInstructions / showHitboxes / audioMuted are per-VM config
// now — see new gmVM(...) below.
globalThis.inputState = {
    joystick1: { up: false, down: false, left: false, right: false },
    joystick2: { up: false, down: false, left: false, right: false },
    button1: false,
    button2: false
};
globalThis.decode16bit = (lo, hi) => lo + (hi << 8);
// Real charset — gmCharset has its bitmap data baked in. Stubbing it out
// (loaded: undefined) silently skips every print/draw path in the runtime,
// so frame goldens wouldn't include printed text. Load the real one.
await import('../js/gmCharset.js');
globalThis.charset = new globalThis.gmCharset();

// Load dependencies
await import('../js/c64lib.js');
await import('../js/d64lib.js');
await import('../js/gmOpcodes.js');
await import('../js/gmSprite.js');
await import('../js/gmScene.js');

// Mock c64Screen constants (used by gmRuntime.render())
globalThis.c64Screen = {
    WIDTH: 320,
    HEIGHT: 200
};

await import('../js/gmSound.js');
await import('../js/gmMusic.js');

// Set up loadFileByName
let currentDisk = null;
globalThis.loadFileByName = (fileName) => {
    if (!currentDisk) return null;
    return currentDisk.readFile(fileName);
};

await import('../js/gmParser.js');
await import('../js/gmRuntime.js');

const { D64, parseProgramData, buildAST, gmVM } = globalThis;

const GOLDEN_DIR = join(__dirname, 'golden');
const DISKS_DIR = join(__dirname, 'disks');

// Ensure golden directory exists
mkdirSync(GOLDEN_DIR, { recursive: true });

// Mock screen (supports rendering)
class MockScreen {
    constructor() {
        this.width = 320;
        this.height = 200;
        this.pixels = new Uint8Array(320 * 200 * 4);
        this.ctx = {
            fillRect: () => {},
            strokeRect: () => {},
            fillText: () => {},
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 1,
            font: ''
        };
    }
    clear(r = 0, g = 0, b = 0) {
        for (let i = 0; i < this.pixels.length; i += 4) {
            this.pixels[i] = r;
            this.pixels[i + 1] = g;
            this.pixels[i + 2] = b;
            this.pixels[i + 3] = 255;
        }
    }
    present() {}
    getContext() { return this.ctx; }
}

// Reset input state
function resetInput() {
    globalThis.inputState = {
        joystick1: { up: false, down: false, left: false, right: false },
        joystick2: { up: false, down: false, left: false, right: false },
        button1: false,
        button2: false
    };
}

// Set joystick direction
function setJoystick(joystickNum, direction) {
    const joy = joystickNum === 1 ? globalThis.inputState.joystick1 : globalThis.inputState.joystick2;
    joy.up = direction === 'up';
    joy.down = direction === 'down';
    joy.left = direction === 'left';
    joy.right = direction === 'right';
}

// Set button state
function setButton(buttonNum, pressed) {
    if (buttonNum === 1) globalThis.inputState.button1 = pressed;
    else globalThis.inputState.button2 = pressed;
}

// Capture VM state snapshot
function captureState(vm) {
    return {
        variables: Array.from({ length: 26 }, (_, i) => ({
            name: String.fromCharCode(97 + i),
            value: vm.vars[i],
            defined: vm.varsDefined[i]
        })).filter(v => v.defined),

        sprites: vm.sprites.map((slot, i) => ({
            slot: i + 1,
            visible: slot.visible,
            name: slot.spriteName,
            x: Math.round(slot.x * 100) / 100,
            y: Math.round(slot.y * 100) / 100,
            speed: slot.speed,
            direction: slot.direction,
            animSpeed: slot.animSpeed,
            currentFrame: slot.currentFrame
        })),

        scenes: vm.scenes.map((scene, i) => ({
            slot: i + 1,
            loaded: !!scene,
            name: scene?.name || null
        })),
        activeScene: vm.activeScene,
        scores: [...vm.score],
        running: vm.running,
        paused: vm.paused,
        pc: vm.pc
    };
}

// Load program helper
function loadProgram(disk, programName) {
    currentDisk = disk;
    const fileData = disk.readFile(programName);
    if (!fileData) throw new Error(`Program not found: ${programName}`);

    const programData = parseProgramData(fileData);
    const ast = buildAST(programData);

    const screen = new MockScreen();
    const vm = new gmVM(screen, { skipPauseInstructions: true });
    vm.loadProgram(ast, fileData);
    vm.running = true;

    return { vm, fileData, programData };
}

// Run VM for N steps
// Batches steps like the browser does (50 steps per frame, then updateSpritePositions)
const STEPS_PER_FRAME = 50;
function runSteps(vm, steps) {
    let remaining = steps;
    while (remaining > 0 && vm.running) {
        const batch = Math.min(remaining, STEPS_PER_FRAME);
        for (let i = 0; i < batch && vm.running; i++) {
            vm.step();
        }
        vm.updateSpritePositions();
        remaining -= batch;
    }
}

// Save golden file
function saveGolden(filename, state) {
    const path = join(GOLDEN_DIR, filename);
    writeFileSync(path, JSON.stringify(state, null, 2));
    console.log(`  Saved: ${filename}`);
}

// Main
console.log('Generating gmRuntime golden files...\n');

const diskData = new Uint8Array(readFileSync(join(DISKS_DIR, 'gmc64-test.d64')));
const disk = new D64(diskData);

// Sample pixels at every 8th position (40x25 = 1000 sample points). Same
// shape as the test side expects. Used by both GMC64I and ALIENS frame
// goldens below.
function frameSampleIndices() {
    const out = [];
    for (let y = 0; y < 200; y += 8) {
        for (let x = 0; x < 320; x += 8) {
            const idx = (y * 320 + x) * 4;
            out.push(idx, idx + 1, idx + 2, idx + 3); // RGBA
        }
    }
    return out;
}

// ============================================================ GMC64I =====
console.log('GMC64I:');
resetInput();

let { vm } = loadProgram(disk, 'GMC64I/PRG');
runSteps(vm, 100);
saveGolden('runtime-GMC64I-100steps.json', captureState(vm));

// Long-run state — by 5000 steps the demo has had time to lay down
// plotted scene pixels, animate sprites, and advance several program
// sections. GMC64I is the fixture with mid-program content that early-
// frame goldens couldn't catch.
resetInput();
({ vm } = loadProgram(disk, 'GMC64I/PRG'));
runSteps(vm, 5000);
saveGolden('runtime-GMC64I-5000steps.json', captureState(vm));

// Same long-run state with a rendered frame. The pixel samples cover
// plotted content so a regression in scene plotting would change the
// snapshot.
const gmc64iFrame = { ...captureState(vm) };
vm.renderPixels();
gmc64iFrame.sampleIndices = frameSampleIndices();
gmc64iFrame.pixelSamples = gmc64iFrame.sampleIndices.map(i => vm.screen.pixels[i]);
console.log('  GMC64I frame samples: ' + (gmc64iFrame.sampleIndices.length / 4) + ' pixels');
saveGolden('runtime-GMC64I-5000-frame.json', gmc64iFrame);

// ============================================================ ALIENS =====
console.log('\nALIENS:');
resetInput();

({ vm } = loadProgram(disk, 'ALIENS/PRG'));
runSteps(vm, 100);
saveGolden('runtime-ALIENS-100steps.json', captureState(vm));

// Frame render after 100 steps — captures the formation in place at the
// start of the game with the starfield scene live.
function frameWithSamples(vm) {
    const out = { ...captureState(vm) };
    vm.renderPixels();
    out.sampleIndices = frameSampleIndices();
    out.pixelSamples = out.sampleIndices.map(i => vm.screen.pixels[i]);
    return out;
}
const aliensFrame = frameWithSamples(vm);
console.log('  ALIENS frame samples: ' + (aliensFrame.sampleIndices.length / 4) + ' pixels');
saveGolden('runtime-ALIENS-100-frame.json', aliensFrame);

// Single combined-input frame, staggered inputs:
//   steps   1–100 : no input (init/setup)
//   step      100 : joystick right held
//   step      110 : button held (in addition)
//   from then on  : run until score > 0, capture frame
// End-state shows ship shifted right, an alien removed, and score=10.
resetInput();
({ vm } = loadProgram(disk, 'ALIENS/PRG'));
runSteps(vm, 100);
setJoystick(1, 'right');
runSteps(vm, 10);
setButton(1, true);
let combinedSteps = 0;
while (combinedSteps < 4000 && vm.score[0] === 0) {
    runSteps(vm, 100);
    combinedSteps += 100;
}
console.log('  ALIENS combined-input first collision at step ' + (110 + combinedSteps) + ' (score=' + vm.score[0] + ')');
saveGolden('runtime-ALIENS-combined-frame.json', frameWithSamples(vm));

console.log('\nDone!');
