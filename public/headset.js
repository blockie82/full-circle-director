/* Full Circle Player (Full Circle Immersive) – the headset app for Full Circle Director.
 * Connects to the PC server, keeps videos in this headset's storage, follows the
 * operator's playback in sync, and reports where the wearer is looking. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };
  const SHAPES = { '360': '360°', '180': '180°', flat: 'Flat screen' };
  const LAYOUTS = { mono: 'Mono', tb: '3D top-bottom', sbs: '3D side-by-side' };

  // ------------------------------------------------------------ identity
  let myId = store.get('fc.id', null);
  if (!myId) { myId = 'hs-' + Math.random().toString(36).slice(2, 10); store.set('fc.id', myId); }
  let myName = store.get('fc.name', null);
  let library = [];
  const libItem = id => library.find(v => v.id === id) || null;

  // ------------------------------------------------------------ video element (kept in the page so it isn't throttled)
  const video = document.createElement('video');
  video.id = 'srcVideo'; video.playsInline = true; video.preload = 'auto'; video.loop = false;
  document.body.appendChild(video);
  let presented = 0;
  if ('requestVideoFrameCallback' in video) {
    const onVF = () => { presented++; video.requestVideoFrameCallback(onVF); };
    video.requestVideoFrameCallback(onVF);
  }
  // ------------------------------------------------------------ still images
  const image = new Image();
  let imgSource = null, imageReady = false;          // decoded picture, scaled to fit the graphics chip's limit
  const isImageItem = it => !!it && it.kind === 'image';
  function mediaSize() {
    return isImageItem(itemNow()) && imgSource ? { w: imgSource.width, h: imgSource.height } : { w: video.videoWidth || 16, h: video.videoHeight || 9 };
  }
  async function loadImage(url, token) {
    imageReady = false;
    try {
      image.src = url; await image.decode();
      if (token !== sourceToken) return;
      const max = Math.min(renderer.capabilities.maxTextureSize || 8192, 16384);
      const k = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
      if (k < 1) {
        const c = document.createElement('canvas'); c.width = Math.round(image.naturalWidth * k); c.height = Math.round(image.naturalHeight * k);
        c.getContext('2d').drawImage(image, 0, 0, c.width, c.height); imgSource = c;
      } else imgSource = image;
      imgTex.image = imgSource; imgTex.needsUpdate = true;
      imageReady = true;
      rebuildView(true); updateUI(); sendStatus();
    } catch (e) {
      if (token === sourceToken) setHint('This headset couldn\'t open the image.', true);
    }
  }

  let soundBlocked = false;
  function playVideo() {
    const p = video.play();
    if (p) p.catch(e => {
      if (e.name === 'NotAllowedError') {
        // The browser needs a tap before it allows sound; play muted until then
        soundBlocked = true; video.muted = true; video.play().catch(() => {});
        setHint('Tap anywhere on this page to turn the sound on.');
      }
    });
  }
  document.addEventListener('pointerdown', () => {
    if (soundBlocked) { soundBlocked = false; video.muted = false; setHint(''); updateUI(); }
  });

  // ------------------------------------------------------------ server link
  let lastRecenterSeq = null;
  const link = new FC.FCLink({
    hello: () => ({ t: 'hello', role: 'headset', id: myId, name: myName }),
    onConnection(ok) {
      $('conn').textContent = ok ? 'Connected' : 'Reconnecting…';
      $('conn').className = 'chip ' + (ok ? 'ok' : 'warn');
    },
    onMessage(m) {
      switch (m.t) {
        case 'welcome':
          myName = m.name; store.set('fc.name', myName);
          $('name').value = myName; $('swatch').style.background = m.color; break;
        case 'name':
          myName = m.name; store.set('fc.name', myName); $('name').value = myName; break;
        case 'library':
          library = m.items; dropStaleIndex(); renderFiles(); ensureSource(); break;
        case 'state':
          if (lastRecenterSeq === null) lastRecenterSeq = m.state.recenterSeq;
          else if (m.state.recenterSeq !== lastRecenterSeq) { lastRecenterSeq = m.state.recenterSeq; recenter(m.state.recenterYaw); }
          ensureSource(); applyScreen(); syncTick(true); break;
        case 'download': enqueue(m.ids); break;
        case 'cancel': cancelDownloads(); break;
        case 'remove': (m.ids || [m.id]).forEach(id => removeLocal(id)); break;
      }
    }
  });
  $('name').addEventListener('change', () => {
    myName = $('name').value.trim().slice(0, 40) || myName; $('name').value = myName;
    store.set('fc.name', myName); link.send({ t: 'rename', name: myName });
  });

  // ------------------------------------------------------------ local storage of videos (origin private file system)
  const index = store.get('fc.files', {});       // id -> size of the complete copy on this headset
  const dl = {};                                  // id -> { state, pct, error }
  const manual = {};                              // id -> File picked by hand
  let queue = [], active = null, abortCtl = null;
  const opfsOK = !!(navigator.storage && navigator.storage.getDirectory);
  const fileName = id => 'v_' + encodeURIComponent(id);
  const opfs = () => navigator.storage.getDirectory();
  const hasLocal = it => !!it && index[it.id] === it.size;

  async function verifyIndex() {
    if (!opfsOK) return;
    const root = await opfs();
    for (const id of Object.keys(index)) {
      try { const f = await (await root.getFileHandle(fileName(id))).getFile(); if (f.size !== index[id]) delete index[id]; }
      catch { delete index[id]; }
    }
    store.set('fc.files', index);
  }
  function dropStaleIndex() {
    // a library file that changed size on the PC needs downloading again
    for (const id of Object.keys(index)) { const it = libItem(id); if (it && it.size !== index[id]) { delete index[id]; } }
    store.set('fc.files', index);
  }

  function enqueue(ids) {
    if (!opfsOK) { setHint('This browser can\'t store videos on the headset.', true); return; }
    (ids || []).forEach(id => {
      const it = libItem(id);
      if (!it || hasLocal(it) || queue.includes(id) || active === id) return;
      queue.push(id); dl[id] = { state: 'queued', pct: 0 };
    });
    renderFiles(); pump();
  }
  function cancelDownloads() {
    queue.forEach(id => { dl[id] = { state: 'cancelled', pct: 0 }; }); queue = [];
    if (abortCtl) abortCtl.abort();
    renderFiles();
  }
  async function pump() {
    if (active || !queue.length) return;
    const id = queue.shift(), it = libItem(id);
    if (!it) return pump();
    active = id; abortCtl = new AbortController();
    dl[id] = { state: 'active', pct: 0 };
    delete index[id]; store.set('fc.files', index);
    let writer = null;
    try {
      const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (est && est.quota && est.quota - est.usage < it.size * 1.02) throw new Error('Not enough space on this headset');
      const root = await opfs();
      const fh = await root.getFileHandle(fileName(id), { create: true });
      writer = await fh.createWritable();
      const res = await fetch('/videos/' + encodeURIComponent(id), { signal: abortCtl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('The PC refused the download (' + res.status + ')');
      const reader = res.body.getReader();
      let got = 0, lastDraw = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
        got += value.byteLength; dl[id].pct = got / it.size;
        if (performance.now() - lastDraw > 500) { lastDraw = performance.now(); renderFiles(); }
      }
      await writer.close(); writer = null;
      if (got !== it.size) throw new Error('The download was incomplete');
      index[id] = it.size; store.set('fc.files', index);
      dl[id] = { state: 'done', pct: 1 };
      ensureSource();
    } catch (e) {
      if (writer) { try { await writer.abort(); } catch {} }
      try { await (await opfs()).removeEntry(fileName(id)); } catch {}
      dl[id] = e.name === 'AbortError' ? { state: 'cancelled', pct: 0 }
        : { state: 'error', pct: 0, error: e.name === 'QuotaExceededError' ? 'Not enough space on this headset' : e.message };
    }
    active = null; abortCtl = null; renderFiles(); pump();
  }
  async function removeLocal(id) {
    if (id === current.id && current.kind === 'local') { setHint('Can\'t remove the video that is loaded right now.', true); return; }
    if (active === id && abortCtl) abortCtl.abort();
    queue = queue.filter(q => q !== id);
    delete index[id]; store.set('fc.files', index); delete dl[id];
    if (opfsOK) { try { await (await opfs()).removeEntry(fileName(id)); } catch {} }
    renderFiles();
  }

  $('localFile').addEventListener('change', () => {
    const f = $('localFile').files[0]; if (!f) return;
    const it = libItem(f.name) || library.find(v => v.name === f.name);
    if (!it) { setHint('"' + f.name + '" isn\'t in the library on the PC. Pick a file with the same name as one in the library.', true); return; }
    manual[it.id] = f; setHint('Using "' + f.name + '" from this headset.'); renderFiles(); ensureSource();
  });

  // ------------------------------------------------------------ choosing what to play
  const current = { id: null, kind: null, sig: '', url: null };
  let sourceToken = 0;
  async function ensureSource() {
    const s = link.state; if (!s) return;
    const it = s.videoId ? libItem(s.videoId) : null;
    let kind = null;
    if (it) kind = manual[it.id] ? 'manual' : hasLocal(it) ? 'local' : s.stream ? 'stream' : null;
    const sig = it ? [it.id, it.size, kind].join('|') : '';
    if (sig !== current.sig) {
      const token = ++sourceToken;
      let url = null;
      try {
        if (kind === 'manual') url = URL.createObjectURL(manual[it.id]);
        else if (kind === 'local') url = URL.createObjectURL(await (await (await opfs()).getFileHandle(fileName(it.id))).getFile());
        else if (kind === 'stream') url = '/videos/' + encodeURIComponent(it.id);
      } catch (e) { kind = null; delete index[it.id]; store.set('fc.files', index); }
      if (token !== sourceToken) { if (url && url.startsWith('blob:')) URL.revokeObjectURL(url); return; }
      if (current.url && current.url.startsWith('blob:')) URL.revokeObjectURL(current.url);
      Object.assign(current, { id: it ? it.id : null, kind, sig, url });
      imageReady = false;
      if (url && isImageItem(it)) { video.pause(); video.removeAttribute('src'); video.load(); loadImage(url, token); }
      else if (url) { video.src = url; video.load(); }
      else { video.pause(); video.removeAttribute('src'); video.load(); }
    }
    rebuildView(); updateUI();
  }
  video.addEventListener('loadedmetadata', () => { rebuildView(true); updateMediaLayer(); syncTick(true); updateUI(); });
  video.addEventListener('loadeddata', () => updateMediaLayer());
  video.addEventListener('error', () => {
    if (!current.url || isImageItem(itemNow())) return;
    setHint('This headset couldn\'t play the video (' + ((video.error && video.error.code === 4) ? 'format not supported' : 'decode error') + ').', true);
  });

  // ------------------------------------------------------------ keeping in sync
  let lastCheck = 0, lastHardSeek = 0, drift = 0;
  const SEEK_LEAD = 0.15; // seconds to aim ahead when jumping, to cover the time a seek takes
  function syncTick(force) {
    const s = link.state;
    if (!s || !current.kind || isImageItem(itemNow()) || video.readyState < 1) return;
    const t = link.serverNow();
    const dur = video.duration || Infinity;
    const holdAt = p => {
      if (!video.paused) video.pause();
      video.playbackRate = 1;
      if (!video.seeking && Math.abs(video.currentTime - Math.min(p, dur)) > 0.04) video.currentTime = Math.min(p, dur);
    };
    if (!s.playing) { drift = 0; return holdAt(s.position); }
    if (t < s.at) { drift = 0; return holdAt(s.position); }     // waiting for the shared start time
    const exp = link.expected(t);
    if (exp >= dur - 0.05) { drift = 0; if (!video.paused) video.pause(); return; }
    if (video.paused) {
      if (!video.seeking && Math.abs(video.currentTime - exp) > 0.25) video.currentTime = exp + SEEK_LEAD;
      playVideo(); return;
    }
    if (!force && t - lastCheck < 200) return;
    lastCheck = t;
    if (video.seeking) return;
    const d = video.currentTime - exp; drift = d;
    if (Math.abs(d) > 0.5 && t - lastHardSeek > 2000) {
      lastHardSeek = t; video.playbackRate = 1; video.currentTime = exp + SEEK_LEAD; return;
    }
    // small differences: speed up or slow down slightly until we're back in step
    video.playbackRate = Math.abs(d) > 0.015 ? Math.max(0.92, Math.min(1.08, 1 - d * 0.8)) : 1;
  }
  setInterval(() => { syncTick(); telemetry(); }, 50);

  // ------------------------------------------------------------ 3D views
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setPixelRatio(1); renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local');
  $('view').appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
  const content = new THREE.Group(); scene.add(content);
  const tex = new THREE.VideoTexture(video);
  tex.encoding = THREE.sRGBEncoding; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const imgTex = new THREE.Texture();
  imgTex.encoding = THREE.sRGBEncoding; imgTex.minFilter = THREE.LinearMipmapLinearFilter; imgTex.magFilter = THREE.LinearFilter;
  imgTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  let meshes = [];

  // In WebGL mode a panel says what's happening when no video is showing
  const wc = document.createElement('canvas'); wc.width = 1024; wc.height = 256;
  const wtex = new THREE.CanvasTexture(wc);
  const waitPanel = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.5), new THREE.MeshBasicMaterial({ map: wtex, transparent: true }));
  waitPanel.position.set(0, 0, -3); scene.add(waitPanel);
  let waitText = '';
  function drawWait(text) {
    if (text === waitText) return;
    waitText = text;
    const x = wc.getContext('2d'); x.clearRect(0, 0, 1024, 256);
    const g = x.createLinearGradient(0, 0, 1024, 0); g.addColorStop(0, '#7400b8'); g.addColorStop(0.5, '#5390d9'); g.addColorStop(1, '#80ffdb');
    x.fillStyle = 'rgba(18,13,41,0.92)'; x.fillRect(0, 0, 1024, 256); x.fillStyle = g; x.fillRect(0, 0, 1024, 8);
    x.fillStyle = '#eef0ff'; x.font = '700 56px Manrope, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, 512, 132); wtex.needsUpdate = true;
  }

  const itemNow = () => (current.kind ? libItem(current.id) : null);
  function eyeAspect(it) {
    let { w, h } = mediaSize();
    if (it.layout === 'sbs') w /= 2; if (it.layout === 'tb') h /= 2;
    return w / h;
  }
  function remapUV(geo, su, ou, sv, ov) {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
    uv.needsUpdate = true;
  }
  function geometryFor(it) {
    if (it.shape === 'flat') return new THREE.PlaneGeometry(1, 1 / eyeAspect(it));
    const g = it.shape === '180' ? new THREE.SphereGeometry(50, 96, 64, Math.PI / 2, Math.PI) : new THREE.SphereGeometry(50, 96, 64);
    g.scale(-1, 1, 1); g.rotateY(-Math.PI / 2);
    return g;
  }
  let viewSig = '';
  function rebuildView(forceAspect) {
    const loaded = itemNow();
    const it = loaded && (!isImageItem(loaded) || imageReady) ? loaded : null;   // an image shows once it has decoded
    const ms = mediaSize();
    const sig = it ? [it.id, it.shape, it.layout, current.kind, forceAspect ? ms.w + 'x' + ms.h : ''].join('|') : 'none';
    if (sig === viewSig && !forceAspect) return;
    viewSig = sig;
    meshes.forEach(m => { content.remove(m); m.geometry.dispose(); m.material.dispose(); }); meshes = [];
    if (it) {
      const parts = it.layout === 'mono' ? [[0, -1]] : [[1, 0], [2, 1]];
      parts.forEach(([layer, eye]) => {
        const g = geometryFor(it);
        if (it.layout === 'tb') remapUV(g, 1, 0, 0.5, eye === 0 ? 0.5 : 0);
        if (it.layout === 'sbs') remapUV(g, 0.5, eye === 0 ? 0 : 0.5, 1, 0);
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: isImageItem(it) ? imgTex : tex, side: THREE.DoubleSide }));
        m.layers.set(layer); content.add(m); meshes.push(m);
      });
    }
    waitPanel.visible = !it;
    drawWait(link.state && link.state.videoId ? (loaded ? 'Loading…' : 'Not on this headset yet') : 'Waiting for the operator');
    applyScreen();
    updateMediaLayer();
  }

  // ------------------------------------------------------------ recentre and screen placement
  let yawOffset = 0, rawYaw = 0, rawPitch = 0, looking = false;
  // Turn the video so that the point at targetDeg (0 = centre) sits straight ahead of the wearer
  function recenter(targetDeg) { yawOffset = rawYaw - (+targetDeg || 0) * Math.PI / 180; applyScreen(); updateMediaTransform(); }
  function screenCfg() { return (link.state && link.state.screen) || { dist: 12, width: 12 }; }
  function applyScreen() {
    content.rotation.y = -yawOffset;
    const it = itemNow();
    if (it && it.shape === 'flat') { const sc = screenCfg(); meshes.forEach(m => { m.position.set(0, 0, -sc.dist); m.scale.setScalar(sc.width); }); }
    updateMediaTransform();
  }

  // ------------------------------------------------------------ media layer (headset compositor draws the picture)
  // The compositor shows exactly one layer: the video, a still image, or a "waiting" panel.
  // A new layer is only made once its content is ready, and a failed attempt is retried,
  // so the headset never stays stuck on an old picture.
  let session = null, layerSession = null, mediaBinding = null, mediaSpace = null, mediaLayer = null, mediaSig = '', layerKind = null;
  let glBinding = null, staticDirty = false, staticGL = null;
  const yawQuat = a => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });
  const WAIT_W = 2, WAIT_H = 0.5, WAIT_DIST = 3;
  function updateMediaTransform() {
    if (!mediaLayer) return;
    const a = -yawOffset, it = itemNow();
    const ahead = d => ({ x: Math.sin(yawOffset) * d, y: 0, z: -Math.cos(yawOffset) * d });
    if (layerKind === 'wait') {
      mediaLayer.transform = new XRRigidTransform(ahead(WAIT_DIST), yawQuat(a));
    } else if (it && it.shape === 'flat') {
      const sc = screenCfg();
      mediaLayer.transform = new XRRigidTransform(ahead(sc.dist), yawQuat(a));
      mediaLayer.width = sc.width; mediaLayer.height = sc.width / eyeAspect(it);
    } else {
      mediaLayer.transform = new XRRigidTransform({ x: 0, y: 0, z: 0 }, yawQuat(a));
    }
  }
  function setLayer(layer, kind) {
    const old = mediaLayer;
    mediaLayer = layer; layerKind = kind;
    staticDirty = kind !== 'video';
    updateMediaTransform();
    layerSession.updateRenderState({ layers: [layer] });
    if (old && old !== layer && old.destroy) try { old.destroy(); } catch {}
  }
  function updateMediaLayer() {
    if (!layerSession) return;
    const it = itemNow();
    const want = !it ? 'wait'
      : isImageItem(it) ? (imageReady ? 'image' : 'wait')
      : (video.readyState >= 1 && video.videoWidth ? 'video' : 'wait');   // wait until the video has opened
    const sig = want === 'wait' ? 'wait|' + waitText : [want, it.id, it.shape, it.layout, current.kind].join('|');
    if (sig === mediaSig) return;
    const layout = it ? { mono: 'mono', tb: 'stereo-top-bottom', sbs: 'stereo-left-right' }[it.layout] : 'mono';
    try {
      if (want === 'wait') {
        if (!glBinding) { if (mediaLayer) { layerSession.updateRenderState({ layers: [] }); mediaLayer = null; layerKind = null; } mediaSig = sig; return; }
        setLayer(glBinding.createQuadLayer({ space: mediaSpace, layout: 'mono', viewPixelWidth: wc.width, viewPixelHeight: wc.height, isStatic: true, width: WAIT_W, height: WAIT_H }), 'wait');
      } else if (want === 'image') {
        if (!glBinding) { setHint('Images need the WebGL renderer on this headset. Choose it under Settings and enter VR again.', true); return; }
        // A still picture can't use the video layer, so it is copied once into a static layer the compositor keeps showing
        const { w, h } = mediaSize();
        let ew = it.layout === 'sbs' ? w / 2 : w, eh = it.layout === 'tb' ? h / 2 : h;
        const k = Math.min(1, 8192 / Math.max(ew, eh)); ew = Math.round(ew * k); eh = Math.round(eh * k);
        if (it.shape === 'flat') {
          const sc = screenCfg();
          setLayer(glBinding.createQuadLayer({ space: mediaSpace, layout, viewPixelWidth: ew, viewPixelHeight: eh, isStatic: true, width: sc.width, height: sc.width / eyeAspect(it) }), 'image');
        } else {
          setLayer(glBinding.createEquirectLayer({
            space: mediaSpace, layout, viewPixelWidth: ew, viewPixelHeight: eh, isStatic: true,
            centralHorizontalAngle: it.shape === '180' ? Math.PI : Math.PI * 2,
            upperVerticalAngle: Math.PI / 2, lowerVerticalAngle: -Math.PI / 2
          }), 'image');
        }
      } else {
        if (it.shape === 'flat') {
          const sc = screenCfg();
          setLayer(mediaBinding.createQuadLayer(video, { space: mediaSpace, layout, width: sc.width, height: sc.width / eyeAspect(it) }), 'video');
        } else {
          setLayer(mediaBinding.createEquirectLayer(video, {
            space: mediaSpace, layout,
            centralHorizontalAngle: it.shape === '180' ? Math.PI : Math.PI * 2,
            upperVerticalAngle: Math.PI / 2, lowerVerticalAngle: -Math.PI / 2
          }), 'video');
        }
      }
      mediaSig = sig;     // only remembered once the layer really exists, so a failure is retried
    } catch (e) {
      setHint('Couldn\'t switch the picture in VR (' + e.message + '). Retrying…', true);
      clearTimeout(retryTimer); retryTimer = setTimeout(updateMediaLayer, 500);
    }
  }
  let retryTimer = null;

  // Copy a still picture (an image, or the waiting panel) into the static layer, one eye at a time.
  // The layer only needs this when it is first made, or if the headset says it has lost the contents.
  function drawStaticLayer(frame) {
    const gl = renderer.getContext(), it = itemNow();
    if (!glBinding || typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return;
    const src = layerKind === 'image' ? imgSource : wc;
    const layout = layerKind === 'image' && it ? it.layout : 'mono';
    if (!src) return;
    const version = layerKind === 'image' ? 'img' : 'wait:' + waitText;
    if (!staticGL || staticGL.src !== src || staticGL.version !== version) {
      if (staticGL) { gl.deleteTexture(staticGL.tex); gl.deleteFramebuffer(staticGL.read); gl.deleteFramebuffer(staticGL.draw); }
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      const read = gl.createFramebuffer();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      staticGL = { tex: t, read, draw: gl.createFramebuffer(), src, version, w: src.width, h: src.height };
    }
    const W = staticGL.w, H = staticGL.h;
    // source rectangles in GL coordinates (the picture was flipped on upload, so its top is at y = H)
    const eyes = layout === 'mono' ? [[null, 0, 0, W, H]]
      : layout === 'sbs' ? [['left', 0, 0, W / 2, H], ['right', W / 2, 0, W, H]]
      : [['left', 0, H / 2, W, H], ['right', 0, 0, W, H / 2]];   // top half is the left eye
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, staticGL.read);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, staticGL.draw);
    for (const [eye, x0, y0, x1, y1] of eyes) {
      const sub = eye ? glBinding.getSubImage(mediaLayer, frame, eye) : glBinding.getSubImage(mediaLayer, frame);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sub.colorTexture, 0);
      const v = sub.viewport;
      gl.blitFramebuffer(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), v.x, v.y, v.x + v.width, v.y + v.height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    if (renderer.resetState) renderer.resetState();
    staticDirty = false;
  }

  // ------------------------------------------------------------ head direction
  function setLookFromQuat(q) {
    const fx = -2 * (q.x * q.z + q.w * q.y), fy = -2 * (q.y * q.z - q.w * q.x), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    rawYaw = Math.atan2(fx, -fz); rawPitch = Math.asin(Math.max(-1, Math.min(1, fy))); looking = true;
  }
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  let lastLook = 0, lastStatus = 0, lastPresented = 0, fps = 0;
  function telemetry() {
    const t = performance.now();
    if (t - lastLook >= 100) {
      lastLook = t;
      link.send(looking && session
        ? { t: 'look', y: +(wrap(rawYaw - yawOffset) * 180 / Math.PI).toFixed(1), p: +(rawPitch * 180 / Math.PI).toFixed(1) }
        : { t: 'look', y: null, p: null });
    }
    if (t - lastStatus >= 1000) {
      fps = (presented - lastPresented) * 1000 / (t - lastStatus || 1000); lastPresented = presented;
      lastStatus = t; sendStatus();
    }
  }

  // ------------------------------------------------------------ status for the operator
  let battery = null, storageFree = null;
  if (navigator.getBattery) navigator.getBattery().then(b => { battery = b; }).catch(() => {});
  async function checkStorage() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    try { const e = await navigator.storage.estimate(); storageFree = e.quota - e.usage; } catch {}
    $('storage').textContent = storageFree != null ? FC.fmtSize(storageFree) + ' free for videos and images' : '';
  }
  function sendStatus() {
    const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
    const files = {};
    library.forEach(it => {
      files[it.id] = manual[it.id] ? { state: 'done', pct: 1, manual: true }
        : hasLocal(it) ? { state: 'done', pct: 1 } : (dl[it.id] || { state: 'none', pct: 0 });
    });
    link.send({ t: 'status', status: {
      inVR: !!session, renderer: session ? (layerSession ? 'layer' : 'webgl') : null,
      videoId: current.id, source: current.kind,
      ready: !!current.kind && (isImageItem(itemNow()) ? imageReady : video.readyState >= 2),
      playing: !video.paused && !isImageItem(itemNow()), time: video.currentTime || 0, drift: Math.round(drift * 1000), rate: video.playbackRate,
      fps: video.paused ? null : Math.round(fps), dropped: q ? q.droppedVideoFrames : null,
      muted: video.muted, battery: battery ? Math.round(battery.level * 100) : null, charging: battery ? battery.charging : null,
      storageFree, files, sync: link.rtt != null ? Math.round(link.rtt / 2) : null,
      error: video.error ? 'Playback error ' + video.error.code : null
    } });
    $('clock').textContent = link.rtt != null ? 'Timing accurate to about ' + Math.max(1, Math.round(link.rtt / 2)) + ' ms' : '';
  }

  // ------------------------------------------------------------ page UI
  let hintText = '', hintBad = false, hintTimer = null;
  function setHint(t, bad) {
    hintText = t; hintBad = !!bad; updateUI();
    clearTimeout(hintTimer); if (t && bad) hintTimer = setTimeout(() => { hintText = ''; updateUI(); }, 8000);
  }
  function updateUI() {
    const s = link.state, it = s && s.videoId ? libItem(s.videoId) : null;
    $('nowName').textContent = it ? (it.folder ? it.folder + ' › ' : '') + (it.name || it.id) : 'Waiting for the operator';
    $('nowFormat').textContent = it ? (it.kind === 'image' ? 'Image · ' : '') + SHAPES[it.shape] + ' · ' + LAYOUTS[it.layout] + ' · ' + FC.fmtSize(it.size) : '';
    const chip = $('nowReady');
    chip.hidden = !it;
    if (it) {
      const d = dl[it.id];
      if (current.kind === 'local' || current.kind === 'manual') { chip.className = 'chip ok'; chip.textContent = 'On this headset'; }
      else if (current.kind === 'stream') { chip.className = 'chip warn'; chip.textContent = 'Streaming from the PC'; }
      else if (d && d.state === 'active') { chip.className = 'chip warn'; chip.textContent = 'Downloading ' + Math.floor(d.pct * 100) + '%'; }
      else { chip.className = 'chip bad'; chip.textContent = 'Not on this headset'; }
    }
    const btn = $('vrBtn');
    if (session) { btn.textContent = 'Exit VR'; btn.disabled = false; }
    else {
      btn.textContent = 'Enter VR';
      btn.disabled = !vrSupported;
    }
    let hint = hintText;
    if (!hint) {
      if (!window.isSecureContext) hint = 'Open this page with https:// so VR can start.';
      else if (!vrSupported) hint = vrChecked ? 'VR isn\'t available in this browser.' : 'Checking VR support…';
      else if (!current.kind && it) hint = 'This isn\'t on the headset yet. Download it below, or ask the operator to send it.';
      else if (!current.kind) hint = 'Put the headset on and press Enter VR. You\'ll see a waiting screen until the operator loads something.';
      else hint = 'Put the headset on and press Enter VR. The operator controls playback.';
    }
    $('hint').textContent = hint; $('hint').className = 'hint' + (hintBad ? ' bad' : '');
  }

  const openGroups = new Set();
  function fileRow(it) {
    const row = document.createElement('div'); row.className = 'file';
    const d = dl[it.id], have = hasLocal(it), picked = !!manual[it.id];
    let status, cls = '';
    if (picked) { status = 'Using a file picked on this headset'; cls = 'ok'; }
    else if (have) { status = 'On this headset'; cls = 'ok'; }
    else if (d && d.state === 'active') status = 'Downloading ' + Math.floor(d.pct * 100) + '%';
    else if (d && d.state === 'queued') status = 'Waiting to download';
    else if (d && d.state === 'error') { status = d.error; cls = 'bad'; }
    else status = 'Not on this headset';
    const info = document.createElement('div');
    const n = document.createElement('div'); n.className = 'n'; n.textContent = it.name || it.id;
    const m = document.createElement('div'); m.className = 'm';
    m.textContent = (it.kind === 'image' ? 'Image · ' : '') + FC.fmtSize(it.size) + ' · ' + SHAPES[it.shape] + ' · ' + LAYOUTS[it.layout] + ' · ' + status;
    if (cls) m.style.color = cls === 'ok' ? 'var(--green)' : 'var(--red)';
    info.append(n, m);
    const b = document.createElement('button'); b.type = 'button';
    if (d && (d.state === 'active' || d.state === 'queued')) { b.textContent = 'Cancel'; b.className = 'quiet'; b.onclick = () => removeLocal(it.id); }
    else if (have) { b.textContent = 'Remove'; b.className = 'quiet'; b.onclick = () => removeLocal(it.id); }
    else { b.textContent = 'Download'; b.onclick = () => enqueue([it.id]); b.disabled = !opfsOK || picked; }
    row.append(info, b);
    if (d && d.state === 'active') { const bar = document.createElement('div'); bar.className = 'bar'; const i = document.createElement('i'); i.style.width = (d.pct * 100).toFixed(1) + '%'; bar.append(i); row.append(bar); }
    return row;
  }
  function renderFiles() {
    const list = $('fileList');
    if (!library.length) { list.innerHTML = '<p class="empty">Nothing in the library yet.</p>'; updateUI(); return; }
    list.textContent = '';
    // folders become one collapsible line each, so a long series of photos doesn't fill the page
    const folders = new Map();
    library.filter(v => v.folder).forEach(v => { if (!folders.has(v.folder)) folders.set(v.folder, []); folders.get(v.folder).push(v); });
    folders.forEach((items, name) => {
      const det = document.createElement('details'); det.className = 'fgroup'; det.open = openGroups.has(name);
      det.addEventListener('toggle', () => { det.open ? openGroups.add(name) : openGroups.delete(name); });
      const sum = document.createElement('summary');
      const have = items.filter(v => hasLocal(v) || manual[v.id]).length;
      const active = items.some(v => dl[v.id] && (dl[v.id].state === 'active' || dl[v.id].state === 'queued'));
      const t = document.createElement('span'); t.className = 'n'; t.textContent = name;
      const m = document.createElement('span'); m.className = 'm';
      m.textContent = have + ' of ' + items.length + ' on this headset' + (active ? ' · downloading' : '');
      if (have === items.length) m.style.color = 'var(--green)';
      const b = document.createElement('button'); b.type = 'button';
      if (have < items.length) { b.textContent = 'Download all'; b.disabled = !opfsOK; b.onclick = e => { e.preventDefault(); enqueue(items.map(v => v.id)); }; }
      else { b.textContent = 'Remove all'; b.className = 'quiet'; b.onclick = e => { e.preventDefault(); items.forEach(v => removeLocal(v.id)); }; }
      sum.append(t, m, b); det.append(sum);
      const inner = document.createElement('div'); inner.className = 'files';
      items.forEach(it => inner.append(fileRow(it)));
      det.append(inner); list.append(det);
    });
    library.filter(v => !v.folder).forEach(it => list.append(fileRow(it)));
    updateUI();
  }


  // ------------------------------------------------------------ entering VR
  let vrSupported = false, vrChecked = false;
  const hasMediaLayers = 'XRMediaBinding' in window;
  $('engine').value = store.get('fc.engine', hasMediaLayers ? 'layer' : 'webgl');
  if (!hasMediaLayers) { $('engine').value = 'webgl'; $('engine').options[0].disabled = true; }
  $('engine').addEventListener('change', () => { store.set('fc.engine', $('engine').value); updateUI(); });

  if (window.isSecureContext && navigator.xr) {
    navigator.xr.isSessionSupported('immersive-vr').then(ok => { vrSupported = ok; vrChecked = true; updateUI(); }, () => { vrChecked = true; updateUI(); });
  } else { vrChecked = true; }

  function onSessionEnd() {
    session = layerSession = mediaLayer = mediaBinding = mediaSpace = glBinding = layerKind = null; mediaSig = ''; looking = false;
    clearTimeout(retryTimer);
    updateUI(); sendStatus();
  }

  async function enterMediaLayer() {
    const s = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['layers'], optionalFeatures: ['local'] });
    session = layerSession = s;
    mediaSpace = await s.requestReferenceSpace('local');
    mediaBinding = new XRMediaBinding(s);
    try {
      const gl = renderer.getContext();
      if (gl.makeXRCompatible) await gl.makeXRCompatible();
      glBinding = new XRWebGLBinding(s, gl);
    } catch (e) { glBinding = null; }
    mediaSig = ''; updateMediaLayer();
    s.addEventListener('end', onSessionEnd);
    s.addEventListener('squeezestart', () => recenter(0));   // grip recentres for this wearer
    const onFrame = (time, frame) => {
      if (session !== s) return;
      const pose = frame.getViewerPose(mediaSpace);
      if (pose) setLookFromQuat(pose.transform.orientation);
      if (mediaLayer && layerKind !== 'video' && (staticDirty || mediaLayer.needsRedraw)) {
        try { drawStaticLayer(frame); } catch (e) { staticDirty = false; setHint('Couldn\'t draw the picture: ' + e.message, true); }
      }
      syncTick(); telemetry();
      s.requestAnimationFrame(onFrame);
    };
    s.requestAnimationFrame(onFrame);
  }

  async function enterWebGL() {
    const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local'] });
    session = s;
    s.addEventListener('end', onSessionEnd);
    s.addEventListener('squeezestart', () => recenter(0));
    await renderer.xr.setSession(s);
  }

  const headQ = new THREE.Quaternion();
  renderer.setAnimationLoop(() => {
    if (!renderer.xr.isPresenting || layerSession) return;
    renderer.xr.getCamera(camera).getWorldQuaternion(headQ);
    setLookFromQuat(headQ);
    syncTick(); telemetry();
    renderer.render(scene, camera);
  });

  $('vrBtn').addEventListener('click', async () => {
    if (session) { session.end(); return; }
    soundBlocked = false; video.muted = false; // this tap counts as permission for sound
    try {
      if ($('engine').value === 'layer') {
        try { await enterMediaLayer(); }
        catch (e) { session = layerSession = null; setHint('Media layer unavailable (' + e.message + '). Using WebGL instead.', true); await enterWebGL(); }
      } else await enterWebGL();
      recenterOnStart();
    } catch (e) {
      session = null;
      setHint('Couldn\'t start VR: ' + e.message, true);
    }
    updateUI(); sendStatus();
  });
  // Face the centre of the video when entering VR
  function recenterOnStart() { let n = 0; const tryIt = () => { if (looking) recenter(link.state ? link.state.recenterYaw : 0); else if (++n < 30) setTimeout(tryIt, 50); }; tryIt(); }

  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });

  // ------------------------------------------------------------ start
  if (opfsOK && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  verifyIndex().then(() => { renderFiles(); ensureSource(); });
  checkStorage(); setInterval(checkStorage, 15000);
  drawWait('Waiting for the operator');
  updateUI();
})();
