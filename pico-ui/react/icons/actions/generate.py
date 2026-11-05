"""Deterministic local Pillow renderer. Run from any directory; no network/assets."""
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path
import math
ROOT=Path(__file__).resolve().parent
N=192
names='send mic gear pause play skip stop check x search bolt chat shield alert ask hand plus chevron expand trash pencil paperclip file volume brain activity monitor update power bookmark'.split()
def render(name):
    mask=Image.new('L',(N,N)); d=ImageDraw.Draw(mask)
    def pts(p): return [(round(x*8),round(y*8)) for x,y in p]
    def poly(p,fill=255): d.polygon(pts(p),fill=fill)
    def line(p,w=2.5,fill=255):
        q=pts(p); r=w*4
        d.line(q,fill=fill,width=round(w*8),joint='curve')
        for x,y in q: d.ellipse((int(x-r),int(y-r),int(x+r),int(y+r)),fill=fill)
    def box(b,r=1,fill=255): d.rounded_rectangle(tuple(round(v*8) for v in b),radius=round(r*8),fill=fill)
    def circle(x,y,r,fill=255): d.ellipse(tuple(round(v*8) for v in (x-r,y-r,x+r,y+r)),fill=fill)
    def arc(cx,cy,r,a,b,w=2.5): line([(cx+r*math.cos(t*math.pi/180),cy+r*math.sin(t*math.pi/180)) for t in range(a,b+1,3)],w)
    if name=='send': poly([(10.3,21),(10.3,9),(5,13),(3.5,10.7),(12,3),(20.5,10.7),(19,13),(13.7,9),(13.7,21)])
    elif name=='mic':
        box((9,3,15,14),3); arc(12,11,7,0,180); line([(12,18),(12,21)],2); line([(8,21),(16,21)],2)
    elif name=='gear':
        poly([(12+(9.5 if i%4 in (0,1) else 7.4)*math.cos(i*math.pi/16),12+(9.5 if i%4 in (0,1) else 7.4)*math.sin(i*math.pi/16)) for i in range(32)]); circle(12,12,3.4,0)
    elif name=='pause': box((5,4,10,20),1.1); box((14,4,19,20),1.1)
    elif name in ('play','skip'):
        poly([(6,3.5),(6,20.5),(19 if name=='play' else 16,12)])
        if name=='skip': box((18,4,21,20),.8)
    elif name=='stop': box((4,4,20,20),3)
    elif name=='check': line([(4,12),(9,17),(20,6)],3.4)
    elif name=='x': line([(6,6),(18,18)],3); line([(18,6),(6,18)],3)
    elif name=='plus': line([(12,4),(12,20)],3); line([(4,12),(20,12)],3)
    elif name=='chevron': line([(5,15),(12,8),(19,15)],3)
    elif name=='search': circle(10,10,7.5); circle(10,10,4.6,0); line([(15.5,15.5),(21,21)],3.2)
    elif name=='bolt': poly([(13,2),(3.5,14),(10.5,14),(10,22),(20.5,9.5),(13,9.5)])
    elif name=='chat':
        box((3,3.5,21,18.5),6); poly([(5,15),(3.5,21),(12,18)]); box((7,9,17,10.5),.6,0); box((7,13,14,14.5),.6,0)
    elif name=='shield':
        poly([(12,2.5),(21,6),(20,15),(17,19),(12,22),(7,19),(4,15),(3,6)]); line([(8,11.5),(11,14.5),(16,9)],1.8,0)
    elif name=='alert':
        poly([(12,2),(22,21),(2,21)]); box((11,8,13,14),.8,0); circle(12,17.5,1.1,0)
    elif name=='ask':
        circle(12,12,9.5); circle(12,12,6.9,0); arc(12,9,2.6,190,440,1.8); line([(12.5,11.6),(12,14)],1.7); circle(12,17,1)
    elif name=='hand':
        box((7,9,20,21),4)
        for x,y in [(7,5),(10.4,2),(13.8,3),(17.2,6)]: box((x,y,x+2.8,15),1.4)
        line([(9,18),(3,12.5)],3.5)
    elif name=='expand':
        line([(14,4),(20,4),(20,10)],2.7); line([(20,4),(13,11)],2.7); line([(4,14),(4,20),(10,20)],2.7); line([(4,20),(11,13)],2.7)
    elif name=='trash':
        box((6,7,18,21),2); box((4,4.5,20,7),1); box((9,2,15,5),1)
        for x in (10,14): box((x-.6,10,x+.6,18),.4,0)
    elif name=='pencil':
        poly([(3,21),(4,15),(16,3),(21,8),(9,20)]); line([(14.5,5),(18.5,9)],1.3,0); poly([(3,21),(4,17),(7,20)],0)
    elif name=='paperclip':
        line([(9,14),(15,8),(17,8),(18,10),(8,20),(5,20),(3,18),(3,15),(15,3),(18,3),(21,6),(21,9),(10,20)],2.1)
    elif name=='file':
        poly([(5,2),(14,2),(20,8),(20,22),(5,22)]); poly([(14,2),(14,8),(20,8)],0); line([(8,13),(16,13)],1.2,0); line([(8,17),(14,17)],1.2,0)
    elif name=='volume':
        poly([(3,9),(7,9),(12,4),(12,20),(7,15),(3,15)]); arc(12,12,5,-50,50,2); arc(12,12,9,-50,50,2)
    elif name=='brain':
        for x,y,r in [(8,6,4),(16,6,4),(6,11,4),(18,11,4),(8,17,4),(16,17,4)]: circle(x,y,r)
        line([(12,3),(12,21)],1.4,0); line([(5,10),(8,11),(8,14)],1.2,0); line([(19,10),(16,11),(16,14)],1.2,0)
    elif name=='activity': line([(3,12),(7,12),(10,4),(14,20),(17,12),(21,12)],2.6)
    elif name=='monitor':
        box((2.5,3,21.5,17.5),2); box((5,5.5,19,14.5),.7,0); box((10.5,17,13.5,21),.5); box((7,20,17,22),1)
    elif name=='update': arc(12,12,8,10,310,2.8); poly([(21,3),(21,11),(13,11)])
    elif name=='power': arc(12,12.5,8,-46,226,2.8); line([(12,2),(12,11)],3)
    elif name=='bookmark': poly([(5,2.5),(19,2.5),(19,22),(12,17),(5,22)])
    # Distance-derived bevel and a directional studio reflection, no background tile.
    dist=Image.new('L',(N,N)); cur=mask
    for i in range(1,25):
        cur=cur.filter(ImageFilter.MinFilter(3))
        dp=dist.load(); cp=cur.load()
        for y in range(N):
            for x in range(N):
                if cp[x,y]: dp[x,y]=i
    m=mask.load(); z=dist.load(); out=Image.new('RGBA',(N,N)); p=out.load()
    accent={'bolt':(19,9,-18),'check':(-14,12,3),'alert':(22,5,-24),'shield':(-9,7,16)}.get(name,(0,0,0))
    for y in range(N):
        for x in range(N):
            if not m[x,y]: continue
            nx=z[max(0,x-2),y]-z[min(N-1,x+2),y]; ny=z[x,max(0,y-2)]-z[x,min(N-1,y+2)]
            light=180+38*math.cos((y/N*.9+x/N*.3)*math.pi*2)-nx*8-ny*12
            if z[x,y]<3: light-=40
            p[x,y]=tuple(max(0,min(255,round(light+a))) for a in (-5+accent[0],2+accent[1],12+accent[2]))+(m[x,y],)
    for size,suffix in [(24,''),(48,'@2x'),(96,'@4x')]: out.resize((size,size),Image.Resampling.LANCZOS).save(ROOT/f'{name}{suffix}.png',optimize=False)
for name in names: render(name)
(ROOT/'index.js').write_text('// Generated by generate.py.\n'+''.join(f"import {n}1 from './{n}.png';\nimport {n}2 from './{n}@2x.png';\n" for n in names)+'export const actionIcons = Object.freeze({\n'+''.join(f'  {n}: [{n}1, {n}2],\n' for n in names)+'});\n')
print(f'Rendered {len(names)} titanium actions at 24/48/96px')
