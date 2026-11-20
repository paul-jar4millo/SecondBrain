"""El refugio azul: an original toon loft floating on a faceted sea.

Run in Blender (-b --factory-startup -P). Outputs refugio.glb, the nav/halo manifest
and an editable .blend. Helpers use x, ground-z, height; exported glTF is Y-up.
Every mesh is accumulated per (group, material) so the map ships as few draw calls.
Group prefixes are a contract with sala.ts: WallN/WallW hide when they would block
the camera, Anim_Spin*/Anim_Bob* are animated, glow_* materials are unlit.
"""
import bpy, bmesh, math, random, json, os
import numpy as np
from mathutils import Vector, Matrix

random.seed(41)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'models', 'sala')
os.makedirs(OUT, exist_ok=True)
W, D = 32, 24
TAU = math.tau

PALETTE = {
    'abyss': '#0A1238', 'navy': '#121F5C', 'ink': '#1A2A78', 'ultra': '#2340C8',
    'cobalt': '#2F66E6', 'azure': '#3F8FF0', 'sky': '#78BDF8', 'ice': '#CFE6FF',
    'white': '#F1F7FF', 'peri': '#8DA2F2', 'peri_deep': '#5C73D9', 'lilac': '#B7A6F2',
    'slate': '#3B4A8C', 'slate_line': '#26336F', 'teal': '#0E7F9E', 'teal_deep': '#0A5775',
    'aqua': '#43C9DC', 'cream': '#FFF0C2', 'coral': '#FF6F61', 'gold': '#E8C168',
    'leaf_a': '#14707F', 'leaf_b': '#23A79B', 'leaf_c': '#5FDCC8', 'paper': '#F7FAFF',
    'glow_moon': '#FFF2C4', 'glow_ice': '#E4F2FF', 'glow_cyan': '#6FE9FF',
    'glow_mint': '#7DFFD0', 'glow_blue': '#5AA8FF', 'glow_lilac': '#C9B4FF',
    'glow_coral': '#FF8A7A', 'glow_screen': '#16286E',
    'glow_sky1': '#2A4FD6', 'glow_sky2': '#4C86F0', 'glow_sky3': '#8CC4FA',
    'glow_sky4': '#CDEBFF', 'glow_sky5': '#FFE9C9',
}


