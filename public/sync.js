/* Full Circle Director – connection and clock sync shared by the panel and headsets.
 * Keeps a WebSocket open to the server (reconnecting if it drops) and estimates the
 * offset between this device's clock and the server's from the fastest ping round trips. */
(function () {
  class FCLink {
    constructor(opts) {
      this.opts = opts;
      this.offset = 0; this.rtt = null; this.synced = false; this.samples = [];
      this.state = null; this.connected = false; this.ws = null;
      this.open();
    }
    open() {
      const ws = this.ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
      ws.onopen = () => {
        this.connected = true; this.samples = [];
        this.send(this.opts.hello());
        let n = 0; const quick = () => { this.ping(); if (++n < 8 && this.ws === ws) setTimeout(quick, 120); }; quick();
        clearInterval(this.pingTimer); this.pingTimer = setInterval(() => this.ping(), 2000);
        this.opts.onConnection && this.opts.onConnection(true);
      };
      ws.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'pong') return this.pong(m);
        if (m.t === 'state') {
          this.state = m.state;
          if (!this.synced) this.offset = m.serverNow - performance.now(); // rough until pings return
        }
        this.opts.onMessage && this.opts.onMessage(m);
      };
      ws.onclose = e => {
        clearInterval(this.pingTimer);
        if (this.ws !== ws) return;
        this.connected = false;
        this.opts.onConnection && this.opts.onConnection(false, e);
        setTimeout(() => { if (this.ws === ws) this.open(); }, 1500);
      };
      ws.onerror = () => {};
    }
    send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
    ping() { this.send({ t: 'ping', c: performance.now() }); }
    pong(m) {
      const t = performance.now(), rtt = t - m.c;
      this.samples.push({ rtt, off: m.s + rtt / 2 - t });
      if (this.samples.length > 20) this.samples.shift();
      const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      this.offset = best.off; this.rtt = best.rtt; this.synced = true;
    }
    serverNow() { return performance.now() + this.offset; }
    /** Where playback should be right now, in seconds */
    expected(t = this.serverNow()) {
      const s = this.state; if (!s) return 0;
      return s.playing ? s.position + Math.max(0, t - s.at) / 1000 : s.position;
    }
  }

  const fmtTime = s => {
    if (!isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = Math.floor(s % 60);
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };
  const fmtSize = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e7 ? (b / 1e6).toFixed(0) + ' MB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';

  // ---- numbered markers, shared by the panel's views and the headsets
  const MARKER_COLORS = ['#3a86ff', '#ff006e', '#ffbe0b', '#06d6a0', '#8338ec', '#fb5607', '#00b4d8', '#e5383b', '#90be6d', '#f15bb5'];
  const markerColor = n => MARKER_COLORS[(n - 1) % MARKER_COLORS.length];
  const MARKER_DEG = 2;      // radius, in degrees of view
  // One marker at canvas x, y with radius r (sx stretches it sideways, for the panorama's poles)
  function drawMarker(ctx, n, x, y, r, sx = 1, alpha = 1) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.scale(sx, 1);
    ctx.beginPath(); ctx.arc(0, 0, r * 1.14, 0, Math.PI * 2); ctx.fillStyle = 'rgba(10,7,24,0.75)'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.84, 0, Math.PI * 2); ctx.fillStyle = markerColor(n); ctx.fill();
    const t = String(n);
    ctx.font = `800 ${Math.round(r * (t.length > 1 ? 0.95 : 1.15))}px Manrope, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = r * 0.16; ctx.strokeStyle = 'rgba(10,7,24,0.55)'; ctx.strokeText(t, 0, r * 0.06);
    ctx.fillStyle = '#ffffff'; ctx.fillText(t, 0, r * 0.06);
    ctx.restore();
  }
  // All of an item's markers onto a see-through overlay: a full 360° panorama, or (flat) the screen itself
  function drawMarkerOverlay(canvas, list, opts) {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const D = Math.PI / 180;
    for (const m of list || []) {
      if (opts.flat) {
        const h = opts.width / opts.aspect, x = (0.5 + opts.dist * Math.tan(m.y * D) / opts.width) * W, y = (0.5 - opts.dist * Math.tan(m.p * D) / h) * H;
        drawMarker(ctx, m.n, x, y, opts.dist * Math.tan(MARKER_DEG * D) / opts.width * W);
      } else {
        const x = (0.5 + m.y / 360) * W, y = (0.5 - m.p / 180) * H, r = MARKER_DEG / 180 * H;
        const sx = 1 / Math.max(0.15, Math.cos(m.p * D));
        for (const k of [-W, 0, W]) drawMarker(ctx, m.n, x + k, y, r, sx);
      }
    }
  }

  window.FC = { FCLink, fmtTime, fmtSize, markerColor, drawMarker, drawMarkerOverlay, MARKER_DEG };
})();
