/*
 * GameMaker Opcodes Definition File
 *
 * This file defines all 103 GameMaker instructions with explicit argument specification.
 *
 * === CRITICAL: ARGUMENT ALIGNMENT ===
 * The template MUST match which argument the runtime (gmRuntime.js) actually uses!
 *
 * GameMaker bytecode quirk: Many "single argument" opcodes store the value in arg2,
 * leaving arg1 as 0/unused. If the template says {type:1} but runtime uses arg2,
 * the display will be wrong (e.g., variable 'a' showing as '`' backtick).
 *
 * When adding/modifying opcodes:
 * 1. Check gmRuntime.js to see which arg (arg1 or arg2) is actually used
 * 2. Template must reference the correct arg: {type:1} for arg1, {type:2} for arg2
 * 3. Args array must match: ['type'] for arg1-only, ['unused', 'type'] for arg2-only
 *
 * Examples of arg2-only opcodes (arg1 unused):
 *   0x01 jump to label l001      - label in arg2
 *   0x02 jump to label l[a]      - variable in arg2
 *   0x2E display scene X         - scene in arg2
 *   0x3D print value of [a]      - variable in arg2
 *   0x53 clear scene X           - scene in arg2
 *   0x67 clear sprite X          - sprite in arg2
 *
 * Template syntax:
 *   {type:1} - arg1 value formatted according to type
 *   {type:2} - arg2 value formatted according to type
 *   Literal text is included as-is
 *
 * Types:
 *   var        - Variable name (a-z), 1-based index
 *   num        - Numeric literal (0-255)
 *   label      - Label number (1-255), displayed as 3-digit padded
 *   sprite     - Sprite slot number (1-8)
 *   spriteName - Sprite data page name, resolved from data pages
 *   scene      - Scene index (1-2) or target (0=scene1, 1=scene2, 2=both)
 *   sceneName  - Scene data page name, resolved from data pages
 *   score      - Score index (1-2)
 *   scoreValue - Score value (0-100, scaled by 10)
 *   scoreComp  - Score comparison (0-255, scaled by 1000)
 *   color      - Color index in palette (0-15)
 *   colorSlot  - Color slot index (1-3 for scene colors)
 *   joystick   - Joystick number (1-2)
 *   joyDir     - Joystick direction (0=off,1=up,2=down,3=left,4=right)
 *   button     - Button number (1-2)
 *   channel    - Sound channel (1-3)
 *   sound      - Sound data page name
 *   song       - Song data page name
 *   volume     - Volume level (0-15)
 *   row        - Print row (0-24)
 *   col        - Print column (0-19)
 *   seconds    - Pause duration (0-255, scaled by 0.1)
 *   string     - String pointer, resolved from data pages
 *   animSpeed  - Animation speed (0-32)
 *   rndRange   - Random range (1-255)
 *   onOff      - On/off toggle (0=off, 1=on)
 *   overUnder  - Sprite priority (0=over, 1=under)
 *   direction  - Sprite direction (0-255 maps to 0-359 degrees)
 *   color23    - Shared color slot (2 or 3)
 */

