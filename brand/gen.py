import math, os
OUT = os.path.dirname(os.path.abspath(__file__))
C = 128.0

def build(R):
    RIN = R / math.sqrt(3)
    def pt(deg, r):
        a = math.radians(deg)
        return (C + r*math.cos(a), C - r*math.sin(a))
    rim = [pt(60*k, R) for k in range(6)]
    hexv = [pt(30+60*k, RIN) for k in range(6)]
    return rim, hexv

def f(v): return f"{v:.3f}".rstrip("0").rstrip(".")
def s(p): return f"{f(p[0])} {f(p[1])}"

def hexpath(hexv): return "M " + " L ".join(s(v) for v in hexv) + " Z"

def blades(rim, R):
    """Six circular segments cut by the chords P_k -> P_(k+2).
    Their union is exactly (disc - hexagon); drawn in order they overlap
    the way real iris leaves do."""
    out = []
    for k in range(6):
        a, b = rim[k], rim[(k+2) % 6]
        out.append(f'M {s(a)} A {f(R)} {f(R)} 0 0 0 {s(b)} Z')
    return out

def edges(rim, hexv):
    """One lit edge per leaf: rim point -> the opening vertex 30 degrees on.
    Only half of each chord is a leaf's leading edge; drawing the whole chord
    gives twelve lines and a lattice, not six leaves and an iris."""
    return [f'M {s(rim[k])} L {s(hexv[(k+1)%6])}' for k in range(6)]

def mix(c1, c2, t):
    p = lambda c: tuple(int(c[i:i+2], 16) for i in (1, 3, 5))
    a, b = p(c1), p(c2)
    return "#%02x%02x%02x" % tuple(round(a[i] + (b[i]-a[i])*t) for i in range(3))

# Blade tones: light source up and to the left, so the leaves facing that way
# catch more of it. Six discrete steps, not a gradient — leaves are flat metal.
DARK, LITE = "#141a25", "#4a5872"
def blade_tone(k):
    facing = 60*k + 60                       # outward normal of blade k
    t = 0.5 + 0.5*math.cos(math.radians(facing - 132))
    return mix(DARK, LITE, t**1.25)

def mark(R=96, seams=True, glow=True, light=True):
    rim, hexv = build(R)
    hp = hexpath(hexv)
    parts = []
    if glow:
        parts.append(f'<circle cx="{f(C)}" cy="{f(C)}" r="{f(R*1.55)}" fill="url(#halo)"/>')
    for k, d in enumerate(blades(rim, R)):
        parts.append(f'<path d="{d}" fill="{blade_tone(k)}"/>')
    if seams:
        # The leading edge of each leaf, catching light spilled from the
        # opening. Drawn before the opening so the crossings are covered.
        parts.append(f'<g stroke="#ffe6c4" stroke-opacity="0.3" stroke-width="{f(R*0.022)}" '
                     f'stroke-linecap="round" fill="none">'
                     + "".join(f'<path d="{d}"/>' for d in edges(rim, hexv)) + '</g>')
    if light:
        parts.append(f'<path d="{hp}" fill="url(#light)"/>')
        parts.append(f'<path d="{hp}" fill="none" stroke="#fff6e6" stroke-opacity="0.55" '
                     f'stroke-width="{f(R*0.012)}" stroke-linejoin="round"/>')
    parts.append(f'<circle cx="{f(C)}" cy="{f(C)}" r="{f(R)}" fill="none" '
                 f'stroke="url(#barrel)" stroke-width="{f(R*0.027)}"/>')
    return "\n  ".join(parts)

DEFS = '''
  <radialGradient id="light" cx="0.5" cy="0.4" r="0.62">
    <stop offset="0" stop-color="#fffaf1"/>
    <stop offset="0.38" stop-color="#ffe3b8"/>
    <stop offset="0.8" stop-color="#ffd096"/>
    <stop offset="1" stop-color="#eda75f"/>
  </radialGradient>
  <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0.3" stop-color="#ffc072" stop-opacity="0.5"/>
    <stop offset="0.62" stop-color="#ffc072" stop-opacity="0.14"/>
    <stop offset="1" stop-color="#ffc072" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="barrel" x1="0.15" y1="0" x2="0.85" y2="1">
    <stop offset="0" stop-color="#eef3fb" stop-opacity="0.72"/>
    <stop offset="0.45" stop-color="#9aa4b8" stop-opacity="0.22"/>
    <stop offset="1" stop-color="#ffd9a0" stop-opacity="0.62"/>
  </linearGradient>
  <linearGradient id="topsheen" x1="0" y1="0" x2="0.25" y2="1">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.075"/>
    <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
  </linearGradient>'''

