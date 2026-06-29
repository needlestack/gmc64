// gmRuntime.js - GameMaker Virtual Machine Runtime
//
// This module contains the gmVM class which executes GameMaker programs.
// It handles:
// - Program execution (step through instructions, evaluate conditions)
// - Sprite management (8 slots with position, animation, movement)
// - Scene management (2 scene slots)
// - Score and variable tracking
// - Collision detection (AABB and pixel-perfect)
// - Rendering to c64Screen buffer
//
// === SPRITE SLOT ARCHITECTURE ===
// Each of the 8 sprite slots has its OWN gmSprite instance (spriteInstance).
// This matches real C64 hardware where each sprite has independent color registers.
//
// When "sprite X is name" executes:
//   1. A NEW gmSprite is created from mediaStore[idx].spriteFileData
//   2. The instance is stored in sprites[X].spriteInstance
//   3. The slot now has independent colors from other slots using the same sprite
//
// Why per-slot instances instead of shared?
//   - Programs commonly use the same sprite image in two slots with
//     different per-slot colors (e.g., a friendly variant in one slot,
//     an enemy variant in another), via "sprite N color 1 = red"
//   - With shared instances, this would change BOTH slots' color
//   - Per-slot instances match real C64 behavior where each sprite has its own
//     color 1 register (colors 2/3 are shared across all sprites)
//
// For shared colors (2 and 3), the runtime iterates all 8 slots and calls
// setSharedColor() on each slot's spriteInstance.
//
// Dependencies (must be loaded before this file):
// - c64lib.js (c64Palette, c64ColorNames, decodeString, decodeChar)
// - c64Screen.js (c64Screen class)
// - gmSprite.js (gmSprite class)
// - gmScene.js (gmScene class)
// - gmSound.js (gmSound class)
// - gmOpcodes.js (gmOpcodes, formatInstruction)
// - gmCharset.js (gmCharset class)
//
// Embedder contract — what an embedder (editor, standalone, tests) must
// provide to drive the runtime:
//
//   Per-instance config (passed via constructor / loadProgram / setConfig):
//   - pauseEnabled  honor `pause for X.X` opcode (false = run-fast / debug)
//   - showHitboxes  draw collision rectangles on top of the rendered frame
//   - audioMuted    suppress sound/song playback (does not stop the program)
//
//   Globals the runtime still reads (legacy, scoped beyond one VM):
//   - inputState        joystick/button state, mutated by input handlers
//   - charset           gmCharset instance for text rendering
//   - decode16bit       helper used by media decoders
//   - audioContext, masterGain   Web Audio nodes for sound/song playback
//
// Embedders should call vm.start({ opsPerFrame, frameMs, onFrame? }) rather
// than rolling their own setTimeout loop; that's the only way the editor
// and standalone stay in sync on game-speed.

// Scene palette indices that hide an "under" sprite's pixels. Color 2 and
// 3 are the high-priority background colours on the real C64 — when the
// VIC's sprite-priority bit is set, those background pixels render in
// front of the sprite. We mirror that here in blitToBuffer.
const UNDER_SKIP_INDICES = new Set([2, 3]);

class gmVM {
    constructor(screen, config = {}) {
        this.screen = screen;
        // Defaults match how the editor runs a game out of the box. Tests
        // and the standalone export override via the second arg or via
        // setConfig() / loadProgram(..., config).
        //
        // rngSeed: if undefined, the `rnd` opcode (0x09) uses Math.random
        // for natural unpredictability. Set to a number to make a game
        // deterministic — useful for tests that snapshot VM state after
        // running a program with random branches.
        this.config = {
            pauseEnabled: true,
            showHitboxes: false,
            audioMuted: false,
            rngSeed: undefined,
            ...config
        };
        this._installRng();
        this.reset();
    }

    setConfig(updates) {
        const seedChanged = 'rngSeed' in updates &&
            updates.rngSeed !== this.config.rngSeed;
        Object.assign(this.config, updates);
        // User mute = ramp the current song's gain to zero, not stopAllAudio.
        // Notes keep being scheduled underneath so unmute is instant (no
        // restart, no jump-to-top). Sound effects use the gate at their
        // play site (transient one-shots — no point playing them silently
        // just so they can finish during a mute window).
        if (typeof updates.audioMuted === 'boolean' && this.currentSong) {
            try {
                this.currentSong.setVolume(updates.audioMuted ? 0 : this.songVolume);
            } catch (e) { /* gmMusic may be mid-teardown — ignore */ }
        }
        if (seedChanged) this._installRng();
    }

