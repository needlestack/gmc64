// Cloudflare Worker for gmc64.com.
//
// We're on the "Workers with Static Assets" model (the modern CF unified
// pipeline), NOT legacy Pages Functions. That means the `functions/`
// directory doesn't auto-route — we own the router explicitly here.
//
// Route table:
//   POST /api/events    → record a telemetry event in KV
//   GET  /api/stats     → aggregate KV → JSON (gated by STATS_TOKEN)
//   *                   → static asset via env.ASSETS
//
// Bindings expected (set once in the CF dashboard):
//   ASSETS      — auto-created by CF from the wrangler.jsonc `assets` field
//   EVENTS_KV   — Workers KV namespace, added via Bindings tab
//   STATS_TOKEN — secret env var, added via Settings → Variables and secrets

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
// storage stays trivial.
const RETAIN_SECONDS = 60 * 60 * 24 * 30;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/api/events' && request.method === 'POST') {
            return handleEventPost(request, env);
        }
        if (url.pathname === '/api/stats' && request.method === 'GET') {
            return handleStatsGet(url, env);
        }
        // Everything else: static site served from the repo root.
        return env.ASSETS.fetch(request);
    },
};

// ---- /api/events (POST) ----------------------------------------------------
// Accepts a single telemetry event from js/telemetry.js and records it in KV.
// Silent 204 on any error — a hostile POSTer shouldn't be able to probe our
// storage, and telemetry must never make the site feel broken.
async function handleEventPost(request, env) {
    if (!env.EVENTS_KV) return new Response(null, { status: 204 });

    let body;
    try {
        body = await request.json();
    } catch {
        return new Response(null, { status: 204 });
    }

    const name = String(body?.name || '');
    if (!ALLOWED_EVENTS.has(name)) return new Response(null, { status: 204 });

    // Key layout: `evt:<name>:<ts>-<nonce>` so we can list-by-prefix per event
    // and never collide when two clients fire the same event simultaneously.
    const ts = new Date().toISOString();
    const nonce = Math.random().toString(36).slice(2, 8);
    const key = `evt:${name}:${ts}-${nonce}`;

    // Small value: timestamp and any shallow client-supplied props.
    // No IPs, no user agents, no headers, no cookies.
    const value = JSON.stringify({ ts, props: body?.props || null });

    try {
        await env.EVENTS_KV.put(key, value, { expirationTtl: RETAIN_SECONDS });
    } catch {
        // Transient KV write failures — swallow. Worst case, we lose one event.
    }
    return new Response(null, { status: 204 });
}

// ---- /api/stats (GET) ------------------------------------------------------
// Aggregates all KV keys by event name, returns JSON. Gated behind
// STATS_TOKEN; wrong or missing token → 404 so probers can't tell the
// endpoint exists.
async function handleStatsGet(url, env) {
    if (!env.STATS_TOKEN || url.searchParams.get('token') !== env.STATS_TOKEN) {
        return new Response('Not found', { status: 404 });
    }

    if (!env.EVENTS_KV) {
        return jsonResponse({ total: 0, by_event: {}, generated_at: new Date().toISOString() });
    }

    // KV list() returns at most 1000 keys per call; paginate until done.
    const byEvent = {};
    let total = 0;
    let cursor;
    do {
        const res = await env.EVENTS_KV.list({ prefix: 'evt:', cursor });
        for (const k of res.keys) {
            const name = k.name.split(':')[1] || 'unknown';
            byEvent[name] = (byEvent[name] || 0) + 1;
            total++;
        }
        cursor = res.list_complete ? null : res.cursor;
    } while (cursor);

    const sortedByEvent = Object.fromEntries(
        Object.entries(byEvent).sort(([a], [b]) => a.localeCompare(b))
    );
    return jsonResponse({ total, by_event: sortedByEvent, generated_at: new Date().toISOString() });
}

function jsonResponse(obj) {
    return new Response(JSON.stringify(obj, null, 2), {
        headers: { 'content-type': 'application/json' },
    });
}