def svg(body, size=256, defs=DEFS):
    d = f'<defs>{defs}</defs>' if defs else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" '
            f'width="{size}" height="{size}" fill="none">{d}\n  {body}\n</svg>\n')

def write(name, txt):
    open(os.path.join(OUT, name), "w", encoding="utf-8").write(txt)
    print("wrote", name)

TILE = ('<rect width="256" height="256" rx="56" fill="#06070a"/>'
        '<rect width="256" height="256" rx="56" fill="url(#topsheen)"/>')

write("mark.svg", svg(mark()))
write("icon.svg", svg(TILE + '\n  <g transform="translate(128 128) scale(0.85) translate(-128 -128)">'
                      + mark() + '</g>'))
write("icon-maskable.svg", svg('<rect width="256" height="256" fill="#06070a"/>'
      '<rect width="256" height="256" fill="url(#topsheen)"/>'
      '<g transform="translate(128 128) scale(0.68) translate(-128 -128)">' + mark() + '</g>'))

# --- small sizes -------------------------------------------------------
# Below ~24px the leaves, the halo and the barrel all disappear into one
# grey smudge. So the small mark keeps only what survives: the opening, and
# a ring thick enough to still be a ring at 16px.
def small(R=104, ring=13):
    rim, hexv = build(R - ring/2 - 9)
    _, hx = build(R*0.68)
    return (f'<circle cx="{f(C)}" cy="{f(C)}" r="{f(R-ring/2)}" fill="none" '
            f'stroke="#ffd9a0" stroke-width="{f(ring)}"/>'
            f'<path d="{hexpath(hx)}" fill="#ffd9a0"/>')

write("favicon.svg", svg('<rect width="256" height="256" rx="52" fill="#06070a"/>' + small(), defs=""))
write("mark-small.svg", svg(small(), defs=""))

# --- line mark for inline UI (inherits currentColor) -------------------
def line(R=92, w=8.5):
    rim, hexv = build(R)
    seg = "".join(f'<path d="M {s(rim[k])} L {s(hexv[(k+1)%6])}"/>' for k in range(6))
    return (f'<g fill="none" stroke="currentColor" stroke-width="{f(w)}" '
            f'stroke-linejoin="round" stroke-linecap="round">'
            f'<circle cx="{f(C)}" cy="{f(C)}" r="{f(R)}"/>'
            f'<path d="{hexpath(hexv)}"/>'
            f'<g stroke-opacity="0.8">{seg}</g></g>')
write("mark-line.svg", svg(line(), defs=""))

# --- single-ink solid (print, stamps, stencils) ------------------------
# A plain ring with a hexagonal hole reads as a washer, so the six leading
# edges are cut back out with a mask: no second colour, chirality intact.
def solid(R=96):
    rim, hexv = build(R)
    ring = (f'M {f(C-R)} {f(C)} a {f(R)} {f(R)} 0 1 0 {f(2*R)} 0 '
            f'a {f(R)} {f(R)} 0 1 0 {f(-2*R)} 0 Z ' + hexpath(hexv))
    cuts = "".join(f'<path d="M {s(rim[k])} L {s(hexv[k])}"/>' for k in range(6))
    return (f'<mask id="leafcut" maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">'
            f'<path d="{ring}" fill="#fff" fill-rule="evenodd"/>'
            f'<g stroke="#000" stroke-width="{f(R*0.055)}">{cuts}</g></mask>'
            f'<rect width="256" height="256" fill="currentColor" mask="url(#leafcut)"/>')
write("mark-solid.svg", svg(solid(), defs=""))