def linear(hexcolor):
    srgb = tuple(int(hexcolor[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in srgb)


materials = {}
for name, color in PALETTE.items():
    c = linear(color)
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*c, 1)
    m.use_nodes = True
    node = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    node.inputs['Base Color'].default_value = (*c, 1)
    node.inputs['Roughness'].default_value = .8
    materials[name] = m

obstacles, halos = [], []
buckets, origins = {}, {}
group_stack = ['World']


class group:
    """Route geometry to a named group; an origin makes it animate about that pivot."""

    def __init__(self, name, origin=None):
        self.name = name
        if origin:
            origins[name] = Vector((origin[0], -origin[1], origin[2]))

    def __enter__(self):
        group_stack.append(self.name)

    def __exit__(self, *_):
        group_stack.pop()


def emit(mat, verts, faces, smooth=False):
    g = group_stack[-1]
    b = buckets.setdefault((g, mat), dict(v=[], f=[], s=[]))
    o = origins.get(g, Vector((0, 0, 0)))
    n = len(b['v'])
    b['v'].extend(Vector(v) - o for v in verts)
    b['f'].extend(tuple(i + n for i in f) for f in faces)
    b['s'].extend([smooth] * len(faces))


def P(x, z, h):
    return Vector((x, -z, h))


def block(x0, x1, z0, z1):
    obstacles.append(dict(x0=round(x0, 3), x1=round(x1, 3), z0=round(z0, 3), z1=round(z1, 3)))


def box(x, z, h, w, d, ht, mat, solid=False, rot=0):
    """Axis box centred on x, z, h; rot turns it about the vertical."""
    c, s = math.cos(rot), math.sin(rot)
    vs = []
    for dz in (-d / 2, d / 2):
        for dx in (-w / 2, w / 2):
            for dh in (-ht / 2, ht / 2):
                vs.append(P(x + dx * c - dz * s, z + dx * s + dz * c, h + dh))
    # Index order: (z, x, h) bits. Normals face outward after the z flip in P().
    emit(mat, vs, [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (1, 5, 7, 3), (0, 2, 6, 4)])
    if solid:
        ex = abs(w / 2 * c) + abs(d / 2 * s)
        ez = abs(w / 2 * s) + abs(d / 2 * c)
        block(x - ex, x + ex, z - ez, z + ez)


def cyl(x, z, h, r, depth, mat, n=14, r2=None, solid=False):
    """Vertical frustum centred on h; r bottom, r2 top."""
    r2 = r if r2 is None else r2
    vs, fs = [], []
    for i in range(n):
        a = i / n * TAU
        vs.append(P(x + math.cos(a) * r, z + math.sin(a) * r, h - depth / 2))
        vs.append(P(x + math.cos(a) * r2, z + math.sin(a) * r2, h + depth / 2))
    for i in range(n):
        j = (i + 1) % n
        fs.append((2 * i, 2 * j, 2 * j + 1, 2 * i + 1))
    fs.append(tuple(2 * i for i in range(n)))
    fs.append(tuple(2 * i + 1 for i in reversed(range(n))))
    emit(mat, vs, fs)
    if solid:
        block(x - r, x + r, z - r, z + r)


def tube(a, b, r, mat, n=6, r2=None):
    """Tube between two (x, z, h) points, tapering to r2."""
    a, b = P(*a), P(*b)
    r2 = r if r2 is None else r2
    axis = (b - a).normalized()
    u = axis.orthogonal().normalized()
    v = axis.cross(u)
    vs = []
    for i in range(n):
        t = i / n * TAU
        off = u * math.cos(t) + v * math.sin(t)
        vs.append(a + off * r)
        vs.append(b + off * r2)
    fs = [(2 * i, 2 * ((i + 1) % n), 2 * ((i + 1) % n) + 1, 2 * i + 1) for i in range(n)]
    fs.append(tuple(2 * i + 1 for i in range(n)))
    fs.append(tuple(2 * i for i in reversed(range(n))))
    emit(mat, vs, fs)


_t = (1 + 5 ** .5) / 2
_IV = [Vector(v).normalized() for v in [(-1, _t, 0), (1, _t, 0), (-1, -_t, 0), (1, -_t, 0), (0, -1, _t), (0, 1, _t),
                                        (0, -1, -_t), (0, 1, -_t), (_t, 0, -1), (_t, 0, 1), (-_t, 0, -1), (-_t, 0, 1)]]
_IF = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
       (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]


def _ico(sub):
    vs, fs = list(_IV), list(_IF)
    for _ in range(sub):
        cache, out = {}, []

        def mid(a, b):
            k = (min(a, b), max(a, b))
            if k not in cache:
                vs.append((vs[a] + vs[b]).normalized())
                cache[k] = len(vs) - 1
            return cache[k]
        for a, b, c in fs:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            out += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        fs = out
    return vs, fs


ICO = {s: _ico(s) for s in (0, 1, 2)}


def ico(x, z, h, r, mat, scale=(1, 1, 1), sub=1, jitter=.08):
    vs, fs = ICO[sub]
    out = []
    for v in vs:
        k = 1 + random.uniform(-jitter, jitter)
        out.append(P(x + v.x * r * k * scale[0], z + v.y * r * k * scale[1], h + v.z * r * k * scale[2]))
    emit(mat, out, fs)


def banded(x, z, h, r, bands, tilt=.5, seg=20, rings=12):
    """Sphere built around a tilted axis, so colour bands get clean edges.
    bands: [(upper limit of cos(latitude) in -1..1, material)], ascending."""
    axis = Vector((math.sin(tilt), .25 * math.sin(tilt), math.cos(tilt))).normalized()
    u = axis.orthogonal().normalized()
    v = axis.cross(u)
    lo = -1.0
    for lim, mat in bands:
        lim = min(lim, 1.0)
        a0, a1 = math.acos(lo), math.acos(lim)
        steps = max(2, round((a0 - a1) / math.pi * rings))
        lats = [a0 + (a1 - a0) * i / steps for i in range(steps + 1)]
        vs, fs = [], []
        for la in lats:
            for j in range(seg):
                t = j / seg * TAU
                d = axis * math.cos(la) + (u * math.cos(t) + v * math.sin(t)) * math.sin(la)
                vs.append(P(x + d.x * r, z + d.y * r, h + d.z * r))
        for i in range(steps):
            for j in range(seg):
                k = (j + 1) % seg
                fs.append((i * seg + j, i * seg + k, (i + 1) * seg + k, (i + 1) * seg + j))
        emit(mat, vs, fs, smooth=True)
        lo = lim
        if lim >= 1:
            break


def torus(c, R, r, mat, normal=(0, 0, 1), seg=32, sides=8, arc=1.0):
    """Torus around normal (x, z, h axes) centred on c; arc < 1 leaves an open ring."""
    centre = P(*c)
    n = P(*normal).normalized()
    u = n.orthogonal().normalized()
    v = n.cross(u)
    vs, fs = [], []
    steps = seg + (0 if arc >= 1 else 1)
    for i in range(steps):
        a = i / seg * TAU * arc
        d = u * math.cos(a) + v * math.sin(a)
        for j in range(sides):
            b = j / sides * TAU
            vs.append(centre + d * (R + r * math.cos(b)) + n * (r * math.sin(b)))
    for i in range(seg if arc >= 1 else seg):
        i2 = (i + 1) % steps
        for j in range(sides):
            j2 = (j + 1) % sides
            fs.append((i * sides + j, i2 * sides + j, i2 * sides + j2, i * sides + j2))
    emit(mat, vs, fs)


def extrude(points, origin, u, v, depth, mat):
    """Extrude a 2D outline along u/v-plane normal; origin/u/v are Blender vectors."""
    n = u.cross(v).normalized() * depth
    front = [origin + u * p[0] + v * p[1] for p in points]
    back = [f - n for f in front]
    k = len(points)
    fs = [tuple(range(k)), tuple(reversed(range(k, 2 * k)))]
    fs += [(i + k, (i + 1) % k + k, (i + 1) % k, i) for i in range(k)]
    emit(mat, front + back, fs)


def wall_frame(wall, u, h, off):
    """Point on a wall plane plus its in-plane axes. N faces +z, W faces +x."""
    if wall == 'N':
        return P(u, -11.7 + off, h), Vector((1, 0, 0)), Vector((0, 0, 1))
    return P(-15.7 + off, u, h), Vector((0, 1, 0)), Vector((0, 0, 1))


def wshape(wall, points, u, h, scale, depth, mat, off=.03):
    o, a, b = wall_frame(wall, u, h, off + depth)
    extrude([(p[0] * scale, p[1] * scale) for p in points], o, a, b, depth, mat)


def wbox(wall, u, h, w, ht, depth, mat, off=0):
    if wall == 'N':
        box(u, -11.7 + off + depth / 2, h, w, depth, ht, mat)
    else:
        box(-15.7 + off + depth / 2, u, h, depth, w, ht, mat)


def crescent(n=14, phase=.32):
    pts = []
    for i in range(n + 1):
        a = math.pi * (.5 + i / n)
        pts.append((math.cos(a), math.sin(a)))
    for i in range(n, -1, -1):
        a = math.pi * (.5 + i / n)
        pts.append((math.cos(a) * phase - .0, math.sin(a) * .97))
    return pts


def star4(inner=.28):
    return [(math.cos(i / 8 * TAU + TAU / 4) * (1 if i % 2 == 0 else inner),
             math.sin(i / 8 * TAU + TAU / 4) * (1 if i % 2 == 0 else inner)) for i in range(8)]


def cloud_shape():
    pts = [(-1, 0), (1, 0)]
    for cx, cy, r, a0, a1 in [(.72, .2, .27, -60, 110), (.28, .38, .36, 0, 150), (-.22, .32, .3, 30, 160), (-.7, .16, .3, 60, 240)]:
        for i in range(6):
            a = math.radians(a0 + (a1 - a0) * i / 5)
            pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    return pts


def poster(wall, u, h, w, ht, style=0, off=.06):
    wbox(wall, u, h, w, ht, .02, 'paper', off=off)
    tones = ['ink', 'cobalt', 'peri', 'sky']
    if style == 0:  # comic page: panels
        for i in range(2):
            for j in range(3):
                wbox(wall, u + (i - .5) * w * .46, h + (j - 1) * ht * .3, w * .4, ht * .25, .01, random.choice(tones), off=off + .02)
    elif style == 1:  # colour block with moon
        wbox(wall, u, h, w * .86, ht * .88, .01, random.choice(['ultra', 'cobalt', 'teal']), off=off + .02)
        wshape(wall, crescent(8), u + w * .05, h + ht * .08, w * .28, .01, 'cream', off=off + .03)
    else:  # sketch sheet
        for j in range(4):
            wbox(wall, u + random.uniform(-.1, .1) * w, h + (j - 1.5) * ht * .2, w * random.uniform(.4, .72), ht * .05, .01, 'slate', off=off + .02)


def pegboard(wall, u0, u1, h0, h1, mat='peri_deep', dot='slate_line', step=.24):
    wbox(wall, (u0 + u1) / 2, (h0 + h1) / 2, u1 - u0, h1 - h0, .05, mat)
    s = .028
    vs, fs = [], []
    u = u0 + step / 2
    while u < u1:
        h = h0 + step / 2
        while h < h1:
            o, a, b = wall_frame(wall, u, h, .055)
            n = len(vs)
            vs += [o - a * s - b * s, o + a * s - b * s, o + a * s + b * s, o - a * s + b * s]
            fs.append((n, n + 1, n + 2, n + 3))
            h += step
        u += step
    emit(dot, vs, fs)


def books_row(x0, z, h, width, height=.42, along='x', mats=None):
    mats = mats or ['cobalt', 'white', 'ultra', 'sky', 'peri', 'lilac', 'teal', 'ice', 'ink', 'cream']
    p = 0
    while p < width - .1:
        t = random.uniform(.07, .13)
        ht = height * random.uniform(.68, 1)
        if random.random() > .12:
            m = random.choice(mats)
            if along == 'x':
                box(x0 + p + t / 2, z, h + ht / 2, t * .92, .24, ht, m)
            else:
                box(x0, z + p + t / 2, h + ht / 2, .24, t * .92, ht, m)
        p += t


def bookcase(x, z, w, ht, shelves=4, frame='peri', back='slate', solid=True):
    d = .46
    box(x, z - d / 2 + .03, ht / 2, w, .06, ht, back, solid=False)
    for sx in (-w / 2, w / 2):
        box(x + sx, z, ht / 2, .08, d, ht, frame)
    for i in range(shelves + 1):
        h = .06 + i * (ht - .1) / shelves
        box(x, z, h, w + .08, d, .07, frame)
        if i < shelves:
            books_row(x - w / 2 + .08, z + .02, h + .04, w - .18, (ht - .1) / shelves * .78)
    if solid:
        block(x - w / 2, x + w / 2, z - d / 2, z + d / 2)


def stool(x, z, r=.3, h=.72, mat='cobalt', leg='white'):
    cyl(x, z, h, r, .1, mat, 12)
    for i in range(3):
        a = i / 3 * TAU + .4
        tube((x + math.cos(a) * r * .6, z + math.sin(a) * r * .6, h), (x + math.cos(a) * r * 1.1, z + math.sin(a) * r * 1.1, 0), .025, leg, 5)
    torus((x, z, h * .42), r * .82, .018, leg, seg=12, sides=4)
    block(x - r, x + r, z - r, z + r)


def round_table(x, z, r, h=.95, top='white', stem='ink', solid=True):
    cyl(x, z, h, r, .08, top, 20)
    cyl(x, z, h - .07, r * .9, .06, stem, 20)
    cyl(x, z, h / 2, .05, h, stem, 8)
    cyl(x, z, .04, r * .5, .08, stem, 16)
    if solid:
        k = r * .8
        block(x - k, x + k, z - k, z + k)


def office_chair(x, z, mat='sky'):
    box(x, z, .62, .62, .6, .12, mat)
    box(x, z - .3, 1.08, .58, .1, .85, mat)
    box(x, z - .3, 1.54, .4, .1, .12, 'ink')
    cyl(x, z, .34, .04, .5, 'navy', 6)
    for i in range(5):
        a = i / 5 * TAU
        tube((x, z, .1), (x + math.cos(a) * .32, z + math.sin(a) * .32, .05), .03, 'navy', 4)
    block(x - .32, x + .32, z - .36, z + .3)


def monitor(x, z, w=1.5, ht=.9, h=1.55, mat='navy'):
    box(x, z, h, w, .07, ht, mat)
    box(x, z + .04, h, w * .93, .02, ht * .9, 'glow_screen')
    for i in range(3):
        for j in range(2):
            m = random.choice(['glow_ice', 'glow_ice', 'glow_blue', 'peri'])
            box(x - w * .2 + i * w * .19, z + .056, h + (j - .5) * ht * .38, w * .16, .008, ht * .32, m)
    box(x + w * .38, z + .056, h, w * .08, .008, ht * .7, 'glow_lilac')
    tube((x, z - .05, h - ht / 2), (x, z - .05, 1.0), .04, mat, 6)
    box(x, z - .05, 1.02, .42, .26, .03, mat)


def plant_spikes(x, z, h, size=1, mats=('leaf_b', 'leaf_a')):
    for i in range(9):
        a = i * 2.4
        lean = .12 + (i % 3) * .14
        tube((x, z, h), (x + math.cos(a) * lean * size * 1.5, z + math.sin(a) * lean * size * 1.5, h + (.9 - lean) * size * 1.1),
             .07 * size, mats[i % len(mats)], 4, r2=.004)


def pot(x, z, r=.28, ht=.5, mat='white', band='cobalt'):
    cyl(x, z, ht / 2, r * .78, ht, mat, 10, r2=r)
    cyl(x, z, ht * .72, r * .92, ht * .16, band, 10)
    cyl(x, z, ht + .002, r * .86, .02, 'navy', 10)
    block(x - r, x + r, z - r, z + r)


def orb_tree(x, z, base=0, ht=1.8, r=.7, tones=('leaf_b', 'leaf_a', 'leaf_c')):
    tube((x, z, base), (x, z, base + ht), .05, 'ink', 5)
    ico(x, z, base + ht + r * .4, r, tones[0], sub=1)
    ico(x + r * .7, z + r * .2, base + ht - r * .05, r * .55, tones[1], sub=1)
    ico(x - r * .5, z - r * .55, base + ht + r * .05, r * .5, tones[2], sub=1)


def crystal(x, z, base, r, ht, mat, lean=(0, 0), sides=6):
    tip = (x + lean[0], z + lean[1], base + ht)
    mid = (x + lean[0] * .68, z + lean[1] * .68, base + ht * .68)
    tube((x, z, base), mid, r, mat, sides, r2=r * .95)
    tube(mid, tip, r * .95, mat, sides, r2=.002)


def crystals(x, z, count=5, spread=.7, scale=1, base=0):
    mats = ['sky', 'ice', 'peri', 'lilac', 'azure']
    crystal(x, z, base, .3 * scale, 2.1 * scale, 'ice')
    for i in range(count):
        a = i / count * TAU + random.random()
        d = spread * random.uniform(.5, 1)
        crystal(x + math.cos(a) * d, z + math.sin(a) * d, base, random.uniform(.11, .22) * scale, random.uniform(.7, 1.5) * scale,
                mats[i % len(mats)], (math.cos(a) * .3 * scale, math.sin(a) * .3 * scale))


def vine(points, mats=('leaf_a', 'leaf_b', 'leaf_c'), leaf=.13, every=.26):
    """Stem through points with diamond leaves alternating on both sides."""
    for a, b in zip(points, points[1:]):
        tube(a, b, .018, 'teal_deep', 4)
        va, vb = Vector(a), Vector(b)
        n = max(1, int((vb - va).length / every))
        for i in range(n):
            p = va.lerp(vb, (i + .5) / n)
            ang = random.uniform(0, TAU)
            s = leaf * random.uniform(.8, 1.25)
            dx, dz, dh = math.cos(ang) * s, math.sin(ang) * s * .6 + .05, random.uniform(-.5, .3) * s
            c = P(p.x, p.y, p.z)
            tip = P(p.x + dx * 1.6, p.y + dz * 1.6, p.z + dh * 1.6)
            side = (tip - c).cross(Vector((.3, 1, .4))).normalized() * s * .46
            m = (c + tip) / 2
            emit(random.choice(mats), [c, m + side, tip, m - side], [(0, 1, 2, 3)])


def catenary(a, b, sag, n=10):
    return [(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t - sag * 4 * t * (1 - t))
            for t in [i / n for i in range(n + 1)]]


def bunting(a, b, sag=.5, mats=('white', 'cobalt', 'sky', 'cream')):
    pts = catenary(a, b, sag, 14)
    for i, (p, q) in enumerate(zip(pts, pts[1:])):
        tube(p, q, .012, 'ink', 4)
        emit(mats[i % len(mats)], [P(*p), P(*q), P((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2 - .34)], [(0, 1, 2)])


def garland(a, b, sag=.5, count=11, mat='glow_moon'):
    pts = catenary(a, b, sag, count + 1)
    for p, q in zip(pts, pts[1:]):
        tube(p, q, .012, 'ink', 4)
    for p in pts[1:-1]:
        tube(p, (p[0], p[1], p[2] - .16), .008, 'ink', 3)
        o = P(p[0], p[1], p[2] - .32)
        extrude([(x * .16, y * .16) for x, y in star4()], o, Vector((.8, .6, 0)), Vector((0, 0, 1)), .03, mat)


def light_bar(x, z, h, w=3.4, along='x', hang=None):
    """Long hanging panel lamp, its panes in alternating neon colours."""
    n = 6
    tones = ['glow_cyan', 'glow_mint', 'glow_blue', 'glow_cyan', 'glow_ice', 'glow_blue']
    if along == 'x':
        box(x, z, h, w, .34, .12, 'abyss')
        for i in range(n):
            box(x - w / 2 + (i + .5) * w / n, z, h + .07, w / n * .84, .26, .02, tones[i])
    else:
        box(x, z, h, .34, w, .12, 'abyss')
        for i in range(n):
            box(x, z - w / 2 + (i + .5) * w / n, h + .07, .26, w / n * .84, .02, tones[i])
    halos.append(dict(x=x, y=h - .2, z=z, color='#6FD8FF', size=w * 1.5))


def arc_lamp(x, z, ang, reach=2.4, ht=3.6, shade=.42):
    """Floor lamp arching to a banded globe."""
    cyl(x, z, .05, .36, .1, 'navy', 14, solid=True)
    pts = []
    for i in range(9):
        t = i / 8
        pts.append((x + math.cos(ang) * reach * t ** 1.8, z + math.sin(ang) * reach * t ** 1.8, ht * math.sin(t * 1.75) / math.sin(1.75) * (1.0 if t < 1 else 1)))
    for p, q in zip(pts, pts[1:]):
        tube(p, q, .035, 'navy', 5)
    e = pts[-1]
    banded(e[0], e[1], e[2] - shade * .6, shade, [(-.1, 'glow_ice'), (.3, 'navy'), (1, 'peri_deep')], tilt=.2, seg=14, rings=8)
    halos.append(dict(x=e[0], y=e[2] - shade, z=e[1], color='#CFE6FF', size=3.4))


def totem(x, z):
    """Stacked banded globes: the plaza's landmark lamp."""
    cyl(x, z, .1, 1.05, .2, 'navy', 20)
    cyl(x, z, .28, .78, .18, 'white', 20)
    block(x - .95, x + .95, z - .95, z + .95)
    h = .9
    for i, r in enumerate([.98, .86, .74]):
        cyl(x, z, h - r - .02, .3, .16, 'cobalt', 12) if i else None
        banded(x, z, h + r * .72, r, [(-.22, 'peri_deep'), (.16, 'ink'), (.42, 'glow_ice'), (1, 'white')], tilt=.34 + i * .1, seg=22, rings=14)
        h += r * 1.7
        torus((x, z, h - r * .1), r * .36, .05, 'navy', seg=14, sides=5)
    halos.append(dict(x=x, y=h - .4, z=z, color='#BFDFFF', size=6))


def bollard(x, z):
    cyl(x, z, .28, .1, .56, 'navy', 8)
    banded(x, z, .68, .19, [(-.1, 'ink'), (1, 'glow_ice')], tilt=.3, seg=10, rings=6)


def vending(x, z, tone='glow_ice', neon='glow_mint'):
    """Faces +x from the west wall."""
    box(x, z, 1.35, 1.0, 1.5, 2.7, 'navy', solid=True)
    box(x + .51, z - .12, 1.55, .02, 1.05, 1.95, tone)
    colors = ['coral', 'cobalt', 'aqua', 'white', 'lilac', 'gold', 'ultra', 'sky']
    for r in range(4):
        box(x + .53, z - .12, .78 + r * .5, .03, 1.0, .03, 'peri')
        for c in range(6):
            cyl(x + .55, z - .57 + c * .18, .94 + r * .5, .055, .28, colors[(r * 3 + c) % 8], 6)
    box(x + .52, z + .56, 1.6, .03, .24, .9, 'ink')
    for r in range(5):
        box(x + .54, z + .56, 1.28 + r * .15, .02, .12, .08, 'glow_cyan' if r % 2 else 'glow_blue')
    box(x + .52, z, .3, .03, 1.2, .26, 'abyss')
    box(x, z, 2.9, 1.04, 1.54, .3, 'ink')
    box(x + .53, z, 2.9, .02, 1.28, .18, neon)
    halos.append(dict(x=x + .7, y=1.6, z=z, color='#9FE8FF', size=5))


def server_rack(x, z):
    box(x, z, 1.6, 1.0, 1.1, 3.2, 'abyss', solid=True)
    for r in range(13):
        box(x + .505, z, .4 + r * .2, .01, .96, .15, 'navy')
        for c in range(7):
            if random.random() > .32:
                box(x + .515, z - .4 + c * .12, .4 + r * .2, .012, .07, .05, random.choice(['glow_cyan', 'glow_mint', 'glow_blue', 'glow_lilac', 'glow_coral']))
    halos.append(dict(x=x + .6, y=1.7, z=z, color='#6FE9FF', size=3.6))


def neon_text(text, wall, u, h, size, mat):
    curve = bpy.data.curves.new('neon', 'FONT')
    curve.body = text
    curve.size = size
    curve.align_x = 'CENTER'
    curve.extrude = .025
    curve.bevel_depth = .012
    curve.resolution_u = 2
    obj = bpy.data.objects.new('neon', curve)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.update()
    mesh = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    o, a, b = wall_frame(wall, u, h, .09)
    n = a.cross(b)
    emit(mat, [o + a * v.co.x + b * v.co.y + n * v.co.z for v in mesh.vertices], [tuple(p.vertices) for p in mesh.polygons])
    bpy.data.objects.remove(obj)
    bpy.data.curves.remove(curve)


# ---------------------------------------------------------------------------
# Painted floor: one bitmap carries the tile, mosaics and pools of light.
# ---------------------------------------------------------------------------
def rgb(hexcolor):
    return np.array([int(hexcolor[i:i + 2], 16) / 255 for i in (1, 3, 5)], dtype=np.float32)


def paint_floor(size=2048):
    SS = 2
    w, h = size * SS, size * 3 // 4 * SS
    xs = (np.arange(w, dtype=np.float32) + .5) / w * W - W / 2
    zs = (np.arange(h, dtype=np.float32) + .5) / h * D - D / 2
    X, Z = np.meshgrid(xs, zs)
    img = np.empty((h, w, 3), dtype=np.float32)
    img[:] = rgb('#E7F0FF')

    def put(mask, color, a=1.0):
        c = rgb(color) if isinstance(color, str) else color
        if isinstance(mask, np.ndarray) and mask.dtype != bool:
            m = (mask * a)[..., None]
            img[:] = img * (1 - m) + c * m
        elif a >= 1:
            img[mask] = c
        else:
            img[mask] = img[mask] * (1 - a) + c * a

    def lines(period, width, axis):
        return np.abs(((axis + period / 2) % period) - period / 2) < width

    def soft(cx, cz, r):
        d = np.hypot(X - cx, Z - cz) / r
        return np.clip(1 - d, 0, 1) ** 2

    terrace = np.ones_like(X, dtype=bool)
    # Terrace: large glazed tile.
    put(terrace & (((np.floor(X / 2) + np.floor(Z / 2)) % 2) == 0), '#DCE9FF')
    put(lines(2, .022, X) | lines(2, .022, Z), '#A6BFF3')

    # Moon-phase mandala around the plaza centre.
    R = np.hypot(X, Z - 4)
    A = np.arctan2(Z - 4, X)
    put(R < 7.2, '#2340C8')
    put((R < 6.95) & (R > 6.55), '#CFE6FF')
    put(R < 6.5, '#2F66E6')
    for k in range(24):
        a = k / 24 * TAU
        cx, cz = math.cos(a) * 5.75, 4 + math.sin(a) * 5.75
        r = .36
        disc = np.hypot(X - cx, Z - cz) < r
        off = (k / 24 - .5) * 2 * r * 2
        put(disc, '#F1F7FF')
        put(disc & (np.hypot(X - cx - off, Z - cz) < r), '#16286E')
    put(R < 5.0, '#1A2A78')
    put((R < 4.86) & (R > 4.74), '#78BDF8')
    petal = (np.abs(np.sin(A * 6)) * 1.5 + 2.6) > R
    put(petal & (R < 4.5), '#2F66E6')
    petal2 = (np.abs(np.cos(A * 6)) * 1.15 + 1.85) > R
    put(petal2 & (R < 3.4), '#78BDF8')
    put(R < 1.75, '#E7F0FF')
    put((R < 1.2) & (np.hypot(X + .42, Z - 4) > .95), '#2340C8')

    # Café: night checker with a giant record for a rug.
    cafe = (X < -5) & (Z >= 1)
    put(cafe, '#131D5E')
    put(cafe & (((np.floor((X + Z) / 1.1) + np.floor((X - Z) / 1.1)) % 2) == 0), '#1A2A78')
    Rc = np.hypot(X + 9, Z - 6)
    put(Rc < 4.2, '#0A1238')
    put((Rc < 4.05) & (Rc > 1.45) & (((Rc * 7.5) % 1) < .16), '#3B4A8C')
    put(Rc < 1.35, '#FF8A7A')
    put(Rc < 1.28, '#2F66E6')
    put(Rc < .18, '#E7F0FF')

    # Studio: slate herringbone, like parquet laid in blue.
    studio = (X < -5) & (Z < 1)
    U = (X + Z) / 1.0
    V = (X - Z) / 1.0
    herr = ((np.floor(U / 1.2) + np.floor(V / .4)) % 3)
    herr2 = ((np.floor(V / 1.2) + np.floor(U / .4)) % 3)
    block_sel = ((np.floor(U / 1.2) + np.floor(V / 1.2)) % 2) == 0
    tone = np.where(block_sel, herr, herr2)
    put(studio, '#17246A')
    put(studio & (tone == 1), '#1E2F85')
    put(studio & (tone == 2), '#26398F')
    put(studio & (lines(1.2, .012, U) | lines(.4, .012, V)), '#121C55')

    # Library: fine pale tile.
    lib = (X >= -5) & (X < 5) & (Z < -3.5)
    put(lib, '#F1F7FF')
    put(lib & (((np.floor(X / .8) + np.floor(Z / .8)) % 2) == 0), '#E2EDFF')
    put(lib & (lines(.8, .014, X) | lines(.8, .014, Z)), '#9DB6EE')
    put(lib & (((np.floor(X / .8) % 5 == 2) & (np.floor(Z / .8) % 3 == 1))), '#8DA2F2')

    # Greenhouse: hexagon mosaic in teal with a pale path.
    gh = (X >= 5) & (Z < -.5)
    q = (X * .5774 * 2 / 1.1)
    r = (Z / 1.1 - X * .5774 / 1.1)
    hexid = (np.floor(q) + 2 * np.floor(r)) % 3
    put(gh, '#0E6F92')
    put(gh & (hexid == 1), '#0A5775')
    put(gh & (hexid == 2), '#128AA6')
    put(gh & (np.abs(X - 10) < 2.1), '#BFE6F2')
    put(gh & (np.abs(X - 10) < 2.1) & (lines(1.05, .03, Z) | lines(1.4, .03, X - 10)), '#7FC4DB')

    # Mirador: pale circles walking out to sea.
    mirror = (X >= 7.4) & (Z >= -.5)
    put(mirror, '#CFE6FF')
    put(mirror & (lines(1.6, .02, X) | lines(1.6, .02, Z)), '#94B6EE')
    for cx, cz, rr in [(12, 4, 2.9), (13.5, 9.5, 1.7)]:
        d = np.hypot(X - cx, Z - cz)
        put(d < rr, '#3F8FF0')
        put(d < rr * .82, '#BFE0FF')
        put(d < rr * .62, '#2F66E6')

    # Thresholds tie the zones together.
    for x0, x1, z0, z1, col in [(-5.25, -4.75, -11.7, -5.8, '#2F66E6'), (-5.25, -4.75, 1, 12, '#2F66E6'), (-16, -5, -1.2, 1.2, '#2F66E6'),
                                (4.8, 5.2, -11.7, -.5, '#F1F7FF'), (-5, 5, -3.7, -3.3, '#2F66E6'), (5, 16, -.7, -.3, '#F1F7FF')]:
        put((X > x0) & (X < x1) & (Z > z0) & (Z < z1), col)
    put((X > -16) & (X < -5) & (np.abs(Z) < 1.1) & (lines(.7, .05, X)), '#CFE6FF')

    # Painted pools of lamplight: cheaper than real lights, and more illustrated.
    for cx, cz, rr, col, a in [(-9, -9, 6, '#4F7BFF', .34), (-14, -3.5, 3.6, '#6FE9FF', .22), (-14, 3.2, 4, '#7DFFD0', .18), (-11, 9, 5, '#7A6BFF', .24),
                               (5.2, 1.2, 5, '#FFF7DD', .2), (2.5, -7, 3.6, '#FFF2C4', .24), (10, -9, 5, '#CDEBFF', .3)]:
        put(soft(cx, cz, rr), col, a)

    # Inked rim.
    put((np.abs(X) > 15.86) | (np.abs(Z) > 11.86), '#0A1238')
    img = img.reshape(h // SS, SS, w // SS, SS, 3).mean(axis=(1, 3))
    return img, w // SS, h // SS


floor_px, fw, fh = paint_floor()
floor_img = bpy.data.images.new('refugio_floor', fw, fh, alpha=False)
pixels = np.concatenate([floor_px[::-1], np.ones((fh, fw, 1), dtype=np.float32)], axis=2)
floor_img.pixels.foreach_set(pixels.ravel())
floor_img.update()
floor_img.pack()
floor_mat = bpy.data.materials.new('floor')
floor_mat.use_nodes = True
bsdf = next(n for n in floor_mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
tex = floor_mat.node_tree.nodes.new('ShaderNodeTexImage')
tex.image = floor_img
floor_mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.inputs['Roughness'].default_value = .8
floor_mesh = bpy.data.meshes.new('Floor')
floor_mesh.from_pydata([P(-16, 12, 0), P(16, 12, 0), P(16, -12, 0), P(-16, -12, 0)], [], [(0, 1, 2, 3)])
floor_mesh.uv_layers.new(name='UVMap')
for i, uv in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]):
    floor_mesh.uv_layers[0].data[i].uv = uv
floor_mesh.materials.append(floor_mat)
floor_obj = bpy.data.objects.new('World_floor', floor_mesh)
bpy.context.scene.collection.objects.link(floor_obj)

# ---------------------------------------------------------------------------
# Pedestal: tiers stepping down into the sea.
# ---------------------------------------------------------------------------
box(0, 0, -.33, 32, 24, .6, 'navy')
box(0, 0, -.82, 33.6, 25.6, .5, 'ultra')
box(0, 0, -1.3, 35.4, 27.4, .5, 'cobalt')
box(0, 0, -1.8, 37.6, 29.6, .5, 'sky')
for x in range(-16, 17, 2):
    for z, s in ((12, 1), (-12, -1)):
        box(x, z + s * .4, -.82, .08, .84, .52, 'sky')
for z in range(-12, 13, 2):
    for x, s in ((16, 1), (-16, -1)):
        box(x + s * .4, z, -.82, .84, .08, .52, 'sky')
for x in range(-14, 16, 4):
    bollard(x, 11.75)
for z in range(-10, 12, 4):
    bollard(15.75, z)

# ---------------------------------------------------------------------------
# North wall
# ---------------------------------------------------------------------------
WALL = 6.4
with group('WallN'):
    # Studio section: slate boards laid in chevrons.
    box(-10.5, -11.85, WALL / 2, 11, .3, WALL, 'slate')
    for i in range(-1, 27):
        x = -16 + i * .44
        for k in range(8):
            h = k * .8
            d = 1 if k % 2 else -1
            a, b = x, min(max(x + .44 * d, -16), -5)
            if -16 <= a <= -5:
                tube((a, -11.69, h), (b, -11.69, h + .8), .012, 'slate_line', 3)
    # Library section: white tile.
    box(0, -11.85, WALL / 2, 10, .3, WALL, 'white')
    for x in np.arange(-5, 5.01, .5):
        box(float(x), -11.695, WALL / 2, .025, .01, WALL, 'ice')
    for h in np.arange(0, WALL, .5):
        box(0, -11.695, float(h), 10, .01, .025, 'ice')
    # Greenhouse section: a sky of glowing panes.
    box(10.5, -11.95, WALL / 2, 11, .1, WALL, 'abyss')
    rows = ['glow_sky5', 'glow_sky4', 'glow_sky4', 'glow_sky3', 'glow_sky3', 'glow_sky2', 'glow_sky2', 'glow_sky1']
    for r in range(8):
        for c in range(11):
            box(5.5 + c, -11.88, .4 + r * .8, .92, .03, .72, rows[r])
    for x in range(5, 17):
        box(x, -11.8, WALL / 2, .08, .14, WALL, 'white')
    for r in range(9):
        box(10.5, -11.8, r * .8, 11, .14, .08, 'white')
    box(0, -11.8, WALL + .1, 32.2, .5, .2, 'ink')
    # Painted clouds and a neon moon above the studio desk.
    wshape('N', cloud_shape(), -12.4, 5.05, 1.7, .05, 'white')
    wshape('N', cloud_shape(), -12.4, 5.03, 1.78, .03, 'sky', off=.0)
    wshape('N', cloud_shape(), -6.9, 5.2, 1.1, .05, 'white')
    wshape('N', crescent(), -9.7, 4.75, .92, .07, 'glow_moon')
    halos.append(dict(x=-9.9, y=4.7, z=-11.4, color='#FFE9A8', size=5.5))
    for u, h, s in [(-8.2, 5.1, .22), (-8.6, 4.6, .13), (-11, 4.4, .16)]:
        wshape('N', [(0, 1), (.62, 0), (0, -1), (-.62, 0)], u, h, s, .03, 'lilac')
    # Pegboards with pinned art.
    pegboard('N', -15.4, -10.2, 1.75, 3.95)
    pegboard('N', -9.9, -5.7, 1.75, 3.95, 'peri')
    for u, h, w, ht, st in [(-14.7, 3.1, .75, 1.05, 0), (-13.8, 2.8, .62, .9, 2), (-12.9, 3.2, .75, 1, 1), (-12, 2.85, .6, .8, 0), (-11.2, 3.15, .66, .95, 2),
                            (-9.2, 3.1, .7, 1, 0), (-8.3, 2.75, .55, .75, 1), (-7.5, 3.2, .62, .85, 2), (-6.6, 2.9, .7, 1, 0)]:
        poster('N', u, h, w, ht, st)
    for u, h in [(-10.8, 2.35), (-10.45, 2.7), (-13.2, 2.2), (-14.2, 2.15), (-8.8, 2.25)]:
        wshape('N', [(math.cos(i / 10 * TAU), math.sin(i / 10 * TAU)) for i in range(10)], u, h, .13, .03, random.choice(['coral', 'cream', 'aqua', 'white']), off=.06)
    wbox('N', -6.3, 2.2, 1.6, .07, .34, 'white', off=.05)
    for i in range(4):
        cyl(-6.9 + i * .38, -11.5, 2.38, .07, .3, ['cream', 'aqua', 'lilac', 'white'][i], 6)
    vine(catenary((-15.3, -11.5, 4.5), (-6, -11.5, 4.15), .35, 12), mats=('leaf_b', 'leaf_c', 'leaf_b'), leaf=.24, every=.17)
    vine([(-14.2, -11.5, 4.3), (-14.0, -11.48, 3.7), (-14.15, -11.48, 3.2)], mats=('leaf_b', 'leaf_c'), leaf=.2, every=.16)
    vine([(-7.6, -11.5, 4.2), (-7.4, -11.48, 3.75)], mats=('leaf_b', 'leaf_c'), leaf=.2, every=.16)
    # Interlocked rings on a stepped sky: the library's painting.
    box(-2.2, -11.68, 4.2, 4.6, .04, 2.8, 'ink')
    for i, (m, ht) in enumerate([('ultra', 2.6), ('cobalt', 1.9), ('azure', 1.2), ('sky', .6)]):
        box(-2.2, -11.65 + i * .004, 2.9 + ht / 2, 4.4, .02, ht, m)
    for i, m in enumerate(['white', 'ice', 'white']):
        torus((-3.2 + i * 1.0, -11.5, 4.2 + (.16 if i == 1 else 0)), .62, .1, m, normal=(.25 * (i - 1), 1, .25), seg=26, sides=7)
    # Wall bookcases.
    for x in (-3.6, -1.15, 1.3, 3.75):
        bookcase(x, -11.42, 2.4, 2.75, 4)
    bunting((-4.8, -11.3, 3.1), (0.8, -11.3, 3.25), .25)

# ---------------------------------------------------------------------------
# West wall
# ---------------------------------------------------------------------------
with group('WallW'):
    box(-15.85, 0, WALL / 2, .3, 24, WALL, 'navy')
    box(-15.8, 0, WALL + .1, .5, 24.2, .2, 'ink')
    # Gold wire grids with sketch sheets (studio side).
    for z0 in (-10.6, -7.0):
        for u in np.arange(0, 3.01, .3):
            box(-15.66, z0 + float(u), 3.35, .03, .03, 2.7, 'gold')
        for h in np.arange(2, 4.71, .3):
            box(-15.66, z0 + 1.5, float(h), .03, 3, .03, 'gold')
        poster('W', z0 + .85, 3.5, 1.2, 1.7, 2)
        poster('W', z0 + 2.2, 3.3, 1.2, 1.7, 0)
    wshape('W', cloud_shape(), -3, 5.3, 1.4, .05, 'peri')
    # Café side: dark pegboard, neon lettering, stars.
    pegboard('W', 1.2, 11.8, .3, 5.9, 'ink', 'abyss')
    neon_text('refugio', 'W', 7.5, 4.2, 1.15, 'glow_cyan')
    halos.append(dict(x=-15.2, y=4.5, z=7.5, color='#6FE9FF', size=6.5))
    wshape('W', crescent(), 10.6, 4.9, .55, .06, 'glow_moon')
    wshape('W', star4(), 3.4, 5.1, .36, .05, 'glow_lilac')
    wshape('W', star4(), 11.2, 2.8, .22, .05, 'glow_ice')
    poster('W', 4.4, 3.5, 1, 1.4, 1)
    poster('W', 10, 2.6, .9, 1.3, 1)

# Long drafting desk under the pegboards.
box(-10.6, -10.75, .98, 9.4, 1.5, .1, 'teal', solid=True)
box(-10.6, -10.75, .92, 9.3, 1.44, .04, 'teal_deep')
for x in (-15.1, -10.6, -6.1):
    for z in (-11.3, -10.15):
        box(x, z, .46, .07, .07, .92, 'abyss')
box(-14.2, -11.15, .63, 1.8, .6, .55, 'white')
box(-14.2, -10.84, .63, .76, .02, .42, 'ice')
box(-13.25, -11.15, .63, .05, .6, .55, 'cobalt')
monitor(-11.3, -11.1)
monitor(-9.6, -11.1)
box(-7.5, -11.05, 1.22, 1.9, .5, .36, 'white')
books_row(-8.35, -11.05, 1.4, 1.7, .5, mats=['cobalt', 'sky', 'ink', 'white', 'lilac', 'cream'])
# Tilted pen display.
tablet = [P(-12.9, -10.1, 1.06), P(-11.4, -10.1, 1.06), P(-11.4, -10.75, 1.42), P(-12.9, -10.75, 1.42)]
emit('slate_line', tablet, [(0, 1, 2, 3)])
emit('glow_ice', [t + Vector((0, 0, .012)) + (Vector((-12.15, 10.42, 1.24)) - t) * .1 for t in tablet], [(0, 1, 2, 3)])
box(-9.7, -10.3, 1.05, 1.5, .5, .05, 'peri')
for r in range(3):
    for c in range(9):
        box(-10.3 + c * .15, -10.45 + r * .15, 1.09, .12, .12, .03, 'ice')
cyl(-8.4, -10.3, 1.12, .1, .2, 'cream', 10)
cyl(-8.4, -10.3, 1.23, .082, .01, 'slate', 10)
office_chair(-10.4, -9.35)
light_bar(-11.2, -9.3, 4.1, 5)
tube((-13.2, -9.3, 4.15), (-13.2, -11.6, 5.4), .012, 'ink', 3)
tube((-9.2, -9.3, 4.15), (-9.2, -11.6, 5.4), .012, 'ink', 3)

# Sound bench and server rack on the studio's west side.
server_rack(-15.1, -3.9)
box(-14.9, -6.4, .8, 1.2, 2.4, .08, 'abyss', solid=True)
for z in (-7.4, -5.4):
    tube((-14.9, z, 0), (-14.9, z, .76), .05, 'slate', 5)
box(-14.8, -6.9, .9, .7, .85, .12, 'peri_deep')
for i in range(5):
    cyl(-14.6, -7.2 + i * .15, .98, .04, .05, 'glow_cyan' if i % 2 else 'white', 6)
box(-14.9, -5.7, .92, .75, .95, .05, 'navy')
box(-15.2, -5.7, 1.12, .05, .9, .42, 'glow_screen')
box(-15.17, -5.7, 1.12, .01, .78, .32, 'glow_blue')
# Abstract studio plant and low divider.
pot(-13.6, -2.2, .34, .6, 'white', 'cobalt')
plant_spikes(-13.6, -2.2, .6, 1.25)
bookcase(-5.05, -1.2, 2.6, 1.3, 2, 'peri_deep', 'ink')

# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------
# Loft with bed, reached by a white ladder; neon moons along its rail.
LX0, LX1, LZ0, LZ1, LH = 1.7, 5.3, -11.6, -7.8, 3.05
box((LX0 + LX1) / 2, (LZ0 + LZ1) / 2, LH, LX1 - LX0, LZ1 - LZ0, .16, 'white')
box((LX0 + LX1) / 2, (LZ0 + LZ1) / 2, LH - .13, LX1 - LX0 - .1, LZ1 - LZ0 - .1, .1, 'cobalt')
for x in (LX0 + .1, LX1 - .1):
    box(x, LZ1 - .1, LH / 2, .14, .14, LH, 'white', solid=True)
tube((LX0, LZ1, LH + 1), (LX1, LZ1, LH + 1), .04, 'white', 6)
tube((LX0, LZ0 + .2, LH + 1), (LX0, LZ1, LH + 1), .04, 'white', 6)
for x in np.arange(LX0, LX1 + .01, .45):
    tube((float(x), LZ1, LH), (float(x), LZ1, LH + 1), .018, 'white', 4)
box(3.7, -10.2, LH + .3, 2.8, 2.2, .36, 'ice')
box(3.7, -9.75, LH + .52, 2.84, 1.3, .12, 'cobalt')
box(2.7, -10.8, LH + .55, .9, .8, .2, 'white')
for i in range(3):
    o = P(2.5 + i * 1.15, -7.74, LH + 1.7)
    extrude([(x * .42, y * .42) for x, y in crescent(10)], o, Vector((1, 0, 0)), Vector((0, 0, 1)), .06, 'glow_moon')
    tube((2.5 + i * 1.15, -7.8, LH + 1.0), (2.5 + i * 1.15, -7.8, LH + 1.32), .012, 'white', 3)
halos.append(dict(x=3.6, y=LH + 1.7, z=-7.6, color='#FFEBB0', size=5.5))
for x in (1.45, 1.05):
    tube((x, -7.45, 0), (x, -7.8, LH + 1), .035, 'white', 5)
for i in range(1, 9):
    tube((1.45, -7.45 - i * .04, i * .42), (1.05, -7.45 - i * .04, i * .42), .022, 'white', 4)
block(1, 1.5, -7.85, -7.4)
# Under-loft nook.
box(3.6, -10.5, .42, 2.6, .95, .46, 'cobalt', solid=True)
box(3.6, -10.92, .85, 2.6, .24, .55, 'ultra')
for x, m in [(2.8, 'cream'), (4.3, 'sky')]:
    box(x, -10.4, .76, .55, .3, .3, m)
# Reading corner.
box(-3.4, -8.8, .4, 1.3, 1.2, .44, 'sky', solid=True)
box(-3.4, -9.3, .86, 1.3, .24, .62, 'azure')
box(-3.95, -8.8, .72, .2, 1.2, .24, 'azure')
box(-2.85, -8.8, .72, .2, 1.2, .24, 'azure')
round_table(-2.9, -6.4, .62, .78, 'white', 'cobalt')
stool(-3.95, -6.0, .26, .5, 'peri')
books_row(-3.1, -6.4, .83, .46, .2)
cyl(-2.6, -6.2, .88, .07, .14, 'cream', 10)
round_table(3.3, -5.4, .75, .85, 'peri', 'white')
stool(2.3, -4.9, .26, .55, 'cobalt')
stool(4.3, -4.8, .26, .55, 'white', 'cobalt')
box(3.2, -5.4, .92, .52, .36, .03, 'navy')
box(3.2, -5.56, 1.06, .5, .02, .28, 'glow_blue')
arc_lamp(-4.2, -4.6, -.6, 2.3, 3.5)
pot(-1.1, -10.7, .26, .45, 'cobalt', 'white')
ico(-1.1, -10.7, 1.1, .5, 'leaf_a')
ico(-.9, -10.5, .85, .34, 'leaf_b')

# ---------------------------------------------------------------------------
# Greenhouse: arching ribs, not walls, so the camera sees through.
# ---------------------------------------------------------------------------
for z in (-10.5, -7.8, -5.1, -2.4):
    pts = [(10.5 + math.cos(a) * 5.1, z, 4.4 * math.sin(a)) for a in [i / 12 * math.pi for i in range(13)]]
    for p, q in zip(pts, pts[1:]):
        tube(p, q, .05, 'white', 5)
    for x in (5.4, 15.6):
        cyl(x, z, .15, .13, .3, 'ink', 8, solid=True)
for z0, z1 in ((-10.5, -2.4),):
    for a in (.5, 1.0, 1.57, 2.14, 2.64):
        x, h = 10.5 + math.cos(a) * 5.1, 4.4 * math.sin(a)
        tube((x, z0, h), (x, z1, h), .028, 'white', 4)
vine(catenary((5.9, -10.5, 2.4), (9, -10.5, 4.3), -.2, 6))
vine(catenary((15.1, -7.8, 2.4), (12.2, -7.8, 4.2), -.2, 6))
vine(catenary((5.9, -5.1, 2.3), (8.6, -5.1, 4.2), -.2, 6))

for x in (6.9, 14.05):
    box(x, -6.7, .32, 1.5, 7.8, .64, 'white', solid=True)
    box(x, -6.7, .655, 1.34, 7.64, .03, 'teal_deep')
    for z in np.arange(-10.2, -2.9, 1.2):
        z = float(z)
        k = random.random()
        if k < .36:
            plant_spikes(x, z, .66, 1.1, ('leaf_c', 'leaf_b'))
        elif k < .7:
            orb_tree(x + random.uniform(-.2, .2), z, .66, random.uniform(.9, 1.5), random.uniform(.42, .6))
        else:
            crystals(x, z, 4, .45, .62, .66)
# Potting table and hanging globes.
box(10, -10.4, .9, 3.4, 1.1, .1, 'white', solid=True)
for dx in (-1.6, 1.6):
    box(10 + dx, -10.4, .43, .08, 1, .86, 'ink')
for i, x in enumerate((9, 10, 11)):
    cyl(x, -10.4, 1.13, .17, .28, ['cobalt', 'white', 'peri'][i], 9, r2=.22)
    plant_spikes(x, -10.4, 1.25, .5, ('leaf_b', 'leaf_c'))
for x, z, h in [(8.6, -7.8, 2.95), (11.6, -5.1, 3.1), (10.2, -2.4, 2.9)]:
    tube((x, z, 3.9), (x, z, h + .3), .012, 'ink', 3)
    banded(x, z, h, .32, [(-.2, 'teal'), (.2, 'white'), (1, 'glow_cyan')], tilt=.3, seg=12, rings=8)
    vine([(x + .2, z, h - .1), (x + .28, z + .1, h - .8), (x + .1, z + .1, h - 1.3)], leaf=.1, every=.16)
halos.append(dict(x=10, y=2.6, z=-7.5, color='#9FF0FF', size=9))

# ---------------------------------------------------------------------------
# Terrace plaza
# ---------------------------------------------------------------------------
totem(5.2, .9)
arc_lamp(-5.4, 1.9, .55, 2.5, 3.4)
arc_lamp(6.6, 8.6, 2.6, 2.6, 3.7)
# A banana bench hugging the mandala's south rim.
for i in range(10):
    a = math.radians(58 + i * 6.8)
    x, z = math.cos(a) * 7.6, 4 + math.sin(a) * 7.6
    box(x, z, .3, 1.0, .75, .34, 'white' if i % 2 else 'ice', solid=True, rot=a + math.pi / 2)
    box(x + math.cos(a) * .36, z + math.sin(a) * .36, .68, 1.0, .16, .5, 'cobalt', rot=a + math.pi / 2)
round_table(-3.3, 7.6, .72, .82, 'white', 'cobalt')
stool(-4.4, 8.1, .26, .52, 'sky')
stool(-2.4, 8.6, .26, .52, 'cobalt')
cyl(-3.3, 7.6, .9, .08, .15, 'cream', 8)
round_table(3.6, 6.1, .72, .82, 'peri', 'white')
stool(2.6, 6.9, .26, .52, 'white', 'cobalt')
stool(4.6, 6.8, .26, .52, 'cobalt')
ico(3.6, 6.1, 1.1, .2, 'coral', sub=1, jitter=0)
# Star garlands strung across the plaza.
garland((-15.5, 1.1, 5.2), (5.2, .9, 5.5), 1.0, 15)
bunting((-4.9, -3.5, 4.1), (5.1, -.9, 4.3), .6)
tube((-4.9, -3.5, 0), (-4.9, -3.5, 4.1), .05, 'white', 6)
tube((5.1, -.9, 0), (5.1, -.9, 4.3), .05, 'white', 6)
block(-5, -4.8, -3.6, -3.4)

# Mirador: interlocked ring sculpture and crystal beds on the sea side.
cyl(12, 4, .11, 2.05, .22, 'white', 24)
cyl(12, 4, .25, 1.75, .06, 'teal', 24)
block(10.3, 13.7, 2.3, 5.7)
with group('Anim_Spin_rings', origin=(12, 4, 2.4)):
    torus((12, 4, 2.4), 1.7, .15, 'white', normal=(1, 0, .3), seg=34, sides=8)
    torus((12, 4, 2.4), 1.3, .13, 'cobalt', normal=(.2, 1, .1), seg=30, sides=8)
    torus((12, 4, 2.4), .9, .11, 'gold', normal=(.2, .5, 1), seg=26, sides=8)
    banded(12, 4, 2.4, .4, [(-.1, 'ultra'), (.2, 'white'), (1, 'glow_ice')], tilt=.6, seg=14, rings=8)
tube((12, 4, .25), (12, 4, 1.9), .05, 'white', 6)
halos.append(dict(x=12, y=2.4, z=4, color='#BFE0FF', size=6))
crystals(13.6, 9.6, 7, 1.0, 1.25)
block(12.7, 14.5, 8.7, 10.5)
crystals(9.8, 9.6, 5, .7, .8)
block(9.2, 10.4, 9, 10.2)
crystals(14.6, -.5 + 1.8, 4, .5, .7)
block(14.1, 15.1, .8, 1.8)
for x, z in [(8.6, 1.2), (15, 6.6)]:
    pot(x, z, .3, .52, 'cobalt', 'white')
    plant_spikes(x, z, .52, 1.0, ('leaf_c', 'leaf_b'))

# ---------------------------------------------------------------------------
# Café
# ---------------------------------------------------------------------------
vending(-15.05, 3.0)
vending(-15.05, 4.8, 'glow_sky3', 'glow_coral')
box(-15.1, 6.3, 1.5, .9, 1, 3, 'ink', solid=True)
box(-14.64, 6.3, 1.5, .02, .03, 2.8, 'slate_line')
box(-14.62, 6.2, 1.6, .05, .04, .3, 'gold')
box(-15, 6.3, 3.2, .7, .9, .4, 'cobalt')
box(-14.98, 6.3, 3.48, .6, .5, .16, 'white')
# Counter with stools.
box(-14.1, 9.6, .55, 1, 3.8, 1.1, 'ink', solid=True)
box(-14.05, 9.6, 1.14, 1.2, 4, .08, 'sky')
for z in (8.2, 9.3, 10.4):
    stool(-13, z, .26, .78, 'peri', 'white')
# DJ deck with spinning platters.
box(-14.1, 9.6, 1.26, .78, 1.9, .14, 'abyss')
for i, z in enumerate((9.05, 10.15)):
    cyl(-14.1, z, 1.35, .33, .05, 'navy', 16)
    with group(f'Anim_Spin_disc{i}', origin=(-14.1, z, 1.39)):
        cyl(-14.1, z, 1.39, .3, .03, 'slate_line', 16)
        cyl(-14.1, z, 1.41, .1, .02, 'glow_coral', 8)
        box(-14.0, z, 1.41, .2, .03, .01, 'white')
box(-14.05, 8.1, 1.3, .4, .5, .2, 'peri_deep')
# High tables with a bottle and a sofa island.
round_table(-6.2, 3.6, .6, 1.25, 'ink', 'white')
stool(-5.9, 4.7, .24, .8, 'cobalt')
stool(-7.3, 3.3, .24, .8, 'sky')
cyl(-6.2, 3.6, 1.48, .1, .36, 'white', 10)
cyl(-6.2, 3.6, 1.55, .104, .12, 'cobalt', 10)
cyl(-6.2, 3.6, 1.72, .04, .12, 'white', 8)
box(-8.8, 11.1, .36, 4.8, 1, .4, 'ink', solid=True)
box(-8.8, 11.55, .78, 4.8, .3, .7, 'peri_deep')
for x, m in [(-10.3, 'sky'), (-8.8, 'cobalt'), (-7.2, 'lilac')]:
    box(x, 11.05, .68, .9, .55, .26, m)
pot(-6, 11.1, .3, .55, 'white', 'ink')
ico(-6, 11.1, 1.2, .55, 'leaf_b')
ico(-5.8, 10.9, 1.7, .36, 'leaf_c')
light_bar(-10.2, 2.6, 4.2, 4.6)
tube((-10.2, 2.6, 4.25), (-15.6, 2.6, 5.5), .012, 'ink', 3)
light_bar(-9, 9.1, 4.1, 4.6)
tube((-9, 9.1, 4.15), (-15.6, 9.1, 5.5), .012, 'ink', 3)
# Hanging plant over the counter.
tube((-12.1, 6.8, 5.2), (-12.1, 6.8, 3.65), .012, 'ink', 3)
cyl(-12.1, 6.8, 3.5, .18, .3, 'white', 8, r2=.26)
vine([(-12.1, 6.9, 3.5), (-12.3, 7.0, 2.9), (-12.15, 7.05, 2.4)], every=.14)
vine([(-12.0, 6.75, 3.5), (-11.8, 6.8, 3.0)], every=.14)

# ---------------------------------------------------------------------------
# The sea beyond: towers, islets, clouds and a mast-borne moon.
# ---------------------------------------------------------------------------
SEA = -2.05


def tower(x, z, r, ht, mats=('white', 'ink', 'cobalt')):
    h = SEA
    i = 0
    while h < ht:
        s = random.uniform(1.2, 2.6)
        cyl(x, z, h + s / 2, r * (1 - .03 * i), s, mats[i % len(mats)], 16)
        h += s
        i += 1
    torus((x, z, h - .2), r * 1.05, .08, 'glow_ice', seg=20, sides=5)


def islet(x, z, r):
    ico(x, z, SEA - .1, r, 'navy', (1, 1, .42), sub=2, jitter=.05)
    ico(x, z, SEA + .28, r * .78, 'teal', (1, 1, .28), sub=1)
    orb_tree(x + r * .1, z, SEA + .4, r * .7, r * .34, ('leaf_c', 'leaf_b', 'leaf_a'))
    orb_tree(x - r * .35, z + r * .2, SEA + .4, r * .4, r * .24)


def cloud(x, z, h, s):
    for dx, dz, r in [(0, 0, 1), (.95, .1, .72), (-.95, -.05, .76), (.35, .55, .62), (-.4, -.6, .58)]:
        ico(x + dx * s, z + dz * s, h + r * s * .2, r * s, random.choice(['white', 'ice', 'white']), (1.15, 1, .62), sub=1, jitter=.05)


# Tall scenery shares the wall groups: it hides with them when it would block the view.
with group('WallN'):
    tower(-22, -19, 2.1, 11)
    tower(-14, -27, 1.5, 15)
    tower(23, -16, 1.8, 13)
with group('WallW'):
    tower(-27, -3, 1.3, 8)
tower(27, 3, 1.1, 2)
islet(-27, 8, 3.6)
islet(9, -24, 4.2)
islet(30, -6, 3)
islet(24, 15, 3)
islet(-9, 21, 2.4)
torus((24, -3.5, SEA), 6.5, .34, 'white', normal=(.8, .5, .05), seg=44, sides=8)
torus((-24, 15, SEA), 5, .3, 'sky', normal=(.5, .8, .1), seg=40, sides=8)

# A colossal crescent rising out of the sea behind the wall line.
with group('WallN'):
    o = P(-3.5, -25, .9)
    extrude([(x * 6, y * 6) for x, y in crescent(20, .42)], o, Vector((.8, .6, 0)), Vector((0, 0, 1)), .6, 'glow_moon')
halos.append(dict(x=-5, y=.9, z=-25, color='#FFE9A8', size=20, wall='WallN'))

with group('Anim_Bob_a', origin=(0, 0, 0)):
    cloud(-19, -17, 7, 2.0)
    cloud(12, -22, 9, 2.6)
    cloud(30, -14, 5, 1.8)
    banded(1, -18, 8, 1.5, [(-.25, 'peri_deep'), (.2, 'ink'), (1, 'white')], tilt=.5)
with group('Anim_Bob_b', origin=(0, 0, 0)):
    cloud(-26, 2, 2.5, 1.7)
    cloud(25, 6, -.7, 1.5)
    cloud(-14, 19, -1, 1.4)
    cloud(19, 19, -1.1, 1.2)
    banded(-19, -24, 12, 1.1, [(-.2, 'cobalt'), (.2, 'white'), (1, 'sky')], tilt=.8)
    banded(14, -18, 5.5, .8, [(-.1, 'ink'), (.25, 'glow_ice'), (1, 'peri')], tilt=.3)

# ---------------------------------------------------------------------------
# Task worktables. Four standing slots leave circulation routes open.
# Coordinates match PUESTOS in room-life.ts.
# ---------------------------------------------------------------------------
workstations = [
    ('investigar', -.7, -10, 'ice'),
    ('planificar', 0, .3, 'peri'),
    ('programar', -10, -7.2, 'cobalt'),
    ('revisar', -8.3, -1.2, 'sky'),
]
for task, x, z, color in workstations:
    with group('Puesto_' + task):
        box(x, z, .96, 3.4, .9, .12, color, solid=True)
        box(x, z, .86, 3.2, .7, .06, 'navy')
        for dx in (-1.45, 1.45):
            box(x + dx, z, .43, .09, .65, .86, 'white')
        tube((x - 1.35, z - .2, 1.05), (x - 1.35, z - .2, 1.75), .03, 'ink', 5)
        box(x - 1.15, z - .2, 1.75, .55, .18, .06, 'glow_ice')
        if task == 'programar':
            monitor(x, z - .2, 1.45, .7, 1.45)
            box(x, z + .24, 1.05, 1.2, .26, .04, 'ice')
        elif task == 'investigar':
            books_row(x - .7, z - .15, 1.04, 1.6, .34)
            box(x + .35, z + .22, 1.04, .65, .4, .025, 'paper')
            box(x + .35, z + .22, 1.057, .025, .4, .005, 'cobalt')
        elif task == 'planificar':
            box(x, z - .28, 1.6, 1.7, .08, 1.05, 'white')
            for dx, h in [(-.5, 1.7), (.15, 1.7), (.15, 1.35), (.65, 1.35)]:
                box(x + dx, z - .23, h, .32, .025, .2, 'cobalt' if dx < 0 else 'peri')
            box(x, z + .2, 1.04, 1, .35, .025, 'paper')
        else:
            for dx in (-.55, .45):
                box(x + dx, z, 1.05, .7, .56, .035, 'paper')
                for dz in (-.14, 0, .14):
                    box(x + dx, z + dz, 1.075, .48, .025, .008, 'cobalt')

# ---------------------------------------------------------------------------
# Build meshes, export.
# ---------------------------------------------------------------------------
count = 0
for (g, mat), b in buckets.items():
    mesh = bpy.data.meshes.new(f'{g}_{mat}')
    mesh.from_pydata([tuple(v) for v in b['v']], [], b['f'])
    mesh.materials.append(materials[mat])
    mesh.polygons.foreach_set('use_smooth', b['s'])
    mesh.validate()
    obj = bpy.data.objects.new(f'{g}__{mat}', mesh)
    obj.location = origins.get(g, Vector((0, 0, 0)))
    bpy.context.scene.collection.objects.link(obj)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    count += len(b['f'])

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'refugio.glb'), export_format='GLB', use_selection=True,
                          export_yup=True, export_tangents=False, export_morph=False, export_skins=False,
                          export_animations=False, export_lights=False, export_cameras=False)
with open(os.path.join(OUT, 'refugio-nav.json'), 'w') as f:
    json.dump(dict(width=W, depth=D, obstacles=obstacles, halos=halos), f)

bpy.ops.object.camera_add(location=(26, -34, 29))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 46
bpy.context.scene.camera = camera
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'ops', 'room-refuge.blend'))
print('REFUGE_EXPORTED', len(obstacles), 'obstacles', len(buckets), 'meshes', count, 'faces',
      os.path.getsize(os.path.join(OUT, 'refugio.glb')), 'bytes')
