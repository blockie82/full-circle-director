'use strict';
/*
 * Makes the Microsoft Store package: dist/FullCircleDirector-<version>.msix
 * Run desktop/build-windows.js first, and put your Partner Center identity in desktop/store/store.json.
 * Packs with MakeAppx (Windows SDK) on Windows, or makemsix (github.com/microsoft/msix-packaging) elsewhere;
 * set MAKEMSIX to its path if it isn't on the PATH. The Store signs the package, so no certificate is needed.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const store = JSON.parse(fs.readFileSync(path.join(__dirname, 'store', 'store.json'), 'utf8'));
const SRC = path.join(ROOT, 'dist', 'Full Circle Director');
const LAYOUT = path.join(ROOT, 'dist', 'msix-layout');
const OUT = path.join(ROOT, 'dist', `FullCircleDirector-${pkg.version}.msix`);
if (!fs.existsSync(path.join(SRC, 'Full Circle Director.exe'))) { console.error('Run node desktop/build-windows.js first.'); process.exit(1); }
if (/0{8}-0{4}/.test(store.publisher)) console.warn('Note: desktop/store/store.json still has placeholder identity values. The Store will reject this package until they match Partner Center.');

// 1. The app's files, without the zip-only note
fs.rmSync(LAYOUT, { recursive: true, force: true });
fs.cpSync(SRC, LAYOUT, { recursive: true });
fs.rmSync(path.join(LAYOUT, 'READ ME FIRST.txt'), { force: true });

// 2. The manifest (the Store wants the fourth version number to be 0)
const [a, b, c] = pkg.version.split('.').map(Number);
const xml = fs.readFileSync(path.join(__dirname, 'store', 'AppxManifest.xml'), 'utf8')
  .replace(/{{(\w+)}}/g, (_, k) => k === 'version' ? `${a}.${b}.${c}.0` : String(store[k]).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'));
fs.writeFileSync(path.join(LAYOUT, 'AppxManifest.xml'), xml);

// 3. Tile and Start menu images, made from the app icon
fs.cpSync(path.join(__dirname, 'store', 'Assets'), path.join(LAYOUT, 'Assets'), { recursive: true });

// 4. Pack
fs.rmSync(OUT, { force: true });
if (process.platform === 'win32') {
  execFileSync('makeappx', ['pack', '/d', LAYOUT, '/p', OUT, '/o'], { stdio: 'inherit' });
} else {
  const tool = process.env.MAKEMSIX || 'makemsix';
  const r = spawnSync(tool, ['pack', '-d', LAYOUT, '-p', OUT], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('makemsix failed' + (r.error ? ': ' + r.error.message : '')); process.exit(1); }
}
console.log('Done: ' + OUT);
