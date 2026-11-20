import sys; sys.path.insert(0,'.')
from pov import *
W,H,FOV=2560,1440,90
def shot(src, yaw, pitch, out, markers=(), laser=None, maxw=8000):
    cam=Cam(W,H,FOV,yaw,pitch)
    im=Image.fromarray(cam.view(load_eq(src,maxw))).convert('RGBA')
    r=cam.deg_px(MARKER_DEG)
    for n,(y,p) in enumerate(markers,1):
        q=cam.project(y,p); draw_marker(im,n,q[0],q[1],r)
    if laser: draw_laser(im,cam,laser)
    im.convert('RGB').save(out); print(out)
M='/home/claude/metasrc/'
shot('src/ward2.jpg',30,4,'out/s1.png',laser=[(59,-18.5),(57.2,-16.6),(55.2,-14.6),(53,-12.4),(50.6,-10)])
shot(M+'Moot_3.jpg',0,-6,'out/s2.png',markers=[(-6,2),(-11,-15),(30,-3),(-33,-12)])
shot(M+'R0010140.JPG',-10,-4,'out/s3.png',markers=[(0,3),(-22,-17),(31,11)])
