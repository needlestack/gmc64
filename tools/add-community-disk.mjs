// tools/add-community-disk.mjs
//
// Add a .d64 to disks/community/ with an auto-generated poster PNG and
// a manifest entry. Uses play.html + Puppeteer to render the poster
// exactly the way visitors will see it in the listing.
//
// Usage:
//   node tools/add-community-disk.mjs <disk.d64> \
//       --title "Space Blaster" \
//       --credit "Alice" \
//       [--description "Brief blurb"] \
//       [--file GAME/PRG]        (required if disk has 2+ PRGs)
//       [--poster-seconds 8]     (default 8; capped at 10 by play.html)
//       [--slug space-blaster]   (default: slugified title)
//
// Output:
//   disks/community/<slug>.d64
//   disks/community/<slug>.png
//   disks/community/manifest.json  (entry appended)

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, statSync } from 'fs';
import { dirname, join, resolve, basename, extname, normalize } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import puppeteer from 'puppeteer';
import { bootstrap } from './node-bootstrap.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..');
const COMMUNITY  = join(ROOT, 'disks/community');
const MANIFEST   = join(COMMUNITY, 'manifest.json');

function usage(msg) {
    if (msg) console.error('error:', msg);
    console.error(readFileSync(__filename, 'utf8')
        .split('\n')
        .filter(l => l.startsWith('//'))
        .slice(0, 20).join('\n'));
    process.exit(1);
}

function parseArgs(argv) {
    const opts = { posterSeconds: 8 };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { rest.push(a); continue; }
        const key = a.slice(2);
        const val = argv[++i];
        if (val === undefined) usage(`missing value for --${key}`);
        switch (key) {
            case 'title':          opts.title = val; break;
            case 'credit':         opts.credit = val; break;
            case 'description':    opts.description = val; break;
            case 'file':           opts.file = val; break;
            case 'poster-seconds': opts.posterSeconds = parseFloat(val); break;
            case 'slug':           opts.slug = val; break;
            default: usage(`unknown option --${key}`);
        }
    }
    if (rest.length !== 1) usage('exactly one positional argument (the .d64 path) is required');
    opts.disk = rest[0];
    if (!opts.title)  usage('--title is required');
    if (!opts.credit) usage('--credit is required');
    if (!existsSync(opts.disk)) usage(`disk not found: ${opts.disk}`);
    return opts;
}

// URL-friendly slug — lowercase, alphanumerics + dashes only, no leading
// or trailing dashes. Used as the on-disk basename for both the .d64
// and the poster PNG.
function slugify(s) {
    return s.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function pickPrg(diskPath, requestedFile) {
    const gm = await bootstrap();
    const disk = new gm.D64(new Uint8Array(readFileSync(diskPath)));
    const prgs = disk.getDirectory()
        .filter(e => /\/PRG$/i.test(e.fileName))
        .map(e => e.fileName);
    if (requestedFile) {
        // Case-insensitive lookup so submitters don't have to match padding.
        const hit = prgs.find(n => n.toUpperCase() === requestedFile.toUpperCase());
        if (!hit) usage(`--file "${requestedFile}" not on disk. PRGs: ${prgs.join(', ')}`);
        return hit;
    }
    if (prgs.length === 0) usage('disk has no /PRG files');
    if (prgs.length === 1) return prgs[0];
    usage(`disk has ${prgs.length} PRGs — pass --file to pick one. Options: ${prgs.join(', ')}`);
}

// Minimal static file server rooted at the repo. play.html can't
// `fetch()` sibling files when the page itself is loaded from file://
// (Chrome CORS-blocks cross-origin fetches on the `null` origin), so
// serve everything from a real http:// origin instead. Uses ephemeral
// ports so multiple invocations don't collide.
const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.d64':  'application/octet-stream',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.woff2':'font/woff2',
};
function startStaticServer(rootDir) {
    return new Promise((resolveReady) => {
        const server = createServer((req, res) => {
            const urlPath = decodeURIComponent(req.url.split('?')[0]);
            const fsPath = normalize(join(rootDir, urlPath));
            if (!fsPath.startsWith(rootDir)) { res.writeHead(403); return res.end(); }
            try {
                const st = statSync(fsPath);
                if (st.isDirectory()) { res.writeHead(404); return res.end(); }
                const mime = MIME[extname(fsPath).toLowerCase()] || 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size });
                res.end(readFileSync(fsPath));
            } catch (e) {
                res.writeHead(404); res.end();
            }
        });
        server.listen(0, '127.0.0.1', () => resolveReady({
            port: server.address().port,
            close: () => new Promise(r => server.close(r))
        }));
    });
}

