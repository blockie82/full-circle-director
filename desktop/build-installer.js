'use strict';
/*
 * Makes the Windows Setup program: dist/FullCircleDirector-Setup-<version>.exe
 * Run desktop/build-windows.js first. Needs NSIS (makensis) on the PATH:
 *   Windows: install NSIS from nsis.sourceforge.io   Linux: apt install nsis   macOS: brew install makensis
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SRC = path.join(ROOT, 'dist', 'Full Circle Director');
if (!fs.existsSync(path.join(SRC, 'Full Circle Director.exe'))) { console.error('Run node desktop/build-windows.js first.'); process.exit(1); }
const OUT = path.join(ROOT, 'dist', `FullCircleDirector-Setup-${pkg.version}.exe`);
console.log('Making the Setup program (this compresses about 300 MB, so it takes a minute)…');
execFileSync('makensis', ['-V2', `-DVERSION=${pkg.version}`, `-DSRC=${SRC}`, `-DOUT=${OUT}`, path.join(__dirname, 'installer.nsi')], { stdio: 'inherit' });
console.log('Done: ' + OUT);
