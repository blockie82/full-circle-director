'use strict';
/*
 * Full Circle Director (Full Circle Immersive) – local playback server
 *
 *  - Headsets join at  https://<this-PC's-IP>:8443   (self-signed certificate, accept once per headset)
 *  - The control panel runs at  http://localhost:8080  (this PC only)
 *  - Put video and image files in the "videos" folder next to this file.
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
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch (e) { console.error('Could not save', f, e.message); } };

const cfg = Object.assign(
  { headsetPort: 8443, panelPort: 8080, startLeadMs: 1200 },
  readJSON(path.join(ROOT, 'config.json'), {})
);
const MEDIA = path.resolve(ROOT, cfg.mediaDir || cfg.videosDir || 'media');
// The media folder used to be called "videos". On start, anything in an old "videos" folder
// is moved into "media" (unzipping an update creates an empty "media" folder alongside it).
(() => {
  const legacy = path.join(ROOT, 'videos');
  if (cfg.videosDir || !fs.existsSync(legacy) || path.resolve(legacy) === MEDIA) return;
  try {
    fs.mkdirSync(MEDIA, { recursive: true });
    let moved = 0;
    for (const name of fs.readdirSync(legacy)) {
      if (name.toLowerCase() === 'readme.txt') continue;
      const to = path.join(MEDIA, name);
      if (fs.existsSync(to)) { console.warn(`Left "${name}" in the old videos folder because media already has one with that name.`); continue; }
      fs.renameSync(path.join(legacy, name), to); moved++;
    }
    const left = fs.readdirSync(legacy).filter(n => n.toLowerCase() !== 'readme.txt');
    if (!left.length) fs.rmSync(legacy, { recursive: true, force: true });
    if (moved) console.log(`Moved ${moved} item${moved === 1 ? '' : 's'} from the old "videos" folder into "${path.basename(MEDIA)}".`);
  } catch (e) { console.warn('Couldn\'t move the old "videos" folder into "media" (' + e.message + '). Move your files across by hand.'); }
})();
const META_FILE = path.join(ROOT, 'library.json');
const HEADSETS_FILE = path.join(ROOT, 'headsets.json');
const now = () => performance.timeOrigin + performance.now(); // server clock, ms
const VERSION = readJSON(path.join(ROOT, 'package.json'), {}).version || '?';

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

// ---------------------------------------------------------------- media library
// Files can sit in the media folder itself or one folder down; each such folder is a group in the panel.
const VIDEO_EXT = ['.mp4', '.m4v', '.webm', '.mkv', '.mov'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const MEDIA_EXT = [...VIDEO_EXT, ...IMAGE_EXT];
const isMediaName = f => !f.startsWith('.') && MEDIA_EXT.includes(path.extname(f).toLowerCase());
const naturally = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
let meta = readJSON(META_FILE, {});       // { "file" or "folder/file": { shape, layout, duration } }
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
  fs.mkdirSync(MEDIA, { recursive: true });
  const items = [];
  const add = rel => {
    try {
      const st = fs.statSync(path.join(MEDIA, ...rel.split('/')));
      const name = rel.split('/').pop();
      const m = Object.assign(guessFormat(name), meta[rel] || {});
      const kind = IMAGE_EXT.includes(path.extname(name).toLowerCase()) ? 'image' : 'video';
      const item = { id: rel, name, folder: rel.includes('/') ? rel.split('/')[0] : null, kind, size: st.size,
        shape: m.shape, layout: m.layout, duration: kind === 'video' ? (m.duration || null) : null };
      Object.defineProperty(item, 'mtime', { value: st.mtimeMs });   // kept off the wire
      if (kind === 'video') item.proxy = proxyStatus(item);
      items.push(item);
    } catch {}
  };
  for (const e of fs.readdirSync(MEDIA, { withFileTypes: true })) {
    if (e.isFile() && isMediaName(e.name)) add(e.name);
    else if (e.isDirectory() && !e.name.startsWith('.')) {
      try {
        for (const f of fs.readdirSync(path.join(MEDIA, e.name), { withFileTypes: true })) if (f.isFile() && isMediaName(f.name)) add(e.name + '/' + f.name);
      } catch {}
    }
  }
  library = items.sort((a, b) => naturally(a.folder || '', b.folder || '') || naturally(a.name, b.name));
  return library;
}
const rescan = () => { scanLibrary(); broadcast({ t: 'library', items: library }); proxyCheck(); };

// ---------------------------------------------------------------- preview copies ("proxies") for the control panel
// A heavy video (8K, or a format this PC can't decode smoothly) gets a light 1080p H.264 copy that only the
// control panel uses for its preview and "through their eyes" views. Headsets always get the original.
const PROXIES = path.join(ROOT, 'proxies');
const proxyCfg = Object.assign({ enabled: true, width: 1920, maxSourceWidth: 3840, codec: 'h264' }, cfg.proxy || {});
const PROXY_EXT = proxyCfg.codec === 'vp9' ? '.webm' : '.mp4';
const LIGHT_CODECS = ['h264', 'vp8', 'vp9', 'av1'];
let FFMPEG = null;
function findFfmpeg() {
  const tries = [];
  if (cfg.ffmpegPath) tries.push(cfg.ffmpegPath);
  try { const p = require('ffmpeg-static'); if (p) tries.push(p); } catch {}
  tries.push('ffmpeg');
  for (const c of tries) {
    try { if (spawnSync(c, ['-version'], { timeout: 8000 }).status === 0) return c; } catch {}
  }
  return null;
}
const proxyKey = it => crypto.createHash('sha1').update(it.id + '|' + it.size + '|' + Math.round(it.mtime || 0)).digest('hex').slice(0, 16);
const proxyPath = it => path.join(PROXIES, proxyKey(it) + PROXY_EXT);
const proxyJobs = new Map();     // id -> { state: 'queued' | 'making' | 'error', pct, error, force }
let proxyBusy = null;            // id being made right now

function proxyStatus(it) {
  if (fs.existsSync(proxyPath(it))) return { state: 'ready', key: proxyKey(it) };
  const job = proxyJobs.get(it.id);
  if (job) return { state: job.state, pct: job.pct || 0, error: job.error || null };
  if (!FFMPEG) return { state: 'unavailable' };
  const probe = (meta[it.id] || {}).probe;
  if (probe && probe.key === proxyKey(it) && !probe.needs) return { state: 'none', width: probe.width, codec: probe.codec };
  return { state: proxyCfg.enabled ? 'checking' : 'none' };
}

function probe(it) {
  return new Promise(resolve => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', path.join(MEDIA, ...it.id.split('/'))]);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', () => {
      const v = /Stream #\S+.*?Video: (\w+)[^\n]*?, (\d{3,5})x(\d{3,5})/.exec(err);
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
      resolve({ codec: v ? v[1] : null, width: v ? +v[2] : 0, height: v ? +v[3] : 0, duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]) : null });
    });
    p.on('error', () => resolve({ codec: null, width: 0 }));
  });
}

let proxyChecking = false, proxyBroadcastAt = 0;
function proxyBroadcast(force) {
  const t = Date.now(); if (!force && t - proxyBroadcastAt < 1000) return;
  proxyBroadcastAt = t; library.forEach(it => { if (it.kind === 'video') it.proxy = proxyStatus(it); });
  broadcast({ t: 'library', items: library });
}

// Remove copies whose video has gone, been renamed or been replaced (copies are named by file name, size and date)
function proxyTidy() {
  let names; try { names = fs.readdirSync(PROXIES); } catch { return; }
  const wanted = new Set(library.filter(v => v.kind === 'video').map(v => proxyKey(v) + PROXY_EXT));
  const busy = proxyBusy ? library.find(v => v.id === proxyBusy) : null;
  names.forEach(n => {
    if (wanted.has(n) || (busy && n.startsWith(proxyKey(busy)))) return;
    fs.rm(path.join(PROXIES, n), { force: true }, () => {});
  });
}

// Look at each video once; queue a preview copy for anything heavy
async function proxyCheck() {
  proxyTidy();
  if (!FFMPEG || proxyChecking) return;
  proxyChecking = true;
  try {
    for (const it of library.filter(v => v.kind === 'video')) {
      if (fs.existsSync(proxyPath(it)) || proxyJobs.has(it.id)) continue;
      const key = proxyKey(it), m = meta[it.id] || {};
      if (!m.probe || m.probe.key !== key) {
        const p = await probe(it);
        const needs = p.width > proxyCfg.maxSourceWidth || !LIGHT_CODECS.includes((p.codec || '').toLowerCase());
        meta[it.id] = Object.assign({}, meta[it.id], { probe: { key, width: p.width, codec: p.codec, needs } });
        if (p.duration && !meta[it.id].duration) meta[it.id].duration = p.duration;
        writeJSON(META_FILE, meta);
      }
      if (proxyCfg.enabled && meta[it.id].probe.needs) proxyJobs.set(it.id, { state: 'queued', pct: 0 });
    }
  } finally { proxyChecking = false; }
  proxyBroadcast(true); proxyNext();
}

function proxyNext() {
  if (proxyBusy || !FFMPEG) return;
  const next = [...proxyJobs.entries()].find(([, j]) => j.state === 'queued');
  if (!next) return;
  const [id, job] = next, it = library.find(v => v.id === id);
  if (!it) { proxyJobs.delete(id); return proxyNext(); }
  proxyBusy = id; job.state = 'making'; job.pct = 0;
  fs.mkdirSync(PROXIES, { recursive: true });
  const out = proxyPath(it), tmp = out + '.part' + PROXY_EXT;
  const dur = it.duration || ((meta[id] || {}).duration) || 0;
  const args = ['-hide_banner', '-y', '-hwaccel', 'auto', '-i', path.join(MEDIA, ...id.split('/')), '-an',
    '-vf', `scale=${proxyCfg.width}:-2`, '-pix_fmt', 'yuv420p', '-g', '30',
    ...(proxyCfg.codec === 'vp9'
      ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-deadline', 'realtime', '-cpu-used', '8']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-movflags', '+faststart']), tmp];
  console.log(`Making a preview copy of ${id} for the control panel…`);
  const p = spawn(FFMPEG, args);
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
  let tail = '';
  p.stderr.on('data', d => {
    const t = String(d); tail = (tail + t).slice(-2000);
    const m = /time=(\d+):(\d+):([\d.]+)/.exec(t);
    if (m && dur) { job.pct = Math.min(0.99, ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) / dur); proxyBroadcast(); }
  });
  const finish = ok => {
    proxyBusy = null;
    if (ok) { fs.renameSync(tmp, out); proxyJobs.delete(id); console.log(`Preview copy ready: ${id}`); }
    else {
      fs.rm(tmp, { force: true }, () => {});
      job.state = 'error'; job.error = /No space left/i.test(tail) ? 'The PC\'s disk is full' : 'Couldn\'t make a preview copy';
      console.warn(`Couldn't make a preview copy of ${id}:\n${tail.split('\n').slice(-4).join('\n')}`);
    }
    proxyBroadcast(true); proxyNext();
  };
  p.on('close', code => finish(code === 0 && fs.existsSync(tmp)));
  p.on('error', () => finish(false));
}

function proxyRemove(ids) {
  ids.forEach(id => {
    const it = library.find(v => v.id === id);
    if (it) fs.rm(proxyPath(it), { force: true }, () => {});
    proxyJobs.delete(id);
  });
}

let scanTimer = null;
function watchVideos() {
  try {
    const onChange = () => { clearTimeout(scanTimer); scanTimer = setTimeout(rescan, 800); };
    try { fs.watch(MEDIA, { recursive: true }, onChange); }
    catch { fs.watch(MEDIA, onChange); }
  } catch (e) { console.warn('Not watching the media folder for changes:', e.message); }
}

// ---------------------------------------------------------------- static files (with byte ranges for video)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
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
      return res.end(JSON.stringify({ addresses: lanIPs().map(ip => `https://${ip}:${cfg.headsetPort}`), mediaDir: MEDIA, version: VERSION, features: ['upload', 'folders', 'images'] }));
    }
    if (url === '/api/upload' && req.method === 'PUT') { if (!isLocal(req)) return deny(res); return upload(req, res); }
    if (url === '/api/delete' && req.method === 'POST') { if (!isLocal(req)) return deny(res); return remove(req, res); }
    if (url === '/lib/three.min.js') return sendFile(req, res, path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js'), true);
    if (url.startsWith('/proxy/')) {
      if (!isLocal(req)) { res.writeHead(403); return res.end(); }
      const it = library.find(v => v.id === url.slice(7));
      if (!it) { res.writeHead(404); return res.end('Not in the library'); }
      return sendFile(req, res, proxyPath(it), true);
    }
    const prefix = url.startsWith('/media/') ? '/media/' : url.startsWith('/videos/') ? '/videos/' : null;
    if (prefix) {
      const rel = url.slice(prefix.length);
      if (!library.some(v => v.id === rel)) { res.writeHead(404); return res.end('Not in the library'); }
      return sendFile(req, res, path.join(MEDIA, ...rel.split('/')));
    }
    const file = path.normalize(path.join(PUBLIC, url));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    sendFile(req, res, file);
  };
}

// ---------------------------------------------------------------- adding and deleting files from the panel
const deny = res => { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Only the server PC can change the library.'); };
const reply = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// "Folder/name.jpg" -> ['Folder', 'name.jpg'], keeping only names that are safe on Windows
function safeParts(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/')
    .map(x => x.replace(/[<>:"|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim())
    .filter(x => x && x !== '.' && x !== '..');
  if (!parts.length || parts.length > 2 || parts.some(x => x.startsWith('.'))) return null;
  if (!MEDIA_EXT.includes(path.extname(parts[parts.length - 1]).toLowerCase())) return null;
  return parts;
}

function upload(req, res) {
  const parts = safeParts(new URL(req.url, 'http://x').searchParams.get('path'));
  if (!parts) { req.resume(); return reply(res, 400, { error: 'Only videos (MP4, WebM, MKV, MOV) and images (JPG, PNG, WebP) can be added.' }); }
  const dir = parts.length === 2 ? path.join(MEDIA, parts[0]) : MEDIA;
  fs.mkdirSync(dir, { recursive: true });
  // never overwrite: "name.jpg" becomes "name (2).jpg" if it already exists
  const ext = path.extname(parts[parts.length - 1]), base = path.basename(parts[parts.length - 1], ext);
  let name = base + ext, n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base} (${n++})${ext}`;
  const tmp = path.join(dir, `.${name}.${Date.now()}.part`);
  const out = fs.createWriteStream(tmp);
  let failed = false;
  const fail = (msg) => {
    if (failed) return; failed = true;
    out.destroy(); fs.rm(tmp, { force: true }, () => {});
    if (!res.headersSent) reply(res, 500, { error: msg });
  };
  req.on('aborted', () => fail('The upload was cancelled.'));
  out.on('error', e => fail(e.code === 'ENOSPC' ? 'The PC\'s disk is full.' : e.message));
  out.on('finish', () => {
    if (failed) return;
    fs.rename(tmp, path.join(dir, name), err => {
      if (err) return fail(err.message);
      rescan();
      const id = (parts.length === 2 ? parts[0] + '/' : '') + name;
      console.log('Added ' + id);
      reply(res, 200, { ok: true, id });
    });
  });
  req.pipe(out);
}

function remove(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const id = q.get('id'), folder = q.get('folder');
  const loaded = state.videoId;
  let ids = [];
  if (id) {
    if (!library.some(v => v.id === id)) return reply(res, 404, { error: 'That file isn\'t in the library.' });
    if (loaded === id) return reply(res, 409, { error: 'Unload it first.' });
    fs.rmSync(path.join(MEDIA, ...id.split('/')), { force: true });
    ids = [id];
  } else if (folder) {
    const parts = String(folder).split('/');
    if (parts.length !== 1 || !library.some(v => v.folder === folder)) return reply(res, 404, { error: 'That folder isn\'t in the library.' });
    if (loaded && loaded.startsWith(folder + '/')) return reply(res, 409, { error: 'Unload the item from this folder first.' });
    ids = library.filter(v => v.folder === folder).map(v => v.id);
    fs.rmSync(path.join(MEDIA, folder), { recursive: true, force: true });
  } else return reply(res, 400, { error: 'Nothing to delete.' });
  proxyRemove(ids);
  ids.forEach(i => delete meta[i]); writeJSON(META_FILE, meta);
  sendHeadsets({ t: 'remove', ids });   // free the space on the headsets too
  rescan();
  reply(res, 200, { ok: true, removed: ids.length });
}

// ---------------------------------------------------------------- playback state
let state = {
  videoId: null, playing: false, position: 0, at: now(), seq: 0,
  recenterSeq: 0, recenterYaw: 0, stream: false, screen: { dist: 12, width: 12 }
};
const expectedPos = (s, t = now()) => s.playing ? s.position + Math.max(0, t - s.at) / 1000 : s.position;
const durationOf = id => (library.find(v => v.id === id) || {}).duration || null;
const isImage = id => (library.find(v => v.id === id) || {}).kind === 'image';

function setState(patch) {
  state = { ...state, ...patch, seq: state.seq + 1 };
  broadcast({ t: 'state', state, serverNow: now() });
}

function command(m) {
  const t = now(), pos = expectedPos(state, t);
  const lead = cfg.startLeadMs;
  // play, pause and seeking mean nothing for a still image
  if (['play', 'pause', 'seek', 'skip'].includes(m.op) && isImage(state.videoId)) return;
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
    case 'proxy': {      // make (or remake) a preview copy on request
      const it = library.find(v => v.id === m.id && v.kind === 'video'); if (!it || !FFMPEG) return;
      fs.rm(proxyPath(it), { force: true }, () => {});
      proxyJobs.set(it.id, { state: 'queued', pct: 0 }); proxyBroadcast(true); return proxyNext();
    }
    case 'proxyCancel': {
      const j = proxyJobs.get(m.id); if (j && j.state !== 'making') proxyJobs.delete(m.id);
      return proxyBroadcast(true);
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
      return sendHeadsets({ t: 'remove', ids: m.ids || [m.id] }, m.to);
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
FFMPEG = findFfmpeg();
scanLibrary();
watchVideos();
if (FFMPEG) setTimeout(proxyCheck, 1500);
else console.log('  Preview copies are off: ffmpeg wasn\'t found. Run START.bat again to install it, or set "ffmpegPath" in config.json.');

const headsetServer = https.createServer(certificate(), handler('headset.html'));
const panelServer = http.createServer(handler('panel.html'));
panelServer.requestTimeout = 0;   // big uploads can take longer than Node's default five minutes
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
    console.log(`  Full Circle Director ${VERSION} is running`);
    console.log('  -------------------------------');
    console.log(`  Control panel (this PC):  http://localhost:${cfg.panelPort}`);
    console.log('  Headsets open:            ' + (ips.length ? ips.map(ip => `https://${ip}:${cfg.headsetPort}`).join('\n                            ') : '(no network found – connect this PC to Wi-Fi or Ethernet)'));
    console.log(`  Media folder:             ${MEDIA}`);
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    console.log(`  Found:                    ${plural(library.filter(v => v.kind === 'video').length, 'video')}, ${plural(library.filter(v => v.kind === 'image').length, 'image')}`);
    console.log('');
    console.log('  Leave this window open while you use the system. Close it to stop the server.');
    console.log('');
  });
});
