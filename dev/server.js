#!/usr/bin/env node
/*
 * FrameCast dev server — for testing the TV app in a desktop browser.
 *
 *   node dev/server.js            -> http://localhost:8090
 *
 * Serves app/ (with hls.js injected so <video> can play HLS), a CORS proxy at
 * /proxy?url= for trying a real provider from the browser, and a mock Xtream
 * provider at http://localhost:8090/mock  (username: demo, password: demo).
 * None of this ships to the TV.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 8090;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const MEDIA_DIR = path.join(__dirname, 'media');

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.xml': 'application/xml',
    '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t'
};

/* ------------------------------------------------------------------ */
/* Test video (generated once with ffmpeg)                             */
/* ------------------------------------------------------------------ */

function findFfmpeg() {
    // FFMPEG=path\to\ffmpeg overrides; otherwise ffmpeg must be on PATH.
    const candidates = [process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
    for (const c of candidates) {
        const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
        if (r.status === 0) return c;
    }
    return null;
}

function ensureMedia() {
    const playlist = path.join(MEDIA_DIR, 'stream.m3u8');
    if (fs.existsSync(playlist)) return true;
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
        console.warn('[dev] ffmpeg not found: mock channels will have no video. Set FFMPEG=path\\to\\ffmpeg.exe');
        return false;
    }
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    console.log('[dev] Generating 60s test video…');
    const r = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k',
        '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(MEDIA_DIR, 'seg%03d.ts'),
        playlist
    ], { stdio: 'inherit' });
    return r.status === 0;
}

/* ------------------------------------------------------------------ */
/* Mock Xtream provider                                                */
/* ------------------------------------------------------------------ */

const GENRES = ['News', 'Sports', 'Movies', 'Kids', 'Music', 'Documentary', 'Comedy', 'Drama',
    'Lifestyle', 'Food', 'Travel', 'Science', 'History', 'Nature', 'Business', 'Weather',
    'Gaming', 'Classic TV', 'Reality', 'Faith', 'Local', 'International', 'Spanish', 'French', 'German'];
const WORDS = ['One', 'Prime', 'Plus', 'Max', 'Live', 'World', 'Central', 'Now', 'Extra', 'Gold',
    'Channel', 'Network', 'Select', 'Classic', 'Direct', 'Premier', 'Star', 'Nova', 'Wave', 'Pulse'];
const SHOWS = ['Morning Briefing', 'The Big Match', 'Late Night Talk', 'Wild Coasts', 'Cooking at Home',
    'World Report', 'Market Watch', 'Cartoon Hour', 'Retro Hits', 'Deep Space', 'Cold Case Files',
    'Weekend Movie', 'Travel Diaries', 'Science Today', 'The Quiz Show', 'Evening News', 'Garden Rescue',
    'History Uncovered', 'Top 40 Countdown', 'Championship Highlights'];

const CATEGORIES = GENRES.map((name, i) => ({ category_id: String(100 + i), category_name: name, parent_id: 0 }));
const STREAMS = [];
let n = 1;
CATEGORIES.forEach((cat, ci) => {
    for (let k = 0; k < 80; k++) {
        const name = `${GENRES[ci]} ${WORDS[(k * 7 + ci) % WORDS.length]}${k >= WORDS.length ? ' ' + (Math.floor(k / WORDS.length) + 1) : ''}${k % 5 === 0 ? ' HD' : ''}`;
        STREAMS.push({
            num: n, name, stream_type: 'live', stream_id: 5000 + n,
            stream_icon: k % 9 === 4 ? '' : `/mock/logo/${5000 + n}.svg`,
            epg_channel_id: `ch${n}.mock`, added: '1700000000',
            category_id: cat.category_id, tv_archive: 0
        });
        n++;
    }
});

