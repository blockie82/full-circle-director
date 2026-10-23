/* Full Circle Immersive – control panel */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const { fmtTime, fmtSize } = FC;
  const SHAPES = { '360': '360°', '180': '180°', flat: 'Flat screen' };
  const LAYOUTS = { mono: 'Mono', tb: '3D top-bottom', sbs: '3D side-by-side' };
  const FOV_H = 104, FOV_V = 96; // Quest 3 field of view, degrees (approximate)

  let library = [], headsets = [], selected = null;
  const libItem = id => library.find(v => v.id === id) || null;
  const cmd = (op, extra) => link.send(Object.assign({ t: 'cmd', op }, extra));

  // ------------------------------------------------------------ connection
  const link = new FC.FCLink({
    hello: () => ({ t: 'hello', role: 'panel' }),
    onConnection(ok) {
      $('conn').textContent = ok ? 'Server running' : 'Server not reachable';
      $('conn').className = 'chip ' + (ok ? 'ok' : 'bad');
    },
    onMessage(m) {
      if (m.t === 'library') { library = m.items; renderLibrary(); onState(); }
      else if (m.t === 'state') onState();
      else if (m.t === 'headsets') { headsets = m.list; renderHeadsets(); }
    }
  });

  fetch('/api/info').then(r => r.json()).then(info => {
    $('joinUrl').textContent = info.addresses[0] || 'No network found';
    $('joinUrl').title = info.addresses.join('\n');
    videosDir = info.videosDir; renderLibrary();
  }).catch(() => { $('joinUrl').textContent = 'Unknown'; });
  let videosDir = '';
  $('copyUrl').addEventListener('click', () => {
    const t = $('joinUrl').textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Address copied'), () => {
      const r = document.createRange(); r.selectNodeContents($('joinUrl')); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
  });

  let toastTimer = null;
  function toast(t) { $('toast').textContent = t; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2200); }

  // ------------------------------------------------------------ preview video (muted copy on this PC, kept in step)
  const pv = $('pv');
  let pvId = null, pvFailed = false;
  function onState() {
    const s = link.state; if (!s) return;
    const it = s.videoId ? libItem(s.videoId) : null;
    if ((it ? it.id : null) !== pvId) {
      pvId = it ? it.id : null; pvFailed = false;
      if (it) { pv.src = '/videos/' + encodeURIComponent(it.id); pv.load(); } else { pv.removeAttribute('src'); pv.load(); }
      eyesSig = ''; target = null; renderTarget();
    }
    $('streamOk').checked = !!s.stream;
    const sc = s.screen || { dist: 12, width: 12 };
    if (!draggingScreen) { $('dist').value = sc.dist; $('size').value = sc.width; }
    $('distVal').textContent = sc.dist.toFixed(1) + ' m'; $('sizeVal').textContent = sc.width.toFixed(1) + ' m';
    $('flatSum').textContent = sc.dist.toFixed(1).replace('.0', '') + ' m away, ' + sc.width.toFixed(1).replace('.0', '') + ' m wide';
    renderNow(); renderLibrary(); pvSync(true);
  }
  pv.addEventListener('loadedmetadata', () => {
    if (pvId && isFinite(pv.duration)) cmd('duration', { id: pvId, duration: pv.duration });
    eyesSig = ''; renderNow();
  });
  pv.addEventListener('error', () => { if (pvId) { pvFailed = true; renderNow(); } });

  let lastPvCheck = 0;
  function pvSync(force) {
    const s = link.state; if (!s || !pvId || pv.readyState < 1) return;
    const t = link.serverNow(), exp = link.expected(t), dur = pv.duration || Infinity;
    const hold = p => { if (!pv.paused) pv.pause(); pv.playbackRate = 1; if (!pv.seeking && Math.abs(pv.currentTime - Math.min(p, dur)) > 0.05) pv.currentTime = Math.min(p, dur); };
    if (!s.playing || t < s.at) return hold(s.position);
    if (exp >= dur - 0.05) return hold(dur);
    if (pv.paused) { if (Math.abs(pv.currentTime - exp) > 0.25) pv.currentTime = exp + 0.1; pv.play().catch(() => {}); return; }
    if (!force && t - lastPvCheck < 250) return; lastPvCheck = t;
    if (pv.seeking) return;
    const d = pv.currentTime - exp;
    if (Math.abs(d) > 0.6) pv.currentTime = exp + 0.1;
    else pv.playbackRate = Math.abs(d) > 0.03 ? Math.max(0.92, Math.min(1.08, 1 - d * 0.8)) : 1;
  }

  // ------------------------------------------------------------ now playing + transport
  const durationNow = () => { const it = link.state && libItem(link.state.videoId); return (it && it.duration) || (isFinite(pv.duration) ? pv.duration : 0); };
  function renderNow() {
    const s = link.state, it = s && s.videoId ? libItem(s.videoId) : null;
    $('nowName').textContent = it ? it.id : 'No video loaded';
    $('nowFmt').textContent = it ? SHAPES[it.shape] + ' · ' + LAYOUTS[it.layout] : '';
    $('stageEmpty').hidden = !!it;
    const pickable = !!it && it.shape !== 'flat';
    $('stage').classList.toggle('pickable', pickable); $('pickHint').hidden = !pickable;
    $('previewNote').textContent = it && pvFailed ? 'This PC can\'t preview this video format. Headset markers are shown on a grid instead.' : '';
    ['playBtn', 'stopBtn', 'backBtn', 'fwdBtn', 'seek'].forEach(id => { $(id).disabled = !it; });
    const playing = !!(s && s.playing);
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('wallIcon').innerHTML = $('playIcon').innerHTML = playing ? '<path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/>' : '<path d="M7 4.5v15l13-7.5z"/>';
    renderReady();
  }
  function renderReady() {
    const s = link.state, chip = $('readyChip');
    const it = s && s.videoId ? libItem(s.videoId) : null;
    const online = headsets.filter(h => h.online);
    if (!it || !online.length) { chip.hidden = true; return; }
    const ready = online.filter(h => h.status && h.status.videoId === it.id && h.status.source).length;
    chip.hidden = false;
    chip.textContent = 'Ready on ' + ready + ' of ' + online.length + ' headsets';
    chip.className = 'chip ' + (ready === online.length ? 'ok' : ready ? 'warn' : 'bad');
  }
  function tickTransport() {
    const s = link.state;
    if (!s) return;
    const dur = durationNow(), pos = Math.min(link.expected(), dur || Infinity);
    $('tNow').textContent = fmtTime(pos); $('tDur').textContent = fmtTime(dur);
    $('wallTime').textContent = fmtTime(pos) + ' / ' + fmtTime(dur);
    if (!seeking) $('seek').value = dur ? Math.round(pos / dur * 1000) : 0;
    const st = $('playState'); const wait = s.at - link.serverNow();
    if (!s.videoId) { st.textContent = 'Nothing loaded'; st.className = 'chip'; }
    else if (s.playing && wait > 0) { st.textContent = 'Starting in ' + (wait / 1000).toFixed(1) + ' s'; st.className = 'chip warn'; }
    else if (s.playing) { st.textContent = 'Playing'; st.className = 'chip live'; }
    else if (dur && s.position >= dur - 0.1) { st.textContent = 'Finished'; st.className = 'chip'; }
    else if (s.position > 0) { st.textContent = 'Paused'; st.className = 'chip warn'; }
    else { st.textContent = 'Stopped'; st.className = 'chip'; }
  }
  $('playBtn').addEventListener('click', () => cmd(link.state && link.state.playing ? 'pause' : 'play'));
  $('stopBtn').addEventListener('click', () => cmd('stop'));
  $('backBtn').addEventListener('click', () => cmd('skip', { by: -10 }));
  $('fwdBtn').addEventListener('click', () => cmd('skip', { by: 10 }));
  const recentreAll = () => { cmd('recenter', { yaw: 0 }); toast('Everyone is now facing the centre of the video'); };
  $('recenterBtn').addEventListener('click', recentreAll);
  let seeking = false;
  $('seek').addEventListener('input', () => { seeking = true; $('tNow').textContent = fmtTime($('seek').value / 1000 * durationNow()); });
  $('seek').addEventListener('change', () => { seeking = false; cmd('seek', { position: $('seek').value / 1000 * durationNow() }); });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (wallOpen) openWall(false); else if (target) { target = null; renderTarget(); } return; }
    if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) return;
    if (!link.state || !link.state.videoId) return;
    if (e.key === ' ') { e.preventDefault(); $('playBtn').click(); }
    else if (e.key === 'ArrowLeft') cmd('skip', { by: -10 });
    else if (e.key === 'ArrowRight') cmd('skip', { by: 10 });
  });

  // screen settings
  let draggingScreen = false, screenTimer = null;
  function sendScreen() {
    $('distVal').textContent = (+$('dist').value).toFixed(1) + ' m'; $('sizeVal').textContent = (+$('size').value).toFixed(1) + ' m';
    clearTimeout(screenTimer); screenTimer = setTimeout(() => cmd('screen', { dist: +$('dist').value, width: +$('size').value }), 120);
  }
  ['dist', 'size'].forEach(id => {
    $(id).addEventListener('input', () => { draggingScreen = true; sendScreen(); });
    $(id).addEventListener('change', () => { draggingScreen = false; sendScreen(); });
  });
  $('streamOk').addEventListener('change', () => cmd('stream', { on: $('streamOk').checked }));
  $('cancelAll').addEventListener('click', () => { cmd('cancel'); toast('Downloads cancelled'); });

  // ------------------------------------------------------------ library
  function readiness(id) {
    const online = headsets.filter(h => h.online);
    let done = 0, active = 0;
    online.forEach(h => {
      const f = h.status && h.status.files && h.status.files[id];
      if (f && f.state === 'done') done++; else if (f && (f.state === 'active' || f.state === 'queued')) active++;
    });
    return { done, active, total: online.length };
  }
  let libSig = '', openVid = null;
  function renderLibrary() {
    const s = link.state;
    const cur = s && s.videoId;
    $('libSum').textContent = library.length
      ? library.length + (library.length === 1 ? ' video' : ' videos') + (cur ? ' · Loaded: ' + cur : ' · nothing loaded')
      : 'No videos yet';
    const sig = JSON.stringify([library, cur, openVid, headsets.map(h => [h.online, h.status && h.status.files])]);
    if (sig === libSig) return;
    const box = $('lib');
    if (document.activeElement && box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return; // don't redraw under an open menu
    libSig = sig;
    const focusId = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    box.textContent = '';
    if (!library.length) {
      box.innerHTML = '<p class="empty-lib">No videos yet. Copy video files into <code></code> and they\'ll appear here automatically.</p>';
      box.querySelector('code').textContent = videosDir || 'the videos folder';
      return;
    }
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    library.forEach(it => {
      const isCur = cur === it.id, open = openVid === it.id, r = readiness(it.id);
      const row = mk('div', 'vid' + (isCur ? ' current' : '') + (open ? ' open' : ''));
      const head = mk('div', 'vhead');
      const tog = mk('button', 'vtog'); tog.type = 'button'; tog.dataset.key = 'tog:' + it.id;
      tog.setAttribute('aria-expanded', open ? 'true' : 'false');
      tog.onclick = () => {
        openVid = open ? null : it.id; renderLibrary();
        const el = openVid && $('lib').querySelector('.vid.open'); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      const txt = mk('span', 'txt');
      txt.append(mk('span', 'n', it.id), mk('span', 'm num', [SHAPES[it.shape] + ' ' + LAYOUTS[it.layout], fmtSize(it.size), it.duration ? fmtTime(it.duration) : null,
        r.total ? r.done + ' of ' + r.total + ' ready' + (r.active ? ', ' + r.active + ' downloading' : '') : null].filter(Boolean).join(' · ')));
      tog.append(mk('span', 'ar'), txt);
      const acts = mk('div', 'acts');
      if (isCur) acts.append(Object.assign(mk('span', 'chip live', 'Loaded')));
      const load = mk('button', isCur ? 'quiet' : 'primary', isCur ? 'Unload' : 'Load'); load.type = 'button'; load.dataset.key = 'load:' + it.id;
      load.onclick = () => cmd(isCur ? 'unload' : 'load', isCur ? {} : { id: it.id });
      acts.append(load);
      head.append(tog, acts); row.append(head);
      if (open) {
        const body = mk('div', 'vbody');
        const mkSel = (opts, val, label) => {
          const sel = document.createElement('select'); sel.setAttribute('aria-label', label + ' for ' + it.id);
          Object.entries(opts).forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); });
          sel.value = val; return sel;
        };
        const shapeSel = mkSel(SHAPES, it.shape, 'Projection'), layoutSel = mkSel(LAYOUTS, it.layout, 'Stereo layout');
        const fmtChange = () => cmd('format', { id: it.id, shape: shapeSel.value, layout: layoutSel.value });
        shapeSel.onchange = fmtChange; layoutSel.onchange = fmtChange;
        const send = mk('button', '', 'Send to headsets'); send.type = 'button';
        send.disabled = !r.total || r.done === r.total;
        send.onclick = () => { cmd('download', { ids: [it.id] }); toast('Sending ' + it.id + ' to the headsets'); };
        const rm = mk('button', 'quiet', 'Remove from headsets'); rm.type = 'button';
        rm.disabled = !r.done || isCur; rm.title = isCur ? 'Unload the video first' : '';
        rm.onclick = () => { cmd('remove', { id: it.id }); toast('Removing ' + it.id + ' from the headsets'); };
        body.append(shapeSel, layoutSel, mk('span', 'sp'), send, rm);
        row.append(body);
      }
      box.append(row);
    });
    if (focusId) { const el = box.querySelector('[data-key="' + CSS.escape(focusId) + '"]'); if (el) el.focus(); }
  }

  // folding panels, remembered between visits
  function setFold(sec, open) {
    sec.classList.toggle('open', open);
    sec.querySelector('.foldhead').setAttribute('aria-expanded', open ? 'true' : 'false');
    sec.querySelector('.foldbody').hidden = !open;
    if (sec.id === 'libFold') document.body.classList.toggle('lib-open', open);
  }
  document.querySelectorAll('.fold').forEach(sec => {
    let open = sec.classList.contains('open');
    try { const v = localStorage.getItem('fc.fold.' + sec.id); if (v !== null) open = v === '1'; } catch {}
    setFold(sec, open);
    sec.querySelector('.foldhead').addEventListener('click', () => {
      const now = !sec.classList.contains('open'); setFold(sec, now);
      try { localStorage.setItem('fc.fold.' + sec.id, now ? '1' : '0'); } catch {}
    });
  });

  // ------------------------------------------------------------ headsets
  let hsSig = '', renaming = null;
  function renderHeadsets() {
    renderReady(); renderLibrary();
    const online = headsets.filter(h => h.online).length;
    $('hsCount').textContent = headsets.length ? online + ' of ' + headsets.length + ' connected' : '';
    const sig = JSON.stringify(headsets.map(h => [h.id, h.name, h.online, h.status, selected === h.id]));
    if (sig === hsSig || renaming) return; hsSig = sig;
    const box = $('hs');
    if (!headsets.length) { box.innerHTML = '<p class="empty-lib">No headsets yet. On each Quest, open the address at the top of this page in the browser.</p>'; return; }
    box.textContent = '';
    const s = link.state;
    headsets.slice().sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name)).forEach(h => {
      const st = h.status || {};
      const el = document.createElement('div');
      el.className = 'h' + (selected === h.id ? ' sel' : '') + (h.online ? '' : ' off');
      el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', 'Watch through ' + h.name);
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = h.color;
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = h.name;
      const chip = document.createElement('span');
      if (!h.online) { chip.className = 'chip'; chip.textContent = 'Offline'; }
      else if (s && s.videoId && !(st.videoId === s.videoId && st.source)) { chip.className = 'chip bad'; chip.textContent = 'Video missing'; }
      else if (st.inVR) { chip.className = 'chip live'; chip.textContent = 'In VR'; }
      else { chip.className = 'chip ok'; chip.textContent = 'Not in VR yet'; }
      const meta = document.createElement('div'); meta.className = 'meta num';
      const bits = [];
      if (h.online) {
        if (st.playing && st.drift != null) bits.push([Math.abs(st.drift) > 100 ? 'bad' : Math.abs(st.drift) > 40 ? 'warn' : 'ok', 'Sync ' + (st.drift > 0 ? '+' : '') + st.drift + ' ms']);
        if (st.fps) bits.push(['', st.fps + ' fps']);
        if (st.source === 'stream') bits.push(['warn', 'Streaming']);
        if (st.muted) bits.push(['warn', 'Sound off: tap the headset page']);
        if (st.battery != null) bits.push([st.battery < 20 && !st.charging ? 'bad' : '', 'Battery ' + st.battery + '%' + (st.charging ? ' charging' : '')]);
        if (st.storageFree != null) bits.push(['', fmtSize(st.storageFree) + ' free']);
        if (st.error) bits.push(['bad', st.error]);
      } else bits.push(['', h.lastSeen ? 'Last seen ' + new Date(h.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '']);
      bits.forEach(([c, t]) => { const sp = document.createElement('span'); if (c) sp.className = c; sp.textContent = t; meta.append(sp); });
      el.append(sw, nm, chip, meta);
      const act = Object.entries(st.files || {}).find(([, f]) => f.state === 'active');
      if (act) {
        const bar = document.createElement('div'); bar.className = 'bar'; bar.title = 'Downloading ' + act[0];
        const i = document.createElement('i'); i.style.width = (act[1].pct * 100).toFixed(1) + '%'; bar.append(i);
        const lbl = document.createElement('div'); lbl.className = 'meta'; lbl.textContent = 'Downloading ' + act[0] + ' · ' + Math.floor(act[1].pct * 100) + '%';
        el.append(lbl, bar);
      }
      const tools = document.createElement('div'); tools.className = 'tools';
      const ren = document.createElement('button'); ren.type = 'button'; ren.className = 'quiet'; ren.textContent = 'Rename';
      ren.onclick = e => { e.stopPropagation(); startRename(h, nm); };
      tools.append(ren);
      if (h.online && s && s.videoId && !(st.files && st.files[s.videoId] && st.files[s.videoId].state === 'done')) {
        const snd = document.createElement('button'); snd.type = 'button'; snd.textContent = 'Send current video';
        snd.onclick = e => { e.stopPropagation(); cmd('download', { ids: [s.videoId], to: [h.id] }); toast('Sending to ' + h.name); };
        tools.append(snd);
      }
      if (!h.online) {
        const fg = document.createElement('button'); fg.type = 'button'; fg.className = 'quiet'; fg.textContent = 'Forget';
        fg.onclick = e => { e.stopPropagation(); cmd('forget', { headset: h.id }); };
        tools.append(fg);
      }
      el.append(tools);
      const pick = () => { selected = selected === h.id ? null : h.id; hsSig = ''; renderHeadsets(); };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); pick(); } });
      box.append(el);
    });
  }
  function startRename(h, nm) {
    renaming = h.id;
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = h.name; inp.maxLength = 40; inp.setAttribute('aria-label', 'New name');
    nm.replaceWith(inp); inp.focus(); inp.select();
    const done = save => { if (!renaming) return; renaming = null; if (save && inp.value.trim()) cmd('rename', { headset: h.id, name: inp.value.trim() }); hsSig = ''; renderHeadsets(); };
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }
  $('eyesNext').addEventListener('click', () => {
    const on = headsets.filter(h => h.online); if (!on.length) return;
    const i = on.findIndex(h => h.id === selected); selected = on[(i + 1) % on.length].id; hsSig = ''; renderHeadsets();
  });

  // ------------------------------------------------------------ stage: panorama with headset markers
  // One small frame buffer (left eye only) feeds both the stage and the "through their eyes" view.
  const frame = document.createElement('canvas'); frame.width = 2048; frame.height = 1024;
  const fctx = frame.getContext('2d');
  const stage = $('stageCanvas'), sctx = stage.getContext('2d');
  function grabFrame(it) {
    if (pvFailed || pv.readyState < 2 || !pv.videoWidth) return false;
    let sw = pv.videoWidth, sh = pv.videoHeight;
    if (it.layout === 'sbs') sw /= 2; if (it.layout === 'tb') sh /= 2;
    const ar = sw / sh;
    const fw = it.shape === 'flat' ? 1600 : 2048;
    const fh = it.shape === 'flat' ? Math.round(1600 / ar) : it.shape === '180' ? 2048 : 1024;
    if (frame.width !== fw || frame.height !== fh) { frame.width = fw; frame.height = fh; }
    fctx.drawImage(pv, 0, 0, sw, sh, 0, 0, frame.width, frame.height);
    return true;
  }
  // Map a look direction (degrees) to a point on the stage, 0..1
  function project(it, y, p) {
    if (it.shape === 'flat') {
      if (Math.abs(y) >= 89 || Math.abs(p) >= 89) return null;
      const sc = (link.state && link.state.screen) || { dist: 12, width: 12 };
      const h = sc.width / ((frame.width / frame.height) || 16 / 9);
      return { x: 0.5 + sc.dist * Math.tan(y * Math.PI / 180) / sc.width, y: 0.5 - sc.dist * Math.tan(p * Math.PI / 180) / h };
    }
    const span = it.shape === '180' ? 180 : 360;
    return { x: 0.5 + y / span, y: 0.5 - p / 180 };
  }
  function drawGrid(w, h, it) {
    sctx.fillStyle = '#05030d'; sctx.fillRect(0, 0, w, h);
    sctx.strokeStyle = 'rgba(161,157,201,0.18)'; sctx.lineWidth = 1;
    const cols = it.shape === '360' ? 8 : 4;
    for (let i = 1; i < cols; i++) { sctx.beginPath(); sctx.moveTo(i * w / cols, 0); sctx.lineTo(i * w / cols, h); sctx.stroke(); }
    for (let j = 1; j < 4; j++) { sctx.beginPath(); sctx.moveTo(0, j * h / 4); sctx.lineTo(w, j * h / 4); sctx.stroke(); }
  }
  function drawStage() {
    const s = link.state, it = s && s.videoId ? libItem(s.videoId) : null;
    const rect = stage.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (stage.width !== w || stage.height !== h) { stage.width = w; stage.height = h; }
    sctx.clearRect(0, 0, w, h);
    if (!it) return;
    const have = grabFrame(it);
    // fit the frame inside the stage
    let dw = w, dh = h, ox = 0, oy = 0;
    const far = it.shape === 'flat' ? frame.width / frame.height : it.shape === '180' ? 1 : 2;
    if (w / h > far) { dw = h * far; ox = (w - dw) / 2; } else { dh = w / far; oy = (h - dh) / 2; }
    sctx.fillStyle = '#05030d'; sctx.fillRect(0, 0, w, h);
    if (have) sctx.drawImage(frame, ox, oy, dw, dh);
    else { sctx.save(); sctx.translate(ox, oy); drawGrid(dw, dh, it); sctx.restore(); }
    geom = { ox, oy, dw, dh, dpr };
    if (target && it.shape !== 'flat') drawTarget(it, ox, oy, dw, dh, dpr);

    const now = Date.now();
    const showFov = $('showFov').checked, showNames = $('showNames').checked;
    headsets.forEach(hs => {
      if (!hs.online || !hs.look || hs.look.y == null || now - hs.look.at > 1500) return;
      const pt = project(it, hs.look.y, hs.look.p); if (!pt) return;
      const x = ox + pt.x * dw, y = oy + pt.y * dh;
      const isSel = hs.id === selected;
      sctx.save();
      if (showFov && it.shape !== 'flat') {
        const span = it.shape === '180' ? 180 : 360;
        const fw = FOV_H / span * dw, fh = FOV_V / 180 * dh;
        sctx.strokeStyle = hs.color; sctx.globalAlpha = isSel ? 0.95 : 0.55; sctx.lineWidth = (isSel ? 2.5 : 1.5) * dpr;
        sctx.setLineDash(isSel ? [] : [6 * dpr, 5 * dpr]);
        // draw again shifted by one panorama width so boxes wrap around the seam
        [-dw, 0, dw].forEach(shift => { if (it.shape === '360' || shift === 0) roundRect(x - fw / 2 + shift, y - fh / 2, fw, fh, 10 * dpr); });
        sctx.setLineDash([]);
      }
      sctx.globalAlpha = 1;
      sctx.beginPath(); sctx.arc(x, y, (isSel ? 9 : 7) * dpr, 0, Math.PI * 2);
      sctx.fillStyle = hs.color; sctx.fill(); sctx.lineWidth = 2 * dpr; sctx.strokeStyle = '#0a0718'; sctx.stroke();
      if (showNames) {
        sctx.font = `700 ${12 * dpr}px Manrope, sans-serif`;
        const tw = sctx.measureText(hs.name).width, px = 8 * dpr, bh = 22 * dpr;
        let lx = x + 12 * dpr, ly = y - bh / 2;
        if (lx + tw + px * 2 > ox + dw) lx = x - 12 * dpr - tw - px * 2;
        sctx.fillStyle = 'rgba(10,7,24,0.82)'; roundRect(lx, ly, tw + px * 2, bh, bh / 2, true);
        sctx.fillStyle = hs.color; sctx.textBaseline = 'middle'; sctx.fillText(hs.name, lx + px, ly + bh / 2 + dpr);
      }
      sctx.restore();
    });
  }
  function roundRect(x, y, w, h, r, fill) {
    sctx.beginPath();
    sctx.moveTo(x + r, y); sctx.arcTo(x + w, y, x + w, y + h, r); sctx.arcTo(x + w, y + h, x, y + h, r);
    sctx.arcTo(x, y + h, x, y, r); sctx.arcTo(x, y, x + w, y, r); sctx.closePath();
    fill ? sctx.fill() : sctx.stroke();
  }

  // ------------------------------------------------------------ marking a point to turn everyone towards
  let target = null;  // { y, p } in degrees: right of centre is positive, up is positive
  let geom = null;    // where the video frame was last drawn on the stage, in canvas pixels
  const curItem = () => { const s = link.state; return s && s.videoId ? libItem(s.videoId) : null; };
  stage.addEventListener('click', e => {
    const it = curItem(); if (!it || !geom || it.shape === 'flat') return;
    const r = stage.getBoundingClientRect();
    const u = ((e.clientX - r.left) * geom.dpr - geom.ox) / geom.dw, v = ((e.clientY - r.top) * geom.dpr - geom.oy) / geom.dh;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    const span = it.shape === '180' ? 180 : 360;
    target = { y: (u - 0.5) * span, p: (0.5 - v) * 180 };
    renderTarget();
  });
  function renderTarget() {
    $('targetBar').hidden = !target;
    if (!target) return;
    const a = Math.round(Math.abs(target.y));
    $('targetWhat').textContent = 'Point marked ' + (a < 2 ? 'at the centre' : a + '° ' + (target.y > 0 ? 'right' : 'left') + ' of centre') + '. Wearers turn left or right to face it; up and down stay level.';
  }
  $('turnBtn').addEventListener('click', () => {
    if (!target) return;
    cmd('recenter', { yaw: +target.y.toFixed(1) });
    toast('Everyone is now facing the marked point');
  });
  $('clearTarget').addEventListener('click', () => { target = null; renderTarget(); });
  function drawTarget(it, ox, oy, dw, dh, dpr) {
    const pt = project(it, target.y, target.p); if (!pt) return;
    const x = ox + pt.x * dw, y = oy + pt.y * dh, r = 16 * dpr;
    sctx.save();
    sctx.strokeStyle = 'rgba(255,255,255,0.55)'; sctx.lineWidth = 1 * dpr; sctx.setLineDash([4 * dpr, 6 * dpr]);
    sctx.beginPath(); sctx.moveTo(x, oy); sctx.lineTo(x, oy + dh); sctx.stroke(); sctx.setLineDash([]);
    sctx.lineWidth = 3 * dpr; sctx.strokeStyle = '#0a0718';
    sctx.beginPath(); sctx.arc(x, y, r, 0, Math.PI * 2); sctx.stroke();
    sctx.lineWidth = 2 * dpr; sctx.strokeStyle = '#ffffff';
    sctx.beginPath(); sctx.arc(x, y, r, 0, Math.PI * 2);
    sctx.moveTo(x - r * 1.6, y); sctx.lineTo(x - r * 0.5, y); sctx.moveTo(x + r * 0.5, y); sctx.lineTo(x + r * 1.6, y);
    sctx.moveTo(x, y - r * 1.6); sctx.lineTo(x, y - r * 0.5); sctx.moveTo(x, y + r * 0.5); sctx.lineTo(x, y + r * 1.6); sctx.stroke();
    sctx.font = `700 ${12 * dpr}px Manrope, sans-serif`; sctx.textBaseline = 'middle';
    const label = 'Face here', tw = sctx.measureText(label).width, bh = 22 * dpr, px = 8 * dpr;
    let lx = x - tw / 2 - px; lx = Math.max(ox, Math.min(lx, ox + dw - tw - px * 2));
    const ly = y + r * 1.8 + bh > oy + dh ? y - r * 1.8 - bh : y + r * 1.8;
    sctx.fillStyle = '#ffffff'; roundRect(lx, ly, tw + px * 2, bh, bh / 2, true);
    sctx.fillStyle = '#0a0718'; sctx.fillText(label, lx + px, ly + bh / 2 + dpr);
    sctx.restore();
  }

  // ------------------------------------------------------------ through their eyes
  const eyesCanvas = $('eyesCanvas');
  const er = new THREE.WebGLRenderer({ canvas: eyesCanvas, antialias: true });
  er.outputEncoding = THREE.sRGBEncoding;
  const escene = new THREE.Scene(), ecam = new THREE.PerspectiveCamera(90, 16 / 10, 0.05, 200);
  ecam.rotation.order = 'YXZ';
  const ftex = new THREE.CanvasTexture(frame); ftex.encoding = THREE.sRGBEncoding; ftex.minFilter = THREE.LinearFilter; ftex.generateMipmaps = false;
  let emesh = null, eyesSig = '';
  function buildEyes(it) {
    const sig = it ? [it.id, it.shape, frame.width, frame.height, JSON.stringify(link.state.screen)].join('|') : '';
    if (sig === eyesSig) return; eyesSig = sig;
    if (emesh) { escene.remove(emesh); emesh.geometry.dispose(); emesh.material.dispose(); emesh = null; }
    if (!it) return;
    let g;
    if (it.shape === 'flat') {
      const sc = link.state.screen || { dist: 12, width: 12 };
      g = new THREE.PlaneGeometry(sc.width, sc.width * frame.height / frame.width); g.translate(0, 0, -sc.dist);
    } else {
      g = it.shape === '180' ? new THREE.SphereGeometry(50, 64, 48, Math.PI / 2, Math.PI) : new THREE.SphereGeometry(50, 64, 48);
      g.scale(-1, 1, 1); g.rotateY(-Math.PI / 2);
    }
    emesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: ftex, side: THREE.DoubleSide }));
    escene.add(emesh);
  }
  function drawEyes() {
    const s = link.state, it = s && s.videoId ? libItem(s.videoId) : null;
    const hs = headsets.find(h => h.id === selected);
    $('eyesTitle').textContent = hs ? 'Through ' + hs.name + '\'s eyes' : 'Through their eyes';
    let msg = '';
    if (!hs) msg = 'Select a headset to see roughly what its wearer sees.';
    else if (!hs.online) msg = hs.name + ' is offline.';
    else if (!it) msg = 'No video is loaded.';
    else if (pvFailed) msg = 'This PC can\'t preview this video format.';
    else if (!hs.look || hs.look.y == null || Date.now() - hs.look.at > 1500) msg = hs.name + ' isn\'t in VR right now.';
    $('eyesMsg').textContent = msg; $('eyesMsg').hidden = !msg; document.querySelector('#eyesBox .cross').hidden = !!msg;
    if (msg) { er.clear(); return; }
    const rect = eyesCanvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (eyesCanvas.width !== w || eyesCanvas.height !== h) er.setSize(w, h, false);
    er.setScissorTest(false); er.setViewport(0, 0, w, h); ecam.aspect = w / h; ecam.updateProjectionMatrix();
    buildEyes(it);
    ftex.needsUpdate = true;
    ecam.rotation.y = -hs.look.y * Math.PI / 180; ecam.rotation.x = hs.look.p * Math.PI / 180;
    er.render(escene, ecam);
  }

  // ------------------------------------------------------------ all headsets at once
  let wallOpen = false;
  const tiles = new Map();
  function openWall(on) {
    wallOpen = on; $('wall').hidden = !on;
    const host = on ? $('wallGrid') : $('eyesBox');
    host.insertBefore(eyesCanvas, host.firstChild);
    document.body.style.overflow = on ? 'hidden' : '';
    (on ? $('wallClose') : $('wallBtn')).focus();
  }
  $('wallBtn').addEventListener('click', () => openWall(true));
  $('wallClose').addEventListener('click', () => openWall(false));
  $('wallPlay').addEventListener('click', () => $('playBtn').click());
  $('wallRecenter').addEventListener('click', recentreAll);

  function drawWall() {
    const it = curItem();
    const on = headsets.filter(h => h.online).sort((a, b) => a.name.localeCompare(b.name));
    $('wallCount').textContent = on.length + (on.length === 1 ? ' headset' : ' headsets') + ' connected';
    $('wallEmpty').hidden = on.length > 0;
    const box = $('wallGrid'), rect = box.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(rect.width * dpr), H = Math.round(rect.height * dpr);
    if (eyesCanvas.width !== W || eyesCanvas.height !== H) er.setSize(W, H, false);
    // pick the column count that makes the 16:10 tiles largest
    const n = Math.max(1, on.length), gap = 12; let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const tw = Math.min((rect.width - gap * (cols - 1)) / cols, (rect.height - gap * (rows - 1)) / rows * 16 / 10);
      if (!best || tw > best.tw) best = { cols, rows, tw };
    }
    const { cols, rows, tw } = best, th = tw * 10 / 16;
    const x0 = (rect.width - (cols * tw + (cols - 1) * gap)) / 2, y0 = (rect.height - (rows * th + (rows - 1) * gap)) / 2;
    tiles.forEach((el, id) => { if (!on.some(h => h.id === id)) { el.remove(); tiles.delete(id); } });
    er.setScissorTest(false); er.setViewport(0, 0, W, H); er.setClearColor(0x0a0718, 1); er.clear();
    if (it && !pvFailed) { grabFrame(it); buildEyes(it); ftex.needsUpdate = true; }
    er.setScissorTest(true);
    const now = Date.now();
    on.forEach((h, i) => {
      const x = x0 + (i % cols) * (tw + gap), y = y0 + Math.floor(i / cols) * (th + gap);
      let el = tiles.get(h.id);
      if (!el) {
        el = document.createElement('div'); el.className = 'tile'; el.tabIndex = 0; el.setAttribute('role', 'button');
        el.innerHTML = '<div class="lbl"><i></i><span></span></div><span class="cross"></span><div class="msg"></div><span class="st num"></span>';
        const pick = () => { selected = h.id; hsSig = ''; renderHeadsets(); };
        el.addEventListener('click', pick);
        el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        box.append(el); tiles.set(h.id, el);
      }
      Object.assign(el.style, { left: x + 'px', top: y + 'px', width: tw + 'px', height: th + 'px' });
      el.classList.toggle('sel', selected === h.id);
      el.setAttribute('aria-label', h.name);
      el.querySelector('.lbl i').style.background = h.color;
      el.querySelector('.lbl span').textContent = h.name;
      const st = h.status || {};
      const live = h.look && h.look.y != null && now - h.look.at < 1500;
      let msg = '';
      if (!it) msg = 'No video loaded';
      else if (!(st.videoId === it.id && st.source)) msg = 'Video not on this headset';
      else if (pvFailed) msg = 'This PC can\'t preview this format';
      else if (!live) msg = 'Not in VR';
      el.querySelector('.msg').textContent = msg;
      el.querySelector('.cross').hidden = !!msg;
      const bits = [];
      if (st.playing && st.drift != null) bits.push('Sync ' + (st.drift > 0 ? '+' : '') + st.drift + ' ms');
      if (st.battery != null) bits.push('Battery ' + st.battery + '%');
      el.querySelector('.st').textContent = bits.join(' · ');
      el.querySelector('.st').hidden = !bits.length;
      if (msg) return;
      const vx = Math.round(x * dpr), vy = Math.round((rect.height - y - th) * dpr), vw = Math.round(tw * dpr), vh = Math.round(th * dpr);
      er.setViewport(vx, vy, vw, vh); er.setScissor(vx, vy, vw, vh);
      ecam.aspect = tw / th; ecam.updateProjectionMatrix();
      ecam.rotation.y = -h.look.y * Math.PI / 180; ecam.rotation.x = h.look.p * Math.PI / 180;
      er.render(escene, ecam);
    });
    er.setScissorTest(false);
  }

  // ------------------------------------------------------------ main loop
  let lastDraw = 0;
  function loop(t) {
    pvSync(); tickTransport();
    if (t - lastDraw > 33) { lastDraw = t; if (wallOpen) drawWall(); else { drawStage(); drawEyes(); } }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  renderLibrary();
})();
