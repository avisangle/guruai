"""Builds shekru.svg, shekru.rig.json and the review PNGs. Run with the project venv."""
import os, sys, json, io
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen, cairosvg
from PIL import Image, ImageDraw, ImageFont
OUT='/Users/avinashsangle/AI/Personal/guru/design/characters/shekru/svg/'
BG='#FFFDF7'
def png(opts,w,bg=BG):
    svg,_=gen.build(opts)
    b=cairosvg.svg2png(bytestring=svg.encode(),output_width=w,output_height=w,background_color=bg)
    return Image.open(io.BytesIO(b))
svg,rigd=gen.build()
open(OUT+'shekru.svg','w').write(svg)
json.dump(rigd,open(OUT+'shekru.rig.json','w'),indent=1)
print('svg bytes',len(svg),'cap factors',gen.CAPF)
png({},1024).convert('RGB').save(OUT+'preview-rest.png')
try: font=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',22)
except Exception: font=ImageFont.load_default()

P=rigd['parts']
def pose(**angles):
    return {k.replace('_','-'):(a,P[k.replace('_','-')]['pivot'][0],P[k.replace('_','-')]['pivot'][1]) for k,a in angles.items()}
def tails(a): return {'tail_%d'%k:a for k in range(1,5)}

# viewBox safety: bounding box of the art at rest and with every tail segment at +-15 deg
for name,o in (('rest',{}),('tail +15 each',{'rot':pose(**tails(15))}),('tail -15 each',{'rot':pose(**tails(-15))})):
    o=dict(o,viewBox='-200 -200 912 912')
    bb=png(o,912,None).convert('RGBA').getchannel('A').getbbox(); bb=tuple(v-200 for v in bb)
    print('bbox %-14s'%name,bb,'margins L%d T%d R%d B%d'%(bb[0],bb[1],512-bb[2],512-bb[3]))

# rotation / pose test
poses=[
 ('a  head +12, arms out 35/30, tail +10 each',pose(head=12,arm_l_upper=35,arm_r_upper=-35,arm_l_lower=30,arm_r_lower=-30,**tails(10))),
 ('b  head -12, arms in, legs/ears 25, tail -10 each',pose(head=-12,arm_l_upper=-35,arm_r_upper=35,arm_l_lower=-40,arm_r_lower=40,leg_l=-25,leg_r=25,ear_l=-25,ear_r=25,**tails(-10))),
 ('c  wave: upper 88, forearm 58, head 8, tail -12 each',pose(head=8,arm_l_upper=88,arm_l_lower=58,**tails(-12))),
 ('d  listening (arm-r drawn above head), tail +15 each',pose(head=9,arm_r_upper=-114,arm_r_lower=-44,arm_l_upper=-8,**tails(15))),
]
cell=640
im=Image.new('RGB',(cell*2,(cell+34)*2),BG); d=ImageDraw.Draw(im)
for i,(name,rot) in enumerate(poses):
    x=(i%2)*cell; y=(i//2)*(cell+34)
    im.paste(png({'rot':rot,'front':['arm-r'] if name.startswith('d') else []},cell).convert('RGB'),(x,y)); d.text((x+12,y+cell+2),name,fill='#555',font=font)
    d.rectangle((x,y,x+cell-1,y+cell-1),outline='#E3DDCF')
im.save(OUT+'preview-rotation-test.png')

# contact sheet
x0,y0=gen.T((gen.CX-120,60)); HEADVB='%g %g %g %g'%(x0,y0,240*gen.SC,240*gen.SC)
cell=300; lab=36
W=cell*5+40; H=560+(cell+lab)*3+40
sheet=Image.new('RGB',(W,H),BG); d=ImageDraw.Draw(sheet)
sheet.paste(png({},520).convert('RGB'),(20,20)); d.text((30,24),'rest pose',fill='#555',font=font)
x0=580
d.text((x0,24),'small-size test',fill='#555',font=font)
s128=png({},512).convert('RGB').resize((128,128),Image.LANCZOS); s64=png({},512).convert('RGB').resize((64,64),Image.LANCZOS)
sheet.paste(s128,(x0,70)); d.text((x0,204),'128 px',fill='#555',font=font)
sheet.paste(s64,(x0+170,70)); d.text((x0+170,140),'64 px',fill='#555',font=font)
t=png({},512,None).convert('RGBA').resize((128,128),Image.LANCZOS)
dark=Image.new('RGB',(128,128),'#2B3A55'); dark.paste(t,(0,0),t)
sheet.paste(dark,(x0+280,70)); d.text((x0+280,204),'128 px on dark',fill='#555',font=font)
t64=t.resize((64,64),Image.LANCZOS); dk=Image.new('RGB',(64,64),'#2B3A55'); dk.paste(t64,(0,0),t64); sheet.paste(dk,(x0+460,70))
sheet.paste(s64.resize((256,256),Image.NEAREST),(x0,260)); d.text((x0,520),'64 px, shown 4x',fill='#555',font=font)
items=[(v,{'mouth':v,'viewBox':HEADVB}) for v in rigd['conventions']['visemes']]
items.append(('blink (eyelids shown)',{'viewBox':HEADVB,'show':['eye-l-eyelid','eye-r-eyelid']}))
items.append(('eyes-happy',{'viewBox':HEADVB,'show':['eyes-happy'],'hide':['eyes'],'mouth':'mouth-EE'}))
for i,(name,o) in enumerate(items):
    cx=20+(i%5)*cell; cy=560+(i//5)*(cell+lab)
    sheet.paste(png(o,cell-12).convert('RGB'),(cx,cy)); d.text((cx+8,cy+cell-10),name,fill='#555',font=font)
sheet.save(OUT+'preview-sheet.png')
