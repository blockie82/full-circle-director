# 30 s Meta Horizon Store trailer, from the headset's point of view.
import sys, subprocess, math, numpy as np
sys.path.insert(0, '/home/claude/metastore')
from pov import *

W, H, FPS, DUR, FOV = 1920, 1080, 30, 30.0, 90
M = '/home/claude/metasrc/'
OUT = '/home/claude/metastore/out/Trailer 30s (1920x1080).mp4'

card = np.asarray(Image.open('src/card.png').convert('RGB'))
panel = Image.open('src/panel.png').convert('RGB')
wait = Image.open('/home/claude/waiting-screen.png').convert('RGBA')
moot = load_eq(M + 'Moot_3.jpg', 6000)
beach = load_eq(M + 'R0010140.JPG')

# ward video frames, decoded as needed (50 fps source, take every frame at t*50)
WARD_START = 1.0
wproc = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(WARD_START), '-i', '/mnt/user-data/uploads/test_clip.mp4',
                          '-vf', 'fps=30', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
WF = 3840 * 1920 * 3
ward_last = None
def ward_frame():
    global ward_last
    b = wproc.stdout.read(WF)
    if len(b) == WF: ward_last = np.frombuffer(b, np.uint8).reshape(1920, 3840, 3)
    return ward_last

ease = lambda x: 0.5 - 0.5 * math.cos(math.pi * max(0, min(1, x)))
def lerp(a, b, k): return a + (b - a) * k

def overlay(base, cam, markers, t, laser_fn=None):
    im = Image.fromarray(base).convert('RGBA')
    r = cam.deg_px(MARKER_DEG)
    for n, (y, p, t0) in enumerate(markers, 1):
        if t < t0: continue
        k = min(1, (t - t0) / 0.25); s = 1 + 0.25 * math.sin(k * math.pi)   # pop in
        q = cam.project(y, p)
        if q: draw_marker(im, n, q[0], q[1], r * s * k if k < 1 else r, alpha=k)
    if laser_fn:
        path = [laser_fn(t - lag / 1000) for lag, _, _ in TRAIL]
        if path[0]: draw_laser(im, cam, [p for p in path if p])
    return np.asarray(im.convert('RGB'))

# ---- scenes: (start, end, render(t_local, t_global))
def s_card(t, T):
    return card
def s_wait(t, T):
    img = np.zeros((H, W, 3), np.uint8); img[:] = (6, 5, 12)
    im = Image.fromarray(img)
    w = int(2 * 960 / 3 * 1.05); h = int(w * 400 / 1024)
    dx = int(30 * math.sin(t * 0.8)); dy = int(10 * math.sin(t * 0.6))
    im.paste(wait.resize((w, h), Image.LANCZOS), (W // 2 - w // 2 + dx, H // 2 - h // 2 + dy), wait.resize((w, h), Image.LANCZOS))
    return np.asarray(im)
def s_ward(t, T):
    eq = ward_frame()
    cam = Cam(W, H, FOV, lerp(18, 32, ease(t / 7)), lerp(2, 4, ease(t / 7)))
    def laser(tt):
        if tt < 4.0: return None
        k = ease((tt - 4.0) / 1.7)
        return (lerp(20, 59, k), lerp(-4, -18.5, k) + 3 * math.sin(k * math.pi))
    return overlay(cam.view(eq), cam, [], t, laser)
def s_moot(t, T):
    cam = Cam(W, H, FOV, lerp(-14, 8, ease(t / 6)), -6)
    return overlay(cam.view(moot), cam, [(-6, 2, 1.0), (-11, -15, 2.0), (30, -3, 3.0), (-33, -12, 4.0)], t)
def s_beach(t, T):
    cam = Cam(W, H, FOV, lerp(-30, 0, ease(t / 6.5)), lerp(-2, -4, ease(t / 6.5)))
    def laser(tt):
        if tt < 1.6: return None
        k = ease((tt - 1.6) / 1.4)
        return (lerp(-40, -10, k), lerp(5, -9, k))
    return overlay(cam.view(beach), cam, [(0, 3, 0.6), (-22, -17, 4.2), (31, 11, 4.8)], t, laser)
def s_panel(t, T):
    z = lerp(1.0, 1.06, t / 3.0)
    w, h = int(2560 / z), int(1440 / z)
    return np.asarray(panel.crop(((2560 - w) // 2, (1440 - h) // 2, (2560 + w) // 2, (1440 + h) // 2)).resize((W, H), Image.LANCZOS))

SCENES = [(0, 2.5, s_card), (2.5, 5.5, s_panel), (5.5, 8, s_wait), (8, 14.5, s_ward), (14.5, 20.5, s_moot), (20.5, 27, s_beach), (27, 30, s_card)]
XF = 0.4

enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                        '-i', 'src/music.m4a', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
                        '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-c:a', 'aac', '-b:a', '192k', '-t', str(DUR),
                        '-movflags', '+faststart', OUT], stdin=subprocess.PIPE)
cache = {}
for i in range(int(DUR * FPS)):
    T = i / FPS
    idx = next(k for k, (a, b, _) in enumerate(SCENES) if a <= T < b or k == len(SCENES) - 1)
    a, b, fn = SCENES[idx]
    f = fn(T - a, T).astype(np.float32)
    # fade from black at the start, to black at the end, and cross-dissolve between scenes
    if idx > 0 and T - a < XF:
        pa, pb, pfn = SCENES[idx - 1]
        if pfn is not s_ward:   # don't pull extra ward frames
            g = pfn(T - pa, T).astype(np.float32); k = (T - a) / XF; f = g * (1 - k) + f * k
    f *= min(1, T / 0.5, (DUR - T) / 0.7)
    enc.stdin.write(np.clip(f, 0, 255).astype(np.uint8).tobytes())
    if i % 90 == 0: print(f'{T:.0f}s', flush=True)
enc.stdin.close(); enc.wait(); wproc.kill()
print('done')
