"""Shekru SVG generator. gen.build(opts) -> (svg_text, rig_dict)."""
import math, json

CX = 166.0      # body centre x in viewBox
GROUND = 470.0

MAROON='#801936'; MAROON_D='#650F2C'
CREAM='#FDE6BD'; CREAM_D='#F1CB9A'
ORANGE='#ED9950'; ORANGE_D='#D67B3E'
GREEN='#8FB157'; GREEN_M='#7BA04B'; GREEN_D='#5C853C'
PINK='#F2788F'; PINK_L='#F9A6B5'
BROWN='#5A2612'; RIM='#7A3A1E'; LINE='#8C452B'; BROW='#B4663A'
WHITE='#FFFFFF'; TOOTH_E='#DDBE96'
MOUTH_IN='#5E1029'; TONGUE='#F0766D'; BLUSH='#F8B48E'

# Final placement of the design inside the 512 viewBox (baked into every coordinate).
SC = 0.86; TX = 6.0; TY = 46.0
def T(p): return (p[0]*SC+TX, p[1]*SC+TY)

def f(v):
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s

def X(x): return x + CX
MS=None

def P(d, mirror=False):
    """Path string in body-centred coords -> absolute. Only M L C Q Z, absolute."""
    out=[]; toks=d.split(); i=0
    while i < len(toks):
        t=toks[i]
        if t in 'MLCQZ':
            out.append(t); i+=1
        else:
            x=float(t); y=float(toks[i+1]); i+=2
            if mirror: x=-x
            if MS: x*=MS[0]; y=MS[2]+(y-MS[2])*MS[1]
            out.append(f(X(x))+' '+f(y))
    return ' '.join(out)

def sym(right_half):
    """right_half: 'x y C ...' starting at top centre going clockwise to bottom centre.
    Returns closed symmetric path (body-centred coords)."""
    toks=right_half.split()
    pts=[]; i=0; cmds=[]
    # parse as: x0 y0 then repeated C c1 c2 p
    p0=(float(toks[0]),float(toks[1])); i=2; segs=[]
    while i < len(toks):
        assert toks[i]=='C'
        v=[float(t) for t in toks[i+1:i+7]]; i+=7
        segs.append(((v[0],v[1]),(v[2],v[3]),(v[4],v[5])))
    d='M %g %g'%p0
    for c1,c2,p in segs: d+=' C %g %g %g %g %g %g'%(c1+c2+p)
    # mirror back: reverse segments
    cur_pts=[p0]+[s[2] for s in segs]
    for k in range(len(segs)-1,-1,-1):
        c1,c2,p=segs[k]; start=cur_pts[k]
        d+=' C %g %g %g %g %g %g'%(-c2[0],c2[1],-c1[0],c1[1],-start[0],start[1])
    return d+' Z'

def arc(c, r, a0, a1, first=False):
    """cubic approximation of arc, angles in radians, returns ' C ...' (abs coords, no X shift)"""
    n=max(1,int(math.ceil(abs(a1-a0)/(math.pi/2)-1e-9)))
    da=(a1-a0)/n; k=4/3*math.tan(da/4); s=''
    for i in range(n):
        b0=a0+i*da; b1=b0+da
        p0=(c[0]+r*math.cos(b0), c[1]+r*math.sin(b0)); p1=(c[0]+r*math.cos(b1), c[1]+r*math.sin(b1))
        c1=(p0[0]-k*r*math.sin(b0), p0[1]+k*r*math.cos(b0)); c2=(p1[0]+k*r*math.sin(b1), p1[1]-k*r*math.cos(b1))
        s+=' C %s %s %s %s %s %s'%tuple(f(v) for v in (c1+c2+p1))
    return s

def capsule(p0, r0, p1, r1):
    """tapered capsule, abs coords"""
    dx=p1[0]-p0[0]; dy=p1[1]-p0[1]; L=math.hypot(dx,dy); phi=math.atan2(dy,dx)
    beta=math.asin((r0-r1)/L); g=math.pi/2-beta
    a=phi+g
    s='M %s %s'%(f(p0[0]+r0*math.cos(a)), f(p0[1]+r0*math.sin(a)))
    s+=arc(p0,r0,phi+g,phi+2*math.pi-g)
    b=phi-g
    s+=' L %s %s'%(f(p1[0]+r1*math.cos(b)), f(p1[1]+r1*math.sin(b)))
    s+=arc(p1,r1,phi-g,phi+g)
    return s+' Z'

def rot(pt, c, deg):
    a=math.radians(deg); x=pt[0]-c[0]; y=pt[1]-c[1]
    return (c[0]+x*math.cos(a)-y*math.sin(a), c[1]+x*math.sin(a)+y*math.cos(a))

def xf_path(d, fn):
    """d: abs path string with M L C Q Z; apply fn to each point"""
    out=[]; toks=d.split(); i=0
    while i < len(toks):
        if toks[i] in 'MLCQZ': out.append(toks[i]); i+=1
        else:
            x,y=fn((float(toks[i]),float(toks[i+1]))); i+=2; out.append(f(x)+' '+f(y))
    return ' '.join(out)