const gmOpcodes = {
    // No operation / blank line
    0x00: {
        name: '',
        template: '',
        args: []
    },

    // === FLOW CONTROL ===

    0x01: {
        name: 'jump to label l001',
        template: 'jump to label l{label:2}',
        args: ['unused', 'label']
    },
    0x02: {
        name: 'jump to label l[a]',
        template: 'jump to label l[{var:2}]',
        args: ['unused', 'var']
    },
    0x03: {
        name: 'jump to subroutine at l001',
        template: 'jump to subroutine at l{label:2}',
        args: ['unused', 'label']
    },
    0x04: {
        name: 'jump to subroutine at l[a]',
        template: 'jump to subroutine at l[{var:2}]',
        args: ['unused', 'var']
    },
    0x05: {
        name: 'return from subroutine',
        template: 'return from subroutine',
        args: []
    },
    0x06: {
        name: 'stop program',
        template: 'stop program',
        args: []
    },

    // === VARIABLE OPERATIONS ===

    0x07: {
        name: 'set a = 000',
        template: 'set {var:1} = {num:2}',
        args: ['var', 'num']
    },
    0x08: {
        name: 'set a = [a]',
        template: 'set {var:1} = [{var:2}]',
        args: ['var', 'var']
    },
    0x09: {
        name: 'set a = rnd number 0 to 001',
        template: 'set {var:1} = rnd number 0 to {rndRange:2}',
        args: ['var', 'rndRange']
    },
    0x0A: {
        name: 'set a =value at data+[a]',
        template: 'set {var:1} =value at data+[{var:2}]',
        args: ['var', 'var']
    },
    0x0B: {
        name: 'set a = a + 000',
        template: 'set {var:1} = {var:1} + {num:2}',
        args: ['var', 'num']
    },
    0x0C: {
        name: 'set a = a + [a]',
        template: 'set {var:1} = {var:1} + [{var:2}]',
        args: ['var', 'var']
    },
    0x0D: {
        name: 'set a = a - 000',
        template: 'set {var:1} = {var:1} - {num:2}',
        args: ['var', 'num']
    },
    0x0E: {
        name: 'set a = a - [a]',
        template: 'set {var:1} = {var:1} - [{var:2}]',
        args: ['var', 'var']
    },
    0x0F: {
        name: 'set a = a x 000',
        template: 'set {var:1} = {var:1} x {num:2}',
        args: ['var', 'num']
    },
    0x10: {
        name: 'set a = a x [a]',
        template: 'set {var:1} = {var:1} x [{var:2}]',
        args: ['var', 'var']
    },
    0x11: {
        name: 'set a = a / 000',
        template: 'set {var:1} = {var:1} / {num:2}',
        args: ['var', 'num']
    },
    0x12: {
        name: 'set a = a / [a]',
        template: 'set {var:1} = {var:1} / [{var:2}]',
        args: ['var', 'var']
    },

    // === CONDITIONALS ===

    0x13: {
        name: 'if a = 000 then',
        template: 'if {var:1} = {num:2} then',
        args: ['var', 'num']
    },
    0x14: {
        name: 'if a = [a] then',
        template: 'if {var:1} = [{var:2}] then',
        args: ['var', 'var']
    },
    0x15: {
        name: 'if a > 000 then',
        template: 'if {var:1} > {num:2} then',
        args: ['var', 'num']
    },
    0x16: {
        name: 'if a > [a] then',
        template: 'if {var:1} > [{var:2}] then',
        args: ['var', 'var']
    },
    0x17: {
        name: 'if a < 000 then',
        template: 'if {var:1} < {num:2} then',
        args: ['var', 'num']
    },
    0x18: {
        name: 'if a < [a] then',
        template: 'if {var:1} < [{var:2}] then',
        args: ['var', 'var']
    },
    0x19: {
        name: 'if joystick 1 is right then',
        template: 'if joystick {joystick:1} is {joyDir:2} then',
        args: ['joystick', 'joyDir']
    },
    0x1A: {
        name: 'if button 1 is on  then',
        template: 'if button {button:1} is {onOff:2}  then',
        args: ['button', 'onOff']
    },
    0x1B: {
        name: 'if sprite  hit sprite  then',
        template: 'if sprite {sprite:1} hit {hitTarget:2} then',
        args: ['sprite', 'hitTarget']
    },
    0x54: {
        name: 'otherwise',
        template: 'otherwise',
        args: []
    },
    0x55: {
        name: 'endif',
        template: 'endif',
        args: []
    },

    // === SKIP INSTRUCTIONS ===

    0x62: {
        name: 'skip next if a = 000',
        template: 'skip next if {var:1} = {num:2}',
        args: ['var', 'num']
    },
    0x63: {
        name: 'skip next if a > 000',
        template: 'skip next if {var:1} > {num:2}',
        args: ['var', 'num']
    },
    0x64: {
        name: 'skip next if a < 000',
        template: 'skip next if {var:1} < {num:2}',
        args: ['var', 'num']
    },

    // === DATA TABLE ===

    0x1C: {
        name: 'data table at l001',
        template: 'data table at l{label:2}',
        args: ['unused', 'label']
    },
    0x1D: {
        name: 'data values - 000 000',
        template: 'data values - {num:1} {num:2}',
        args: ['num', 'num']
    },

    // === SCORE OPERATIONS ===

    0x1E: {
        name: 'add [a] to score1',
        template: 'add [{var:1}] to score{score:2}',
        args: ['var', 'score']
    },
    0x44: {
        name: 'add 0000 to score1',
        template: 'add {scoreValue:1} to score{score:2}',
        args: ['scoreValue', 'score']
    },
    0x45: {
        name: 'add 0000 to score[a]',
        template: 'add {scoreValue:1} to score[{var:2}]',
        args: ['scoreValue', 'var']
    },
    0x58: {
        name: 'add [a] to score[a]',
        template: 'add [{var:1}] to score[{var:2}]',
        args: ['var', 'var']
    },
    0x46: {
        name: 'score1 at row 00 column 00',
        template: 'score1 at row {row:1} column {col:2}',
        args: ['row', 'col']
    },
    0x47: {
        name: 'score2 at row 00 column 00',
        template: 'score2 at row {row:1} column {col:2}',
        args: ['row', 'col']
    },
    0x48: {
        name: 'clear score1',
        template: 'clear score{score:1}',
        args: ['score']
    },
    0x49: {
        name: 'clear score[a]',
        template: 'clear score[{var:1}]',
        args: ['var']
    },
    0x42: {
        name: 'score1 color= 0 on 0',
        template: 'score1 color= {sceneColorSlot:1} on {sceneColorSlot:2}',
        args: ['sceneColorSlot', 'sceneColorSlot']
    },
    0x43: {
        name: 'score2 color= 0 on 0',
        template: 'score2 color= {sceneColorSlot:1} on {sceneColorSlot:2}',
        args: ['sceneColorSlot', 'sceneColorSlot']
    },
    0x4A: {
        name: 'if score1 > 000000 then',
        template: 'if score{score:1} > {scoreComp:2} then',
        args: ['score', 'scoreComp']
    },
    0x4B: {
        name: 'if score[a] > 000000 then',
        template: 'if score[{var:1}] > {scoreComp:2} then',
        args: ['var', 'scoreComp']
    },
    0x4C: {
        name: 'if score1 > score2 then',
        template: 'if score{score:1} > score{score:2} then',
        args: ['score', 'score']
    },
    0x5B: {
        name: 'score1 displays on scene1',
        template: 'score{score:1} displays on {sceneTarget:2}',
        args: ['score', 'sceneTarget']
    },

    // === SPRITE OPERATIONS ===

    0x1F: {
        name: 'sprite  x position =000',
        template: 'sprite {sprite:1} x position ={num:2}',
        args: ['sprite', 'num']
    },
    0x20: {
        name: 'sprite  x position =[a]',
        template: 'sprite {sprite:1} x position =[{var:2}]',
        args: ['sprite', 'var']
    },
    0x21: {
        name: 'sprite  y position =000',
        template: 'sprite {sprite:1} y position ={num:2}',
        args: ['sprite', 'num']
    },
    0x22: {
        name: 'sprite  y position =[a]',
        template: 'sprite {sprite:1} y position =[{var:2}]',
        args: ['sprite', 'var']
    },
    0x23: {
        name: 'sprite  dir =000  000°',
        template: 'sprite {sprite:1} dir ={direction:2}',
        args: ['sprite', 'direction']
    },
    0x24: {
        name: 'sprite  dir =[a]',
        template: 'sprite {sprite:1} dir =[{var:2}]',
        args: ['sprite', 'var']
    },
    0x25: {
        name: 'sprite  movement speed=000',
        template: 'sprite {sprite:1} movement speed={num:2}',
        args: ['sprite', 'num']
    },
    0x26: {
        name: 'sprite  movement speed=[a]',
        template: 'sprite {sprite:1} movement speed=[{var:2}]',
        args: ['sprite', 'var']
    },
    0x27: {
        name: 'sprite 1 is [    ]',
        template: 'sprite {sprite:1} is {spriteName:2}',
        args: ['sprite', 'spriteName']
    },
    0x29: {
        name: 'sprite  animation spd =000',
        template: 'sprite {sprite:1} animation spd ={animSpeed:2}',
        args: ['sprite', 'animSpeed']
    },
    0x2A: {
        name: 'sprite  animation spd =[a]',
        template: 'sprite {sprite:1} animation spd =[{var:2}]',
        args: ['sprite', 'var']
    },
    0x2C: {
        name: 'set a =sprite  x position',
        template: 'set {var:1} =sprite {sprite:2} x position',
        args: ['var', 'sprite']
    },
    0x2D: {
        name: 'set a =sprite  y position',
        template: 'set {var:1} =sprite {sprite:2} y position',
        args: ['var', 'sprite']
    },
    0x2F: {
        name: 'sprite  color 1 =black',
        template: 'sprite {sprite:1} color 1 ={colorName:2}',
        args: ['sprite', 'colorName']
    },
    0x30: {
        name: 'sprite  color 1 =[a]',
        template: 'sprite {sprite:1} color 1 =[{var:2}]',
        args: ['sprite', 'var']
    },
    0x31: {
        name: 'sprite shared colr2=black',
        template: 'sprite shared colr{color23:1}={colorName:2}',
        args: ['color23', 'colorName']
    },
    0x32: {
        name: 'sprite shared colr2=[a]',
        template: 'sprite shared colr{color23:1}=[{var:2}]',
        args: ['color23', 'var']
    },
    0x59: {
        name: 'sprite  over colors 2/3',
        template: 'sprite {sprite:1} {overUnder:2} colors 2/3',
        args: ['sprite', 'overUnder']
    },
    0x65: {
        name: 'sprite  animates always',
        template: 'sprite {sprite:1} animates {alwaysOnce:2}',
        args: ['sprite', 'alwaysOnce']
    },
    0x67: {
        name: 'clear sprite',
        template: 'clear sprite {sprite:2}',
        args: ['unused', 'sprite']
    },

    // === SCENE OPERATIONS ===

    0x28: {
        name: 'scene 1 is [    ]',
        template: 'scene {scene:1} is {sceneName:2}',
        args: ['scene', 'sceneName']
    },
    0x2E: {
        name: 'display scene 1',
        template: 'display scene {scene:2}',
        args: ['unused', 'scene']
    },
    0x33: {
        name: 'scene 1 background=color',
        template: 'scene {scene:1} background={colorName:2}',
        args: ['scene', 'colorName']  // arg1 is scene number (0 or 1), arg2 is color
    },
    0x34: {
        name: 'scene 1 background=[var]',
        template: 'scene {scene:1} background=[{var:2}]',
        args: ['scene', 'var']  // arg1 is scene number (0 or 1), arg2 is var
    },
    0x35: {
        name: 'scene 1 border = color',
        template: 'scene {scene:1} border = {colorName:2}',
        args: ['scene', 'colorName']  // arg1 is scene number (0 or 1), arg2 is color
    },
    0x36: {
        name: 'scene 1 border = [var]',
        template: 'scene {scene:1} border = [{var:2}]',
        args: ['scene', 'var']  // arg1 is scene number (0 or 1), arg2 is var
    },
    0x37: {
        name: 'scene 1 color 1 = black',
        template: 'scene 1 color {colorSlot:1} = {colorName:2}',
        args: ['colorSlot', 'colorName']
    },
    0x38: {
        name: 'scene 1 color 1 = [a]',
        template: 'scene 1 color {colorSlot:1} = [{var:2}]',
        args: ['colorSlot', 'var']
    },
    0x51: {
        name: 'scene 2 color 1 = black',
        template: 'scene 2 color {colorSlot:1} = {colorName:2}',
        args: ['colorSlot', 'colorName']
    },
    0x52: {
        name: 'scene 2 color 1 = [a]',
        template: 'scene 2 color {colorSlot:1} = [{var:2}]',
        args: ['colorSlot', 'var']
    },
    0x53: {
        name: 'clear scene 1',
        template: 'clear scene {scene:2}',
        args: ['unused', 'scene']
    },
    0x56: {
        name: 'display other scene',
        template: 'display other scene',
        args: []
    },

    // === PRINT OPERATIONS ===

    0x39: {
        name: 'print at row 00 column 00',
        template: 'print at row {row:1} column {col:2}',
        args: ['row', 'col']
    },
    0x3A: {
        name: 'print at row [a] column [a]',
        template: 'print at row [{var:1}] column [{var:2}]',
        args: ['var', 'var']
    },
    0x3B: {
        name: 'print _____________________',
        template: 'print {string:1}',
        args: ['string']
    },
    0x3C: {
        name: 'print character of [a]',
        template: 'print character of [{var:2}]',
        args: ['unused', 'var']
    },
    0x3D: {
        name: 'print value of [a]',
        template: 'print value of [{var:2}]',
        args: ['unused', 'var']  // arg1 unused, arg2 is variable
    },
    0x3E: {
        name: 'print color= 00 on 00',
        template: 'print color= {sceneColorSlot:1} on {sceneColorSlot:2}',
        args: ['sceneColorSlot', 'sceneColorSlot']
    },
    0x3F: {
        name: 'print color=[a] on [a]',
        template: 'print color=[{var:1}] on [{var:2}]',
        args: ['var', 'var']
    },
    0x5C: {
        name: 'print on scene1',
        template: 'print on {sceneTarget:2}',
        args: ['unused', 'sceneTarget']  // arg1 unused, arg2 is scene target
    },

    // === SOUND OPERATIONS ===

    0x40: {
        name: 'sound channel 1 = [    ]',
        template: 'sound channel {channel:1+1} = {sound:2}',
        args: ['channel', 'sound']
    },
    0x41: {
        name: 'sound channel 1 off',
        template: 'sound channel {channel:2+1} off',
        args: ['unused', 'channel']
    },
    0x60: {
        name: 'song is [    ]',
        template: 'song is {song:2}',
        args: ['unused', 'song']
    },
    0x61: {
        name: 'song volume = 00',
        template: 'song volume = {volume:2}',
        args: ['unused', 'volume']
    },

    // === PLOT OPERATIONS ===

    0x4D: {
        name: 'plot color 0 to scene 1',
        // Uses plotColor (range 0-3, 0-based display) — not colorSlot. The
        // runtime masks arg1 to 2 bits so plotting with the background
        // colour (0) is legal; colorSlot would render val=3 as "4".
        template: 'plot color {plotColor:1} to scene {scene:2}',
        args: ['plotColor', 'scene']
    },
    0x4E: {
        name: 'plot color [a] to scene 1',
        template: 'plot color [{var:1}] to scene {scene:2}',
        args: ['var', 'scene']
    },
    0x4F: {
        name: 'plot a dot at x=000 y=000',
        template: 'plot a dot at x={num:1} y={num:2}',
        args: ['num', 'num']
    },
    0x50: {
        name: 'plot a dot at x=[a] y=[a]',
        template: 'plot a dot at x=[{var:1}] y=[{var:2}]',
        args: ['var', 'var']
    },

    // === PAUSE ===

    0x57: {
        name: 'pause for 00.0 seconds',
        template: 'pause for {seconds:2} seconds',
        args: ['unused', 'seconds']
    },

    // === RAM OPERATIONS ===

    0x5D: {
        name: 'set a =value at ram+[a]',
        template: 'set {var:1} =value at ram+[{var:2}]',
        args: ['var', 'var']
    },
    0x5E: {
        name: 'set value at ram+[a] =[a]',
        template: 'set value at ram+[{var:1}] =[{var:2}]',
        args: ['var', 'var']
    },
    0x5F: {
        name: 'set value at ram+[a] =000',
        template: 'set value at ram+[{var:1}] ={num:2}',
        args: ['var', 'num']
    },

    // === DEBUG ===

    0x5A: {
        name: 'trace of [a] on',
        template: 'trace of [{var:1}] {onOff:2}',
        args: ['var', 'onOff']
    },
    0x66: {
        name: 'screen update on',
        template: 'screen update {onOff:2}',
        args: ['unused', 'onOff']
    },

    // === COMMENT ===

    0x2B: {
        name: '/ comment',
        template: '/ {string:1}',
        args: ['string']
    }
};

