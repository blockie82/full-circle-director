import re
S='.'
s=open('src.html',encoding='utf-8').read()
vb,path=open(S+'/mark_path.txt').read().split('\n',1); path=path.strip()
mark=f'<svg viewBox="{vb}" aria-hidden="true"><defs><linearGradient id="fcgX" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7400b8"/><stop offset="0.5" stop-color="#5390d9"/><stop offset="1" stop-color="#80ffdb"/></linearGradient></defs><path fill-rule="evenodd" fill="url(#fcgX)" d="{path}"/></svg>'
out=s.replace('{{MARK}}',mark,1).replace('{{MARK}}',mark.replace('fcgX','fcgY'))
out=out.replace('{{MARKD}}',path)
out=out.replace('{{MARKPATH_HMD}}',f'<path fill-rule="evenodd" fill="url(#hRim)" transform="translate(-237 -239)" d="{path}"/>')
out=out.replace('{{MARKPATH}}',f'<path fill-rule="evenodd" fill="url(#hmdRim)" transform="translate(-237 -239)" d="{path}"/>')
rd=lambda n: open(n+'.b64').read()
out=out.replace('{{POSTER}}',rd('hero-poster')).replace('{{HEROVID}}',rd('herovid')).replace('{{HELI}}',rd('heli'))
out=out.replace('{{BEACH}}',','.join("'"+rd('beach%d'%i)+"'" for i in range(1,7)))
out=out.replace('{{HMDIMG}}',rd('hmdimg'))
out=out.replace('{{PANEL}}',rd('panel2')).replace('{{GRID}}',rd('grid2'))
out=out.replace('{{FLATVIEW}}',rd('flatview')).replace('{{VIEW360}}',rd('view360')).replace('{{LASERSHOT}}',rd('laser'))
assert not re.findall(r'\{\{[A-Z]+\}\}',out)
def ascii_only(t):
    parts=re.split(r'(<script>.*?</script>)',t,flags=re.S); o=[]
    for p in parts:
        o.append(''.join(c if ord(c)<128 else ('\\u%04x' if p.startswith('<script>') else '&#x%x;') % ord(c) for c in p))
    return ''.join(o)
body=ascii_only(out)
open('full-circle-director-site.html','w',encoding='ascii').write('<meta charset="utf-8">\n'+body)
he=body.index('</style>')+len('</style>')
open('index.html','w',encoding='ascii').write('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'+body[:he]+'\n</head>\n<body>\n'+body[he:]+'\n</body>\n</html>\n')
open('s.js','w').write(re.findall(r'<script>(.*?)</script>',body,re.S)[0])
print(len(body)//1024,'KB')
