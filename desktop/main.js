'use strict';
/*
 * Full Circle Director – Windows desktop app.
 * Starts the local server in the background and shows the control panel in its own window.
 * Settings, the media library and preview copies live in Documents\Full Circle Director.
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const ICON = path.join(__dirname, 'icon.ico');
const NAME = 'Full Circle Director';

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.setAppUserModelId('com.fullcircleimmersive.director');

const DATA = path.join(app.getPath('documents'), NAME);
const CFG_FILE = path.join(DATA, 'config.json');
const LOG_FILE = path.join(DATA, 'server-log.txt');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; } };
const writeCfg = c => fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2));
const panelPort = () => readCfg().panelPort || 8080;
const mediaDir = () => path.resolve(DATA, readCfg().mediaDir || 'media');

let win = null, server = null, serverOut = '', quitting = false, restarting = false;

// ------------------------------------------------------------------ the server
function startServer() {
  fs.mkdirSync(DATA, { recursive: true });
  const log = fs.createWriteStream(LOG_FILE, { flags: 'w' });
  serverOut = '';
  server = fork(path.join(APP_ROOT, 'server.js'), [], {
    cwd: APP_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, FCD_DATA_DIR: DATA, ELECTRON_RUN_AS_NODE: '1' }
  });
  const onData = d => { const t = String(d); serverOut = (serverOut + t).slice(-10000); log.write(t); };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
  server.on('exit', () => {
    server = null; log.end();
    if (quitting || restarting) return;
    const reason = (serverOut.match(/Port \d+ is already in use[^\n]*/) || serverOut.match(/couldn't start[^\n]*/i) || [])[0]
      || 'The server stopped unexpectedly.';
    dialog.showErrorBox(NAME, reason + (/already in use/.test(reason)
      ? '\n\nIf the older START.bat version is still running, close its black window and open Full Circle Director again.'
      : '') + '\n\nDetails are in ' + LOG_FILE);
    app.quit();
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (!server) return resolve();
    server.once('exit', () => resolve());
    try { server.disconnect(); } catch {}
    setTimeout(() => { if (server) try { server.kill(); } catch {} }, 3000);
  });
}

function waitForPanel(timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port: panelPort(), path: '/api/info', timeout: 1500 }, res => {
        res.resume();
        if (res.statusCode === 200) resolve(); else retry();
      });
      req.on('error', retry); req.on('timeout', () => { req.destroy(); });
    };
    const retry = () => { if (!server) return reject(new Error('stopped')); if (Date.now() > until) return reject(new Error('timeout')); setTimeout(tryOnce, 300); };
    tryOnce();
  });
}

async function restartServer() {
  restarting = true;
  await stopServer();
  restarting = false;
  startServer();
  win.loadURL(loadingPage('Restarting…'));
  try { await waitForPanel(); win.loadURL(`http://127.0.0.1:${panelPort()}/`); } catch {}
}

// ------------------------------------------------------------------ the window
const loadingPage = text => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-content:center;gap:14px;background:#0a0718;color:#a9a5d2;font:600 18px 'Segoe UI',sans-serif;text-align:center">
  <div style="font-size:26px;color:#eef0ff;font-weight:800">${NAME}</div><div>${text}</div>
  <div style="height:3px;width:220px;margin:6px auto 0;background:linear-gradient(90deg,#7400b8,#5390d9,#80ffdb);border-radius:2px"></div></body></html>`);

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640, show: false,
    title: NAME, icon: ICON, backgroundColor: '#0a0718', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.on('page-title-updated', e => e.preventDefault());
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  // Links to other websites open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${panelPort()}`) && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(loadingPage('Starting…'));
}

// ------------------------------------------------------------------ menu
async function useExistingMediaFolder() {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the folder that holds your videos and images', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return;
  const c = readCfg(); c.mediaDir = r.filePaths[0]; writeCfg(c);
  await restartServer();
}