// Type formatters - convert raw arg value to display string
const gmTypeFormatters = {
    // Variable formatter: GM uses 1-based indexing (1='a', 2='b', ... 26='z')
    // If you see '`' (backtick, ASCII 96) instead of a letter, the template is
    // referencing the wrong arg (val=0 produces charCode 96). Check that the
    // template's {var:N} matches which arg the runtime actually uses.
    var: (val) => String.fromCharCode('a'.charCodeAt(0) + val - 1),
    num: (val) => String(val).padStart(3, '0'),
    label: (val) => String(val).padStart(3, '0'),
    sprite: (val) => String(val + 1),  // 0-based in bytecode, display as 1-based
    hitTarget: (val) => {
        // 0-7 = sprite 1-8, 8 = anyone, 9 = clr2/3
        if (val <= 7) return `sprite ${val + 1}`;
        if (val === 8) return 'anyone';
        if (val === 9) return 'clr2/3';
        return `sprite ${val + 1}`;
    },
    spriteName: (val, mediaStore) => mediaStore?.[val]?.name || '[      ]',
    scene: (val) => String(val + 1),  // 0-based in bytecode, display as 1-based
    sceneTarget: (val) => {
        if (val === 0) return 'scene1';
        if (val === 1) return 'scene2';
        if (val === 2) return 'both';
        return `scene${val}`;
    },
    sceneName: (val, mediaStore) => mediaStore?.[val]?.name || '[      ]',
    score: (val) => String(val + 1),  // 0-based in bytecode, display as 1-based
    scoreValue: (val) => String(val * 10).padStart(4, '0'),
    scoreComp: (val) => String(val * 1000).padStart(6, '0'),
    color: (val) => String(val).padStart(2, '0'),
    colorSlot: (val) => String(val + 1),  // 0-indexed in bytecode, display as 1-3
    plotColor: (val) => String(val),  // Plot color: 0=bg, 1-3=scene colors. 0-based display.
    sceneColorSlot: (val) => String(val).padStart(2, '0'),  // Scene color index 0-3
    colorName: (val, _, c64ColorNames) => c64ColorNames?.[val] || `color${val}`,
    color23: (val) => String(val + 1),  // Bytecode is 1-indexed (1=color2, 2=color3)
    joystick: (val) => String(val + 1),  // 0-based in bytecode, display as 1-based
    joyDir: (val) => ['up', 'down', 'left', 'right', 'off'][val] || 'off',
    button: (val) => String(val + 1),  // 0-based in bytecode, display as 1-based
    onOff: (val) => val ? 'off' : 'on',  // 0=on, 1=off in GM bytecode
    channel: (val) => String(val + 1),  // 0-based in bytecode, display as 1-based
    sound: (val, mediaStore) => mediaStore?.[val]?.name || '[      ]',
    song: (val, mediaStore) => mediaStore?.[val]?.name || '[      ]',
    volume: (val) => String(val).padStart(2, '0'),
    row: (val) => String(val).padStart(2, '0'),
    col: (val) => String(val).padStart(2, '0'),
    seconds: (val) => (val * 0.1).toFixed(1).padStart(4, '0'),  // "00.1", "01.0", "10.0", "25.5"
    string: (val, mediaStore) => mediaStore?.[val]?.name || '_____________________',
    animSpeed: (val) => String(val).padStart(3, '0'),
    rndRange: (val) => String(val).padStart(3, '0'),
    overUnder: (val) => val ? 'under' : 'over',
    alwaysOnce: (val) => val ? 'once' : 'always',
    direction: (val) => {
        // When val lands on a cardinal byte, the cardinal label REPLACES
        // the degree readout (matches GM). Other bytes get the standard
        // "${byte}  ${deg}°" display. The type-to-search letter input
        // uses display.includes(letter) for direction (see
        // findEnumValueForKey) so e.g. 'u' picks the byte whose display
        // contains "up" — the label is at the tail, not the head.
        const tail = val === 0   ? 'up'
                   : val === 64  ? 'right'
                   : val === 128 ? 'down'
                   : val === 192 ? 'left'
                   : `${String(Math.round((val / 256) * 360)).padStart(3, '0')}°`;
        return `${String(val).padStart(3, '0')}  ${tail}`;
    },
    unused: () => ''
};

