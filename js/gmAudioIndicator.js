// gmAudioIndicator — speaker-icon button that shows + toggles audio state.
//
// One control, two visual states (muted / unmuted), reused across every
// surface that renders a game: the editor's play overlay, the eventual
// headless game export, and any future embed iframe. Centralising it
// here means audio UX stays consistent — and a single click on the icon
// is both the user-gesture handler the browser autoplay policy requires
// AND the unmute toggle the user expects.
//
// "Muted" is the *effective* state: the icon shows a strike-through
// speaker when the user has explicitly muted OR when the AudioContext is
// browser-suspended. The user doesn't need to know the difference; one
// click resolves both.
//
// Wiring:
//
//   const indicator = new GMAudioIndicator(parentEl);
//   indicator.bind({
//       getMuted:        () => audioMuted,
//       setMuted:        (m) => { audioMuted = m; vm.setConfig({audioMuted: m}); },
//       getAudioContext: () => audioContext,
//       onUnlock:        () => { /* restart song, etc. */ }
//   });
//   // call indicator.refresh() any time external state changes.

class GMAudioIndicator {
    constructor(parent) {
        const btn = document.createElement('button');
        btn.className = 'gm-audio-indicator';
        btn.type = 'button';
        btn.title = 'Toggle sound';
        btn.setAttribute('aria-label', 'Toggle sound');
        parent.appendChild(btn);

        this.btn = btn;
        this.binding = null;
        this._renderedMuted = null; // last drawn state, for skip-if-unchanged

        btn.addEventListener('click', () => this._onClick());

        // Initial render — assume muted until bound and told otherwise.
        this._render(true);
    }

    bind({ getMuted, setMuted, getAudioContext, onUnlock }) {
        this.binding = { getMuted, setMuted, getAudioContext, onUnlock };
        this.refresh();
    }

    refresh() {
        // Lazy-attach the statechange listener the first time we see a
        // real AudioContext. Bind may have happened before the host
        // created the context (the editor lazy-inits audio on first run),
        // so we can't rely on context existing at bind time.
        if (this.binding && !this._statechangeAttached) {
            const ctx = this.binding.getAudioContext?.();
            if (ctx && typeof ctx.addEventListener === 'function') {
                ctx.addEventListener('statechange', () => this.refresh());
                this._statechangeAttached = true;
            }
        }
        this._render(this._isEffectivelyMuted());
    }

    _isEffectivelyMuted() {
        if (!this.binding) return true;
        if (this.binding.getMuted()) return true;
        const ctx = this.binding.getAudioContext?.();
        if (ctx && ctx.state === 'suspended') return true;
        return false;
    }

    _onClick() {
        if (!this.binding) return;
        const wasMuted = this._isEffectivelyMuted();
        if (wasMuted) {
            // Unmute path: clear user mute, resume context (if suspended —
            // and this click is the user gesture that lets resume() actually
            // work), then notify host so it can restart any song that lost
            // its scheduling window during the suspension.
            this.binding.setMuted(false);
            const ctx = this.binding.getAudioContext?.();
            if (ctx && ctx.state === 'suspended') {
                ctx.resume().then(() => {
                    if (this.binding.onUnlock) this.binding.onUnlock();
                    this.refresh();
                });
            }
        } else {
            this.binding.setMuted(true);
        }
        this.refresh();
    }

    _render(muted) {
        if (this._renderedMuted === muted) return;
        this._renderedMuted = muted;
        this.btn.classList.toggle('muted', muted);
        this.btn.innerHTML = this._iconHTML(muted);
    }

    _iconHTML(muted) {
        // Simple inline SVG — speaker cone with optional sound-waves
        // (unmuted) or a strike-through (muted). currentColor lets CSS
        // recolour the whole icon.
        const speaker = '<path d="M3 9v6h4l5 4V5L7 9H3z" fill="currentColor"/>';
        const waves   = '<path d="M14 8a4 4 0 0 1 0 8M17 5a8 8 0 0 1 0 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
        const slash   = '<line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>';
        const body = muted ? speaker + slash : speaker + waves;
        return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
    }
}

// Make available globally for browser <script> loads and Node.js ESM imports.
if (typeof globalThis !== 'undefined') {
    globalThis.GMAudioIndicator = GMAudioIndicator;
}
