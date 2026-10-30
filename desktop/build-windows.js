'use strict';
/*
 * Builds the Windows app: dist/Full Circle Director/ and dist/FullCircleDirector-Windows.zip
 * Runs on Windows, macOS or Linux:   node desktop/build-windows.js
 * Needs internet (downloads Electron and the Windows build of ffmpeg) and the "zip" command, or
 * Windows' built-in tar, to make the zip.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ELECTRON = '33.2.1';
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.build-cache');
const NAME = 'Full Circle Director';
const OUT = path.join(DIST, NAME);
const APP = path.join(OUT, 'resources', 'app');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

fs.mkdirSync(CACHE, { recursive: true });
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. Electron for Windows
const zip = path.join(CACHE, `electron-v${ELECTRON}-win32-x64.zip`);
if (!fs.existsSync(zip)) {
  console.log('Downloading Electron ' + ELECTRON + ' for Windows…');
  run(`curl -fL --retry 3 -o "${zip}" https://github.com/electron/electron/releases/download/v${ELECTRON}/electron-v${ELECTRON}-win32-x64.zip`);
}
run(process.platform === 'win32' ? `tar -xf "${zip}" -C "${OUT}"` : `unzip -q "${zip}" -d "${OUT}"`);
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, NAME + '.exe'));
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 2. The app itself
fs.mkdirSync(APP, { recursive: true });
for (const f of ['server.js', 'public', 'desktop/main.js', 'desktop/icon.ico', 'LICENSE', 'Setup guide.html', 'README.md']) {
  fs.cpSync(path.join(ROOT, f), path.join(APP, f), { recursive: true });
}
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({
  name: 'full-circle-director', productName: NAME, version: pkg.version, description: pkg.description,
  main: 'desktop/main.js', license: 'MIT', author: 'Full Circle Immersive',
  dependencies: pkg.dependencies, optionalDependencies: pkg.optionalDependencies
}, null, 2));
console.log('Installing the server\'s components (Windows builds)…');
run('npm install --omit=dev --no-audit --no-fund --no-package-lock', {
  cwd: APP, env: { ...process.env, npm_config_platform: 'win32', npm_config_arch: 'x64' }
});
// three.js: only the one file the headsets use
const three = path.join(APP, 'node_modules', 'three');
for (const f of fs.readdirSync(three)) if (!['build', 'package.json', 'LICENSE'].includes(f)) fs.rmSync(path.join(three, f), { recursive: true, force: true });
for (const f of fs.readdirSync(path.join(three, 'build'))) if (f !== 'three.min.js') fs.rmSync(path.join(three, 'build', f));
if (!fs.existsSync(path.join(APP, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))) {
  console.warn('Warning: the Windows ffmpeg didn\'t download, so preview copies will be off in this build.');
}

// 3. Icon, name and version on the .exe
console.log('Setting the icon and app details…');
if (!fs.existsSync(path.join(CACHE, 'package.json'))) fs.writeFileSync(path.join(CACHE, 'package.json'), '{"private":true}');
run('npm install --no-audit --no-fund --no-package-lock resedit@2.0.3', { cwd: CACHE });
(async () => {
const ResEdit = await import(require('url').pathToFileURL(path.join(CACHE, 'node_modules', 'resedit', 'dist', 'index.js')).href);
const exePath = path.join(OUT, NAME + '.exe');
const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
const group = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)[0];
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, ico.icons.map(i => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
const [a, b, c] = pkg.version.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: NAME, ProductName: NAME, CompanyName: 'Full Circle Immersive', InternalName: NAME,
  OriginalFilename: NAME + '.exe', LegalCopyright: '© 2026 Full Circle Immersive. MIT License.',
  FileVersion: pkg.version, ProductVersion: pkg.version
});
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));

// 4. A short note for people who download it
fs.writeFileSync(path.join(OUT, 'READ ME FIRST.txt'), [
  `${NAME} ${pkg.version}`, '',
  `1. Double-click "${NAME}.exe".`,
  '2. If Windows shows "Windows protected your PC", choose More info, then Run anyway. The app isn\'t signed with a paid certificate.',
  '3. When Windows Firewall asks, tick Private networks and choose Allow. Headsets can\'t connect otherwise.',
  '',
  'Your videos, images and settings are kept in Documents\\Full Circle Director.',
  'Coming from the START.bat version? Use File > Import from the START.bat version… to bring across your headsets, certificate and videos.',
  'Keep this whole folder together; the app needs everything in it.'
].join('\r\n'));

// 5. Zip it
const outZip = path.join(DIST, 'FullCircleDirector-Windows.zip');
run(process.platform === 'win32' ? `tar -a -cf "${outZip}" -C "${DIST}" "${NAME}"` : `cd "${DIST}" && zip -qry "${outZip}" "${NAME}"`);
console.log('\nDone: ' + outZip);
})().catch(e => { console.error(e); process.exit(1); });