async function importPrevious() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the folder of your previous Full Circle Director (the one with START.bat)', properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return;
  const old = r.filePaths[0];
  if (!fs.existsSync(path.join(old, 'server.js'))) {
    return dialog.showMessageBox(win, { type: 'warning', message: 'That folder doesn\'t look like a Full Circle Director folder.', detail: 'Choose the folder that contains START.bat and server.js.' });
  }
  await stopServer();
  const copied = [];
  for (const name of ['cert', 'headsets.json', 'library.json', 'proxies']) {
    const from = path.join(old, name);
    if (fs.existsSync(from)) { fs.cpSync(from, path.join(DATA, name), { recursive: true, force: true }); copied.push(name); }
  }
  const c = readCfg();
  const oldMedia = ['media', 'videos'].map(n => path.join(old, n)).find(p => fs.existsSync(p) && fs.readdirSync(p).some(f => f.toLowerCase() !== 'readme.txt'));
  if (oldMedia) c.mediaDir = oldMedia;
  writeCfg(c);
  restarting = false; startServer();
  win.loadURL(loadingPage('Restarting…'));
  try { await waitForPanel(); win.loadURL(`http://127.0.0.1:${panelPort()}/`); } catch {}
  dialog.showMessageBox(win, {
    type: 'info', message: 'Your previous setup has been brought across.',
    detail: (copied.includes('cert') ? 'Headsets that already accepted the security warning won\'t be asked again. ' : '')
      + (oldMedia ? `Your videos are used from where they are:\n${oldMedia}` : 'No videos were found in the old folder.')
  });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Open media folder', click: () => { fs.mkdirSync(mediaDir(), { recursive: true }); shell.openPath(mediaDir()); } },
      { label: 'Use an existing media folder…', click: useExistingMediaFolder },
      { label: 'Import from the START.bat version…', click: importPrevious },
      { type: 'separator' },
      { label: 'Open settings folder', click: () => shell.openPath(DATA) },
      { label: 'Show server log', click: () => shell.openPath(LOG_FILE) },
      { label: 'Restart server', click: restartServer },
      { type: 'separator' },
      { role: 'quit', label: 'Quit Full Circle Director' }
    ] },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' },
      { role: 'toggleDevTools', label: 'Developer tools' }
    ] },
    { label: 'Help', submenu: [
      { label: 'Setup guide', click: () => shell.openPath(path.join(APP_ROOT, 'Setup guide.html')) },
      { label: 'Full Circle Immersive website', click: () => shell.openExternal('http://fullcircleimmersive.com/') },
      { label: 'Project on GitHub', click: () => shell.openExternal('https://github.com/blockie82/full-circle-director') },
      { type: 'separator' },
      { label: 'About', click: () => dialog.showMessageBox(win, { type: 'info', icon: ICON, message: NAME,
        detail: `Version ${app.getVersion()}\nBy Full Circle Immersive. Released under the MIT License.\n\nSettings and media: ${DATA}` }) }
    ] }
  ]));
}

// ------------------------------------------------------------------ first run: offer shortcuts
async function offerShortcuts() {
  if (process.platform !== 'win32') return;
  const flag = path.join(DATA, '.shortcuts-offered');
  if (fs.existsSync(flag)) return;
  fs.writeFileSync(flag, '');
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Add shortcuts', 'Not now'], defaultId: 0, cancelId: 1, icon: ICON,
    message: 'Add Full Circle Director to your desktop and Start menu?',
    detail: 'If you move this folder later, run the app from its new place and use Help > About to check where it\'s running from.'
  });
  if (r.response !== 0) return;
  const opts = { target: process.execPath, icon: process.execPath, iconIndex: 0, description: 'Synced 360° video for VR headsets', appUserModelId: 'com.fullcircleimmersive.director' };
  try { shell.writeShortcutLink(path.join(app.getPath('desktop'), NAME + '.lnk'), 'create', opts); } catch {}
  try { shell.writeShortcutLink(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', NAME + '.lnk'), 'create', opts); } catch {}
}

// ------------------------------------------------------------------ start
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { quitting = true; if (server) { try { server.disconnect(); } catch {} } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  buildMenu();
  createWindow();
  startServer();
  try {
    await waitForPanel();
    await win.loadURL(`http://127.0.0.1:${panelPort()}/`);
    offerShortcuts();
    if (process.env.FCD_SMOKE_SHOT) {           // used only by the build's self-test
      setTimeout(async () => { const img = await win.webContents.capturePage(); fs.writeFileSync(process.env.FCD_SMOKE_SHOT, img.toPNG()); app.quit(); }, 2500);
    }
  } catch (e) {
    if (!quitting && server) { dialog.showErrorBox(NAME, 'The server took too long to start.\n\nDetails are in ' + LOG_FILE); app.quit(); }
  }
});
