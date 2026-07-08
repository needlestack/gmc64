// gmc64 — thin anonymous usage telemetry.
//
// One global entry point: `gmc64Telemetry.logEvent(name, props?)`.
// Fires events at ~half a dozen instrumented sites (session start,
// d64 upload, file load, file save, game play, export, demo auto-load)
// so we can distinguish "opened tab, bounced" from "actually used it."
//
// Sends fire-and-forget POSTs to a same-origin `/api/events` endpoint
// (a Cloudflare Pages Function backed by Workers KV — see
// `functions/api/events.js`). No cookies, no PII, no beacons to
// third parties. Events never block or delay the UI.
//
// Never sends: filenames, file contents, program bytes, IPs, user
// agents. Event names + optional shallow property maps only.
//
// About standalone exports: this file is stripped from
// js/standalone-source.js by tools/bundle-standalone.js (see the
// `<!-- bundle:exclude -->` markers around the script tag in
// play.html). Exported standalone games ship with zero telemetry
// code — a self-hosted export sends nothing, ever.

(function () {
    'use strict';

    // Only fire from http(s) contexts. Under file:// the browser blocks
    // fetch() at the security-check level before any catch() can silence
    // it (it also spams the console). And under file:// there's no
    // /api/events endpoint anyway. Skip cleanly.
    const canSend = typeof location !== 'undefined'
        && (location.protocol === 'http:' || location.protocol === 'https:');

    // Fire-and-forget POST to the same-origin events endpoint.
    // - `keepalive: true` keeps the request in flight if the tab is
    //   being closed (matters for events like standalone_exported
    //   where the download click could navigate away).
    // - Same-origin, so no CORS preflight.
    // - Any failure (offline, 404, endpoint down) is caught and
    //   dropped — telemetry must never make the site feel broken.
    function sendEvent(name, props) {
        if (!canSend) return;
        try {
            fetch('/api/events', {
                method: 'POST',
                keepalive: true,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name, props: props || null }),
            }).catch(() => { /* ignore */ });
        } catch (_) {
            // never throw
        }
    }

    // Session-scoped once-only guard for events that shouldn't repeat
    // (session_engaged, demo_auto_loaded). Stored in-memory only —
    // reload = new session for our purposes.
    const fired = Object.create(null);

    function logEvent(name, props) {
        sendEvent(name, props);
    }

    function logOnce(name, props) {
        if (fired[name]) return;
        fired[name] = true;
        sendEvent(name, props);
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
