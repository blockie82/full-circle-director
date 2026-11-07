# Full Circle Director

*By Full Circle Immersive.*

![The Full Circle Director control panel: a 360° video preview with eight headsets' views marked on it, a point marked for everyone to face, the headset list and a view through one headset's eyes](docs/screenshot-panel.jpg)

*The control panel during a session. Each coloured box is what one headset's wearer can see; the white crosshair marks a point everyone can be turned to face.*

![All eight headsets' views side by side in a grid](docs/screenshot-grid.jpg)

*View all headsets: what every wearer is looking at, side by side.*

Synced 360°, 180° and 3D video playback, and 360° image viewing, across Meta Quest headsets, controlled from one Windows PC on a local network.

- **Server** (`server.js`): serves the headset app over HTTPS with its own certificate, holds the shared playback state, and keeps every headset's clock in step.
- **Control panel** (`public/panel.html`, opens at `http://localhost:8080` on the PC): play, pause, stop and seek for everyone; a live preview showing where each wearer is looking; "through their eyes" views, singly or as a grid; turning everyone to face a chosen point; a laser pointer that shows every wearer a red dot on the spot you point at; the media library, with adding files and folders from the panel and stepping through a folder with Previous and Next.
- **Full Circle Player**, the headset app (`public/headset.html`, opens at `https://<PC address>:8443` in the Quest browser): stores videos on the headset, plays them in VR through the headset's compositor layer for smooth 8K, and follows the operator's playback in sync.

## Windows app

`FullCircleDirector-Windows.zip` contains a standalone app: unzip it and run `Full Circle Director.exe`. No Node.js needed. It starts the server itself, shows the control panel in its own window, and keeps media and settings in `Documents\Full Circle Director`.

There are three ways to get it:

- **Setup program** (`FullCircleDirector-Setup-<version>.exe`): installs for the current user without needing administrator rights. It adds Start menu and desktop shortcuts and an entry in Settings > Apps for uninstalling. `/S` installs silently.
- **Microsoft Store package** (`FullCircleDirector-<version>.msix`): for publishing through Partner Center. The Store signs it, so no certificate is needed. It also opens port 8443 on private networks itself, so there's no firewall question.
- **Zip** (`FullCircleDirector-Windows.zip`): unzip anywhere and run.

Building:

1. `node desktop/build-windows.js` makes the app folder and the zip. It works on Windows, macOS or Linux and downloads Electron and the Windows build of ffmpeg. The app's code is in `desktop/main.js`.
2. `node desktop/build-installer.js` makes the Setup program. It needs [NSIS](https://nsis.sourceforge.io/).
3. `node desktop/build-msix.js` makes the Store package. On Windows it needs MakeAppx from the Windows SDK; on other systems it needs `makemsix` from [msix-packaging](https://github.com/microsoft/msix-packaging), with `MAKEMSIX` pointing to it.

### Publishing to the Microsoft Store

1. Sign up at [Partner Center](https://partner.microsoft.com/dashboard) (free for individual developers) and reserve the name *Full Circle Director*.
2. Under the app's *Product identity*, copy *Package/Identity/Name*, *Package/Identity/Publisher* and *Package/Properties/PublisherDisplayName* into `desktop/store/store.json`, then rebuild the `.msix`.
3. Create a submission and upload the `.msix`. The package uses the `runFullTrust` capability, which the Store asks you to explain; for example: *"A desktop app that runs a local web server so VR headsets on the same network can play synced video."*
4. Fill in the listing (description, screenshots, age rating, a privacy policy link) and submit for certification.

## Running it from source

1. Install [Node.js](https://nodejs.org) (LTS).
2. Double-click `START.bat`. The first run installs the dependencies (needs internet once).
3. Follow `Setup guide.html` for connecting headsets and running a session.

Settings such as ports and the media folder are in `config.json`.

On slower PCs the control panel previews a light 1080p copy of heavy videos (wider than 4K, or H.265 and similar), made in the background with ffmpeg and kept in `proxies/`. Headsets always play the original. Optional settings in `config.json`:

```json
"proxy": { "enabled": true, "width": 1920, "maxSourceWidth": 3840 },
"ffmpegPath": "C:\\path\\to\\ffmpeg.exe"
```

## Folder layout

| Path | What it is |
| --- | --- |
| `server.js` | The local server |
| `public/` | Control panel, headset app, shared sync code, brand assets |
| `proxies/` | Preview copies for the control panel (made automatically, not stored in the repository) |
| `media/` | Videos and images, loose or in folders (not stored in the repository) |
| `desktop/` | The Windows app (Electron) and its build script |
| `extras/sphere-player.html` | Standalone single-headset test player |
| `Setup guide.html` | Operator setup guide |

Fonts: Manrope, under the SIL Open Font License (`public/fonts/Manrope-OFL.txt`).

## Licence

Free to use, with no subscription or licence fees, under the [Full Circle Director Free Use Licence](LICENSE):

- **You can** use it free of charge for personal use, education and business, including to run paid training or events, and give unchanged copies to others for free.
- **You can't** change it and pass on or publish a changed version, or sell it, charge for copies, or bundle it into something that's sold, without written permission from Full Circle Immersive.

The source code is public so you can see how it works, but it isn't open source. Versions before 2.0.0 were released under the MIT License, and copies of those keep that licence.

The parts it is built on have their own licences: three.js, ws and selfsigned (MIT), node-forge (BSD), ffmpeg in the Windows app (GPL, with its licence beside it), Electron (MIT, see `LICENSES.chromium.html` in the app), and the Manrope font (SIL Open Font License, see `public/fonts/Manrope-OFL.txt`).

## Credits

Created by [blockie82](https://github.com/blockie82) for Full Circle Immersive, built with Claude.
