const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs');
const logo = fs.readFileSync(__dirname + '/src/logo.svg', 'utf8');
const css = `*{margin:0} html,body{width:512px;height:512px;overflow:hidden}
.bg{position:absolute;inset:0;background:radial-gradient(70% 90% at 18% 10%, rgba(116,0,184,.55), transparent 62%),radial-gradient(70% 90% at 88% 100%, rgba(72,191,227,.30), transparent 60%), #0a0718}
.w{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.e{width:340px;height:340px}.e svg{width:100%;height:100%;display:block}`;
(async () => {
  const b = await chromium.launch();
  for (const [name, body, tr] of [
    ['Spatialised tile - background (512x512).png', '<div class="bg"></div>', false],
    ['Spatialised tile - foreground (512x512).png', `<div class="w"><div class="e">${logo}</div></div>`, true]]) {
    const p = await b.newPage({ viewport: { width: 512, height: 512 } });
    await p.setContent(`<!doctype html><style>${css}</style><body${tr ? ' style="background:transparent"' : ''}>${body}</body>`);
    await p.screenshot({ path: __dirname + '/out/' + name, omitBackground: tr }); await p.close();
  }
  await b.close();
})();