function mockEpg(streamId, limit) {
    const id = parseInt(streamId, 10) || 0;
    if (id % 13 === 0) return [];                  // some channels have no guide data
    const slot = 30 * 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const start0 = nowSec - (nowSec % slot) - ((id % 3) * 600);
    const rows = [];
    for (let i = 0; i < limit; i++) {
        const start = start0 + i * slot;
        const title = SHOWS[(id + i) % SHOWS.length] + (id % 4 === 0 ? ' — Café Édition' : '');
        rows.push({
            id: String(id * 100 + i), epg_id: String(id),
            title: Buffer.from(title, 'utf8').toString('base64'),
            description: Buffer.from('Mock programme', 'utf8').toString('base64'),
            start_timestamp: String(start), stop_timestamp: String(start + slot),
            channel_id: `ch${id - 5000}.mock`
        });
    }
    return rows;
}

function logoSvg(id) {
    const s = STREAMS.find(x => String(x.stream_id) === String(id));
    const label = s ? s.name.split(' ').map(w => w[0]).join('').slice(0, 3) : '?';
    const hue = (parseInt(id, 10) * 47) % 360;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">
<rect width="160" height="120" rx="16" fill="hsl(${hue},55%,42%)"/>
<text x="80" y="76" font-family="Arial" font-size="44" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`;
}

function handleMock(req, res, url) {
    const p = url.pathname.replace(/^\/mock/, '');
    const q = url.searchParams;

    if (p === '/player_api.php') {
        if (q.get('username') !== 'demo' || q.get('password') !== 'demo') {
            return sendJson(res, { user_info: { auth: 0 } });
        }
        const action = q.get('action');
        // Simulate a slow-ish provider so loading states are visible.
        const delay = action === 'get_live_streams' ? 600 : action === 'get_short_epg' ? 150 : 200;
        return setTimeout(() => {
            switch (action) {
                case null:
                    return sendJson(res, {
                        user_info: {
                            username: 'demo', auth: 1, status: 'Active',
                            exp_date: String(Math.floor(Date.now() / 1000) + 86400 * 30),
                            max_connections: '1', active_cons: '0',
                            allowed_output_formats: ['m3u8', 'ts']
                        },
                        server_info: { url: url.host, port: String(PORT), timezone: 'UTC' }
                    });
                case 'get_live_categories': return sendJson(res, CATEGORIES);
                case 'get_live_streams': {
                    const cat = q.get('category_id');
                    return sendJson(res, cat ? STREAMS.filter(s => s.category_id === cat) : STREAMS);
                }
                case 'get_short_epg':
                    return sendJson(res, { epg_listings: mockEpg(q.get('stream_id'), parseInt(q.get('limit'), 10) || 4) });
                default:
                    return sendJson(res, []);
            }
        }, delay);
    }

    let m = p.match(/^\/live\/demo\/demo\/(\d+)\.(m3u8|ts)$/);
    if (m) {
        const id = parseInt(m[1], 10);
        if (id % 17 === 0) { res.writeHead(404); return res.end('offline'); }   // some "offline" channels
        const playlist = path.join(MEDIA_DIR, 'stream.m3u8');
        if (!fs.existsSync(playlist)) { res.writeHead(503); return res.end('no test media'); }
        if (m[2] === 'ts') return sendFile(res, path.join(MEDIA_DIR, 'seg000.ts'));
        const body = fs.readFileSync(playlist, 'utf8').replace(/^(seg\d+\.ts)$/gm, '/media/$1');
        res.writeHead(200, { 'Content-Type': TYPES['.m3u8'], 'Cache-Control': 'no-store' });
        return res.end(body);
    }

    m = p.match(/^\/logo\/(\d+)\.svg$/);
    if (m) {
        res.writeHead(200, { 'Content-Type': TYPES['.svg'], 'Cache-Control': 'max-age=3600' });
        return res.end(logoSvg(m[1]));
    }

    res.writeHead(404); res.end();
}

/* ------------------------------------------------------------------ */
/* Proxy for real providers (browser CORS)                             */
/* ------------------------------------------------------------------ */

function proxy(req, res, target, redirects) {
    let u;
    try { u = new URL(target); } catch { res.writeHead(400); return res.end('bad url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { res.writeHead(400); return res.end('http(s) only'); }
    const lib = u.protocol === 'https:' ? https : http;
    const up = lib.get(u, { headers: { 'User-Agent': 'FrameCast-dev' } }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (redirects || 0) < 5) {
            r.resume();
            return proxy(req, res, new URL(r.headers.location, u).toString(), (redirects || 0) + 1);
        }
        const headers = { 'Content-Type': r.headers['content-type'] || 'application/octet-stream' };
        let isPlaylist = /mpegurl/i.test(headers['Content-Type']) || /\.m3u8(\?|$)/.test(u.pathname);
        if (!isPlaylist) {
            res.writeHead(r.statusCode, headers);
            return r.pipe(res);
        }
        // Rewrite playlist entries so segments also go through the proxy.
        let body = '';
        r.setEncoding('utf8');
        r.on('data', c => { body += c; });
        r.on('end', () => {
            body = body.split('\n').map(line => {
                const t = line.trim();
                if (!t || t.startsWith('#')) return line;
                return '/proxy?url=' + encodeURIComponent(new URL(t, u).toString());
            }).join('\n');
            res.writeHead(r.statusCode, headers);
            res.end(body);
        });
    });
    up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502); } res.end(e.message); });
    req.on('close', () => up.destroy());
}

/* ------------------------------------------------------------------ */

function sendJson(res, obj) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

function sendFile(res, file) {
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    });
}

// Maps a URL path onto a file inside `base`, or null if it would escape `base`
// (e.g. "../app-backup/x", which a plain startsWith(base) check would let through)
// or isn't valid percent-encoding.
function safeJoin(base, rel) {
    let decoded;
    try { decoded = decodeURIComponent(rel); } catch { return null; }
    if (decoded.includes('\0')) return null;
    const root = path.resolve(base);
    const p = path.resolve(root, decoded);
    return p === root || p.startsWith(root + path.sep) ? p : null;
}

ensureMedia();

function forbidden(res) { res.writeHead(403); res.end(); }

function handle(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p.startsWith('/mock/')) return handleMock(req, res, url);
    if (p === '/proxy') return proxy(req, res, url.searchParams.get('url'));
    if (p.startsWith('/media/')) {
        const media = safeJoin(MEDIA_DIR, p.slice(7));
        return media ? sendFile(res, media) : forbidden(res);
    }
    if (p.startsWith('/$WEBAPIS/') || p.startsWith('/%24WEBAPIS/')) { res.writeHead(404); return res.end(); }

    if (p === '/' || p === '/index.html') {
        let html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
        html = html.replace('<script src="js/storage.js"></script>',
            '<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js"></script>\n    <script src="js/storage.js"></script>');
        // On the TV the area behind the page is the (black) video plane; mimic that.
        html = html.replace('</head>', '    <style>html { background: #000; }</style>\n</head>');
        res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
        return res.end(html);
    }

    const file = safeJoin(APP_DIR, p.slice(1));
    if (!file) return forbidden(res);
    sendFile(res, file);
}

http.createServer((req, res) => {
    try {
        handle(req, res);
    } catch (err) {
        // A malformed request must not take the server down.
        console.warn('[dev] Bad request:', err.message);
        if (!res.headersSent) res.writeHead(400);
        res.end();
    }
// Local machine only: /proxy fetches any URL it's given, so it must not be reachable
// from other devices on the network. Set HOST=0.0.0.0 to override deliberately.
}).listen(PORT, HOST, () => {
    console.log(`[dev] FrameCast: http://localhost:${PORT}  (listening on ${HOST} only)`);
    console.log(`[dev] Mock provider: server http://localhost:${PORT}/mock  user demo  pass demo`);
});
