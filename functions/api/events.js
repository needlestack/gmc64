// Cloudflare Pages Function — accepts a single telemetry event from
// js/telemetry.js and records it in Workers KV.
//
// Route: POST https://gmc64.com/api/events
// Body:  { name: "d64_uploaded", props?: {...} }   (JSON, tiny)
//
// Bindings required (set once in the CF Pages dashboard →
// Settings → Functions → KV namespace bindings):
//     EVENTS_KV → any Workers KV namespace we'll own
//
// Storage layout — one KV entry per event, keyed by
//     evt:<event_name>:<ISO-timestamp>-<nonce>
// so `list({prefix: 'evt:'})` returns everything and
// `list({prefix: 'evt:d64_uploaded:'})` returns just that event.
// The random nonce prevents key collisions when two clients fire
// the same event in the same millisecond.
//
// Every response is 204 No Content. We never leak an error to the
// client — a misbehaving or hostile POSTer shouldn't be able to
// probe our storage, and telemetry must never make the site feel
// broken.

const ALLOWED_EVENTS = new Set([
    'session_engaged',
    'demo_auto_loaded',
    'd64_uploaded',
    'file_loaded',
    'file_saved',
    'game_played',
    'standalone_exported',
]);

// 30-day retention. Long enough to spot trends, short enough that
// storage stays trivial. Extend later if we ever want longer-term
// aggregation.
const RETAIN_SECONDS = 60 * 60 * 24 * 30;

export async function onRequestPost(context) {
    const { request, env } = context;

    // If KV isn't bound yet (fresh deploy before someone clicks the
    // dashboard binding step), succeed silently rather than 500ing.
    if (!env.EVENTS_KV) return new Response(null, { status: 204 });

    let body;
    try {
        body = await request.json();
    } catch {
        return new Response(null, { status: 204 });
    }

    const name = String(body?.name || '');
    if (!ALLOWED_EVENTS.has(name)) {
        // Silent — someone POSTing arbitrary event names doesn't get
        // to fill our KV with junk, and probing for what we accept
        // gives back nothing useful.
        return new Response(null, { status: 204 });
    }

    const ts = new Date().toISOString();
    const nonce = Math.random().toString(36).slice(2, 8);
    const key = `evt:${name}:${ts}-${nonce}`;

    // Keep the value small — just the timestamp and any shallow
    // props the client sent. No IPs, no user agents, no request
    // headers, no cookies.
    const value = JSON.stringify({
        ts,
        props: body?.props || null,
    });

    try {
        await env.EVENTS_KV.put(key, value, { expirationTtl: RETAIN_SECONDS });
    } catch {
        // KV write can fail transiently. Swallow — worst case we
        // lose a single event.
    }
    return new Response(null, { status: 204 });
}
