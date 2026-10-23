# Full Circle Director

*By Full Circle Immersive.*

Synced 360°, 180° and 3D video playback across Meta Quest headsets, controlled from one Windows PC on a local network.

- **Server** (`server.js`): serves the headset app over HTTPS with its own certificate, holds the shared playback state, and keeps every headset's clock in step.
- **Control panel** (`public/panel.html`, opens at `http://localhost:8080` on the PC): play, pause, stop and seek for everyone; a live preview showing where each wearer is looking; "through their eyes" views, singly or as a grid; turning everyone to face a chosen point; the video library.
- **Full Circle Player**, the headset app (`public/headset.html`, opens at `https://<PC address>:8443` in the Quest browser): stores videos on the headset, plays them in VR through the headset's compositor layer for smooth 8K, and follows the operator's playback in sync.

## Running it

1. Install [Node.js](https://nodejs.org) (LTS).
2. Double-click `START.bat`. The first run installs the dependencies (needs internet once).
3. Follow `Setup guide.html` for connecting headsets and running a session.

Settings such as ports and the videos folder are in `config.json`.

## Folder layout

| Path | What it is |
| --- | --- |
| `server.js` | The local server |
| `public/` | Control panel, headset app, shared sync code, brand assets |
| `videos/` | Put video files here (not stored in the repository) |
| `extras/sphere-player.html` | Standalone single-headset test player |
| `Setup guide.html` | Operator setup guide |

Fonts: Manrope, under the SIL Open Font License (`public/fonts/Manrope-OFL.txt`).