// Format an instruction for display
function formatInstruction(opcode, arg1, arg2, mediaStore, c64ColorNames) {
    const op = gmOpcodes[opcode];
    if (!op) return `??? (0x${opcode.toString(16).padStart(2, '0')})`;
    if (!op.template) return '';

    // Replace {type:argnum} or {type:argnum+offset} placeholders
    return op.template.replace(/\{(\w+):(\d)(\+(\d+))?\}/g, (match, type, argNum, _, offset) => {
        let val = argNum === '1' ? arg1 : arg2;
        if (offset) val += parseInt(offset, 10);
        const formatter = gmTypeFormatters[type];
        if (!formatter) return match;
        return formatter(val, mediaStore, c64ColorNames);
    });
}

// Instruction sort order - matches original GameMaker menu order
// This is the order instructions appear in the instruction picker
const gmInstructionSortOrder = [
    0x44, // add 0000 to score1
    0x45, // add 0000 to score[a]
    0x1E, // add [a] to score1
    0x58, // add [a] to score[a]
    0x53, // clear scene 1
    0x48, // clear score1
    0x49, // clear score[a]
    0x67, // clear sprite
    0x2B, // / comment
    0x1C, // data table at l001
    0x1D, // data values - 000 000
    0x56, // display other scene
    0x2E, // display scene X
    0x55, // endif
    0x13, // if a = 000 then
    0x14, // if a = [a] then
    0x15, // if a > 000 then
    0x16, // if a > [a] then
    0x17, // if a < 000 then
    0x18, // if a < [a] then
    0x1A, // if button 1 is on then
    0x19, // if joystick 1 is right then
    0x4A, // if score1 > 000000 then
    0x4B, // if score[a] > 000000 then
    0x4C, // if score1 > score2 then
    0x1B, // if sprite hit sprite then
    0x01, // jump to label l001
    0x02, // jump to label l[a]
    0x03, // jump to subroutine at l001
    0x04, // jump to subroutine at l[a]
    0x54, // otherwise
    0x57, // pause for 00.0 seconds
    0x4F, // plot a dot at x=000 y=000
    0x50, // plot a dot at x=[a] y=[a]
    0x4D, // plot color 0 to scene 1
    0x4E, // plot color [a] to scene 1
    0x3B, // print _____________________
    0x39, // print at row 00 column 00
    0x3A, // print at row [a] column [a]
    0x3C, // print character of [a]
    0x3E, // print color= 00 on 00
    0x3F, // print color=[a] on [a]
    0x5C, // print on scene1
    0x3D, // print value of [a]
    0x05, // return from subroutine
    0x33, // scene X background=color
    0x34, // scene X background=[var]
    0x35, // scene X border = color
    0x36, // scene X border = [var]
    0x37, // scene 1 color 1 = black
    0x38, // scene 1 color 1 = [a]
    0x28, // scene 1 is [    ]
    0x51, // scene 2 color 1 = black
    0x52, // scene 2 color 1 = [a]
    0x46, // score1 at row 00 column 00
    0x47, // score2 at row 00 column 00
    0x42, // score1 color= 0 on 0
    0x43, // score2 color= 0 on 0
    0x5B, // score1 displays on scene1
    0x66, // screen update on
    0x07, // set a = 000
    0x08, // set a = [a]
    0x0B, // set a = a + 000
    0x0C, // set a = a + [a]
    0x0D, // set a = a - 000
    0x0E, // set a = a - [a]
    0x0F, // set a = a x 000
    0x10, // set a = a x [a]
    0x11, // set a = a / 000
    0x12, // set a = a / [a]
    0x09, // set a = rnd number 0 to 001
    0x2C, // set a =sprite x position
    0x2D, // set a =sprite y position
    0x0A, // set a =value at data+[a]
    0x5D, // set a =value at ram+[a]
    0x5F, // set value at ram+[a] =000
    0x5E, // set value at ram+[a] =[a]
    0x62, // skip next if a = 000
    0x63, // skip next if a > 000
    0x64, // skip next if a < 000
    0x60, // song is [    ]
    0x61, // song volume = 00
    0x40, // sound channel 1 = [    ]
    0x41, // sound channel 1 off
    0x27, // sprite 1 is [    ]
    0x65, // sprite animates always
    0x29, // sprite animation spd =000
    0x2A, // sprite animation spd =[a]
    0x2F, // sprite color 1 =black
    0x30, // sprite color 1 =[a]
    0x23, // sprite dir =000
    0x24, // sprite dir =[a]
    0x25, // sprite movement speed=000
    0x26, // sprite movement speed=[a]
    0x31, // sprite shared colr2=black
    0x32, // sprite shared colr2=[a]
    0x59, // sprite over colors 2/3
    0x1F, // sprite x position =000
    0x20, // sprite x position =[a]
    0x21, // sprite y position =000
    0x22, // sprite y position =[a]
    0x06, // stop program
    0x5A, // trace of [a] on
];

// Make available globally for browser and Node.js testing
if (typeof globalThis !== 'undefined') {
    globalThis.gmOpcodes = gmOpcodes;
    globalThis.gmTypeFormatters = gmTypeFormatters;
    globalThis.formatInstruction = formatInstruction;
    globalThis.gmInstructionSortOrder = gmInstructionSortOrder;
}

