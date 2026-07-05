// gmTouchControls.js — Virtual joystick + fire button overlay for mobile play.
//
// Mounts translucent controls onto the game canvas that write directly to the
// global inputState the VM reads each frame. Both play.html and editor.html
// (in play mode) use it.
//
// Usage:
//     const controls = GMTouchControls.mount(hostEl, { inputState });
//     // ... later ...
//     controls.unmount();
//
// Options:
//   inputState  — the object with joystick1/button1 fields (defaults to globalThis.inputState)
//   port        — which joystick port to write to (1 or 2, default 1)
//
// Device detection: shown only on touch-primary devices with a small viewport
// (phone-sized). Tablets and desktops keep the keyboard-driven UX. Use
// GMTouchControls.deviceMode() for the classification helper.

const GMTouchControls = {
    // === DEVICE CLASSIFICATION ===
    // "phone"   — small touch device (< 900px wide, coarse pointer). Full
    //             mobile treatment: hide chrome, show virtual controls.
    // "tablet"  — large touch device. Show virtual controls but keep the
    //             desktop chrome; user has room for both.
    // "desktop" — non-touch or fine-pointer. No virtual controls at all;
    //             keyboard driving.
    deviceMode() {
        const coarse = matchMedia('(pointer: coarse)').matches;
        const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        if (!coarse && !hasTouch) return 'desktop';
        const small = window.innerWidth < 900;
        return small ? 'phone' : 'tablet';
    },

    // Simple boolean for "should we show virtual controls?" — true for both
    // phones and tablets; only desktops are excluded.
    shouldShowControls() {
        return this.deviceMode() !== 'desktop';
    },

    // Simple boolean for "should we hide the desktop chrome?" — phones only.
    // Tablets keep the chrome because they have screen real-estate for it.
    isPhoneLayout() {
        return this.deviceMode() === 'phone';
    },

    // === MOUNT ===
    mount(hostEl, { inputState = globalThis.inputState, port = 1 } = {}) {
        if (!inputState) throw new Error('GMTouchControls.mount: no inputState provided');
        if (this.shouldShowControls() === false) {
            return { unmount() {}, updateActiveJoystick() {} };
        }

        // === DOM ===
        // Single overlay element positioned absolutely over the host, holding
        // the joystick region on the left and the fire button on the right.
        // Everything uses `touch-action: none` so browser gestures (pinch,
        // scroll, double-tap zoom) don't interfere with game input.
        const overlay = document.createElement('div');
        overlay.className = 'gm-touch-overlay';

        const joystickEl = document.createElement('div');
        joystickEl.className = 'gm-touch-joystick';
        const puckEl = document.createElement('div');
        puckEl.className = 'gm-touch-joystick-puck';
        joystickEl.appendChild(puckEl);

        const fireEl = document.createElement('div');
        fireEl.className = 'gm-touch-fire';
        fireEl.textContent = '●';   // filled dot — reads as "button"

        overlay.appendChild(joystickEl);
        overlay.appendChild(fireEl);
        hostEl.appendChild(overlay);

        // === STATE ===
        // Track active touch identifiers so multi-touch works: joystick and
        // fire can be held simultaneously without either canceling the other.
        // When a finger moves off its zone, we keep its identifier bound to
        // the zone it started in — matches real d-pad/button behaviour.
        let joyTouchId = null;
        let fireTouchId = null;
        let joyCenterX = 0;
        let joyCenterY = 0;
        const JOY_DEADZONE = 12;     // pixels from center where no direction registers
        const JOY_MAX_OFFSET = 45;   // puck can move this far from center
        const joyKey = port === 2 ? 'joystick2' : 'joystick1';
        const btnKey = port === 2 ? 'button2'   : 'button1';

        // === EVENT HANDLERS ===
        // Refresh joystick center after any layout change (rotation, fullscreen).
        function refreshJoyCenter() {
            const rect = joystickEl.getBoundingClientRect();
            joyCenterX = rect.left + rect.width / 2;
            joyCenterY = rect.top + rect.height / 2;
        }

        function resetJoystickState() {
            inputState[joyKey].up = false;
            inputState[joyKey].down = false;
            inputState[joyKey].left = false;
            inputState[joyKey].right = false;
            puckEl.style.transform = '';
            joystickEl.classList.remove('gm-touch-active');
        }

        // Given a touch's page position relative to joystick center, update
        // the four boolean directions on inputState AND move the puck. Uses
        // an 8-way angular resolve with a small dead zone.
        function updateJoystick(touchX, touchY) {
            const dx = touchX - joyCenterX;
            const dy = touchY - joyCenterY;
            const dist = Math.hypot(dx, dy);

            // Puck follows finger but clamped to a max radius
            const clampedDist = Math.min(dist, JOY_MAX_OFFSET);
            const puckX = dist > 0 ? (dx / dist) * clampedDist : 0;
            const puckY = dist > 0 ? (dy / dist) * clampedDist : 0;
            puckEl.style.transform = `translate(${puckX}px, ${puckY}px)`;

            if (dist < JOY_DEADZONE) {
                inputState[joyKey].up = false;
                inputState[joyKey].down = false;
                inputState[joyKey].left = false;
                inputState[joyKey].right = false;
                return;
            }

            // 8-way octant resolve. Angle 0 = right; positive = down.
            // Boundaries at every 22.5° (halfway between adjacent octants).
            const angle = Math.atan2(dy, dx);
            const deg = (angle * 180 / Math.PI + 360) % 360;
            inputState[joyKey].right = deg >= 292.5 || deg < 67.5;
            inputState[joyKey].down  = deg >= 22.5  && deg < 157.5;
            inputState[joyKey].left  = deg >= 112.5 && deg < 247.5;
            inputState[joyKey].up    = deg >= 202.5 && deg < 337.5;
        }

        function onTouchStart(e) {
            for (const t of e.changedTouches) {
                const target = document.elementFromPoint(t.clientX, t.clientY);
                if (!target) continue;
                // Joystick — the whole left region is receptive so the user
                // doesn't have to land precisely on the puck.
                if (joyTouchId === null && (target === joystickEl || target === puckEl || joystickEl.contains(target))) {
                    joyTouchId = t.identifier;
                    refreshJoyCenter();
                    joystickEl.classList.add('gm-touch-active');
                    updateJoystick(t.clientX, t.clientY);
                    e.preventDefault();
                    continue;
                }
                // Fire button
                if (fireTouchId === null && (target === fireEl || fireEl.contains(target))) {
                    fireTouchId = t.identifier;
                    inputState[btnKey] = true;
                    fireEl.classList.add('gm-touch-active');
                    e.preventDefault();
                    continue;
                }
            }
        }

        function onTouchMove(e) {
            for (const t of e.changedTouches) {
                if (t.identifier === joyTouchId) {
                    updateJoystick(t.clientX, t.clientY);
                    e.preventDefault();
                }
                // Fire button is binary — no move handling needed for it
            }
        }

        function onTouchEnd(e) {
            for (const t of e.changedTouches) {
                if (t.identifier === joyTouchId) {
                    joyTouchId = null;
                    resetJoystickState();
                }
                if (t.identifier === fireTouchId) {
                    fireTouchId = null;
                    inputState[btnKey] = false;
                    fireEl.classList.remove('gm-touch-active');
                }
            }
        }

        // Attach at the overlay level (not window) so touches outside the
        // controls don't accidentally trigger them.
        overlay.addEventListener('touchstart', onTouchStart, { passive: false });
        overlay.addEventListener('touchmove',  onTouchMove,  { passive: false });
        overlay.addEventListener('touchend',   onTouchEnd,   { passive: false });
        overlay.addEventListener('touchcancel', onTouchEnd,  { passive: false });

        // Recompute joystick center on rotation/resize/fullscreen — the
        // element moves around visually and getBoundingClientRect() lies
        // if we cached it from before.
        window.addEventListener('resize', refreshJoyCenter);
        window.addEventListener('orientationchange', refreshJoyCenter);

        return {
            unmount() {
                overlay.remove();
                window.removeEventListener('resize', refreshJoyCenter);
                window.removeEventListener('orientationchange', refreshJoyCenter);
            },
            // For hosts that dynamically change joystick port (unusual)
            setPort(newPort) { /* reserved for later */ },
        };
    },
};

if (typeof globalThis !== 'undefined') {
    globalThis.GMTouchControls = GMTouchControls;
}
