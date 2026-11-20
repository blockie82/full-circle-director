const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs');
const icon = 'data:image/png;base64,' + fs.readFileSync('/home/claude/full-circle/android/app/src/main/res/drawable/logo.png').toString('base64');
// The app's own layout (MainActivity.java): colours BG 11,8,24 / CARD 24,19,44 / ACCENT 78,205,220 / LINE 60,52,96, sizes in dp
const html = `<!doctype html><style>
*{margin:0;box-sizing:border-box} body{width:2560px;height:1440px;font-family:Inter,Roboto,sans-serif;
background:radial-gradient(80% 70% at 50% 40%,#2b2f3a,#14161c 70%,#0d0e12);display:flex;align-items:center;justify-content:center}
.panel{width:1024px;height:680px;zoom:1.62;background:rgb(11,8,24);border-radius:22px;overflow:hidden;display:flex;justify-content:center;box-shadow:0 30px 80px rgba(0,0,0,.55)}
.col{width:680px;padding:28px 32px;display:flex;flex-direction:column;align-items:center;color:#fff}
img{width:88px;height:88px}
h1{font-size:26px;font-weight:700;margin-top:12px}
.by{font-size:14px;color:rgb(170,165,195)}
.st{font-size:17px;padding:24px 0 12px;text-align:center}
.card{width:100%;display:flex;align-items:center;background:rgb(24,19,44);border:1px solid rgb(60,52,96);border-radius:12px;padding:12px 12px 12px 16px;margin-bottom:8px}
.card .n{font-size:17px;font-weight:700}.card .a{font-size:13px;color:rgb(170,165,195)}
.btn{font-size:15px;padding:8px 18px;border-radius:12px;border:1px solid rgb(60,52,96);color:#fff}
.p{background:rgb(78,205,220);border-color:rgb(78,205,220);color:rgb(11,8,24)}
.or{font-size:14px;color:rgb(170,165,195);padding:28px 0 8px}
.row{width:100%;display:flex;gap:10px;align-items:center}
.in{flex:1;background:rgb(24,19,44);border:1px solid rgb(60,52,96);border-radius:12px;padding:10px 14px;font-size:16px}
.hint{font-size:13px;color:rgb(170,165,195);padding-top:24px}
</style><div class="panel"><div class="col">
<img src="${icon}"><h1>Full Circle Player</h1><div class="by">by Full Circle Immersive</div>
<div class="st">Found TRAINING-PC – opening the player…</div>
<div class="card"><div style="flex:1"><div class="n">TRAINING-PC</div><div class="a">192.168.8.10&nbsp; · &nbsp;Director 2.4.1</div></div><div class="btn p" style="margin-left:12px">Open player</div></div>
<div class="btn" style="margin-top:8px">Search again</div>
<div class="or">Or type the address shown in the Director</div>
<div class="row"><div class="in">192.168.8.10</div><div class="btn p">Open</div></div>
<div class="hint">The headset and the Director's PC must be on the same Wi-Fi.</div>
</div></div>`;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 2560, height: 1440 } });
  await p.setContent(html); await p.waitForTimeout(300);
  await p.screenshot({ path: __dirname + '/out/s5.png' }); await b.close();
})();
