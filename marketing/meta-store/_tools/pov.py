# What a headset sees: a perspective view out of an equirectangular 360 image, plus the
# app's overlays (numbered markers, laser dot with trail, waiting panel) drawn the same way the player draws them.
import numpy as np, cv2, math
from PIL import Image, ImageDraw, ImageFont

FONT = '/home/claude/metastore/src/Manrope.ttf'
MARKER_COLORS = ['#3a86ff', '#ff006e', '#ffbe0b', '#06d6a0', '#8338ec', '#fb5607', '#00b4d8', '#e5383b', '#90be6d', '#f15bb5']
MARKER_DEG = 2

def font(px, wght=800):
    f = ImageFont.truetype(FONT, max(1, int(px)))
    try: f.set_variation_by_axes([wght])
    except Exception: pass
    return f

def rot(yaw, pitch):
    p, y = math.radians(pitch), math.radians(yaw)
    Rx = np.array([[1, 0, 0], [0, math.cos(p), math.sin(p)], [0, -math.sin(p), math.cos(p)]])
    Ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    return Ry @ Rx          # camera -> world

class Cam:
    def __init__(s, W, H, hfov, yaw=0, pitch=0):
        s.W, s.H, s.yaw, s.pitch = W, H, yaw, pitch
        s.f = (W / 2) / math.tan(math.radians(hfov) / 2)
        s.R = rot(yaw, pitch)
    def view(s, eq):
        h, w = eq.shape[:2]
        X, Y = np.meshgrid(np.arange(s.W) - s.W / 2 + 0.5, np.arange(s.H) - s.H / 2 + 0.5)
        d = np.stack([X, -Y, np.full_like(X, s.f)], -1)
        d /= np.linalg.norm(d, axis=-1, keepdims=True)
        d = d @ s.R.T
        lon = np.arctan2(d[..., 0], d[..., 2]); lat = np.arcsin(np.clip(d[..., 1], -1, 1))
        mx = ((lon / (2 * math.pi)) + 0.5) * w - 0.5; my = (0.5 - lat / math.pi) * h - 0.5
        return cv2.remap(eq, mx.astype(np.float32), my.astype(np.float32), cv2.INTER_CUBIC, borderMode=cv2.BORDER_WRAP)
    def project(s, yaw, pitch):
        y, p = math.radians(yaw), math.radians(pitch)
        d = np.array([math.sin(y) * math.cos(p), math.sin(p), math.cos(y) * math.cos(p)])
        c = s.R.T @ d
        if c[2] <= 0.05: return None
        return (s.W / 2 + s.f * c[0] / c[2], s.H / 2 - s.f * c[1] / c[2])
    def deg_px(s, deg):   # size on screen of an angle, near the centre
        return s.f * math.tan(math.radians(deg))

def draw_marker(img, n, x, y, r, alpha=1.0):
    """Same look as FC.drawMarker in sync.js; drawn 4x then scaled down for smooth edges."""
    S = 4; R = int(r * 1.2 * S) + 4
    lay = Image.new('RGBA', (2 * R, 2 * R), (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
    c = R
    def circ(rr, fill): d.ellipse([c - rr, c - rr, c + rr, c + rr], fill=fill)
    circ(r * 1.14 * S, (10, 7, 24, 191)); circ(r * S, (255, 255, 255, 255))
    col = MARKER_COLORS[(n - 1) % len(MARKER_COLORS)]
    circ(r * 0.84 * S, tuple(int(col[i:i + 2], 16) for i in (1, 3, 5)) + (255,))
    t = str(n); f = font(r * S * (0.95 if len(t) > 1 else 1.15))
    d.text((c, c + r * 0.06 * S), t, font=f, fill=(255, 255, 255, 255), anchor='mm',
           stroke_width=int(r * 0.08 * S), stroke_fill=(10, 7, 24, 140))
    lay = lay.resize((2 * R // S, 2 * R // S), Image.LANCZOS)
    if alpha < 1: lay.putalpha(lay.getchannel('A').point(lambda v: int(v * alpha)))
    img.alpha_composite(lay, (int(round(x - R / S)), int(round(y - R / S))))

def glow(size, alpha):
    """The laser dot (glowCanvas in headset.js)."""
    n = max(4, int(size)); yy, xx = np.mgrid[0:n, 0:n]; r = n / 2
    t = np.sqrt((xx - r + 0.5) ** 2 + (yy - r + 0.5) ** 2) / r
    stops = [(0, (255, 255, 255, 1)), (0.12, (255, 235, 235, 1)), (0.2, (255, 50, 50, 1)), (0.45, (255, 30, 30, 0.45)), (1, (255, 0, 0, 0))]
    out = np.zeros((n, n, 4))
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        m = (t >= a) & (t <= b); k = ((t - a) / (b - a))[..., None]
        out[m] = (np.array(ca) * (1 - k) + np.array(cb) * k)[m]
    out[..., 3] *= alpha
    rgb = out[..., :3]; a = out[..., 3:]
    return Image.fromarray(np.concatenate([rgb, a * 255], -1).clip(0, 255).astype(np.uint8), 'RGBA')

TRAIL = [(0, 1, 1), (30, .6, .85), (60, .42, .7), (95, .27, .56), (135, .14, .42)]
def draw_laser(img, cam, path):
    """path: list of (yaw, pitch) from newest to oldest, one per trail dot (dot, then trail)."""
    size = cam.deg_px(1.75) * 2
    for i in reversed(range(min(len(path), len(TRAIL)))):
        _, a, sc = TRAIL[i]
        p = cam.project(*path[i])
        if not p: continue
        g = glow(size * sc, a)
        img.alpha_composite(g, (int(p[0] - g.width / 2), int(p[1] - g.height / 2)))

def load_eq(path, max_w=None):
    im = cv2.imread(path, cv2.IMREAD_COLOR)[:, :, ::-1]
    if max_w and im.shape[1] > max_w:
        im = cv2.resize(im, (max_w, max_w // 2), interpolation=cv2.INTER_AREA)
    return np.ascontiguousarray(im)
