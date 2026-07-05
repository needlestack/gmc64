// tools/node-bootstrap.mjs
//
// Boilerplate that any Node script needs before it can load parseProgramData,
// gmSprite, gmVM, etc. Handles:
//   - Mock window / AudioContext / masterGain (gmMusic + gmRuntime want these)
//   - Import order for the runtime JS files (they populate globalThis)
//   - Injection of globalThis.decode16bit (defined in gmParser but only via
//     closure — it's not exported to globalThis, so Node scripts must add it)
//   - Instantiation of globalThis.charset (gmRuntime needs it available)
//
// Usage:
//   import { bootstrap, MockScreen, loadProgram } from './tools/node-bootstrap.mjs';
//   const gm = await bootstrap({ withRuntime: true });
//   const disk = new gm.D64(new Uint8Array(readFileSync(diskPath)));
//   const pd = loadProgram(disk, 'MYGAME/PRG');
//   const vm = new gm.gmVM(new MockScreen(), { skipPauseInstructions: true });
//   vm.loadProgram(gm.buildAST(pd), disk.readFile('MYGAME/PRG'));
//
// Options:
//   withRuntime — if true, also imports gmRuntime.js (needed for VM execution).
//                 Default false for scripts that only parse/serialize.
//   codeRoot    — override the repo root (auto-detected by default).

import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

// Walk up from this file's dir until we find a directory containing js/d64lib.js.
function findCodeRoot() {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, 'js/d64lib.js'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error('node-bootstrap: could not locate js/d64lib.js from any parent of ' + import.meta.url);
}

// Enough of a mock to satisfy the AudioContext calls in gmMusic + gmRuntime.
class MockAudioContext {
    constructor() {
        this.destination = {};
        this.currentTime = 0;
        this.state = 'running';
        this.sampleRate = 44100;
    }
    createOscillator() {
        return {
            connect(){}, start(){}, stop(){},
            frequency: { value: 440, setValueAtTime(){}, setTargetAtTime(){} },
            type: '',
            setPeriodicWave(){},
        };
    }
    createGain() {
        return {
            connect(){},
            gain: {
                value: 1,
                setValueAtTime(){}, setTargetAtTime(){},
                linearRampToValueAtTime(){}, cancelScheduledValues(){},
            },
        };
    }
    createBuffer(_, l) { return { getChannelData: () => new Float32Array(l) }; }
    createBufferSource() { return { connect(){}, start(){}, stop(){}, buffer: null }; }
    createPeriodicWave() { return {}; }
    close() { return Promise.resolve(); }
}

// Screen mock — just enough surface area for the runtime to draw to without
// throwing. Doesn't actually render pixels (Node has no canvas).
export class MockScreen {
    constructor() {
        this.width = 320;
        this.height = 200;
        this.pixels = new Uint8Array(320 * 200 * 4);
        this.ctx = {
            fillRect() {}, strokeRect() {}, fillText() {},
            fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
        };
    }
    clear() {}
    present() {}
    getContext() { return this.ctx; }
}

// Default empty input state — override on globalThis.inputState if you want
// to simulate joystick / button events.
function defaultInputState() {
    return {
        joystick1: { up: false, down: false, left: false, right: false },
        joystick2: { up: false, down: false, left: false, right: false },
        button1: false, button2: false,
    };
}

let _cachedBootstrap = null;

export async function bootstrap({ withRuntime = false, codeRoot = null } = {}) {
    // Idempotent — if already bootstrapped, return the cached refs.
    if (_cachedBootstrap && (!withRuntime || _cachedBootstrap.hasRuntime)) {
        return _cachedBootstrap;
    }

    const ROOT = codeRoot || findCodeRoot();

    // Audio + window mocks (must exist before importing gmMusic/gmRuntime).
    if (!globalThis.window) {
        globalThis.window = { AudioContext: MockAudioContext, webkitAudioContext: null };
    }
    if (!globalThis.audioContext) globalThis.audioContext = new MockAudioContext();
    if (!globalThis.masterGain) globalThis.masterGain = { connect(){}, gain: { value: 1 } };
    if (!globalThis.inputState) globalThis.inputState = defaultInputState();

    // Import in dependency order (each file populates globalThis).
    await import(join(ROOT, 'js/d64lib.js'));
    await import(join(ROOT, 'js/c64lib.js'));
    await import(join(ROOT, 'js/gmOpcodes.js'));
    await import(join(ROOT, 'js/gmSprite.js'));
    await import(join(ROOT, 'js/gmScene.js'));
    await import(join(ROOT, 'js/gmSound.js'));
    await import(join(ROOT, 'js/gmMusic.js'));
    await import(join(ROOT, 'js/gmCharset.js'));

    // charset needs to be instantiated as a global before runtime loads.
    if (!globalThis.charset) globalThis.charset = new globalThis.gmCharset();

    // decode16bit is a closure-scoped fn in gmParser.js; not exposed on
    // globalThis. Inject the same one-liner every test uses.
    if (!globalThis.decode16bit) {
        globalThis.decode16bit = (lo, hi) => lo + (hi << 8);
    }

    await import(join(ROOT, 'js/gmParser.js'));

    if (withRuntime) {
        await import(join(ROOT, 'js/gmRuntime.js'));
    }

    const refs = {
        ROOT,
        hasRuntime: withRuntime,
        D64: globalThis.D64,
        gmSprite: globalThis.gmSprite,
        parseProgramData: globalThis.parseProgramData,
        serializeProgram: globalThis.serializeProgram,
        buildAST: globalThis.buildAST,
        isMarkerEntry: globalThis.isMarkerEntry,
        gmVM: globalThis.gmVM,       // undefined unless withRuntime
        MockScreen,
    };
    _cachedBootstrap = refs;
    return refs;
}

// Convenience: parse a program from a disk, wiring up globalThis.currentDisk +
// loadFileByName the same way the browser does. Returns the ProgramData.
export function loadProgram(disk, progName) {
    globalThis.currentDisk = disk;
    globalThis.loadFileByName = (n) => disk.readFile(n);
    const bytes = disk.readFile(progName);
    if (!bytes) throw new Error(`loadProgram: not on disk: ${progName}`);
    return globalThis.parseProgramData(bytes);
}

// Convenience: run a program headlessly for N frames (50 steps per frame with
// updateSpritePositions per frame — same batching as the browser). Returns the
// VM so caller can inspect state.
export function runFrames(vm, numFrames, stepsPerFrame = 50) {
    for (let f = 0; f < numFrames && vm.running; f++) {
        for (let s = 0; s < stepsPerFrame && vm.running; s++) vm.step();
        vm.updateSpritePositions();
    }
    return vm;
}