async function capturePoster({ diskAbsPath, fileName, posterSeconds, outPath }) {
    const srv = await startStaticServer(ROOT);
    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await browser.newPage();
        page.on('pageerror', err => console.warn('play.html error:', err.message));
        // 2x device scale — poster looks crisp on high-DPI displays without
        // needing a separately-sized capture step.
        await page.setViewport({ width: 640, height: 400, deviceScaleFactor: 2 });

        // Path relative to the repo root — the static server treats ROOT
        // as its docroot, so the same URL will also work in production.
        const diskUrlPath = '/' + diskAbsPath.substring(ROOT.length).replace(/^\/+/, '');
        const params = new URLSearchParams({
            disk: diskUrlPath,
            file: fileName,
            poster_seconds: String(posterSeconds),
            nocredit: '1'
        });
        const url = `http://127.0.0.1:${srv.port}/play.html?${params}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        // proceedWithProgram runs generatePoster() and stores the promise
        // on window.__posterReady. Wait for it to appear, then await it.
        await page.waitForFunction(() => window.__posterReady !== undefined, { timeout: 15000 });
        await page.evaluate(() => window.__posterReady);

        // Hide the play button overlay so the screenshot is just the game
        // frame — otherwise the "▶" would sit in the middle of every poster.
        await page.evaluate(() => {
            const o = document.getElementById('playOverlay');
            if (o) o.classList.remove('active');
        });

        const canvas = await page.$('#gameCanvas');
        if (!canvas) throw new Error('play.html has no #gameCanvas');
        await canvas.screenshot({ path: outPath });
    } finally {
        await browser.close();
        await srv.close();
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(COMMUNITY)) mkdirSync(COMMUNITY, { recursive: true });

    const slug = opts.slug || slugify(opts.title);
    if (!slug) usage('slug came out empty — pass --slug explicitly');
    const diskOut   = join(COMMUNITY, `${slug}.d64`);
    const posterOut = join(COMMUNITY, `${slug}.png`);

    // Refuse to clobber an existing entry — submitter should bump the slug
    // instead. Manifest dedupe is enforced on the append step below too.
    if (existsSync(diskOut))   usage(`already exists: ${diskOut} (pass a different --slug)`);
    if (existsSync(posterOut)) usage(`already exists: ${posterOut}`);

    const fileName = await pickPrg(opts.disk, opts.file);
    console.log(`slug: ${slug}\ntitle: ${opts.title}\ncredit: ${opts.credit}\nfile: ${fileName}`);

    copyFileSync(opts.disk, diskOut);
    console.log(`copied ${basename(opts.disk)} → ${diskOut}`);

    console.log(`rendering poster (poster_seconds=${opts.posterSeconds})…`);
    await capturePoster({
        diskAbsPath:  diskOut,
        fileName,
        posterSeconds: opts.posterSeconds,
        outPath:      posterOut
    });
    console.log(`wrote ${posterOut}`);

    const manifest = existsSync(MANIFEST)
        ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
        : { disks: [] };
    if (manifest.disks.some(d => d.slug === slug)) {
        usage(`manifest already has slug "${slug}"`);
    }
    manifest.disks.push({
        slug,
        title:       opts.title,
        description: opts.description || '',
        credit:      opts.credit,
        disk:        `${slug}.d64`,
        file:        fileName,
        poster:      `${slug}.png`,
        added:       new Date().toISOString().slice(0, 10)
    });
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`updated ${MANIFEST}`);
}

main().catch(e => { console.error(e); process.exit(1); });
