// Shared player chrome behaviors — used by play.html, editor.html's game
// overlay, and the standalone Export Game bundle. Each host owns its own
// DOM structure (they only differ around it — editor.html has additional
// dev controls in the settings popup, play.html doesn't need a stop
// button, etc.), but the icon set, joystick presets, input listeners,
// pause-icon swap, and settings persistence are all identical, so they
// live here.

globalThis.GMPlayerChrome = (function () {

    // ---------- Icons ---------------------------------------------------

    // SVG strings inlined into buttons via .innerHTML. Same viewBox,
    // stroke width, and color tokens so all four buttons visually match.
    // `currentColor` lets each host color the icons via CSS.
    const ICONS = {
        // Play: rounded triangle. Larger stroke than the others because
        // it's the hero button in the play overlay.
        play:
            '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<path d="M7 5 L19 12 L7 19 Z" fill="currentColor" stroke="currentColor" ' +
            'stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>' +
            '</svg>',

        // Pause: two rounded bars.
        pause:
            '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/>' +
            '<rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>' +
            '</svg>',

        // Resume: same triangle as play, but with a lighter stroke — used
        // on the pause button when the VM is currently paused.
        resume:
            '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<path d="M7 5 L19 12 L7 19 Z" fill="currentColor" stroke="currentColor" ' +
            'stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
            '</svg>',

        // Stop: single filled rounded square.
        stop:
            '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>' +
            '</svg>',

        // Hamburger: three rounded horizontal bars.
        hamburger:
            '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<rect x="4" y="6" width="16" height="2" rx="1" fill="currentColor"/>' +
            '<rect x="4" y="11" width="16" height="2" rx="1" fill="currentColor"/>' +
            '<rect x="4" y="16" width="16" height="2" rx="1" fill="currentColor"/>' +
            '</svg>'
    };

    // Swap a pause button between "showing pause" (VM running) and
    // "showing resume" (VM paused). Also updates aria-label.
    function setPauseIcon(btn, paused) {
        if (!btn) return;
        btn.innerHTML = paused ? ICONS.resume : ICONS.pause;
        btn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    }

    // ---------- Joystick presets ---------------------------------------

    // Each preset maps `event.key` values to a *joystick action*:
    // 'up'/'down'/'left'/'right' set the corresponding joystick direction;
    // 'fire' sets the top-level button state (buttonN, not joystickN.fire —
    // that's the field the runtime actually reads).
    //
    // Presets are joystick-agnostic here. The setup wires each preset to a
    // specific joystick number at attach time, so the same 'cursors' preset
    // can drive joystick 1 in one game and joystick 2 in another. Games
    // that overlap keys across joysticks just fire both — that's the
    // user's choice to make when they pair presets.
    //
    // 'cursors' accepts both Enter and Meta as fire so it works for
    // finger positions that expect either. 'none' is the "this joystick
    // is unused" preset.
    const PRESETS = {
        cursors: {
            ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
            Enter: 'fire', Meta: 'fire'
        },
        esdf: {
            e: 'up', E: 'up', d: 'down', D: 'down',
            s: 'left', S: 'left', f: 'right', F: 'right',
            ' ': 'fire'
        },
        wasd: {
            w: 'up', W: 'up', s: 'down', S: 'down',
            a: 'left', A: 'left', d: 'right', D: 'right',
            ' ': 'fire'
        },
        ijkl: {
            i: 'up', I: 'up', k: 'down', K: 'down',
            j: 'left', J: 'left', l: 'right', L: 'right',
            Enter: 'fire'
        },
        none: {}
    };

    // Human-readable labels for populating the settings dropdowns.
    // Order here becomes the display order in the UI.
    const PRESET_LABELS = [
        ['cursors', 'Arrow keys + Enter'],
        ['esdf', 'ESDF + Space'],
        ['wasd', 'WASD + Space'],
        ['ijkl', 'IJKL + Enter'],
        ['none', '(off)']
    ];

    // Attach keydown/keyup listeners to `window`. On each event, look up
    // both joysticks' presets and mutate `inputState` accordingly.
    //
    // `getPresets()` returns { joy1: 'cursors', joy2: 'esdf' } — read at
    // event time so preset changes take effect immediately without
    // reattaching. `isEnabled()` gates event handling (games with no VM
    // running or a paused game shouldn't consume presses).
    //
    // Returns a `detach()` function for cleanup — useful for the editor
    // where the overlay comes and goes.
    function setupInputListeners({ inputState, getPresets, isEnabled }) {
        function applyKey(key, active, e) {
            const { joy1, joy2 } = getPresets();
            let consumed = false;
            const m1 = PRESETS[joy1] || {};
            const m2 = PRESETS[joy2] || {};

            const act1 = m1[key];
            if (act1) {
                if (act1 === 'fire') inputState.button1 = active;
                else inputState.joystick1[act1] = active;
                consumed = true;
            }
            const act2 = m2[key];
            if (act2) {
                if (act2 === 'fire') inputState.button2 = active;
                else inputState.joystick2[act2] = active;
                consumed = true;
            }
            if (consumed && e) e.preventDefault();
        }

        // Clear all four direction booleans on both joysticks. Used as a
        // recovery step when we can't trust that we saw all keyup events
        // (see onUp's Meta handling and the focus-loss listeners below).
        function clearAllDirections() {
            inputState.joystick1.up = false;
            inputState.joystick1.down = false;
            inputState.joystick1.left = false;
            inputState.joystick1.right = false;
            inputState.joystick2.up = false;
            inputState.joystick2.down = false;
            inputState.joystick2.left = false;
            inputState.joystick2.right = false;
        }

        // Full clear — everything to false. Used on focus loss so games
        // never end up with stranded held-key state after alt-tab, tab
        // switch, screen lock, or the browser losing focus for any reason.
        function clearAllInput() {
            clearAllDirections();
            inputState.button1 = false;
            inputState.button2 = false;
        }

        function onDown(e) { if (isEnabled()) applyKey(e.key, true, e); }

        // Meta (Cmd) keyup gets special treatment: on macOS, browsers
        // suppress keyup events for other keys while Cmd is held. That
        // means if the user holds ArrowRight, presses Cmd, then releases
        // ArrowRight while still holding Cmd, we never see the ArrowRight
        // keyup — joystick.right stays true even after the user let go.
        // Result: the ship keeps moving right until they press-and-release
        // it again. Longstanding platform quirk, not fixable at our
        // handler level.
        //
        // Workaround: on Meta keyup, conservatively clear all direction
        // booleans. Anything that was released during the Cmd-down window
        // gets un-stuck. A user still legitimately holding a direction
        // sees a brief pause and continues on the next auto-repeat
        // keydown (browsers keep firing those while a key is held) — a
        // minor UX quirk in exchange for no more stuck ship.
        function onUp(e) {
            if (!isEnabled()) return;
            applyKey(e.key, false, e);
            if (e.key === 'Meta') clearAllDirections();
        }

        // Capture phase so we run before any bubble-phase listeners that
        // might call stopImmediatePropagation (e.g., the editor's blocker
        // that stops editor shortcuts from firing during gameplay). We
        // preventDefault on matched keys but don't stop propagation
        // ourselves — the host's other handlers still get to run.
        window.addEventListener('keydown', onDown, true);
        window.addEventListener('keyup', onUp, true);

        // Belt-and-suspenders for the general "keys were held when focus
        // went away" case: alt-tab, screen lock, tab switch, browser lost
        // focus for any reason. Wipes everything so nothing carries over.
        function onFocusLoss() { clearAllInput(); }
        function onVisibilityChange() {
            if (document.hidden) clearAllInput();
        }
        window.addEventListener('blur', onFocusLoss);
        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            window.removeEventListener('keydown', onDown, true);
            window.removeEventListener('keyup', onUp, true);
            window.removeEventListener('blur', onFocusLoss);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }

    // ---------- Settings persistence -----------------------------------

    // Each host uses a different localStorage key so a user's preset
    // choice in the editor doesn't leak into play.html and vice versa —
    // people may want different mappings for the two contexts.
    function loadInputSettings(storageKey, defaults) {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return { ...defaults };
            const parsed = JSON.parse(raw);
            return { ...defaults, ...parsed };
        } catch (e) {
            return { ...defaults };
        }
    }

    function saveInputSettings(storageKey, settings) {
        try {
            localStorage.setItem(storageKey, JSON.stringify(settings));
        } catch (e) {
            // Quota exceeded or private mode — settings just don't stick.
        }
    }

    // Default choice used by every host: cursors for joystick 1, ESDF for
    // joystick 2. Matches the hardcoded mappings that used to live in each
    // host, so existing muscle memory carries over.
    const DEFAULT_INPUT_SETTINGS = { joy1: 'cursors', joy2: 'esdf' };

    // ---------- Public API ---------------------------------------------

    return {
        ICONS,
        PRESETS,
        PRESET_LABELS,
        DEFAULT_INPUT_SETTINGS,
        setPauseIcon,
        setupInputListeners,
        loadInputSettings,
        saveInputSettings
    };
})();
