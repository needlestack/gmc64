// gmc64 — thin, provider-agnostic anonymous usage telemetry.
//
// One global entry point: `gmc64Telemetry.logEvent(name, props?)`.
// Fires events at ~half a dozen instrumented sites (session start,
// d64 upload, file load, file save, game play, export, demo auto-load)
// so we can distinguish "opened tab, bounced" from "actually used it."
//
// This wrapper is provider-agnostic:
//   - If Cloudflare Web Analytics is enabled on the site (its beacon
//     script is loaded), events are sent there.
//   - Otherwise the call is a silent no-op — no throws, no console
//     noise, no fetch-to-nowhere.
//
// Never sends: filenames, file contents, program bytes, IPs, or
// anything that could identify a specific user or creation. Event
// names + optional shallow property maps only.
//
// About standalone exports: the exported bundle *does* include this
// script, but the CF Web Analytics beacon script is only injected on
// the domain that owns the CF Web Analytics site (gmc64.com). So an
// exported game hosted anywhere else — a personal domain, GitHub
// Pages, file:// — silently no-ops. No cross-site tracking, no
// beacon-to-nowhere. It just quietly does nothing.

(function () {
    'use strict';

    // Provider-specific senders. First one that returns truthy wins;
    // rest are skipped. Add new providers by appending here.
    const senders = [
        // Cloudflare Web Analytics custom events. The beacon script
        // installs a global; we probe the two documented shapes.
        function cloudflare(name, props) {
            if (typeof window === 'undefined') return false;
            const b = window.__cfBeacon;
            if (!b) return false;
            try {
                if (typeof b.sendCustomEvent === 'function') {
                    b.sendCustomEvent(name, props || {});
                    return true;
                }
                // Older / queued form
                if (Array.isArray(b.q) || typeof b.push === 'function') {
                    (b.q || b).push(['event', name, props || {}]);
                    return true;
                }
            } catch (_) { /* fall through */ }
            return false;
        },

        // Plausible (if the user ever adds `<script data-domain="…"
        // src="…plausible.js">`, this picks it up automatically).
        function plausible(name, props) {
            if (typeof window === 'undefined') return false;
            if (typeof window.plausible !== 'function') return false;
            try {
                window.plausible(name, props ? { props } : undefined);
                return true;
            } catch (_) {
                return false;
            }
        },
    ];

    // Session-scoped once-only guard for events that shouldn't repeat
    // (session_engaged, demo_auto_loaded). Stored in-memory only —
    // reload = new session for our purposes.
    const fired = Object.create(null);

    function logEvent(name, props) {
        try {
            for (const sender of senders) {
                if (sender(name, props)) return;
            }
        } catch (_) {
            // Telemetry must never break the app.
        }
    }

    function logOnce(name, props) {
        if (fired[name]) return;
        fired[name] = true;
        logEvent(name, props);
    }

    window.gmc64Telemetry = { logEvent, logOnce };

    // Auto-fire session_engaged on the first real user interaction. Kept
    // in the wrapper (not sprinkled at each editor's init) because it's a
    // property of the session, not any particular editor. Distinguishes
    // "opened a tab, bounced" from "actually touched something."
    if (typeof document !== 'undefined') {
        const onFirstInteraction = () => {
            logOnce('session_engaged');
            document.removeEventListener('pointerdown', onFirstInteraction, true);
            document.removeEventListener('keydown', onFirstInteraction, true);
        };
        document.addEventListener('pointerdown', onFirstInteraction, { capture: true, once: true, passive: true });
        document.addEventListener('keydown',     onFirstInteraction, { capture: true, once: true });
    }
})();
