const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs');
const SRC = __dirname + '/src/', OUT = __dirname + '/out/';
const logo = fs.readFileSync(SRC + 'logo.svg', 'utf8');
const font = 'data:font/woff2;base64,' + fs.readFileSync(SRC + 'manrope.woff2').toString('base64');
const img = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
const css = `@font-face{font-family:M;src:url(${font}) format('woff2');font-weight:200 800}
*{margin:0;box-sizing:border-box} html,body{width:100%;height:100%;overflow:hidden}
body{font-family:M,sans-serif;color:#eef0ff;-webkit-font-smoothing:antialiased}
.bg{position:absolute;inset:0;background:
  radial-gradient(70% 90% at 18% 10%, rgba(116,0,184,.55), transparent 62%),
  radial-gradient(70% 90% at 88% 100%, rgba(72,191,227,.30), transparent 60%), #0a0718}
.wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.emb svg{width:100%;height:100%;display:block;filter:drop-shadow(0 0 .25em rgba(83,144,217,.35))}
.t{font-weight:800;letter-spacing:-.025em;line-height:1.02;white-space:nowrap}
.g{background:linear-gradient(90deg,#a98bff,#7f9cff 35%,#5fd0ee 70%,#8affdf);-webkit-background-clip:text;background-clip:text;color:transparent}
.bar{position:absolute;left:0;right:0;bottom:0;height:.6%;background:linear-gradient(90deg,#7400b8,#5e60ce,#5390d9,#48bfe3,#64dfdf,#80ffdb)}`;
const emb = (s) => `<div class="emb" style="width:${s}px;height:${s}px;flex:none">${logo}</div>`;
const title = (px, br) => `<div class="t" style="font-size:${px}px">Full Circle${br ? '<br>' : ' '}<span class="g">Player</span></div>`;
const row = (W, H, e, t, gap) => `<div class="bg"></div><div class="wrap" style="gap:${gap}px">${emb(e)}${title(t)}</div><div class="bar"></div>`;
const stack = (W, H, e, t, gap, br) => `<div class="bg"></div><div class="wrap" style="flex-direction:column;gap:${gap}px;text-align:center">${emb(e)}${title(t, br)}</div><div class="bar"></div>`;
const play = (s) => `<div style="position:absolute;right:${s*0.13}px;bottom:${s*0.13}px;width:${s*0.3}px;height:${s*0.3}px;border-radius:50%;background:linear-gradient(135deg,#48bfe3,#5390d9);display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 ${s*0.025}px #0a0718"><div style="width:0;height:0;border-left:${s*0.1}px solid #fff;border-top:${s*0.065}px solid transparent;border-bottom:${s*0.065}px solid transparent;margin-left:${s*0.025}px"></div></div>`;

const jobs = [
  ['Hero cover (3000x900).png', 3000, 900, row(3000, 900, 400, 190, 70)],
  ['Cover landscape (2560x1440).png', 2560, 1440, stack(2560, 1440, 470, 200, 60)],
  ['Cover square (1440x1440).png', 1440, 1440, stack(1440, 1440, 420, 132, 50)],
  ['Cover portrait (1008x1440).png', 1008, 1440, stack(1008, 1440, 380, 128, 46, true)],
  ['Mini landscape (1080x360).png', 1080, 360, row(1080, 360, 150, 68, 28)],
  ['Logo transparent (3600x720).png', 3600, 720, `<div class="wrap" style="gap:110px">${emb(600)}${title(300)}</div>`, true],
  ['Icon (512x512).png', 512, 512, `<div class="bg"></div><div class="wrap">${emb(330)}</div>${play(512)}`],
  ['Spatialized icon - background (180x180).png', 180, 180, `<div class="bg"></div>`],
  ['Spatialized icon - foreground (180x180).png', 180, 180, `<div class="wrap">${emb(118)}</div>`, true],
  ['Trailer cover (2560x1440).png', 2560, 1440, `<img src="${img(SRC + 'beach_plain.png')}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:brightness(.42) saturate(.9)"><div style="position:absolute;inset:0;background:radial-gradient(60% 60% at 50% 50%,rgba(10,7,24,.55),rgba(10,7,24,.15))"></div><div class="wrap" style="flex-direction:column;gap:60px;text-align:center">${emb(430)}${title(190)}</div><div class="bar"></div>`],
];
(async () => {
  const b = await chromium.launch();
  for (const [name, W, H, body, transparent] of jobs) {
    const p = await b.newPage({ viewport: { width: W, height: H } });
    await p.setContent(`<!doctype html><style>${css}</style><body${transparent ? ' style="background:transparent"' : ''}>${body}</body>`);
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: OUT + name, omitBackground: !!transparent });
    await p.close(); console.log(name);
  }
  await b.close();
})();
