'use strict';
/*
 * Full Circle Director (Full Circle Immersive) – local playback server
 *
 *  - Headsets join at  https://<this-PC's-IP>:8443   (self-signed certificate, accept once per headset)
 *  - The control panel runs at  http://localhost:8080  (this PC only)
 *  - Put video files in the "videos" folder next to this file.
 *
 * The server holds the one true playback state. Every headset keeps its own
 * clock offset to the server and schedules play/seek against server time,
 * so all headsets start together and stay within a few hundredths of a second.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch (e) { console.error('Could not save', f, e.message); } };

const cfg = Object.assign(
  { headsetPort: 8443, panelPort: 8080, videosDir: 'videos', startLeadMs: 1200 },
  readJSON(path.join(ROOT, 'config.json'), {})
);
const VIDEOS = path.resolve(ROOT, cfg.videosDir);
const META_FILE = path.join(ROOT, 'library.json');
const HEADSETS_FILE = path.join(ROOT, 'headsets.json');
const now = () => performance.timeOrigin + performance.now(); // server clock, ms

// ---------------------------------------------------------------- network + certificate
function lanIPs() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
}

function certificate() {
  const dir = path.join(ROOT, 'cert');
  const keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem'), ipFile = path.join(dir, 'ips.json');
  const ips = lanIPs();
  const covered = readJSON(ipFile, null);
  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && covered && ips.every(ip => covered.includes(ip))) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  const selfsigned = require('selfsigned');
  const all = Array.from(new Set([...(covered || []), ...ips]));
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Full Circle Director local server' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...all.map(ip => ({ type: 7, ip }))] }
    ]
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private); fs.writeFileSync(certFile, pems.cert); writeJSON(ipFile, all);
  console.log('Created a new security certificate. Headsets will need to accept it once.');
  return { key: pems.private, cert: pems.cert };
}

// ---------------------------------------------------------------- video library
const VIDEO_EXT = ['.mp4', '.m4v', '.webm', '.mkv', '.mov'];
let meta = readJSON(META_FILE, {});       // { filename: { shape, layout, duration } }
let library = [];

function guessFormat(name) {
  const n = name.toLowerCase();
  let shape = '360', layout = 'mono';
  if (/(^|[_\-. ])(180|vr180)([_\-. ]|$)/.test(n)) shape = '180';
  if (/(^|[_\-. ])(flat|2d)([_\-. ]|$)/.test(n)) shape = 'flat';
  if (/(_tb|_ou|top.?bottom|over.?under|_3dv)/.test(n)) layout = 'tb';
  else if (/(_lr|_sbs|side.?by.?side|_3dh)/.test(n)) layout = 'sbs';
  return { shape, layout };
}

function scanLibrary() {
  fs.mkdirSync(VIDEOS, { recursive: true });
  library = fs.readdirSync(VIDEOS)
    .filter(f => VIDEO_EXT.includes(path.extname(f).toLowerCase()))
    .map(f => {
      const st = fs.statSync(path.join(VIDEOS, f));
      const m = Object.assign(guessFormat(f), meta[f] || {});
      return { id: f, size: st.size, shape: m.shape, layout: m.layout, duration: m.duration || null };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return library;
}

let scanTimer = null;
function watchVideos() {
  try {
    fs.watch(VIDEOS, () => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => { scanLibrary(); broadcast({ t: 'library', items: library }); }, 800);
    });
  } catch (e) { console.warn('Not watching the videos folder for changes:', e.message); }
}

// ---------------------------------------------------------------- static files (with byte ranges for video)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime'
};

function sendFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Cache-Control': cache ? 'max-age=86400' : 'no-cache'
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start, end;
      if (m[1]) { start = +m[1]; end = m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1; }
      else { start = Math.max(0, st.size - +m[2]); end = st.size - 1; }
      if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function handler(defaultPage) {
  return (req, res) => {
    let url;
    try { url = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    if (url === '/') url = '/' + defaultPage;
    if (url === '/panel' || url === '/panel.html') {
      if (!isLocal(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('The control panel only opens on the server PC.'); }
      return sendFile(req, res, path.join(PUBLIC, 'panel.html'));
    }
    if (url === '/api/info' && isLocal(req)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify({ addresses: lanIPs().map(ip => `https://${ip}:${cfg.headsetPort}`), videosDir: VIDEOS }));
    }
    if (url === '/lib/three.min.js') return sendFile(req, res, path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js'), true);
    if (url.startsWith('/videos/')) {
      const name = path.basename(url.slice(8));
      if (!library.some(v => v.id === name)) { res.writeHead(404); return res.end('Not in the library'); }
      return sendFile(req, res, path.join(VIDEOS, name));
    }
    const file = path.normalize(path.join(PUBLIC, url));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    sendFile(req, res, file);
  };
}

// ---------------------------------------------------------------- playback state
let state = {
  videoId: null, playing: false, position: 0, at: now(), seq: 0,
  recenterSeq: 0, recenterYaw: 0, stream: false, screen: { dist: 12, width: 12 }
};
const expectedPos = (s, t = now()) => s.playing ? s.position + Math.max(0, t - s.at) / 1000 : s.position;
const durationOf = id => (library.find(v => v.id === id) || {}).duration || null;

function setState(patch) {
  state = { ...state, ...patch, seq: state.seq + 1 };
  broadcast({ t: 'state', state, serverNow: now() });
}

function command(m) {
  const t = now(), pos = expectedPos(state, t);
  const lead = cfg.startLeadMs;
  const clamp = p => { const d = durationOf(state.videoId); return Math.max(0, d ? Math.min(p, d - 0.05) : p); };
  switch (m.op) {
    case 'load':
      if (!library.some(v => v.id === m.id)) return;
      return setState({ videoId: m.id, playing: false, position: 0, at: t });
    case 'unload':
      return setState({ videoId: null, playing: false, position: 0, at: t });
    case 'play':
      if (!state.videoId || state.playing) return;
      return setState({ playing: true, position: clamp(pos), at: t + lead });
    case 'pause':
      if (!state.playing) return;
      return setState({ playing: false, position: clamp(pos), at: t });
    case 'stop':
      return setState({ playing: false, position: 0, at: t });
    case 'seek':
      return setState({ position: clamp(+m.position || 0), at: state.playing ? t + lead : t });
    case 'skip':
      return setState({ position: clamp(pos + (+m.by || 0)), at: state.playing ? t + lead : t });
    case 'recenter':
      // yaw (degrees) is the point of the video everyone should end up facing; 0 is the centre
      return setState({ recenterSeq: state.recenterSeq + 1, recenterYaw: Math.max(-180, Math.min(180, +m.yaw || 0)) });
    case 'stream':
      return setState({ stream: !!m.on });
    case 'screen':
      return setState({ screen: { dist: Math.max(2, Math.min(30, +m.dist || 12)), width: Math.max(2, Math.min(40, +m.width || 12)) } });
    case 'format': {
      if (!library.some(v => v.id === m.id)) return;
      meta[m.id] = Object.assign({}, meta[m.id], { shape: m.shape, layout: m.layout });
      writeJSON(META_FILE, meta); scanLibrary();
      broadcast({ t: 'library', items: library });
      if (state.videoId === m.id) setState({}); // headsets rebuild their view
      return;
    }
    case 'duration': {
      if (!library.some(v => v.id === m.id) || !(m.duration > 0)) return;
      if (meta[m.id] && Math.abs((meta[m.id].duration || 0) - m.duration) < 0.01) return;
      meta[m.id] = Object.assign({}, meta[m.id], { duration: m.duration });
      writeJSON(META_FILE, meta); scanLibrary();
      return broadcast({ t: 'library', items: library });
    }
    case 'download':   // ask headsets to copy these videos into their own storage
      return sendHeadsets({ t: 'download', ids: (m.ids || []).filter(id => library.some(v => v.id === id)) }, m.to);
    case 'cancel':
      return sendHeadsets({ t: 'cancel' }, m.to);
    case 'remove':
      return sendHeadsets({ t: 'remove', id: m.id }, m.to);
    case 'rename': {
      const h = headsets.get(m.headset); if (!h) return;
      h.name = String(m.name || '').slice(0, 40) || h.name; saveHeadsets();
      if (h.ws) send(h.ws, { t: 'name', name: h.name });
      return;
    }
    case 'forget':
      if (headsets.has(m.headset) && !headsets.get(m.headset).ws) { headsets.delete(m.headset); saveHeadsets(); }
      return;
  }
}

// Stop at the end of the video rather than running past it
setInterval(() => {
  if (!state.playing) return;
  const d = durationOf(state.videoId);
  if (d && expectedPos(state) >= d) setState({ playing: false, position: d, at: now() });
}, 250);

// ---------------------------------------------------------------- clients
const headsets = new Map(); // id -> { id, name, color, ws, status, look, lastSeen }
const panels = new Set();
const COLORS = ['#80ffdb', '#ff8fb1', '#ffd36b', '#9d8cff', '#5fd3ff', '#ff9f5a', '#b6f36b', '#f08cff', '#6be7c3', '#ffb3e6'];
for (const [id, h] of Object.entries(readJSON(HEADSETS_FILE, {}))) headsets.set(id, { id, name: h.name, color: h.color, ws: null, status: null, look: null, lastSeen: h.lastSeen || 0 });
function saveHeadsets() {
  const out = {}; headsets.forEach(h => { out[h.id] = { name: h.name, color: h.color, lastSeen: h.lastSeen }; });
  writeJSON(HEADSETS_FILE, out);
}

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
function broadcast(msg) {
  const s = JSON.stringify(msg);
  headsets.forEach(h => { if (h.ws && h.ws.readyState === 1) h.ws.send(s); });
  panels.forEach(ws => { if (ws.readyState === 1) ws.send(s); });
}
function sendHeadsets(msg, to) {
  headsets.forEach(h => { if (!to || to.includes(h.id)) send(h.ws, msg); });
}

function headsetSummary() {
  return Array.from(headsets.values()).map(h => ({
    id: h.id, name: h.name, color: h.color, online: !!(h.ws && h.ws.readyState === 1),
    status: h.status, look: h.look, lastSeen: h.lastSeen
  }));
}
// Panels get headset positions ten times a second
setInterval(() => {
  if (!panels.size) return;
  const s = JSON.stringify({ t: 'headsets', list: headsetSummary(), serverNow: now() });
  panels.forEach(ws => { if (ws.readyState === 1) ws.send(s); });
}, 100);

function attach(wss, allowPanel) {
  wss.on('connection', (ws, req) => {
    let me = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'ping') return send(ws, { t: 'pong', c: m.c, s: now() });
      if (m.t === 'hello') {
        if (m.role === 'panel') {
          if (!allowPanel || !isLocal(req)) return ws.close(4003, 'Panel only on the server PC');
          me = { role: 'panel' }; panels.add(ws);
        } else {
          const id = String(m.id || '').slice(0, 64) || 'hs-' + Math.random().toString(36).slice(2, 10);
          let h = headsets.get(id);
          if (!h) {
            const used = new Set(Array.from(headsets.values()).map(x => x.color));
            h = { id, name: m.name || 'Headset ' + (headsets.size + 1), color: COLORS.find(c => !used.has(c)) || COLORS[headsets.size % COLORS.length] };
            headsets.set(id, h);
          }
          if (h.ws && h.ws !== ws) try { h.ws.close(4000, 'Replaced by a newer connection'); } catch {}
          h.ws = ws; h.lastSeen = Date.now(); h.ip = req.socket.remoteAddress;
          me = { role: 'headset', h }; saveHeadsets();
          console.log(`Headset connected: ${h.name} (${h.ip})`);
          send(ws, { t: 'welcome', id, name: h.name, color: h.color });
        }
        send(ws, { t: 'library', items: library });
        send(ws, { t: 'state', state, serverNow: now() });
        return;
      }
      if (!me) return;
      if (me.role === 'panel' && m.t === 'cmd') return command(m);
      if (me.role === 'headset') {
        me.h.lastSeen = Date.now();
        if (m.t === 'status') me.h.status = m.status;
        else if (m.t === 'look') me.h.look = { y: m.y, p: m.p, at: Date.now() };
        else if (m.t === 'rename') { me.h.name = String(m.name || '').trim().slice(0, 40) || me.h.name; saveHeadsets(); }
      }
    });
    ws.on('close', () => {
      if (!me) return;
      if (me.role === 'panel') panels.delete(ws);
      else if (me.h.ws === ws) { me.h.ws = null; me.h.look = null; console.log(`Headset disconnected: ${me.h.name}`); saveHeadsets(); }
    });
  });
  // Drop connections that have gone silent (headset asleep, Wi-Fi lost)
  setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} }), 10000);
}

// ---------------------------------------------------------------- start
scanLibrary();
watchVideos();

const headsetServer = https.createServer(certificate(), handler('headset.html'));
const panelServer = http.createServer(handler('panel.html'));
attach(new WebSocketServer({ server: headsetServer, path: '/ws' }), false);
attach(new WebSocketServer({ server: panelServer, path: '/ws' }), true);

function listenError(port, what) {
  return e => {
    console.error(e.code === 'EADDRINUSE'
      ? `Port ${port} is already in use, so the ${what} can't start. Close the other copy of this server, or change the port in config.json.`
      : `The ${what} couldn't start: ${e.message}`);
    process.exit(1);
  };
}
headsetServer.on('error', listenError(cfg.headsetPort, 'headset server'));
panelServer.on('error', listenError(cfg.panelPort, 'control panel'));

panelServer.listen(cfg.panelPort, '127.0.0.1', () => {
  headsetServer.listen(cfg.headsetPort, '0.0.0.0', () => {
    const ips = lanIPs();
    console.log('');
    console.log('  Full Circle Director is running');
    console.log('  -------------------------------');
    console.log(`  Control panel (this PC):  http://localhost:${cfg.panelPort}`);
    console.log('  Headsets open:            ' + (ips.length ? ips.map(ip => `https://${ip}:${cfg.headsetPort}`).join('\n                            ') : '(no network found – connect this PC to Wi-Fi or Ethernet)'));
    console.log(`  Videos folder:            ${VIDEOS}`);
    console.log(`  Videos found:             ${library.length}`);
    console.log('');
    console.log('  Leave this window open while you use the system. Close it to stop the server.');
    console.log('');
  });
});
