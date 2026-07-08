// Cloudflare Pages Function — aggregates telemetry from KV.
//
// Route: GET https://gmc64.com/api/stats?token=<STATS_TOKEN>
//
// Bindings required:
//     EVENTS_KV   → same Workers KV events.js writes to
//     STATS_TOKEN → env var (Pages → Settings → Environment vars).
//                   Any string, kept secret. Only requests that pass
//                   ?token=<value> get a real response.
//
// Returns JSON:
//     {
//         "total": 42,
//         "by_event": { "d64_uploaded": 5, "game_played": 12, ... },
//         "generated_at": "2026-07-08T…"
//     }
//
// Wrong / missing token → 404 (masquerading as "no such route") so
// probers get zero signal about whether this endpoint exists.

export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (!env.STATS_TOKEN || url.searchParams.get('token') !== env.STATS_TOKEN) {
        return new Response('Not found', { status: 404 });
    }

    if (!env.EVENTS_KV) {
        return new Response(
            JSON.stringify({ total: 0, by_event: {}, generated_at: new Date().toISOString() }, null, 2),
            { headers: { 'content-type': 'application/json' } }
        );
    }

    // KV list() returns at most 1000 keys per call. Paginate until
    // list_complete comes back true. For gmc64's write volume this
    // is one page for years to come, but doing it right is trivial.
    const byEvent = {};
    let total = 0;
    let cursor;
    do {
        const res = await env.EVENTS_KV.list({ prefix: 'evt:', cursor });
        for (const k of res.keys) {
            // Key: evt:<name>:<ts>-<nonce>
            const name = k.name.split(':')[1] || 'unknown';
            byEvent[name] = (byEvent[name] || 0) + 1;
            total++;
        }
        cursor = res.list_complete ? null : res.cursor;
    } while (cursor);

    // Sort event names for a stable, glanceable order.
    const sortedByEvent = Object.fromEntries(
        Object.entries(byEvent).sort(([a], [b]) => a.localeCompare(b))
    );

    return new Response(
        JSON.stringify({
            total,
            by_event: sortedByEvent,
            generated_at: new Date().toISOString(),
        }, null, 2),
        { headers: { 'content-type': 'application/json' } }
    );
}