    // Initialize the RNG used by opcode 0x09 (rnd) based on config.rngSeed.
    // Deterministic seed → mulberry32 (tiny, fast, no allocations).
    // Unset → Math.random (the default, non-deterministic).
    _installRng() {
        const seed = this.config.rngSeed;
        if (typeof seed === 'number') {
            let s = seed >>> 0;
            this._rng = () => {
                s = (s + 0x6D2B79F5) >>> 0;
                let t = Math.imul(s ^ (s >>> 15), s | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        } else {
            this._rng = Math.random;
        }
    }

    reset() {
        // Stop any playing audio before resetting state
        this.stopAllAudio();

        // Program state (AST structure, not flat array)
        this.ast = null;
        this.labelMap = {};
        this.mediaStore = [];
        // Simple execution state - just current list and program counter
        // No stack needed - each list knows its parent via .parent and .parentIndex
        this.currentList = null;
        this.pc = 0;
        this.returnStack = []; // Stack for GOSUB/RETURN
        this.running = false;
        this.paused = false;
        this.pauseUntil = 0; // Wallclock timestamp for pause instruction

        // Variables (26 vars: a-z)
        // GM uses 1-based indexing in bytecode: 1='a', 2='b', ..., 26='z'
        // We store in 0-based array, so use getVar/setVar helpers to convert
        this.vars = new Array(26).fill(0);
        this.varsDefined = new Array(26).fill(false); // Track which vars have been set

        // RAM (256 bytes)
        this.ram = new Uint8Array(256);

        // Data table pointer (instruction index set by "data table at lXXX")
        // Used by "set var = value at data+[var]" to read from data values
        this.dataTableBase = 0;

        // === SPRITE SLOTS ===
        // 8 hardware sprite slots, matching the C64's sprite hardware.
        // Each slot has its OWN gmSprite instance (spriteInstance) so colors
        // can be changed independently per slot.
        //
        // === MULTI-PART SPRITES AT RUNTIME ===
        // Multi-part sprites combine up to 4 C64 hardware sprites. At runtime:
        //   - Main slot: Has spriteInstance (the gmSprite with all quads)
        //   - Subsprite slots: Marked isSubsprite=true, NO spriteInstance
        //
        // The main slot's gmSprite renders ALL quads. Subsprite slots are empty
        // placeholders that reserve the hardware sprite slot.
        //
        // When "sprite N is BIGSHIP" executes for a 4-quad sprite:
        //   slot[N]:   spriteInstance=gmSprite, isSubsprite=false
        //   slot[N+1]: spriteInstance=null,     isSubsprite=true, parentSlotIdx=N, quadIndex=1
        //   slot[N+2]: spriteInstance=null,     isSubsprite=true, parentSlotIdx=N, quadIndex=2
        //   slot[N+3]: spriteInstance=null,     isSubsprite=true, parentSlotIdx=N, quadIndex=3
        //
        // This matches how mediaStore entries work (see gmParser.js):
        //   - Main entry has the gmSprite
        //   - Marker entries reference same gmSprite but have quadIndex > 0
        //
        // See CLAUDE.md "Multi-Part Sprites" for full documentation.
        //
        // Key fields:
        //   spriteInstance: The gmSprite object for this slot (null for subsprite slots)
        //   spriteName: Display name (for debugging - not used for lookups)
        //   isSubsprite: True if this slot is reserved for a multi-part sprite's quad
        //   parentSlotIdx: For subsprites, which slot owns the parent sprite
        this.sprites = [];
        for (let i = 0; i < 8; i++) {
            this.sprites[i] = {
                spriteName: null,     // Name of sprite (for debugging/display only)
                spriteInstance: null, // gmSprite instance (each slot gets its own copy for independent colors)
                x: 0,
                y: 0,
                direction: 0,         // 0-255 (0=up, 64=right, 128=down, 192=left)
                speed: 0,
                visible: false,
                isSubsprite: false,   // True if this slot is reserved for a multi-part sprite's subsprite
                parentSlotIdx: -1,    // If isSubsprite, which slot owns this subsprite
                quadIndex: 0,         // If isSubsprite, which quad of the parent sprite (1, 2, or 3)
                skipQuads: null,      // Set of quad indices to skip rendering (when subsprites are overwritten)
                originalParentSlotIdx: -1, // Original parent slot (preserved across overrides for restoration)
                originalQuadIndex: 0,      // Original quad index (preserved across overrides for restoration)
                animSpeed: 0,         // Animation speed for this slot (persists across sprite swaps)
                animFrame: 0,         // Current animation frame for this slot
                skipCounter: undefined, // Frame skip counter for animation timing
                animateOnce: false,   // If true, animation plays once and stops on last frame
                animateOnceDone: false, // True when animateOnce animation has completed (rendered last frame)
                overUnder: 0          // 0 = over scene colors 2/3 (default), 1 = under (opcode 0x59)
            };
        }

        // Scenes (2 scene slots, GameMaker supports max 2 scenes)
        // GameMaker starts with two blank scenes with all-black palettes
        this.scenes = [new gmScene(), new gmScene()];
        this.activeScene = 0; // Default to scene 0

        // Scores (2 scores, 6-digit values)
        this.score = [0, 0];

        // Score display state (position and colors for rendering)
        // Each score has its own row, column, fg color, bg color
        // Scores render TO scene canvas (like print), not as HUD overlay
        this.scoreRow = [0, 0];       // Row position (0-24)
        this.scoreCol = [0, 0];       // Column position (0-19)
        this.scoreFgColor = [1, 1];   // Foreground color slot (default slot 1)
        this.scoreBgColor = [0, 0];   // Background color slot (default slot 0 = scene background)
        this.scoreScene = [0, 0];     // Which scene(s): 0=scene1, 1=scene2, 2=both
        this.scoreVisible = [false, false]; // Only render if "displays on" has been called

        // === SOUND CHANNELS ===
        // 3 independent sound channels (matching C64's 3 SID voices)
        // Each channel can play one sound at a time
        this.soundChannels = [
            { sound: null, name: null, dataIndex: -1 },  // Channel 0
            { sound: null, name: null, dataIndex: -1 },  // Channel 1
            { sound: null, name: null, dataIndex: -1 }   // Channel 2
        ];

        // === MUSIC ===
        // One song can play at a time
        this.currentSong = null;
        this.currentSongIndex = -1;  // Track which song is playing for noop detection
        this.songVolume = 15;  // 0-15, default max

        // Print state (for text rendering with gmCharset)
        // Print instructions set position/color, then print text to the target scene
        this.printRow = 0;       // Current print row (0-24, character row)
        this.printCol = 0;       // Current print column (0-19, character column)
        this.printFgColor = 1;   // Foreground color (C64 palette index, default white)
        this.printBgColor = -1;  // Background color (-1 = transparent)
        this.printScene = 0;     // Target scene for print (0 or 1)

        // Plot state (for plot a dot commands)
        this.plotColor = 1;      // Color index (0-3) for plot commands, default to color1
        this.plotScene = 0;      // Target scene (0 or 1) for plot commands

        // Screen update flag
        this.screenUpdateOn = true;
    }

    // Get variable value (converts GM's 1-based index to 0-based array index)
    // GM bytecode uses 1='a', 2='b', ... 26='z'
    // IMPORTANT: Check whether the opcode stores the var index in arg1 or arg2!
    // Many opcodes use arg2 with arg1=0. If gmOpcodes.js template is wrong,
    // variables display as '`' (backtick) instead of letters.
    getVar(gmIndex) {
        return this.vars[gmIndex - 1] || 0;
    }

    // Set variable value (converts GM's 1-based index to 0-based array index)
    setVar(gmIndex, value) {
        this.vars[gmIndex - 1] = value;
        this.varsDefined[gmIndex - 1] = true;
    }

    // Stop all playing sounds and music.
    // Called on reset to ensure audio doesn't continue after program stops.
    // Music is pre-scheduled with Web Audio timing, so we must explicitly stop it.
    stopAllAudio() {
        // Stop current song if playing
        if (this.currentSong) {
            try {
                this.currentSong.stop();
            } catch (e) {
                // Already stopped
            }
            this.currentSong = null;
            this.currentSongIndex = -1;
        }

        // Stop all sound channels
        for (let i = 0; i < 3; i++) {
            if (this.soundChannels && this.soundChannels[i] && this.soundChannels[i].sound) {
                try {
                    this.soundChannels[i].sound.stop();
                } catch (e) {
                    // Already stopped
                }
            }
        }
    }

    // Pause all playing sounds and music.
    // Uses Web Audio suspend() to freeze audio in place - can be resumed.
    pauseAudio() {
        if (this.currentSong) {
            try {
                this.currentSong.pause();
            } catch (e) {
                // Ignore errors
            }
        }

        for (let i = 0; i < 3; i++) {
            if (this.soundChannels && this.soundChannels[i] && this.soundChannels[i].sound) {
                try {
                    this.soundChannels[i].sound.pause();
                } catch (e) {
                    // Ignore errors
                }
            }
        }
    }

    // Resume all paused sounds and music.
    resumeAudio() {
        if (this.currentSong) {
            try {
                this.currentSong.resume();
            } catch (e) {
                // Ignore errors
            }
        }

        for (let i = 0; i < 3; i++) {
            if (this.soundChannels && this.soundChannels[i] && this.soundChannels[i].sound) {
                try {
                    this.soundChannels[i].sound.resume();
                } catch (e) {
                    // Ignore errors
                }
            }
        }
    }

    // Get target scenes for print/score operations (handles "both" option)
    // Returns array of scene objects to draw to
    getPrintTargetScenes() {
        if (this.printScene === 2) {
            // Both scenes
            return [this.scenes[0], this.scenes[1]].filter(s => s && s.pixelBuffer);
        } else {
            const scene = this.scenes[this.printScene];
            return (scene && scene.pixelBuffer) ? [scene] : [];
        }
    }

    loadProgram(astData, fileData, config = null) {
        if (config) this.setConfig(config);
        // Re-install RNG so a seeded re-run reproduces the same stream
        // even when no fresh config is passed. Unseeded games are
        // unaffected — Math.random has no resettable state.
        this._installRng();
        this.reset();
        this.ast = astData.program;
        this.labelMap = astData.labelMap;
        this.mediaStore = astData.mediaStore;
        this.dataTables = astData.dataTables || {}; // Maps label -> array of values
        this.fileData = fileData;

        // Initialize execution at the start of the program
        this.currentList = this.ast;
        this.pc = 0;

        // Store metadata for decoding - used for memory dashboard
        // These values come from the PRG file header (bytes 514-517)
        this.PROGRAM_START = 523;
        this.OFFSET = 0x3D90;
        if (fileData && fileData.length > 520) {
            this.PROGRAM_END = 514 + decode16bit(fileData[514], (fileData[515] - 6));
            this.DATA_END = this.OFFSET - decode16bit(fileData[516], fileData[517]);
        } else {
            // For newly created programs (no file data), use defaults.
            // This allows running programs created in the editor without saving first.
            this.PROGRAM_END = this.PROGRAM_START;
            this.DATA_END = 0;
        }

        // Sprites are now created on-demand in sprite assignment (opcode 0x27)
        // Each slot gets its own gmSprite instance from mediaStore[idx].spriteFileData
        // This allows each slot to have independent colors
    }

    // === RUN LOOP ===
    // Embedders call start() to begin executing; the loop owns its own
    // setTimeout chain so editor and standalone share one definition of
    // game speed. Game speed = opsPerFrame * (1000 / frameMs) ops/sec;
    // both knobs matter — changing only one halves or doubles speed.
    //
    // The loop also early-exits when the elapsed wall clock for a frame
    // exceeds frameMs, so a slow vm.step() can't starve render.
    //
    // onFrame({ opsExecuted }) is optional — the editor uses it to drive
    // its FPS / ops-per-frame sidebar dashboard.
    start({ opsPerFrame = 50, frameMs = 16, onFrame = null } = {}) {
        this._loopOpsPerFrame = opsPerFrame;
        this._loopFrameMs = frameMs;
        this._loopOnFrame = onFrame;
        this._loopAnimToggle = false;
        if (this._loopHandle) clearTimeout(this._loopHandle);
        this._loopHandle = null;
        this.running = true;
        this.paused = false;
        this._loopTick();
    }

    // Live-tune loop knobs without restarting (sidebar uses this for
    // ops/frame and could use it for frameMs if we ever add an FPS slider).
    setLoopParams({ opsPerFrame, frameMs } = {}) {
        if (opsPerFrame !== undefined) this._loopOpsPerFrame = opsPerFrame;
        if (frameMs !== undefined) this._loopFrameMs = frameMs;
    }

    _loopTick() {
        this._loopHandle = null;
        if (!this.running || this.paused) return;
        const frameStart = Date.now();
        let opsExecuted = 0;
        while (this.running && !this.paused && opsExecuted < this._loopOpsPerFrame) {
            this.step();
            opsExecuted++;
            if (Date.now() - frameStart >= this._loopFrameMs) break;
        }
        this._loopAnimToggle = !this._loopAnimToggle;
        this.render(this._loopAnimToggle);
        if (this._loopOnFrame) this._loopOnFrame({ opsExecuted });
        if (this.running && !this.paused) {
            this._loopHandle = setTimeout(() => this._loopTick(), this._loopFrameMs);
        }
    }

    stop() {
        this.running = false;
        this.paused = false;
        if (this._loopHandle) {
            clearTimeout(this._loopHandle);
            this._loopHandle = null;
        }
        this.stopAllAudio();
    }

    pause() {
        if (this.paused) return;
        this.paused = true;
        this.pauseAudio();
        if (this._loopHandle) {
            clearTimeout(this._loopHandle);
            this._loopHandle = null;
        }
    }

    resume() {
        if (!this.paused) return;
        this.paused = false;
        this.resumeAudio();
        // Only restart the loop if start() owns it. If we were paused via
        // a vm.pause() called by an embedder that uses its own loop, that
        // embedder must restart its loop itself.
        if (this.running && this._loopFrameMs !== undefined && !this._loopHandle) {
            this._loopTick();
        }
    }

    evaluateCondition(condInstr) {
        const opcode = condInstr.opcode;
        const arg1 = condInstr.arg1;
        const arg2 = condInstr.arg2;

        switch(opcode) {
            case 0x13: // if [var] = 000 then
                return this.getVar(arg1) === arg2;

            case 0x14: // if [var] = [var] then
                return this.getVar(arg1) === this.getVar(arg2);

            case 0x15: // if [var] > 000 then
                return this.getVar(arg1) > arg2;

            case 0x16: // if [var] > [var] then
                return this.getVar(arg1) > this.getVar(arg2);

            case 0x17: // if [var] < 000 then
                return this.getVar(arg1) < arg2;

            case 0x18: // if [var] < [var] then
                return this.getVar(arg1) < this.getVar(arg2);

            case 0x19: // if joystick X is direction then
                // arg1 = joystick (1 or 2), arg2 = direction (0=up, 1=down, 2=left, 3=right, 4=none)
                const joyNum = arg1 + 1;  // arg1 is 0-based, joystick is 1-based
                const joystick = joyNum === 1 ? inputState.joystick1 : inputState.joystick2;
                const dirs = ['up', 'down', 'left', 'right', 'none'];
                let joyResult;
                switch(arg2) {
                    case 0: joyResult = joystick.up; break;
                    case 1: joyResult = joystick.down; break;
                    case 2: joyResult = joystick.left; break;
                    case 3: joyResult = joystick.right; break;
                    case 4: joyResult = !joystick.up && !joystick.down && !joystick.left && !joystick.right; break;
                    default: joyResult = false;
                }
                return joyResult;

            case 0x1A: // if button X is on/off then
                // arg1 = button number (0-based: 0=button1, 1=button2)
                // arg2 = on/off flag (0=on, 1=off)
                const buttonState = arg1 === 0 ? inputState.button1 : inputState.button2;
                return arg2 === 0 ? buttonState : !buttonState;

            case 0x1B: // if sprite X hit target then
                // arg1 = sprite index (0-7), arg2 = target (0-7=sprite, 8=anyone, 9=clr2/3)
                if (arg2 <= 7) {
                    // Sprite vs sprite collision
                    return this.checkSpriteCollision(arg1, arg2);
                } else if (arg2 === 8) {
                    // Sprite vs "anyone" - check against all other visible sprites
                    return this.checkSpriteHitAnyone(arg1);
                } else if (arg2 === 9) {
                    // Sprite vs scene colors 2/3 - pixel-perfect collision with scene
                    return this.checkSpriteHitSceneColors(arg1);
                }
                return false;

            case 0x4A: // if score1 > XXXXXX then
                {
                    const scoreThreshold = arg2 * 1000;
                    return this.score[0] > scoreThreshold;
                }

            case 0x4B: // if score[a] > XXXXXX then
                // arg1 = variable index for score selection
                // Score mapping: odd values → score1 (index 0), even values → score2 (index 1)
                {
                    const scoreIdx = (this.getVar(arg1) % 2 === 1) ? 0 : 1;
                    const scoreThreshold = arg2 * 1000;
                    return this.score[scoreIdx] > scoreThreshold;
                }

            case 0x4C: // if score1 > score2 then
                return this.score[0] > this.score[1];

            default:
                return false;
        }
    }

    step() {
        // Check if we're in a timed pause (from opcode 0x57)
        // Uses wallclock time for simplicity. Alternative: count frames for C64-accurate timing.
        if (this.pauseUntil > 0 && Date.now() < this.pauseUntil) {
            return this.running; // Still paused, skip execution but keep running
        }
        this.pauseUntil = 0; // Clear pause once expired

        // Check if we have a current list
        if (!this.currentList) {
            this.running = false;
            this.stopAllAudio();
            return false;
        }

        // Check if we've reached the end of this list
        while (this.pc >= this.currentList.length) {
            // Move to parent list and continue after the IfNode
            if (this.currentList.parent) {
                const parentIndex = this.currentList.parentIndex;
                this.currentList = this.currentList.parent;
                this.pc = parentIndex + 1;
            } else {
                // No parent = top level ended = program done
                this.running = false;
                this.stopAllAudio();
                return false;
            }
        }

        // Get current instruction or IfNode
        const item = this.currentList[this.pc];

        // Check if it's an IfNode
        if (item.type === 'if') {
            // Evaluate the condition
            const conditionResult = this.evaluateCondition(item.condition);

            // Enter the appropriate sublist, or skip if empty
            if (conditionResult && item.thenList.length > 0) {
                this.currentList = item.thenList;
                this.pc = 0;
            } else if (!conditionResult && item.elseList.length > 0) {
                this.currentList = item.elseList;
                this.pc = 0;
            } else {
                // Empty list or no else - just skip past the IfNode
                this.pc++;
            }
        } else {
            // Regular instruction - execute it (skip comments, opcode 0x2B)
            if (item.opcode !== 0x2B) {
                this.executeInstruction(item);
            }

            // Advance PC (unless it was a jump that changed currentList/pc)
            // We check if we're still on the same item to detect if a jump occurred
            if (this.currentList && this.currentList[this.pc] === item) {
                this.pc++;
            }
        }

        return this.running;
    }

    executeInstruction(instr) {
        const opcode = instr.opcode;
        const arg1 = instr.arg1;
        const arg2 = instr.arg2;

        switch(opcode) {
            case 0x00: // blank line (stops execution)
                this.running = false;
                this.stopAllAudio();
                break;

            case 0x01: // jump to label
                // Label number is in arg2
                if (this.labelMap[arg2] !== undefined) {
                    const target = this.labelMap[arg2];
                    // Jump directly - the list knows its own parent chain
                    this.currentList = target.list;
                    this.pc = target.index;
                }
                break;

            case 0x02: // jump to label l[var] - computed jump
                // Label number comes from the variable specified in arg2
                {
                    const labelNum = this.getVar(arg2);
                    if (this.labelMap[labelNum] !== undefined) {
                        const target = this.labelMap[labelNum];
                        this.currentList = target.list;
                        this.pc = target.index;
                    } else {
                    }
                }
                break;

            case 0x03: // jump to subroutine at label
                // Label number is in arg2
                // Save current position for return, then jump to subroutine
                if (this.labelMap[arg2] !== undefined) {
                    const target = this.labelMap[arg2];

                    // Save current position (pc+1 so we return AFTER the gosub)
                    this.returnStack = this.returnStack || [];
                    this.returnStack.push({
                        list: this.currentList,
                        pc: this.pc + 1
                    });

                    // Jump to the subroutine
                    this.currentList = target.list;
                    this.pc = target.index;
                } else {
                }
                break;

            case 0x04: // jump to subroutine at l[var] - computed gosub
                // Label number comes from the variable specified in arg2
                {
                    const labelNum = this.getVar(arg2);
                    if (this.labelMap[labelNum] !== undefined) {
                        const target = this.labelMap[labelNum];

                        // Save current position (pc+1 so we return AFTER the gosub)
                        this.returnStack = this.returnStack || [];
                        this.returnStack.push({
                            list: this.currentList,
                            pc: this.pc + 1
                        });

                        // Jump to the subroutine
                        this.currentList = target.list;
                        this.pc = target.index;
                    } else {
                    }
                }
                break;

            case 0x05: // return from subroutine
                // Restore position from before the GOSUB
                this.returnStack = this.returnStack || [];
                if (this.returnStack.length > 0) {
                    const returnState = this.returnStack.pop();
                    this.currentList = returnState.list;
                    this.pc = returnState.pc;
                } else {
                    this.running = false;
                    this.stopAllAudio();
                }
                break;

            case 0x06: // stop program
                this.running = false;
                this.stopAllAudio();
                break;

            case 0x07: // set [var] = 000
                // arg1 = variable index (1='a', 2='b', etc.), arg2 = value
                this.setVar(arg1, arg2);
                break;

            case 0x08: // set [var] = [var]
                // arg1 = dest variable, arg2 = source variable
                this.setVar(arg1, this.getVar(arg2));
                break;

            case 0x09: // set [var] = rnd number 0 to XXX
                // arg1 = variable index, arg2 = max value (inclusive)
                // Uses this._rng (Math.random by default, mulberry32 when
                // config.rngSeed is set — see _installRng).
                this.setVar(arg1, Math.floor(this._rng() * (arg2 + 1)));
                break;

            case 0x0B: // set [var] = [var] + 000
                // arg1 = variable index, arg2 = value to add
                this.setVar(arg1, (this.getVar(arg1) + arg2) & 0xFF);
                break;

            case 0x0C: // set [var] = [var] + [var]
                // arg1 = dest variable, arg2 = source variable to add
                this.setVar(arg1, (this.getVar(arg1) + this.getVar(arg2)) & 0xFF);
                break;

            case 0x0D: // set [var] = [var] - 000
                // arg1 = variable index, arg2 = value to subtract
                this.setVar(arg1, (this.getVar(arg1) - arg2) & 0xFF);
                break;

            case 0x0E: // set [var] = [var] - [var]
                // arg1 = dest variable, arg2 = source variable to subtract
                this.setVar(arg1, (this.getVar(arg1) - this.getVar(arg2)) & 0xFF);
                break;

            case 0x0F: // set [var] = [var] x 000
                // arg1 = variable index, arg2 = multiplier
                this.setVar(arg1, (this.getVar(arg1) * arg2) & 0xFF);
                break;

            case 0x10: // set [var] = [var] x [var]
                // arg1 = dest variable, arg2 = source variable to multiply
                this.setVar(arg1, (this.getVar(arg1) * this.getVar(arg2)) & 0xFF);
                break;

            case 0x11: // set [var] = [var] / 000
                // arg1 = variable index, arg2 = divisor
                if (arg2 !== 0) {
                    this.setVar(arg1, Math.floor(this.getVar(arg1) / arg2) & 0xFF);
                }
                break;

            case 0x12: // set [var] = [var] / [var]
                // arg1 = dest variable, arg2 = divisor variable
                const divisor = this.getVar(arg2);
                if (divisor !== 0) {
                    this.setVar(arg1, Math.floor(this.getVar(arg1) / divisor) & 0xFF);
                }
                break;

            // === SOUND OPCODES ===
            // 3 independent sound channels (matching SID's 3 voices)
            // Uses gmSound class for playback via Web Audio API

            case 0x40: // sound channel X = [name]
                // arg1 = channel (0-2), arg2 = data page index
                {
                    const channel = arg1;
                    const dataIndex = arg2;
                    const dataEntry = this.mediaStore[dataIndex];

                    if (channel >= 0 && channel < 3 && dataEntry && dataEntry.soundFileData) {
                        const channelState = this.soundChannels[channel];

                        // Skip if same sound is already playing on this channel
                        if (channelState.dataIndex === dataIndex &&
                            channelState.sound && channelState.sound.isPlaying()) {
                            break;
                        }

                        // Stop any currently playing sound on this channel
                        if (channelState.sound) {
                            channelState.sound.stop();
                        }

                        // Create new gmSound instance and play it
                        const sound = new gmSound(dataEntry.soundFileData);
                        channelState.sound = sound;
                        channelState.name = dataEntry.name;
                        channelState.dataIndex = dataIndex;

                        // Play using global audioContext/masterGain
                        if (!this.config.audioMuted) {
                            if (typeof audioContext !== 'undefined' && audioContext) {
                                sound.play(audioContext, masterGain);
                            }
                        }
                    } else {
                    }
                }
                break;

            case 0x41: // sound channel X off
                // arg2 = channel (0-2)
                {
                    const channel = arg2;
                    if (channel >= 0 && channel < 3 && this.soundChannels[channel].sound) {
                        this.soundChannels[channel].sound.stop();
                        this.soundChannels[channel].sound = null;
                        this.soundChannels[channel].name = null;
                        this.soundChannels[channel].dataIndex = -1;
                    }
                }
                break;

            case 0x60: // song is [name]
                // arg2 = data page index for song
                {
                    const dataIndex = arg2;
                    const dataEntry = this.mediaStore[dataIndex];

                    // If same song is already playing, noop (let it continue)
                    // If same song but finished, restart it
                    if (dataIndex === this.currentSongIndex && this.currentSong) {
                        if (this.currentSong.isPlaying) {
                            // Same song still playing - noop
                            break;
                        }
                        // Same song but finished - will restart below
                    }

                    // Stop any currently playing song
                    if (this.currentSong) {
                        this.currentSong.stop();
                        this.currentSong = null;
                        this.currentSongIndex = -1;
                    }

                    if (dataEntry && dataEntry.songFileData) {
                        const music = new gmMusic(dataEntry.songFileData);
                        this.currentSong = music;
                        this.currentSongIndex = dataIndex;

                        // Always start the song; gate audibility via volume.
                        // A song that begins under mute keeps advancing
                        // silently — unmute later becomes instantly audible
                        // from the right position, no restart required.
                        music.play();
                        music.setVolume(this.config.audioMuted ? 0 : this.songVolume);
                    } else {
                    }
                }
                break;

            case 0x61: // song volume = XX
                // arg2 = volume (0-15)
                this.songVolume = arg2;
                if (this.currentSong) {
                    this.currentSong.setVolume(arg2);
                }
                break;

            // === DATA TABLE OPCODES ===
            // Data tables are read-only arrays defined in the program with "data values" instructions.
            // The parser extracts these into dataTables[label] = [value, value, ...].

            case 0x1C: // data table at lXXX
                // arg2 = label number; sets which data table to read from
                this.dataTableBase = arg2;
                break;

            case 0x1D: // data values - XXX YYY
                // No-op at runtime - data was extracted during parsing
                // These instructions just store data, they don't execute
                break;

            case 0x0A: // set [var] = value at data+[var]
                // arg1 = dest variable, arg2 = index variable
                // Reads from dataTables[dataTableBase][index]
                {
                    const index = this.getVar(arg2);
                    const table = this.dataTables[this.dataTableBase];
                    if (table && index < table.length) {
                        const value = table[index];
                        this.setVar(arg1, value);
                    } else {
                        this.setVar(arg1, 0);
                    }
                }
                break;

            // === RAM ACCESS OPCODES ===
            // GameMaker provides 256 bytes of RAM for array-like storage.
            // Address is computed from a variable value (0-255).

            case 0x5D: // set [var] = value at ram+[var]
                // arg1 = dest variable, arg2 = address variable
                {
                    const addr = this.getVar(arg2) & 0xFF;
                    const value = this.ram[addr];
                    this.setVar(arg1, value);
                }
                break;

            case 0x5E: // set value at ram+[var] = [var]
                // arg1 = address variable, arg2 = value variable
                {
                    const addr = this.getVar(arg1) & 0xFF;
                    const value = this.getVar(arg2) & 0xFF;
                    this.ram[addr] = value;
                }
                break;

            case 0x5F: // set value at ram+[var] = literal
                // arg1 = address variable, arg2 = literal value
                {
                    const addr = this.getVar(arg1) & 0xFF;
                    const value = arg2 & 0xFF;
                    this.ram[addr] = value;
                }
                break;

            // === SKIP NEXT INSTRUCTIONS ===
            // These compare a variable to a literal and skip the next instruction if true.
            // "Skip" means pc += 2 instead of pc += 1 (skip over the next instruction).

            case 0x62: // skip next if [var] = literal
                {
                    const varVal = this.getVar(arg1);
                    if (varVal === arg2) {
                        this.pc += 2; // Skip over THIS instruction AND the next one
                    }
                }
                break;

            case 0x63: // skip next if [var] > literal
                {
                    const varVal = this.getVar(arg1);
                    if (varVal > arg2) {
                        this.pc += 2; // Skip over THIS instruction AND the next one
                    }
                }
                break;

            case 0x64: // skip next if [var] < literal
                {
                    const varVal = this.getVar(arg1);
                    if (varVal < arg2) {
                        this.pc += 2; // Skip over THIS instruction AND the next one
                    }
                }
                break;

            // Conditional instructions (0x13-0x1B, 0x4A-0x4C) are handled in evaluateCondition()
            // They don't execute as regular instructions - they're part of IfNodes

            case 0x1F: // sprite X x position = 000
                this.sprites[arg1].x = arg2;
                break;

            case 0x20: // sprite X x position = [a]
                this.sprites[arg1].x = this.getVar(arg2);
                break;

            case 0x21: // sprite X y position = 000
                this.sprites[arg1].y = arg2;
                break;

            case 0x22: // sprite X y position = [a]
                this.sprites[arg1].y = this.getVar(arg2);
                break;

            case 0x23: // sprite X dir = 000
                this.sprites[arg1].direction = arg2;
                break;

            case 0x24: // sprite X dir = [a]
                this.sprites[arg1].direction = this.getVar(arg2);
                break;

            case 0x25: // sprite X movement speed = 000
                this.sprites[arg1].speed = arg2;
                break;

            case 0x26: // sprite X movement speed = [a]
                this.sprites[arg1].speed = this.getVar(arg2);
                break;

            case 0x27: // sprite X is [name]
                // Creates a NEW gmSprite instance for this slot from mediaStore.
                // Each slot gets its own instance so colors can vary independently.
                // (See file header comment for why this is necessary)
                {
                    const spriteIndex = arg1;
                    const dataIndex = arg2;
                    const slot = this.sprites[spriteIndex];

                    // === SUBSPRITE SLOT HANDLING ===
                    //
                    // GameMaker multi-part sprites work as follows:
                    // - A sprite like "USA" can contain multiple quads (sub-sprites) in a single file
                    // - When "sprite 1 is USA" runs, slot 1 gets the sprite and slot 2 is marked as
                    //   a subsprite slot (isSubsprite=true)
                    // - GameMaker auto-inserts "sprite 2 is -USA" to explicitly assign the subsprite
                    // - The subsprite "-USA" exists BOTH as quad 1 inside "USA" AND as a separate
                    //   sprite object in the data page (with identical pixel data)
                    // - The parent sprite renders all quads, handling position/animation/movement
                    //   for subsprites automatically
                    //
                    // The challenge: when we see "sprite 2 is X", we need to distinguish:
                    //   1. X is the expected subsprite (e.g., -USA) → no-op, parent keeps rendering it
                    //   2. X is a different sprite (e.g., BLANK) → override, parent stops rendering
                    //      that quad, X appears independently at the subsprite's position
                    //
                    // We detect this by comparing actual sprite DATA, not names. The subsprite
                    // embedded in the parent and the standalone subsprite file have identical
                    // frame data if they're truly the same sprite.
                    //
                    // === RESTORATION CHECK ===
                    // If this slot was originally a subsprite but was overridden or cleared,
                    // and we're assigning a marker (no sprite data), restore it to normal subsprite behavior.
                    // This handles both: override -> restore, AND override -> clear -> restore
                    //
                    // We detect restoration by:
                    // 1. Slot was originally a subsprite (originalParentSlotIdx >= 0)
                    // 2. Slot is not currently a subsprite (was overridden or cleared)
                    // 3. Entry has no sprite data (it's a marker, not a real sprite)
                    // 4. Parent still exists and has this quad skipped
                    //
                    if (slot.originalParentSlotIdx >= 0 && !slot.isSubsprite) {
                        const dataEntry = this.mediaStore[dataIndex];
                        const parentIdx = slot.originalParentSlotIdx;
                        const quadIdx = slot.originalQuadIndex;
                        const parentSlot = this.sprites[parentIdx];

                        // Treat as a marker if it has no sprite data OR it's a real
                        // marker entry (quadIndex > 0). isMarkerEntry covers the latter.
                        const noData = !dataEntry || !dataEntry.spriteFileData;
                        const isMarker = noData || isMarkerEntry(dataEntry);
                        const parentHasQuadSkipped = parentSlot && parentSlot.spriteInstance &&
                            parentSlot.skipQuads && parentSlot.skipQuads.has(quadIdx);

                        if (isMarker && parentHasQuadSkipped) {
                            // Check if marker's quadIndex matches the slot's original quadIndex
                            // In GM, assigning the "wrong" marker (e.g., quad 2 marker to a quad 1 slot)
                            // results in a blank slot, not restoration
                            const markerQuadIndex = dataEntry ? (dataEntry.quadIndex || 0) : 0;
                            if (markerQuadIndex !== quadIdx) {
                                slot.spriteInstance = null;
                                slot.spriteName = null;
                                slot.visible = false;
                                break;
                            }


                            // Clear the overriding sprite
                            slot.spriteInstance = null;
                            slot.spriteName = null;

                            // Restore subsprite status
                            slot.isSubsprite = true;
                            slot.parentSlotIdx = parentIdx;
                            slot.quadIndex = quadIdx;
                            slot.visible = false; // Subsprite visibility is inherited from parent

                            // Remove this quad from parent's skipQuads
                            if (parentSlot.skipQuads) {
                                parentSlot.skipQuads.delete(quadIdx);
                                // Clear skipQuads if empty
                                if (parentSlot.skipQuads.size === 0) {
                                    parentSlot.skipQuads = null;
                                }
                            }

                            break;
                        }
                    }

                    if (slot.isSubsprite) {
                        const parentIdx = slot.parentSlotIdx;
                        const quadIdx = slot.quadIndex;
                        const parentSlot = this.sprites[parentIdx];
                        const parentSprite = parentSlot.spriteInstance;

                        const dataEntry = this.mediaStore[dataIndex];

                        // If this is a marker entry (subsprite parsed from PRG), check if it's
                        // the correct marker for this slot's quad.
                        if (isMarkerEntry(dataEntry)) {
                            const markerQuadIndex = dataEntry.quadIndex;
                            if (markerQuadIndex === quadIdx) {
                                // Correct marker - parent continues rendering this quad
                                break;
                            } else {
                                // Wrong marker - blank this quad
                                if (!parentSlot.skipQuads) {
                                    parentSlot.skipQuads = new Set();
                                }
                                parentSlot.skipQuads.add(quadIdx);
                                slot.visible = false;
                                break;
                            }
                        }

                        if (parentSprite && dataEntry && dataEntry.sprite) {
                            const spriteName = dataEntry.name;
                            const assignedSprite = dataEntry.sprite; // Use mediaStore sprite for comparison
                            const assignedQuadIndex = dataEntry.quadIndex || 0;

                            // Check if this is a subsprite entry (quadIndex > 0)
                            // Both PRG-loaded and disk-loaded subsprites use quadIndex to indicate
                            // which quad of the parent sprite this entry represents.
                            // If it matches the slot's quadIndex, the parent continues rendering.
                            if (assignedQuadIndex > 0 && assignedQuadIndex === quadIdx) {
                                break;
                            }

                            // Compare actual sprite data to determine if this is the expected subsprite
                            // We compare the first frame's image data between:
                            //   - parentSprite.sprite[quadIdx] (the subsprite embedded in parent)
                            //   - assignedSprite.sprite[assignedQuadIndex] (the corresponding quad in assigned sprite)
                            const parentSubspriteData = parentSprite.sprite[quadIdx]?.imageData?.[0];
                            const assignedSpriteData = assignedSprite?.sprite?.[assignedQuadIndex]?.imageData?.[0];

                            let isSameSprite = false;
                            if (parentSubspriteData && assignedSpriteData &&
                                parentSubspriteData.length === assignedSpriteData.length) {
                                // Compare byte-by-byte
                                isSameSprite = true;
                                for (let i = 0; i < parentSubspriteData.length; i++) {
                                    if (parentSubspriteData[i] !== assignedSpriteData[i]) {
                                        isSameSprite = false;
                                        break;
                                    }
                                }
                            }

                            if (isSameSprite) {
                                // This is the expected subsprite - parent continues rendering it
                                break;
                            }

                            // Different sprite - this is an override

                            // Calculate where this subsprite would have rendered
                            // Parent position in 320x200 space
                            const parentX320 = (parentSlot.x - 12) * 2;
                            const parentY200 = parentSlot.y - 50;
                            // Get quad position (includes subsprite offset)
                            const quadPos = parentSprite.getQuadPosition(quadIdx, parentX320, parentY200);
                            // Convert back to GM coordinates
                            const newGmX = quadPos.x / 2 + 12;
                            const newGmY = quadPos.y + 50;


                            // Tell parent to stop rendering this quad
                            if (!parentSlot.skipQuads) {
                                parentSlot.skipQuads = new Set();
                            }
                            parentSlot.skipQuads.add(quadIdx);

                            // Set up this slot as an independent sprite with new instance
                            slot.spriteInstance = new gmSprite(dataEntry.spriteFileData);
                            slot.spriteName = spriteName;
                            slot.x = newGmX;
                            slot.y = newGmY;
                            slot.visible = true;
                            slot.isSubsprite = false;
                            slot.parentSlotIdx = -1;
                            slot.quadIndex = 0;
                            slot.animFrame = 0;
                            slot.skipCounter = undefined;
                            // Inherit animation speed from parent, but movement defaults to 0
                            slot.animSpeed = parentSlot.animSpeed;
                            slot.direction = 0;
                            slot.speed = 0;
                        }
                        break;
                    }

                    const dataEntry = this.mediaStore[dataIndex];

                    // If this is a marker entry (subsprite from PRG), it has no sprite data.
                    // This shouldn't happen for non-subsprite slots, but handle gracefully.
                    if (isMarkerEntry(dataEntry)) {
                        break;
                    }

                    if (dataEntry && dataEntry.spriteFileData) {
                        const spriteName = dataEntry.name;

                        // Before assigning, clear any subsprite flags that THIS slot previously set
                        // (in case we're replacing a multi-part sprite with a different one)
                        const oldSpriteInstance = slot.spriteInstance;
                        if (oldSpriteInstance && oldSpriteInstance.sprite[0].numSprites > 1) {
                            const oldNumSubsprites = oldSpriteInstance.sprite[0].numSprites - 1;
                            for (let sub = 1; sub <= oldNumSubsprites; sub++) {
                                if (spriteIndex + sub < 8) {
                                    this.sprites[spriteIndex + sub].isSubsprite = false;
                                    this.sprites[spriteIndex + sub].parentSlotIdx = -1;
                                    this.sprites[spriteIndex + sub].quadIndex = 0;
                                    this.sprites[spriteIndex + sub].originalParentSlotIdx = -1;
                                    this.sprites[spriteIndex + sub].originalQuadIndex = 0;
                                }
                            }
                        }

                        // Only reset frame state if actually changing to a different sprite
                        const isNewSprite = slot.spriteName !== spriteName;

                        // Create a NEW gmSprite instance for this slot (each slot gets its own copy)
                        // This allows each slot to have independent colors
                        slot.spriteInstance = new gmSprite(dataEntry.spriteFileData);
                        slot.spriteName = spriteName;
                        slot.visible = true;
                        slot.isSubsprite = false;
                        if (isNewSprite) {
                            // Reset frame state when swapping to different sprite
                            // animSpeed and animateOnce persist across sprite swaps
                            // If animateOnce is set, the new sprite should play its animation once
                            slot.animFrame = 0;
                            slot.skipCounter = undefined;
                        }

                        // Check if this is a multi-part sprite and mark subsequent slots as subsprites
                        const gmSpriteObj = slot.spriteInstance;
                        if (gmSpriteObj.sprite[0].numSprites > 1) {
                            const numSubsprites = gmSpriteObj.sprite[0].numSprites - 1;

                            // Check for existing overrides BEFORE marking subsprite slots
                            // If a subsprite slot already has an independent sprite (override like "blank"),
                            // preserve it in skipQuads so the parent doesn't render that quad
                            slot.skipQuads = null;
                            for (let sub = 1; sub <= numSubsprites; sub++) {
                                if (spriteIndex + sub < 8) {
                                    const subSlot = this.sprites[spriteIndex + sub];
                                    // If slot has an independent sprite (isSubsprite=false with its own spriteInstance),
                                    // this is an override that should be preserved
                                    if (!subSlot.isSubsprite && subSlot.spriteInstance) {
                                        if (!slot.skipQuads) {
                                            slot.skipQuads = new Set();
                                        }
                                        slot.skipQuads.add(sub);
                                    }
                                }
                            }

                            // Now mark subsprite slots, but preserve any existing overrides
                            for (let sub = 1; sub <= numSubsprites; sub++) {
                                if (spriteIndex + sub < 8) {
                                    const subSlot = this.sprites[spriteIndex + sub];

                                    // If this slot has a preserved override, don't clear it
                                    if (slot.skipQuads && slot.skipQuads.has(sub)) {
                                        // Just update the parent reference info
                                        subSlot.originalParentSlotIdx = spriteIndex;
                                        subSlot.originalQuadIndex = sub;
                                    } else {
                                        // No override - set up as normal subsprite
                                        subSlot.isSubsprite = true;
                                        subSlot.parentSlotIdx = spriteIndex;
                                        subSlot.quadIndex = sub;
                                        subSlot.originalParentSlotIdx = spriteIndex;
                                        subSlot.originalQuadIndex = sub;
                                        subSlot.spriteName = null;
                                        subSlot.spriteInstance = null;
                                        subSlot.visible = false;
                                    }
                                }
                            }
                        } else {
                            // Single-part sprite - reset skipQuads
                            slot.skipQuads = null;
                        }
                    } else {
                    }
                }
                break;

            case 0x67: // clear sprite X
                // Single-arg opcode uses arg2
                {
                    const spriteIndex = arg2;
                    const slot = this.sprites[spriteIndex];

                    // Clear any subsprite reservations this sprite had
                    const oldSpriteInstance = slot.spriteInstance;
                    if (oldSpriteInstance && oldSpriteInstance.sprite[0].numSprites > 1) {
                        const oldNumSubsprites = oldSpriteInstance.sprite[0].numSprites - 1;
                        for (let sub = 1; sub <= oldNumSubsprites; sub++) {
                            if (spriteIndex + sub < 8) {
                                const subSlot = this.sprites[spriteIndex + sub];
                                subSlot.isSubsprite = false;
                                subSlot.parentSlotIdx = -1;
                                subSlot.quadIndex = 0;
                                subSlot.originalParentSlotIdx = -1;
                                subSlot.originalQuadIndex = 0;
                            }
                        }
                    }

                    // Clear the slot
                    // NOTE: Preserve originalParentSlotIdx/originalQuadIndex if this slot
                    // was originally a subsprite - allows restoration after clear
                    slot.spriteName = null;
                    slot.spriteInstance = null;
                    slot.visible = false;
                    slot.isSubsprite = false;
                    slot.parentSlotIdx = -1;
                    slot.quadIndex = 0;
                    slot.skipQuads = null;
                    // Only clear original parent info if this wasn't a subsprite slot
                    if (slot.originalParentSlotIdx < 0) {
                        slot.originalParentSlotIdx = -1;
                        slot.originalQuadIndex = 0;
                    }
                    slot.x = 0;
                    slot.y = 0;
                    slot.direction = 0;
                    slot.speed = 0;
                    slot.animSpeed = 0;
                    slot.animFrame = 0;
                    slot.skipCounter = undefined;
                    slot.animateOnce = false;
                    slot.animateOnceDone = false;
                }
                break;

            case 0x29: // sprite X animation speed = 000
                // Set animation speed on the sprite slot (persists across sprite swaps)
                this.sprites[arg1].animSpeed = arg2;
                break;

            case 0x2A: // sprite X animation speed = [a]
                // Set animation speed on the sprite slot (persists across sprite swaps)
                this.sprites[arg1].animSpeed = this.getVar(arg2);
                break;

            case 0x65: // sprite X animates always/once
                // arg1 = sprite slot, arg2 = 0 for always, 1 for once
                {
                    const slot = this.sprites[arg1];
                    const wasOnce = slot.animateOnce;
                    slot.animateOnce = (arg2 === 1);

                    if (slot.animateOnce) {
                        // Only restart animation when:
                        // 1. Switching from "always" to "once" mode, OR
                        // 2. Already in "once" mode AND last frame has been rendered
                        //    (animateOnceDone flag is set by render when animation completes)
                        if (!wasOnce || slot.animateOnceDone) {
                            slot.animFrame = 0;
                            slot.skipCounter = undefined;
                            slot.animateOnceDone = false;
                        }
                    }
                }
                break;

            case 0x2C: // set [var] = sprite X x position
                // arg1 = variable index, arg2 = sprite slot
                this.setVar(arg1, Math.floor(this.sprites[arg2].x));
                break;

            case 0x2D: // set [var] = sprite X y position
                // arg1 = variable index, arg2 = sprite slot
                this.setVar(arg1, Math.floor(this.sprites[arg2].y));
                break;

            case 0x28: // scene X is [name]
                // arg1 = scene slot (0 or 1), arg2 = data page index
                const sceneSlot = arg1;
                const sceneEntry = this.mediaStore[arg2];

                if (sceneEntry && sceneEntry.type === 'scene' && sceneEntry.scene) {
                    this.scenes[sceneSlot] = sceneEntry.scene;
                } else {
                }
                break;

            case 0x2E: // display scene X
                this.activeScene = arg2; // arg2 is 0-based scene index (0=scene1, 1=scene2)
                break;

            // === SPRITE COLOR MODIFICATION ===
            // These opcodes change palette colors on sprite slot instances.
            // Color 1 is per-slot (each sprite can have different color 1).
            // Colors 2/3 are shared (must update ALL slot instances).
            //
            // Because each slot has its own gmSprite instance, setting color 1
            // on one slot doesn't affect another, even if both use the same
            // sprite. This is critical for programs that use the same sprite
            // image in multiple slots with different per-slot colors.

            case 0x2F: // sprite X color 1 = colorName (immediate color)
                // arg1 = sprite slot (0-7), arg2 = C64 color index (0-15)
                // Only affects this slot's instance - other slots are independent
                {
                    const spriteSlot = this.sprites[arg1];
                    if (spriteSlot && spriteSlot.spriteInstance) {
                        spriteSlot.spriteInstance.setColor(1, arg2);  // GM "Color 1"
                    }
                }
                break;

            case 0x30: // sprite X color 1 = [var] (variable color)
                // arg1 = sprite slot (0-7), arg2 = variable index for color
                {
                    const spriteSlot = this.sprites[arg1];
                    const colorValue = this.getVar(arg2) & 0x0F;
                    if (spriteSlot && spriteSlot.spriteInstance) {
                        spriteSlot.spriteInstance.setColor(1, colorValue);  // GM "Color 1"
                    }
                }
                break;

            case 0x31: // sprite shared colrX = colorName (immediate)
                // arg1 = bytecode color (1=GM "Color 2", 2=GM "Color 3")
                // arg2 = C64 color index (0-15)
                // Shared colors affect ALL sprites - must iterate all 8 slots
                {
                    const colorSlot = arg1 + 1;  // bytecode 1→slot 2, bytecode 2→slot 3
                    for (let i = 0; i < 8; i++) {
                        if (this.sprites[i].spriteInstance) {
                            this.sprites[i].spriteInstance.setSharedColor(colorSlot, arg2);
                        }
                    }
                }
                break;

            case 0x32: // sprite shared colrX = [var] (variable)
                // arg1 = bytecode color (1=GM "Color 2", 2=GM "Color 3")
                // arg2 = variable index for color
                {
                    const colorSlot = arg1 + 1;  // bytecode 1→slot 2, bytecode 2→slot 3
                    const colorValue = this.getVar(arg2) & 0x0F;
                    for (let i = 0; i < 8; i++) {
                        if (this.sprites[i].spriteInstance) {
                            this.sprites[i].spriteInstance.setSharedColor(colorSlot, colorValue);
                        }
                    }
                }
                break;

            // Scene color modification opcodes
            // These change the C64 palette index stored in the scene's color slots
            // arg1 = scene index, arg2 = color value (for variable versions, arg2 is var index)
            case 0x33: // scene X background = color (arg2 is C64 color index)
                if (this.scenes[arg1]) {
                    this.scenes[arg1].bgColor = arg2 & 0x0F;
                    this.scenes[arg1].markColorsDirty();
                }
                break;

            case 0x34: // scene X background = [var]
                if (this.scenes[arg1]) {
                    this.scenes[arg1].bgColor = this.getVar(arg2) & 0x0F;
                    this.scenes[arg1].markColorsDirty();
                }
                break;

            case 0x35: // scene X border = color
                if (this.scenes[arg1]) {
                    this.scenes[arg1].borderColor = arg2 & 0x0F;
                    // Border doesn't affect scene rendering, no dirty flag needed
                }
                break;

            case 0x36: // scene X border = [var]
                if (this.scenes[arg1]) {
                    this.scenes[arg1].borderColor = this.getVar(arg2) & 0x0F;
                    // Border doesn't affect scene rendering, no dirty flag needed
                }
                break;

            case 0x37: // scene 1 color X = colorName
                // arg1 = color slot (0-2 in bytecode, maps to 1-3), arg2 = C64 color index
                if (this.scenes[0]) {
                    const colorSlot = arg1 + 1;  // 0->1, 1->2, 2->3
                    const colorValue = arg2 & 0x0F;
                    if (colorSlot === 1) this.scenes[0].color1 = colorValue;
                    else if (colorSlot === 2) this.scenes[0].color2 = colorValue;
                    else if (colorSlot === 3) this.scenes[0].color3 = colorValue;
                    this.scenes[0].markColorsDirty();
                }
                break;

            case 0x38: // scene 1 color X = [var]
                // arg1 = color slot (0-2 in bytecode, maps to 1-3), arg2 = variable index for color value
                if (this.scenes[0]) {
                    const colorSlot = arg1 + 1;  // 0->1, 1->2, 2->3
                    const colorValue = this.getVar(arg2) & 0x0F;
                    if (colorSlot === 1) this.scenes[0].color1 = colorValue;
                    else if (colorSlot === 2) this.scenes[0].color2 = colorValue;
                    else if (colorSlot === 3) this.scenes[0].color3 = colorValue;
                    this.scenes[0].markColorsDirty();
                }
                break;

            case 0x51: // scene 2 color X = colorName
                // arg1 = color slot (0-2 in bytecode, maps to 1-3), arg2 = C64 color index
                if (this.scenes[1]) {
                    const colorSlot = arg1 + 1;  // 0->1, 1->2, 2->3
                    const colorValue = arg2 & 0x0F;
                    if (colorSlot === 1) this.scenes[1].color1 = colorValue;
                    else if (colorSlot === 2) this.scenes[1].color2 = colorValue;
                    else if (colorSlot === 3) this.scenes[1].color3 = colorValue;
                    this.scenes[1].markColorsDirty();
                }
                break;

            case 0x52: // scene 2 color X = [var]
                // arg1 = color slot (0-2 in bytecode, maps to 1-3), arg2 = variable index for color value
                if (this.scenes[1]) {
                    const colorSlot = arg1 + 1;  // 0->1, 1->2, 2->3
                    const colorValue = this.getVar(arg2) & 0x0F;
                    if (colorSlot === 1) this.scenes[1].color1 = colorValue;
                    else if (colorSlot === 2) this.scenes[1].color2 = colorValue;
                    else if (colorSlot === 3) this.scenes[1].color3 = colorValue;
                    this.scenes[1].markColorsDirty();
                }
                break;

            case 0x1E: // add [a] to score1
                // arg1 = variable index containing value to add
                this.score[0] = Math.min(999999, this.score[0] + this.getVar(arg1));
                this.updateScoreDisplay(0);
                break;

            case 0x42: // score1 color = XX on XX
                // arg1 = foreground color (0-15), arg2 = background color (0-15)
                this.scoreFgColor[0] = arg1;
                this.scoreBgColor[0] = arg2;
                break;

            case 0x43: // score2 color = XX on XX
                // arg1 = foreground color (0-15), arg2 = background color (0-15)
                this.scoreFgColor[1] = arg1;
                this.scoreBgColor[1] = arg2;
                break;

            case 0x44: // add 0000 to score1
                // arg1 = value to add (multiplied by 10), arg2 = score index (0 or 1)
                this.score[arg2] = Math.min(999999, this.score[arg2] + (arg1 * 10));
                this.updateScoreDisplay(arg2);
                break;

            case 0x45: // add 0000 to score[a]
                // arg1 = variable index for score selection, arg2 = value to add
                // Score mapping: odd values → score1 (index 0), even values → score2 (index 1)
                {
                    const scoreIdx = (this.getVar(arg1) % 2 === 1) ? 0 : 1;
                    this.score[scoreIdx] = Math.min(999999, this.score[scoreIdx] + (arg2 * 10));
                    this.updateScoreDisplay(scoreIdx);
                }
                break;

            case 0x46: // score1 at row XX column XX
                // arg1 = row (0-24), arg2 = column (0-19)
                // Just sets position; visibility triggered by add/clear
                this.scoreRow[0] = arg1;
                this.scoreCol[0] = arg2;
                break;

            case 0x47: // score2 at row XX column XX
                // arg1 = row (0-24), arg2 = column (0-19)
                // Just sets position; visibility triggered by add/clear
                this.scoreRow[1] = arg1;
                this.scoreCol[1] = arg2;
                break;

            case 0x48: // clear score1
                this.score[0] = 0;
                this.updateScoreDisplay(0);
                break;

            case 0x49: // clear score[a]
                // arg1 = variable index for score selection
                // Score mapping: odd values → score1 (index 0), even values → score2 (index 1)
                {
                    const scoreIdx = (this.getVar(arg1) % 2 === 1) ? 0 : 1;
                    this.score[scoreIdx] = 0;
                    this.updateScoreDisplay(scoreIdx);
                }
                break;

            case 0x58: // add [a] to score[a]
                // arg1 = variable index for value, arg2 = variable index for score selection
                // Score mapping: odd values → score1 (index 0), even values → score2 (index 1)
                {
                    const scoreIdx = (this.getVar(arg2) % 2 === 1) ? 0 : 1;
                    this.score[scoreIdx] = Math.min(999999, this.score[scoreIdx] + this.getVar(arg1));
                    this.updateScoreDisplay(scoreIdx);
                }
                break;

            case 0x59: // sprite X over/under colors 2/3
                // arg1 = sprite slot (0-7), arg2 = 0 (over, default) or 1 (under).
                // "Under" makes scene pixels of color 2 and 3 hide the sprite
                // (matches the C64's VIC sprite-priority register). The actual
                // masking happens at blit time in the render loop below.
                if (arg1 >= 0 && arg1 < this.sprites.length) {
                    this.sprites[arg1].overUnder = arg2 & 1;
                }
                break;

            // cases 0x4A-0x4C (score conditionals) are handled in evaluateCondition() as IfNodes
            // case 0x54 (otherwise) and 0x55 (endif) are handled by the parser

            // Print instructions - render text to scene using gmCharset
            // Print state: printRow, printCol, printFgColor, printBgColor, printScene

            case 0x39: // print at row 00 column 00
                // arg1 = row (0-24), arg2 = column (0-19)
                this.printRow = arg1;
                this.printCol = arg2;
                break;

            case 0x3A: // print at row [a] column [a]
                // arg1 = variable index for row, arg2 = variable index for column
                // Clamp to valid range: row 0-24 (horizontal), col 0-19 (vertical)
                // Values over the limit are treated as the limit
                this.printRow = Math.min(this.getVar(arg1), 24);
                this.printCol = Math.min(this.getVar(arg2), 19);
                break;

            case 0x3B: // print _____________________ (literal string)
                // The raw bytes are stored in instr.printBytes by the parser
                // Draws to scene's pixel buffer using palette indices (0-3)
                if (instr.printBytes && charset.loaded) {
                    const targetScenes = this.getPrintTargetScenes();
                    for (const targetScene of targetScenes) {
                        // Convert character row/col to GM pixel coordinates (8x8 per char)
                        const x = this.printCol * 8;
                        const y = this.printRow * 8;
                        // Draw using palette indices directly (0-3)
                        charset.drawBytesToScene(targetScene, instr.printBytes, x, y, this.printFgColor, this.printBgColor);
                    }
                    // Advance to next row after printing (GM behavior)
                    this.printRow++;
                } else if (!charset.loaded) {
                }
                break;

            case 0x3C: // print character of [a]
                // arg2 = variable index containing GM character index (0-63)
                // Draws to scene's pixel buffer using palette indices (0-3)
                // Auto-advances printCol after each character (GM behavior)
                if (charset.loaded) {
                    const targetScenes = this.getPrintTargetScenes();
                    const gmIndex = this.getVar(arg2) % 64; // Ensure 0-63 range
                    for (const targetScene of targetScenes) {
                        const x = this.printCol * 8;
                        const y = this.printRow * 8;
                        charset.drawCharToScene(targetScene, gmIndex, x, y, this.printFgColor, this.printBgColor);
                    }
                    // Advance column for next character
                    this.printCol++;
                }
                break;

            case 0x3D: // print value of [var]
                // arg2 = variable index, prints the numeric value as text
                // GM zero-pads to 3 digits (variables are 0-255)
                // Draws to scene's pixel buffer using palette indices (0-3)
                if (charset.loaded) {
                    const targetScenes = this.getPrintTargetScenes();
                    const value = this.getVar(arg2);
                    const valueStr = value.toString().padStart(3, '0');
                    for (const targetScene of targetScenes) {
                        const x = this.printCol * 8;
                        const y = this.printRow * 8;
                        charset.drawStringToScene(targetScene, valueStr, x, y, this.printFgColor, this.printBgColor);
                    }
                }
                break;

            case 0x3E: // print color= 00 on 00
                // arg1 = foreground slot (0-3), arg2 = background slot (0-3)
                this.printFgColor = arg1;
                this.printBgColor = arg2;
                break;

            case 0x3F: // print color=[a] on [a]
                // arg1 = variable index for fg, arg2 = variable index for bg
                this.printFgColor = this.getVar(arg1) % 16;
                this.printBgColor = this.getVar(arg2) % 16;
                break;

            case 0x5B: // scoreX displays on sceneX
                // arg1 = score index (0 or 1)
                // arg2 = scene target (0=scene1, 1=scene2, 2=both)
                // Note: This just sets where the score WILL display, doesn't render yet.
                // Score only renders when "add to score" is executed.
                {
                    const scoreIdx = arg1;
                    this.scoreScene[scoreIdx] = arg2;
                    this.scoreVisible[scoreIdx] = true;
                }
                break;

            case 0x5C: // print on scene
                // Sets target scene for print operations
                // arg2: 0=scene1, 1=scene2, 2=both
                this.printScene = arg2;
                break;

            case 0x53: // clear scene X
                // arg2 = scene number (1 or 2, stored as 0 or 1)
                {
                    const sceneIndex = arg2;
                    if (this.scenes[sceneIndex]) {
                        this.scenes[sceneIndex].clear();
                    }
                }
                break;

            case 0x56: // display other scene
                // Toggle between scene 0 and scene 1
                this.activeScene = this.activeScene === 0 ? 1 : 0;
                break;

            case 0x57: // pause for XX.X seconds
                // arg2 = time value 1-255, with implied decimal before last digit
                // So 15 = 1.5 seconds, 255 = 25.5 seconds, range is 0.1 to 25.5 seconds
                if (this.config.pauseEnabled) {
                    const pauseSeconds = arg2 / 10;
                    const pauseMs = pauseSeconds * 1000;
                    this.pauseUntil = Date.now() + pauseMs;
                }
                break;

            case 0x66: // screen update on/off
                // GM bytecode: 0=on, 1=off (single-arg opcode uses arg2)
                this.screenUpdateOn = (arg2 === 0);
                break;

            case 0x4D: // plot color X to scene Y
                // arg1 = color index (0-3), arg2 = scene index (0 or 1)
                this.plotColor = arg1 & 0x03;
                this.plotScene = arg2 & 0x01;
                break;

            case 0x4E: // plot color [var] to scene Y
                // arg1 = variable index for color, arg2 = scene index (0 or 1)
                this.plotColor = this.getVar(arg1) & 0x03;
                this.plotScene = arg2 & 0x01;
                break;

            case 0x4F: // plot a dot at x=XXX y=XXX (immediate values)
                // arg1 = x coordinate, arg2 = y coordinate
                // GM coordinates: x=12-171 visible, y=50-249 visible
                // Scene coordinates: x=0-159 (fat pixels), y=0-199
                {
                    const scene = this.scenes[this.plotScene];
                    if (scene) {
                        // Convert GM coordinates to scene coordinates
                        const sceneX = arg1 - 12;
                        const sceneY = arg2 - 50;
                        scene.setPixel(sceneX, sceneY, this.plotColor);
                    }
                }
                break;

            case 0x50: // plot a dot at x=[a] y=[a] (variable values)
                // arg1 = variable index for x, arg2 = variable index for y
                {
                    const scene = this.scenes[this.plotScene];
                    if (scene) {
                        const gmX = this.getVar(arg1);
                        const gmY = this.getVar(arg2);
                        // Convert GM coordinates to scene coordinates
                        const sceneX = gmX - 12;
                        const sceneY = gmY - 50;
                        scene.setPixel(sceneX, sceneY, this.plotColor);
                    }
                }
                break;
        }

    }

    // === HITBOX METHODS (320×200 COORDINATES) ===
    // All hitboxes are returned in 320×200 screen coordinates.
    // gmSprite.getHitboxes() expects base position in 320×200 space.

    // Convert GM slot coordinates to 320×200 space
    // Floor values to ensure integer pixel coordinates (positions can be fractional from movement)
    _slotTo320(slot) {
        return {
            x: Math.floor((slot.x - 12) * 2),
            y: Math.floor(slot.y - 50)
        };
    }

    // Get hitboxes for a sprite slot (for collision detection)
    // Each slot returns ONLY its own quad's hitbox:
    //   - Parent slot (e.g., slot 4) → quad 0 only
    //   - Subsprite slot (e.g., slot 5) → quad 1 only
    // This allows GM games to check collisions with specific parts of multi-part sprites.
    getHitboxes(slotIndex) {
        const slot = this.sprites[slotIndex];

        // If this slot has a sprite, it's a parent sprite - return ONLY quad 0
        if (slot.spriteInstance) {
            if (!slot.visible) return [];
            const pos = this._slotTo320(slot);
            return slot.spriteInstance.getHitboxes(pos.x, pos.y, 0);  // quad 0 only
        }

        // This slot doesn't have a spriteInstance - check if it's a subsprite slot
        // Look backwards to find the parent sprite
        for (let parentIdx = slotIndex - 1; parentIdx >= 0; parentIdx--) {
            const parentSlot = this.sprites[parentIdx];
            if (parentSlot.spriteInstance) {
                // Check parent's visibility (subsprites inherit visibility from parent)
                if (!parentSlot.visible) return [];

                // Calculate which quad this slot represents
                const quadIndex = slotIndex - parentIdx;

                // Check if this quad exists in the parent sprite
                if (quadIndex < parentSlot.spriteInstance.sprite[0].numSprites) {
                    const pos = this._slotTo320(parentSlot);
                    return parentSlot.spriteInstance.getHitboxes(pos.x, pos.y, quadIndex);
                }
                break;
            }
        }

        return [];
    }

    // Returns hitboxes for ALL quads of a multi-part sprite (used for visualization)
    getAllHitboxes(slotIndex) {
        const slot = this.sprites[slotIndex];
        if (!slot.visible || !slot.spriteInstance) return [];

        const pos = this._slotTo320(slot);
        return slot.spriteInstance.getHitboxes(pos.x, pos.y, -1); // -1 = all quads
    }

    // Check if a hitbox is fully off-screen (not visible at all)
    // Screen dimensions: 320x200 (after coordinate transform)
    isHitboxOffScreen(box) {
        if (!box) return true;
        // Check if hitbox is entirely outside the visible screen area
        // Screen is 320 pixels wide (0-319) and 200 pixels tall (0-199) after transform
        return (box.x + box.width <= 0 ||   // fully off left
                box.x >= 320 ||              // fully off right
                box.y + box.height <= 0 ||   // fully off top
                box.y >= 200);               // fully off bottom
    }

    // === PIXEL-PERFECT COLLISION DETECTION (320×200 COORDINATES) ===
    // With the new coordinate system, collision is much simpler:
    // - All hitboxes are in 320×200 space
    // - Sprite frames are stored as pixel arrays in 320×200 space
    // - No scale factor conversions needed!

    // Check pixel-perfect collision between two sprites
    // Uses gmSprite.hasPixelAt() to check individual pixels in overlap region
    checkPixelOverlap(gmSprite1, gmSprite2, box1, box2, frame1, frame2, debugLabel = '') {
        // Calculate overlap region (all in 320×200 coordinates)
        // Floor all values to ensure integer pixel coordinates
        const left = Math.floor(Math.max(box1.x, box2.x));
        const right = Math.floor(Math.min(box1.x + box1.width, box2.x + box2.width));
        const top = Math.floor(Math.max(box1.y, box2.y));
        const bottom = Math.floor(Math.min(box1.y + box1.height, box2.y + box2.height));

        const overlapW = right - left;
        const overlapH = bottom - top;

        // No overlap
        if (overlapW < 1 || overlapH < 1) {
            return false;
        }

        // Check each pixel in the overlap region
        for (let y = 0; y < overlapH; y++) {
            for (let x = 0; x < overlapW; x++) {
                const screenX = left + x;
                const screenY = top + y;

                // Convert to local coordinates within each sprite
                const local1X = screenX - box1.x;
                const local1Y = screenY - box1.y;
                const local2X = screenX - box2.x;
                const local2Y = screenY - box2.y;

                // Check if both sprites have non-transparent pixels at this position
                const hasPixel1 = gmSprite1.hasPixelAt(box1.quadIndex, frame1, local1X, local1Y);
                const hasPixel2 = gmSprite2.hasPixelAt(box2.quadIndex, frame2, local2X, local2Y);

                if (hasPixel1 && hasPixel2) {
                    return true;
                }
            }
        }

        return false;
    }

    // Helper to find the parent sprite and gmSprite for a slot (handles subsprites)
    _getSpriteInfo(slotIndex) {
        const slot = this.sprites[slotIndex];

        if (slot.spriteInstance) {
            // This is a parent sprite slot - check visibility directly
            if (!slot.visible) return null;
            return { slot, gmSprite: slot.spriteInstance, parentSlot: slot };
        }

        // This might be a subsprite slot - find parent
        // Subsprite visibility is inherited from parent, not checked on the slot itself
        for (let parentIdx = slotIndex - 1; parentIdx >= 0; parentIdx--) {
            const parentSlot = this.sprites[parentIdx];
            if (parentSlot.spriteInstance) {
                // Check parent's visibility instead
                if (!parentSlot.visible) return null;

                const quadIndex = slotIndex - parentIdx;
                if (quadIndex < parentSlot.spriteInstance.sprite[0].numSprites) {
                    return { slot, gmSprite: parentSlot.spriteInstance, parentSlot, quadIndex };
                }
                break;
            }
        }

        return null;
    }

    checkSpriteCollision(sprite1Index, sprite2Index) {
        const info1 = this._getSpriteInfo(sprite1Index);
        const info2 = this._getSpriteInfo(sprite2Index);

        if (!info1 || !info2) {
            return false;
        }

        const { gmSprite: gmSprite1, parentSlot: parentSlot1 } = info1;
        const { gmSprite: gmSprite2, parentSlot: parentSlot2 } = info2;

        // Get hitboxes (already in 320×200 coordinates)
        const boxes1 = this.getHitboxes(sprite1Index);
        const boxes2 = this.getHitboxes(sprite2Index);

        if (boxes1.length === 0 || boxes2.length === 0) {
            return false;
        }

        // Check all combinations of hitboxes for overlap
        for (const box1 of boxes1) {
            if (this.isHitboxOffScreen(box1)) continue;

            for (const box2 of boxes2) {
                if (this.isHitboxOffScreen(box2)) continue;

                // AABB check first (quick rejection)
                const aabbOverlap = !(
                    box1.x + box1.width < box2.x ||
                    box2.x + box2.width < box1.x ||
                    box1.y + box1.height < box2.y ||
                    box2.y + box2.height < box1.y
                );

                if (aabbOverlap) {
                    // AABB overlaps - do pixel-perfect check
                    // All coordinates are now in 320×200 space - no conversions needed!
                    const frame1 = parentSlot1.animFrame || 0;
                    const frame2 = parentSlot2.animFrame || 0;

                    const pixelOverlap = this.checkPixelOverlap(
                        gmSprite1, gmSprite2, box1, box2, frame1, frame2
                    );

                    if (pixelOverlap) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    /**
     * Check if sprite hits any other visible sprite ("anyone" collision)
     * @param {number} spriteIndex - Index of sprite to check (0-7)
     * @returns {boolean} True if sprite overlaps any other visible sprite
     */
    checkSpriteHitAnyone(spriteIndex) {
        for (let i = 0; i < 8; i++) {
            if (i === spriteIndex) continue; // Don't check against self
            if (!this.sprites[i].visible) continue;
            if (this.checkSpriteCollision(spriteIndex, i)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check if sprite hits scene color slots 2 or 3 (pixel-perfect)
     * @param {number} spriteIndex - Index of sprite to check (0-7)
     * @returns {boolean} True if any non-transparent sprite pixel overlaps scene color 2 or 3
     */
    checkSpriteHitSceneColors(spriteIndex) {
        const slot = this.sprites[spriteIndex];
        if (!slot.visible || !slot.spriteInstance) return false;

        const gmSprite = slot.spriteInstance;
        const frameIndex = slot.animFrame || 0;

        // Get sprite position in GM coordinates
        const gmX = Math.floor(slot.x);
        const gmY = Math.floor(slot.y);

        // Get the current scene
        const scene = this.scenes[this.activeScene];
        if (!scene) return false;

        // Get sprite dimensions accounting for doubling
        const xDouble = gmSprite.sprite[0].xDouble ? 2 : 1;
        const yDouble = gmSprite.sprite[0].yDouble ? 2 : 1;
        const spriteWidthGm = 12 * xDouble;
        const spriteHeightGm = 21 * yDouble;

        // Check each quad of the sprite
        for (let quad = 0; quad < gmSprite.sprite.length; quad++) {
            const frame = gmSprite.getFrame(quad, frameIndex);
            if (!frame) continue;

            // Calculate quad's GM position
            let quadGmX = gmX;
            let quadGmY = gmY;
            if (quad > 0) {
                const spriteData = gmSprite.sprite[quad];
                quadGmX += spriteData.xPosition;
                quadGmY += spriteData.yPosition;
            }

            // Iterate over sprite pixels in GM coordinate space
            for (let gmOffsetY = 0; gmOffsetY < spriteHeightGm; gmOffsetY++) {
                const pixelGmY = (quadGmY + gmOffsetY) & 0xFF;
                // Check if in visible Y range (50-249)
                if (pixelGmY < 50 || pixelGmY >= 250) continue;

                const sceneY = pixelGmY - 50;
                const frameY = gmOffsetY;

                for (let gmOffsetX = 0; gmOffsetX < spriteWidthGm; gmOffsetX++) {
                    const pixelGmX = (quadGmX + gmOffsetX) & 0xFF;
                    // Check if in visible X range (12-171)
                    if (pixelGmX < 12 || pixelGmX >= 172) continue;

                    // Convert to scene coordinates (160x200 fat pixels)
                    const sceneX = pixelGmX - 12;

                    // Check if this sprite pixel is non-transparent
                    const frameX = gmOffsetX * 2; // Frame is in 320 space
                    if (frameX >= frame.width || frameY >= frame.height) continue;

                    const srcIdx = (frameY * frame.width + frameX) * 4;
                    const alpha = frame.pixels[srcIdx + 3];
                    if (alpha === 0) continue; // Transparent, skip

                    // Check scene pixel's color index (0-3)
                    const colorIndex = scene.getPixel(sceneX, sceneY);
                    if (colorIndex === 2 || colorIndex === 3) {
                        return true; // Hit color slot 2 or 3
                    }
                }
            }
        }

        return false;
    }

    /**
     * Render a score value to a scene's offscreen canvas.
     * Called when score changes or when "displays on scene" is executed.
     * @param {number} scoreIdx - Which score (0 or 1)
     * @param {number} sceneIdx - Which scene to render to (0 or 1)
     */
    renderScoreToScene(scoreIdx, sceneIdx) {
        const scene = this.scenes[sceneIdx];
        if (!scene || !charset.loaded) {
            return;
        }

        const scoreStr = this.score[scoreIdx].toString().padStart(6, '0');
        const x = this.scoreCol[scoreIdx] * 8;
        const y = this.scoreRow[scoreIdx] * 8;

        // Draw directly to scene's pixel buffer using palette indices (0-3)
        charset.drawStringToScene(scene, scoreStr, x, y, this.scoreFgColor[scoreIdx], this.scoreBgColor[scoreIdx]);
    }

    /**
     * Update score display on assigned scene(s).
     * Called whenever a score value changes.
     * @param {number} scoreIdx - Which score changed (0 or 1)
     */
    updateScoreDisplay(scoreIdx) {
        // Add/clear makes score visible and renders it
        this.scoreVisible[scoreIdx] = true;

        // Default to scene 0 if "displays on scene" was never called
        const sceneTarget = this.scoreScene[scoreIdx];

        if (sceneTarget === 0 || sceneTarget === 2) {
            this.renderScoreToScene(scoreIdx, 0); // scene 1
        }
        if (sceneTarget === 1 || sceneTarget === 2) {
            this.renderScoreToScene(scoreIdx, 1); // scene 2
        }
    }

    updateSpritePositions() {
        // Update sprite positions based on speed and direction
        // Animation is handled by gmSprite itself
        for (let i = 0; i < this.sprites.length; i++) {
            const sprite = this.sprites[i];

            if (!sprite.visible || sprite.speed === 0) continue;

            // Convert GameMaker direction (0-255) to angle in radians
            // 0 = up (270° in standard coords), 64 = right (0°), 128 = down (90°), 192 = left (180°)
            // GameMaker: 0=up, increases clockwise
            // We need: 0=up=-90°, 64=right=0°, 128=down=90°, 192=left=180°
            const gmAngle = (sprite.direction / 256) * 360; // 0-360 degrees
            const standardAngle = gmAngle - 90; // Convert GM angle (0=up) to standard (0=right)
            const radians = (standardAngle * Math.PI) / 180;

            // Calculate velocity based on verified speed formula
            // C64 pixels aren't square (320x200 on 4:3 display), so X and Y have different rates
            // Measured: X divisor ~46, Y divisor ~32. Tweaked for better feel.
            const pixelsPerFrameX = sprite.speed / 46;
            const pixelsPerFrameY = sprite.speed / 31.5;
            const velocityX = Math.cos(radians) * pixelsPerFrameX;
            const velocityY = Math.sin(radians) * pixelsPerFrameY;

            // Update position
            sprite.x += velocityX;
            sprite.y += velocityY;

            // Wrap around coordinate boundaries
            // GameMaker coordinates go from 0-255 for both X and Y
            if (sprite.x > 255) {
                sprite.x = 0;
            } else if (sprite.x < 0) {
                sprite.x = 255;
            }

            if (sprite.y > 255) {
                sprite.y = 0;
            } else if (sprite.y < 0) {
                sprite.y = 255;
            }
        }
    }

    render(advanceAnimation = true) {
        // Update sprite positions (movement physics) - runs every frame at 60fps
        // Must happen even when screen updates are off, so sprites keep moving
        this.updateSpritePositions();

        if (!this.screenUpdateOn) return;

        // === 320×200 NATIVE RESOLUTION RENDERING ===
        // All rendering happens to screen.pixels (320×200 RGBA buffer).
        // Scene fills the buffer, then sprites blit on top, then present() displays.

        // Render scene background (or clear to black if no scene)
        const activeSceneObj = this.scenes[this.activeScene];
        if (activeSceneObj) {
            // Scene blits to pixel buffer (fills entire screen, no transparency)
            activeSceneObj.blitToBuffer(this.screen.pixels, c64Screen.WIDTH, c64Screen.HEIGHT);
        } else {
            // No scene - clear to black
            this.screen.clear(0, 0, 0);
        }

        // Priority mask used by "sprite under colors 2/3" slots — built
        // once per frame from the active scene and shared across all
        // "under" sprites. The "which indices are special" choice lives
        // here (C64 VIC hardware: colors 2 and 3 outrank sprites).
        const underMask = activeSceneObj?.getUnderMask(UNDER_SKIP_INDICES) || null;

        // Render sprites to pixel buffer
        // Higher numbered sprites render on top, so loop from 7 to 0
        // (sprite 0 drawn first = lowest z-index)
        for (let i = this.sprites.length - 1; i >= 0; i--) {
            const slot = this.sprites[i];
            if (slot.visible && slot.spriteInstance) {
                const gmSpriteObj = slot.spriteInstance;
                if (gmSpriteObj) {
                    // Ensure animFrame is valid and within bounds for THIS sprite
                    const numFrames = gmSpriteObj.getNumFrames();
                    if (typeof slot.animFrame !== 'number' || isNaN(slot.animFrame) ||
                        slot.animFrame < 0 || slot.animFrame >= numFrames) {
                        slot.animFrame = 0;
                    }

                    // Blit sprite to screen's pixel buffer
                    // Pass GM coordinates - blitToBuffer handles coordinate conversion and wrapping
                    const mask = slot.overUnder === 1 ? underMask : null;
                    gmSpriteObj.blitToBuffer(this.screen.pixels, c64Screen.WIDTH, c64Screen.HEIGHT, slot.x, slot.y, slot.animFrame, slot.skipQuads, mask);

                    // Advance animation (only at 30fps, controlled by advanceAnimation flag)
                    if (advanceAnimation && slot.animSpeed > 0) {
                        // If animateOnce is true and we're on the last frame, don't advance
                        if (slot.animateOnce && slot.animFrame >= numFrames - 1) {
                            // Stay on last frame - mark animation as done so it can restart
                            slot.animateOnceDone = true;
                        } else {
                            // Clamp animSpeed to valid range 1-31 to prevent negative framesToSkip
                            const clampedSpeed = Math.max(1, Math.min(31, slot.animSpeed));
                            const framesToSkip = 32 - clampedSpeed;

                            // Initialize or fix invalid skipCounter
                            if (typeof slot.skipCounter !== 'number' || isNaN(slot.skipCounter)) {
                                slot.skipCounter = framesToSkip;
                            }

                            if (slot.skipCounter <= 0) {
                                if (slot.animateOnce) {
                                    // For "once" mode, don't wrap - stop at last frame
                                    slot.animFrame = Math.min(slot.animFrame + 1, numFrames - 1);
                                } else {
                                    // For "always" mode, wrap around
                                    slot.animFrame = (slot.animFrame + 1) % numFrames;
                                }
                                slot.skipCounter = framesToSkip;
                            } else {
                                slot.skipCounter--;
                            }
                        }
                    }
                }
            }
        }

        // Present the composited frame to the canvas
        this.screen.present();

        // Draw collision hitboxes if enabled (drawn after present, directly to canvas)
        if (this.config.showHitboxes) {
            this.drawHitboxes();
        }
    }

    drawHitboxes() {
        // Hitboxes are in 320×200 coordinates, same as canvas
        // No scaling needed - draw directly to canvas after present()
        const ctx = this.screen.ctx;

        for (let i = 0; i < this.sprites.length; i++) {
            const slot = this.sprites[i];
            // Skip reserved subsprite slots (they don't have their own hitbox)
            if (slot.isSubsprite) continue;

            // Use getAllHitboxes for visualization (shows all quads of multi-part sprites)
            const hitboxes = this.getAllHitboxes(i);
            if (hitboxes.length === 0) continue;

            // Draw all hitboxes for this sprite (main + subsprites)
            for (const hitbox of hitboxes) {
                // Draw rectangle outline (coordinates already in 320×200 space)
                ctx.strokeStyle = 'rgba(255, 0, 255, 0.8)';  // Magenta
                ctx.lineWidth = 1;
                ctx.strokeRect(hitbox.x, hitbox.y, hitbox.width, hitbox.height);

                // Draw sprite slot number
                ctx.fillStyle = 'rgba(255, 0, 255, 1)';
                ctx.font = '10px monospace';
                const slotNum = i + 1 + hitbox.quadIndex;
                ctx.fillText(`${slotNum}`, hitbox.x + 1, hitbox.y + 9);
            }
        }
    }
}

// Make available globally for browser and Node.js testing
if (typeof globalThis !== 'undefined') {
    globalThis.gmVM = gmVM;
}