def path(d, fill, extra=''): return '<path d="%s" fill="%s"%s/>'%(xf_path(d,T),fill,extra)
def stroke(d, col, w, extra=''): return '<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"%s/>'%(xf_path(d,T),col,f(w*SC),extra)
def circle(c, r, fill):
    c=T(c); return '<circle cx="%s" cy="%s" r="%s" fill="%s"/>'%(f(c[0]),f(c[1]),f(r*SC),fill)
def ellipse(c, rx, ry, fill):
    c=T(c); return '<ellipse cx="%s" cy="%s" rx="%s" ry="%s" fill="%s"/>'%(f(c[0]),f(c[1]),f(rx*SC),f(ry*SC),fill)

class G:
    def __init__(s, id, hidden=False): s.id=id; s.items=[]; s.hidden=hidden
    def add(s,*it):
        s.items.extend(it); return s
    def render(s, opts, ind=0):
        pad='  '*ind
        hidden=s.hidden
        if s.id in opts.get('show',()): hidden=False
        if s.id in opts.get('hide',()): hidden=True
        a=' id="%s"'%s.id
        if hidden: a+=' display="none"'
        r=opts.get('rot',{}).get(s.id)
        if r: a+=' transform="rotate(%s %s %s)"'%(f(r[0]),f(r[1]),f(r[2]))
        out=[pad+'<g%s>'%a]
        for it in s.items:
            out.append(it.render(opts,ind+1) if isinstance(it,G) else pad+'  '+it)
        out.append(pad+'</g>')
        return '\n'.join(out)

RIG={}
def rig(id, pivot, parent, notes=''):
    pivot=T(pivot)
    RIG[id]={'pivot':[round(pivot[0],1),round(pivot[1],1)],'parent':parent,'notes':notes}

# ---------------------------------------------------------------- tail
# spine points: (x from body centre, y, half-width on the head side, half-width on the outer side)
TAIL_S=[(30,428,24,24),(86,426,34,34),(138,408,44,44),(170,366,52,52),(184,308,57,57),(175,252,60,60),
        (160,204,60,60),(152,164,58,58),(158,124,52,50),(182,92,47,40),(220,82,44,34),(252,98,38,28),(266,130,30,21)]
TAIL_N=6
TAIL_CUTS=[24,36,46]            # joints, as sample indices along the spine
L_B=[0,12,24,30,36,41,46,54,60,66,72]   # fur-clump boundaries, head side
R_B=[0,8,14,19,24,28,32,36,41,46,54,60,66,72]    # fur-clump boundaries, outer side
CREAM_AT=54                     # cream tip starts here (inside tail-4, not at a joint)
TUFT=0.17                       # clump height as a fraction of the local half-width
def cr(p0,p1,p2,p3,t):
    return tuple(0.5*((2*p1[k])+(-p0[k]+p2[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t*t+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t*t*t) for k in range(len(p1)))
def unit(v):
    l=math.hypot(v[0],v[1]) or 1.0; return (v[0]/l,v[1]/l)
def tail_geom():
    S=TAIL_S; pts=[]
    for i in range(len(S)-1):
        p0=S[max(i-1,0)]; p1=S[i]; p2=S[i+1]; p3=S[min(i+2,len(S)-1)]
        for j in range(TAIL_N): pts.append(cr(p0,p1,p2,p3,j/TAIL_N))
    pts.append(S[-1])
    pts=[(X(p[0]),p[1],p[2],p[3]) for p in pts]
    Ls=[];Rs=[];n=len(pts)
    for i,p in enumerate(pts):
        a=pts[max(i-1,0)]; b=pts[min(i+1,n-1)]
        tx,ty=unit((b[0]-a[0],b[1]-a[1]))
        nx,ny=ty,-tx
        Ls.append((p[0]+nx*p[2],p[1]+ny*p[2])); Rs.append((p[0]-nx*p[3],p[1]-ny*p[3]))
    return pts,Ls,Rs
def pt(p): return '%.2f %.2f'%(p[0],p[1])
def clump(Pts,i0,i1,Sm,A):
    """one soft fur clump from notch i0 to notch i1: it leaves along the smooth tail outline, swells,
    and ends in a small rounded tuft that tucks back in at i1 (fur flows towards the tip).
    A<0.5 gives a plain smooth piece of outline."""
    n_=len(Pts); Pa=Pts[i0]; Pb=Pts[i1]
    ta=unit((Pts[min(i0+1,n_-1)][0]-Pts[max(i0-1,0)][0],Pts[min(i0+1,n_-1)][1]-Pts[max(i0-1,0)][1]))
    tb=unit((Pts[min(i1+1,n_-1)][0]-Pts[max(i1-1,0)][0],Pts[min(i1+1,n_-1)][1]-Pts[max(i1-1,0)][1]))
    L=math.hypot(Pb[0]-Pa[0],Pb[1]-Pa[1])
    n=(tb[1],-tb[0])
    if (Pb[0]-Sm[0])*n[0]+(Pb[1]-Sm[1])*n[1]<0: n=(-n[0],-n[1])
    if A<0.5:
        segs=[(Pa,(Pa[0]+ta[0]*L/3,Pa[1]+ta[1]*L/3),(Pb[0]-tb[0]*L/3,Pb[1]-tb[1]*L/3),Pb)]
    else:
        Tp=(Pb[0]+n[0]*A-tb[0]*A*0.9,Pb[1]+n[1]*A-tb[1]*A*0.9)            # top of the tuft's rounded shoulder
        segs=[(Pa,(Pa[0]+ta[0]*L*0.40,Pa[1]+ta[1]*L*0.40),(Tp[0]-tb[0]*L*0.36,Tp[1]-tb[1]*L*0.36),Tp),
              (Tp,(Tp[0]+tb[0]*A*0.85,Tp[1]+tb[1]*A*0.85),(Pb[0]+n[0]*A*0.55+tb[0]*A*0.25,Pb[1]+n[1]*A*0.55+tb[1]*A*0.25),Pb)]
    return (Pa,segs,None,Pb,n,tb)
def side(Pts,spine,B,a,b,amp):
    bs=[i for i in B if a<=i<=b]; out=[]
    for i0,i1 in zip(bs,bs[1:]):
        out.append(clump(Pts,i0,i1,spine[i1],amp(i1))+(i1,))
    return out
def fwd(cl): return ''.join(' C %s %s %s'%(pt(q[1]),pt(q[2]),pt(q[3])) for c in cl for q in c[1])
def back(cl): return ''.join(' C %s %s %s'%(pt(q[2]),pt(q[1]),pt(q[0])) for c in reversed(cl) for q in reversed(c[1]))
def crease(c,w,col):
    """small tapered fold running inward from the notch at the end of clump c"""
    N=c[3]; n=c[4]; ch=c[5]
    d=unit((-n[0]-ch[0]*0.55,-n[1]-ch[1]*0.55)); ln=0.30*w
    S0=(N[0]+d[0]*1.5,N[1]+d[1]*1.5); E=(N[0]+d[0]*ln,N[1]+d[1]*ln); mid=((S0[0]+E[0])/2,(S0[1]+E[1])/2)
    m1=(mid[0]-ch[0]*ln*0.34,mid[1]-ch[1]*ln*0.34); m2=(mid[0]-ch[0]*ln*0.12,mid[1]-ch[1]*ln*0.12)
    return path('M %s Q %s %s Q %s %s Z'%(pt(S0),pt(m1),pt(E),pt(m2),pt(S0)),col)
CAPF=[]; VERBOSE=False
def inside(p,poly):
    c=False; n=len(poly); j=n-1
    for i in range(n):
        xi,yi=poly[i]; xj,yj=poly[j]
        if (yi>p[1])!=(yj>p[1]) and p[0]<(xj-xi)*(p[1]-yi)/(yj-yi)+xi: c=not c
        j=i
    return c
def build_tail():
    CAPF.clear()
    pts,Ls,Rs=tail_geom(); n=len(pts)-1
    cuts=[0]+TAIL_CUTS+[n]
    poly=[Ls[i] for i in range(n+1)]+[Rs[i] for i in range(n,-1,-1)]
    ampL=lambda m: TUFT*pts[m][2]
    ampR=lambda m: TUFT*pts[m][3] if m<=46 else 0.0
    def capr(i):
        w=max(pts[i][2],pts[i][3]); fac=1.0
        while fac>0.8 and not all(inside((pts[i][0]+fac*w*math.cos(t/60*2*math.pi),pts[i][1]+fac*w*math.sin(t/60*2*math.pi)),poly) for t in range(60)): fac-=0.01
        return w*fac,fac
    groups=[]
    for k in range(4):
        a,b=cuts[k],cuts[k+1]; g=G('tail-%d'%(k+1)); body=[]
        body.append(circle(pts[a][:2],capr(a)[0] if k else pts[a][2],MAROON))    # rounded base, tucked under the parent
        if k<3:
            lc=side(Ls,pts,L_B,a,b,ampL); rc=side(Rs,pts,R_B,a,b,ampR)
            body.append(path('M '+pt(Ls[a])+fwd(lc)+' L '+pt(Rs[b])+back(rc)+' Z',MAROON))
            r,fac=capr(b); CAPF.append(round(fac,2))
            body.append(circle(pts[b][:2],r,MAROON))                              # round end over the child, centred on its pivot
            for c in lc: body.append(crease(c,pts[c[6]][2],MAROON_D))
            for c in rc: body.append(crease(c,pts[c[6]][3],MAROON_D))
        else:
            c0=CREAM_AT
            lm=side(Ls,pts,L_B,a,c0,ampL); rm=side(Rs,pts,R_B,a,c0,ampR)
            lcr=side(Ls,pts,L_B,c0,n,ampL); rcr=side(Rs,pts,R_B,c0,n,ampR)
            # cream fluffy end
            e=pts[n]; t=unit((pts[n][0]-pts[n-1][0],pts[n][1]-pts[n-1][1])); nl=unit((Ls[n][0]-e[0],Ls[n][1]-e[1]))
            D=1.15*(e[2]+e[3])/2; E=(e[0]+t[0]*D,e[1]+t[1]*D)
            tip=' C %s %s %s'%(pt((Ls[n][0]+t[0]*0.55*D+nl[0]*0.25*e[2],Ls[n][1]+t[1]*0.55*D+nl[1]*0.25*e[2])),
                               pt((E[0]+nl[0]*0.42*e[2],E[1]+nl[1]*0.42*e[2])),pt(E))
            tip+=' C %s %s %s'%(pt((E[0]-nl[0]*0.42*e[3],E[1]-nl[1]*0.42*e[3])),
                                pt((Rs[n][0]+t[0]*0.35*D,Rs[n][1]+t[1]*0.35*D)),pt(Rs[n]))
            body.append(circle(pts[c0][:2],min(pts[c0][2],pts[c0][3])*0.95,CREAM))
            body.append(path('M '+pt(Ls[c0])+fwd(lcr)+tip+back(rcr)+' Z',CREAM))
            for c in lcr[:-1]: body.append(crease(c,pts[c[6]][2],CREAM_D))
            # maroon part, ending in three soft tufts that lap over the cream
            t0=unit((pts[c0+1][0]-pts[c0-1][0],pts[c0+1][1]-pts[c0-1][1])); w=(pts[c0][2]+pts[c0][3])/2
            Q=[Ls[c0]]+[(Ls[c0][0]+(Rs[c0][0]-Ls[c0][0])*u+t0[0]*0.22*w,Ls[c0][1]+(Rs[c0][1]-Ls[c0][1])*u+t0[1]*0.22*w) for u in (0.36,0.70)]+[Rs[c0]]
            lob=''
            for qa,qb in zip(Q,Q[1:]):
                Dl=0.30*w; sx=(qb[0]-qa[0])*0.06; sy=(qb[1]-qa[1])*0.06
                lob+=' C %s %s %s'%(pt((qa[0]+t0[0]*Dl+sx,qa[1]+t0[1]*Dl+sy)),pt((qb[0]+t0[0]*Dl*1.15-sx,qb[1]+t0[1]*Dl*1.15-sy)),pt(qb))
            body.append(path('M '+pt(Ls[a])+fwd(lm)+lob+back(rm)+' Z',MAROON))
            for c in lm[:-1]: body.append(crease(c,pts[c[6]][2],MAROON_D))
            for c in rm[:-1]:
                if c[6]<=46: body.append(crease(c,pts[c[6]][3],MAROON_D))
        g._body=body; groups.append(g)
        rig('tail-%d'%(k+1),pts[a][:2],'tail' if k==0 else 'tail-%d'%k,
            ['Tail base, hidden behind the hips. Sway +-15deg.','Mid tail. Follow-through, delay ~3 frames after tail-1.','Upper tail, follow-through.','Curl + cream tip (the cream starts inside this segment, not at the joint). Flick +-20deg.'][k]
            +' Drawn under its parent: round base tucked under the round end of the parent, both centred on this pivot; every joint sits at a fur notch.')
    for k in range(2,-1,-1):
        groups[k].add(groups[k+1]); groups[k].add(*groups[k]._body)
    groups[3].add(*groups[3]._body)
    t=G('tail').add(groups[0])
    rig('tail',pts[0][:2],'body','Wrapper for the whole tail; same pivot as tail-1. Segments are nested tail-1 > tail-2 > tail-3 > tail-4.')
    return t

# ---------------------------------------------------------------- legs
def build_leg(side):
    m = side=='r'
    g=G('leg-'+side)
    d='M -24 394 C -54 394 -78 412 -78 437 C -78 445 -76 450 -72 454 C -82 455 -88 459 -88 464 C -88 468 -85 470 -80 470 L -17 470 C -9 470 -5 465 -5 457 C -3 440 -2 420 -5 407 C -8 398 -15 394 -24 394 Z'
    g.add(path(P(d,m),ORANGE))
    g.add(stroke(P('M -78 463 L -77 469',m),ORANGE_D,2.2))
    g.add(stroke(P('M -68 462 L -67 469',m),ORANGE_D,2.2))
    px=28 if m else -28
    rig('leg-'+side,(X(px),420),'body','Hip. Whole leg incl. foot is one piece; top is tucked under the belly. Foot sole on ground y=470.')
    return g

# ---------------------------------------------------------------- body
def build_body():
    g=G('body')
    # maroon back / shoulders, sitting behind the cream front (no outline ring)
    g.add(path(P(sym('0 250 C 34 250 54 262 58 288 C 61 312 64 342 57 372 C 50 398 22 402 0 402')),MAROON))
    g.add(path(P(sym('0 250 C 20 250 28 262 31 286 C 35 320 70 348 70 392 C 70 424 44 437 0 437')),CREAM))
    # soft shadow the chest ruff casts on the chest
    g.add(path(P('M -30 262 L 30 262 C 33 274 31 288 22 296 C 16 303 4 301 0 309 C -4 301 -16 303 -22 296 C -31 288 -33 274 -30 262 Z'),CREAM_D))
    rig('body',(X(0),GROUND),'shekru','Torso: maroon back/shoulders behind a cream front, plus the ruff shadow. Pivot at ground centre for squash/stretch (apply the same transform to the shekru root so limbs, head and tail follow).')
    return g

def build_bag():
    g=G('bag')
    # strap: band from under the chin (screen-left) to the bag
    a=(X(-36),256); b=(X(24),388); w=4.6
    dx=b[0]-a[0]; dy=b[1]-a[1]; l=math.hypot(dx,dy); nx=-dy/l*w; ny=dx/l*w
    g.add(path('M %s %s L %s %s L %s %s L %s %s Z'%tuple(f(v) for v in (a[0]+nx,a[1]+ny,b[0]+nx,b[1]+ny,b[0]-nx,b[1]-ny,a[0]-nx,a[1]-ny)),GREEN_M))
    g.add(path(P('M 9 384 L 51 384 C 56 384 58 388 57 393 L 54 416 C 53 422 49 425 43 425 L 17 425 C 11 425 7 422 6 416 L 3 393 C 2 388 4 384 9 384 Z'),GREEN_D))
    g.add(path(P('M 7 381 L 53 381 C 58 381 60 385 59 390 C 57 404 45 412 30 412 C 15 412 3 404 1 390 C 0 385 2 381 7 381 Z'),GREEN))
    g.add(circle((X(30),404),3.2,GREEN_D))
    rig('bag',(X(-22),284),'body','Strap + bag. Sits on the torso only (no arm joint crossed); strap top is hidden under the chin. Small swing +-6deg about the pivot.')
    return g

# ---------------------------------------------------------------- arms
def build_arm(side):
    s = 1 if side=='r' else -1
    sh=(X(s*53),294); el=(X(s*67),342); wr=(X(s*70),385)
    def place(o,to):
        ax=unit((to[0]-o[0],to[1]-o[1])); px=(ax[1]*s,-ax[0]*s)
        L=math.hypot(to[0]-o[0],to[1]-o[1])
        return L,(lambda q:(o[0]+q[0]*px[0]+q[1]*ax[0],o[1]+q[0]*px[1]+q[1]*ax[1]))
    Lu,fu=place(sh,el)
    # chubby upper arm: round shoulder cap (r 16) -> round elbow cap (r 12.5), both centred on their pivots
    du='M -16 0'+arc((0,0),16,math.pi,2*math.pi)+' C 18 %g 13.5 %g 12.5 %g'%(Lu*0.38,Lu*0.78,Lu)+arc((0,Lu),12.5,0,math.pi)+' C -13.5 %g -17 %g -16 0 Z'%(Lu*0.78,Lu*0.38)
    Lf,ff=place(el,wr)
    # forearm tapering to the wrist, then a rounded paw with three soft finger bumps
    y=Lf
    df=('M -12.5 0'+arc((0,0),12.5,math.pi,2*math.pi)+
        ' C 12.5 %g 9.6 %g 9.8 %g'%(y*0.5,y*0.78,y)+
        ' C 12.5 %g 15 %g 15 %g'%(y+2,y+6,y+12)+
        ' C 15 %g 13.8 %g 10.8 %g'%(y+17,y+21.5,y+22.6)+
        ' C 8.4 %g 6 %g 5 %g'%(y+23.5,y+22.6,y+20.4)+
        ' C 4.6 %g -4.6 %g -5 %g'%(y+27.6,y+27.6,y+20.4)+
        ' C -6 %g -8.4 %g -10.8 %g'%(y+22.6,y+23.5,y+22.6)+
        ' C -13.8 %g -15 %g -15 %g'%(y+21.5,y+17,y+12)+
        ' C -15 %g -12.5 %g -9.8 %g'%(y+6,y+2,y)+
        ' C -9.6 %g -12.5 %g -12.5 0 Z'%(y*0.78,y*0.5))
    lower=G('arm-%s-lower'%side).add(path(xf_path(df,ff),ORANGE))
    upper=G('arm-%s-upper'%side).add(path(xf_path(du,fu),ORANGE),lower)
    g=G('arm-'+side).add(upper)
    rig('arm-'+side,sh,'body','Wrapper; rotate arm-%s-upper instead.'%side)
    rig('arm-%s-upper'%side,sh,'arm-'+side,'Shoulder. Round cap r=16 centred on the pivot, sits over the torso. Raising the arm outward is a %s rotation.'%('negative' if s>0 else 'positive'))
    rig('arm-%s-lower'%side,el,'arm-%s-upper'%side,'Elbow. Forearm + paw; upper arm and forearm both end in an r=12.5 circle centred on this pivot, seamless to +-60deg.')
    return g

# ---------------------------------------------------------------- head
EYE_Y=195.0; EYE_X=44.0
def build_ear(side):
    s = 1 if side=='r' else -1
    base=(X(s*58),130); ang=s*21
    fn=lambda p: rot((p[0]+base[0],p[1]+base[1]),base,ang)
    g=G('ear-'+side)
    g.add(path(xf_path('M -20 8 C -25 -12 -22 -50 0 -50 C 22 -50 25 -12 20 8 Z',fn),MAROON))
    g.add(path(xf_path('M -10 4 C -13 -8 -12 -36 0 -36 C 12 -36 13 -8 10 4 Z',fn),MAROON_D))
    rig('ear-'+side,base,'head','Ear base, tucked under head-base. Twitch +-15deg.')
    return g

def build_eye(side):
    s = 1 if side=='r' else -1
    c=(X(s*EYE_X),EYE_Y); id='eye-'+side
    g=G(id)
    g.add(ellipse((c[0],c[1]-3.2),24.2,26.4,RIM))
    g.add(ellipse(c,23,25,WHITE))
    pc=(c[0]-s*1.5,c[1]+2)
    g.add(G(id+'-pupil').add(circle(pc,16.5,BROWN)))
    g.add(G(id+'-highlight').add(circle((pc[0]-6,pc[1]-7),5.2,WHITE),circle((pc[0]+6.5,pc[1]+7),2.3,WHITE)))
    lid=G(id+'-eyelid',hidden=True)
    lid.add(ellipse((c[0],c[1]-2.5),25.6,28.4,CREAM))
    lid.add(stroke('M %s %s Q %s %s %s %s'%tuple(f(v) for v in (c[0]-19,c[1]+5,c[0],c[1]+17,c[0]+19,c[1]+5)),RIM,4))
    g.add(lid)
    rig(id,c,'eyes','Eye centre. Scale for surprise.')
    rig(id+'-pupil',pc,id,'Pupil r=16.5 inside a 23x25 white; keep gaze offsets within about +-5 px so it stays inside.')
    rig(id+'-highlight',pc,id,'Move together with the pupil.')
    rig(id+'-eyelid',(c[0],c[1]-31),id,'Blink: hidden by default; show for 2-3 frames (or scaleY 0->1 from the pivot at the top of the eye).')
    return g

def build_happy():
    g=G('eyes-happy',hidden=True)
    for s in (-1,1):
        c=(X(s*EYE_X),EYE_Y)
        g.add(stroke('M %s %s Q %s %s %s %s'%tuple(f(v) for v in (c[0]-20,c[1]+8,c[0],c[1]-20,c[0]+20,c[1]+8)),RIM,5.5))
    rig('eyes-happy',(X(0),EYE_Y),'head','Closed happy arcs. When shown, hide the eyes group.')
    return g

def teeth(top, w, h, peak=0):
    """two front teeth; peak>0 makes the top a shallow ^ to tuck under the lip cusp"""
    hw=w/2; b=top+h
    def shape(e):
        return P('M %g %g L 0 %g L %g %g L %g %g C %g %g %g %g %g %g L %g %g C %g %g %g %g %g %g Z'%(
            -hw-e, top+peak, top-e*0.5, hw+e, top+peak, hw+e, b-2.5+e, hw+e, b-0.8+e, hw-1.2+e, b+e, hw-3, b+e,
            -hw+3, b+e, -hw+1.2-e, b+e, -hw-e, b-0.8+e, -hw-e, b-2.5+e))
    return [path(shape(1.1),TOOTH_E), path(shape(0),WHITE), stroke(P('M 0 %g L 0 %g'%(top+1,b-1.5)),TOOTH_E,1.3)]

PH = lambda y: stroke('M %s 222 L %s %s'%(f(X(0)),f(X(0)),f(my(y))),LINE,2.8)

def my(y): return MS[2]+(y-MS[2])*MS[1]
def build_mouth(active='mouth-rest'):
    global MS
    MS=(1.25,1.14,231.0)
    try: return _build_mouth(active)
    finally: MS=None
def _build_mouth(active='mouth-rest'):
    m=G('mouth')
    def grp(name): 
        g=G(name,hidden=(name!=active)); m.add(g); return g
    # rest: closed W smile, two teeth peeking
    g=grp('mouth-rest')
    g.add(*teeth(235.5,14,10,peak=3))
    g.add(stroke('M %s 222 L %s %s'%(f(X(0)),f(X(0)),f(my(233))),LINE,3.6))
    g.add(stroke(P('M -26 227 C -22 241 -6 242.5 0 233.5 C 6 242.5 22 241 26 227'),LINE,4.6))
    # AA: wide open
    g=grp('mouth-AA')
    g.add(path(P('M -22 232 C -14 229 -6 230 0 233 C 6 230 14 229 22 232 C 25 251 14 267 0 267 C -14 267 -25 251 -22 232 Z'),MOUTH_IN))
    g.add(path(P('M -15 258 C -10 249 10 249 15 258 C 11 264.5 5 266 0 266 C -5 266 -11 264.5 -15 258 Z'),TONGUE))
    g.add(*teeth(232,15,10,peak=0))
    g.add(PH(232))
    g.add(stroke(P('M -22 232 C -14 229 -6 230 0 233 C 6 230 14 229 22 232'),LINE,3.6))
    # EE: wide grin
    g=grp('mouth-EE')
    g.add(path(P('M -28 229 C -18 235 -7 234 0 234 C 7 234 18 235 28 229 C 25 244 13 251 0 251 C -13 251 -25 244 -28 229 Z'),MOUTH_IN))
    g.add(path(P('M -11 247.5 C -6 243.5 6 243.5 11 247.5 C 7 249.8 3 250.3 0 250.3 C -3 250.3 -7 249.8 -11 247.5 Z'),TONGUE))
    g.add(*teeth(233.5,15,8,peak=0))
    g.add(PH(233))
    g.add(stroke(P('M -28 229 C -18 235 -7 234 0 234 C 7 234 18 235 28 229'),LINE,3.6))
    # I: small open
    g=grp('mouth-I')
    g.add(path(P('M -14 232 C -9 230 -4 231 0 233 C 4 231 9 230 14 232 C 15 242 8 249 0 249 C -8 249 -15 242 -14 232 Z'),MOUTH_IN))
    g.add(path(P('M -8 246 C -4 242.5 4 242.5 8 246 C 5 248 2 248.3 0 248.3 C -2 248.3 -5 248 -8 246 Z'),TONGUE))
    g.add(*teeth(232,11,6.5,peak=0))
    g.add(PH(232))
    g.add(stroke(P('M -14 232 C -9 230 -4 231 0 233 C 4 231 9 230 14 232'),LINE,3.4))
    # O: round
    g=grp('mouth-O')
    g.add(PH(234))
    g.add(ellipse((X(0),my(247.5)),11.5*1.2,14*1.14,MOUTH_IN))
    g.add(path(P('M -8 254 C -4 249.5 4 249.5 8 254 C 6 259 3 260.4 0 260.4 C -3 260.4 -6 259 -8 254 Z'),TONGUE))
    # OO: small pursed
    g=grp('mouth-OO')
    g.add(PH(236))
    g.add(ellipse((X(0),my(243.5)),6.2*1.2,7.2*1.14,MOUTH_IN))
    g.add(stroke(P('M -7 256.5 Q 0 259.5 7 256.5'),CREAM_D,2.4))
    # MBP: lips pressed
    g=grp('mouth-MBP')
    g.add(PH(236))
    g.add(stroke(P('M -15 236.5 Q 0 235 15 236.5'),LINE,3.6))
    g.add(stroke(P('M -6 245.5 Q 0 248 6 245.5'),CREAM_D,2.4))
    # FV: top teeth over lower lip
    g=grp('mouth-FV')
    g.add(stroke(P('M -11 244 Q 0 251 11 244'),LINE,3.4))
    g.add(*teeth(234,15,12,peak=3))
    g.add(PH(232.5))
    g.add(stroke(P('M -17 230 C -14 238 -5 239.5 0 233 C 5 239.5 14 238 17 230'),LINE,3.6))
    # LTD: tongue up behind teeth
    g=grp('mouth-LTD')
    g.add(path(P('M -18 232 C -11 229 -5 230 0 233 C 5 230 11 229 18 232 C 20 246 11 257 0 257 C -11 257 -20 246 -18 232 Z'),MOUTH_IN))
    g.add(path(P('M -11.5 251 C -13 241 -7 236.5 0 236.5 C 7 236.5 13 241 11.5 251 C 8 255.5 4 256 0 256 C -4 256 -8 255.5 -11.5 251 Z'),TONGUE))
    g.add(*teeth(232,13,7,peak=0))
    g.add(PH(232))
    g.add(stroke(P('M -18 232 C -11 229 -5 230 0 233 C 5 230 11 229 18 232'),LINE,3.4))
    rig('mouth',(X(0),233),'head','Viseme container. Exactly one child visible. All visemes hang from the same anchor (philtrum end, x=%s y=233) and stay inside a 72x44 box.'%f(X(0)))
    return m

def build_head(active):
    h=G('head')
    # cream chest ruff under the chin: moves with the head and hides the head/body join
    ruff=G('neck-ruff').add(path(P('M -40 250 L 40 250 C 45 262 42 280 30 287 C 22 293 8 291 0 300 C -8 291 -22 293 -30 287 C -42 280 -45 262 -40 250 Z'),CREAM))
    h.add(ruff); rig('neck-ruff',(X(0),268),'head','Chest fur under the chin, first (lowest) child of head so it overlaps strap and shoulders. Static inside head.')
    h.add(build_ear('l'),build_ear('r'))
    hb=G('head-base')
    hb.add(path(P(sym('0 98 C 56 98 93 138 93 190 C 93 232 74 262 0 262')),MAROON))
    hb.add(path(P('M 0 277 C 48 277 104 263 104 229 C 104 211 88 207 86 190 C 83 165 70 143 48 143 C 22 143 10 178 0 208 '
                  'C -10 178 -22 143 -48 143 C -70 143 -83 165 -86 190 C -88 207 -104 211 -104 229 C -104 263 -48 277 0 277 Z'),CREAM))
    h.add(hb)
    ch=G('cheeks').add(ellipse((X(-76),236),14,9,BLUSH),ellipse((X(76),236),14,9,BLUSH))
    h.add(ch)
    rig('cheeks',(X(0),236),'head','Blush. Fade opacity up for happy / shy.')
    h.add(G('eyes').add(build_eye('l'),build_eye('r')))
    rig('eyes',(X(0),EYE_Y),'head','Both open eyes. Hide when eyes-happy is shown.')
    h.add(build_happy())
    for side,s in (('l',-1),('r',1)):
        c=(X(s*EYE_X),154.5)
        b=G('brow-'+side).add(stroke('M %s %s Q %s %s %s %s'%tuple(f(v) for v in (c[0]-s*11,c[1]+0.5,c[0]+s*1,c[1]-5.5,c[0]+s*12,c[1]+2.5)),BROW,4.4))
        h.add(b); rig('brow-'+side,c,'head','Brow centre. Rotate +-20deg, translate y -6..+5.')
    n=G('nose')
    n.add(path(P('M -12.5 210 C -12.5 205 -6 203.5 0 203.5 C 6 203.5 12.5 205 12.5 210 C 12.5 216.5 4.5 223 0 223 C -4.5 223 -12.5 216.5 -12.5 210 Z'),PINK))
    n.add(ellipse((X(-4.5),208),4,2.1,PINK_L))
    h.add(n); rig('nose',(X(0),213),'head','Nose. Tiny wiggle (scale / +-2 px).')
    h.add(build_mouth(active))
    rig('head',(X(0),268),'body','Neck. The chin overlaps the torso top by ~20 px, so +-15deg tilt shows no gap. Contains ears, face and mouth.')
    rig('head-base',(X(0),268),'head','Maroon skull + cream face mask (static inside head).')
    return h

def build(opts=None):
    opts=opts or {}
    RIG.clear()
    rig('shekru',(X(0),GROUND),None,'Root. Pivot at ground centre between the feet; use for whole-character squash/stretch, hop and sway.')
    root=G('shekru')
    root.add(build_tail(),build_leg('l'),build_leg('r'),build_body(),build_bag(),build_arm('l'),build_arm('r'),build_head(opts.get('mouth','mouth-rest')))
    for fid in opts.get('front',()):
        it=[c for c in root.items if isinstance(c,G) and c.id==fid][0]; root.items.remove(it); root.items.append(it)
    vb=opts.get('viewBox','0 0 512 512')
    svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s">\n%s\n</svg>\n'%(vb,root.render(opts,1))
    rigd={'viewBox':[0,0,512,512],'ground':round(T((0,GROUND))[1],1),
          'conventions':{'sides':'-l is screen-left, -r is screen-right (viewer\'s view)','pivot':'absolute viewBox coordinates in the rest pose','parent':'logical rig parent. SVG nesting matches it for tail-1..4, arm upper/lower and everything inside head; tail, legs, body, bag, arms and head are siblings under shekru to keep back-to-front draw order, so a body transform must also be applied to its logical children (or just transform shekru).',
                         'drawOrder':['tail','leg-l','leg-r','body','bag','arm-l','arm-r','head'],
                         'drawOrderNote':'Arms sit under the head, so a paw raised beside the face tucks behind the cheek. For hand-on-face poses (listening, thinking) draw that arm above head for the duration of the pose (Rive draw-order key, or render the arm group after head in code).',
                         'placement':'Art is scaled %s and offset so the tail stays inside the viewBox when every tail segment is rotated +-15deg; the rest pose therefore sits left of centre.'%SC,
                         'examplePoses':{'wave':{'arm-l-upper':88,'arm-l-lower':58,'head':8},'listening':{'arm-r-upper':-114,'arm-r-lower':-44,'head':9,'front':['arm-r']}},
                         'visemes':['mouth-rest','mouth-AA','mouth-EE','mouth-I','mouth-O','mouth-OO','mouth-MBP','mouth-FV','mouth-LTD']},
          'parts':dict(RIG)}
    return svg,rigd
