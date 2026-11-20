# Genera los modelos GLB de la sala: figuras originales, adultas y vestidas, en estilo
# low-poly de consola portátil: unos 2,000 triángulos, facetas duras y todo el detalle
# pintado en texturas chicas con filtro de píxel.
#
#   blender -b --factory-startup -P dashboard/ops/room-models.py -- [--preview DIR] [--solo NOMBRE]
#
# Sale un GLB por figura en public/models/sala/, con el mismo esqueleto y acciones.
# Los materiales pelo/pelo2/ropa/acento/gorra/cuadros/rayas usan texturas en grises para
# que la sala pueda teñirlos dentro del juego.
#
# Medidas tomadas de las referencias (fracción de la altura de la cabeza, de coronilla a
# barbilla): ojos a 0.68, boca a 0.91, ojo de 0.17 de ancho, cara visible de 0.62 del ancho
# entre mechones. La cabeza es el 28 % de la figura y las botas casi una cuarta parte.
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Quaternion, Vector

AQUI = os.path.dirname(os.path.abspath(__file__))
SALIDA = os.path.normpath(os.path.join(AQUI, "..", "public", "models", "sala"))

FIGURAS = {
    # Claude: bibliotecaria tranquila. Melena terracota, lentes, moño y libro abierto.
    "ambar": dict(piel="#fff3e8", pelo="#f08a58", pelo2="#ffb98c", ojos="#b5561c", ropa="#f7ead6", tela2="#fff8ee", acento="#d4553a", botas="#fff3e4", ojo="dulce", boca="suave", lentes=True),
    # ChatGPT: sabelotodo burlona. Bob oscuro con mechas menta, sudadera y orejas de gato.
    "menta": dict(piel="#fff4ec", pelo="#59607e", pelo2="#55e8bd", ojos="#12a982", ropa="#4bd9b0", tela2="#f4fff9", acento="#178f70", botas="#f6fffb", ojo="felino", boca="gatita", oscuro=True),
    # Gemini: estrella del escenario. Coletas gemelas, vestido con olanes y varita.
    "lira": dict(piel="#fff6f0", pelo="#a7adff", pelo2="#e2b8ff", ojos="#8d3fe0", ropa="#5560ee", tela2="#f1ebff", acento="#ffcf5c", botas="#ece8ff", ojo="estrella", boca="abierta"),
    # DeepSeek: guitarrista punk, medio dormida. Moñitos en punta, audífonos y guitarra.
    "marina": dict(piel="#fff5ee", pelo="#4a86ec", pelo2="#6fd2ff", ojos="#1b5fc8", ropa="#232f58", tela2="#dfe8fb", acento="#3cb4ff", botas="#eef3fc", ojo="sueno", boca="punto"),
    # Quien juega: gorra, cuello marinero y mirada en espiral, en los azules de la app.
    "jugador": dict(piel="#ffffff", pelo="#59607e", pelo2="#8d93b5", ojos="#101428", ropa="#f6f8ff", tela2="#ffffff", acento="#2858b8", botas="#f2f5ff", ojo="espiral", boca="punto", oscuro=True),
}


def rgb(hexa):
    h = hexa.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def lineal(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# ------------------------------------------------------------------ texturas
def imagen(nombre, px):
    h, w = px.shape[:2]
    img = bpy.data.images.new(nombre, w, h, alpha=True)
    img.colorspace_settings.name = "sRGB"
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = px if px.ndim == 3 else px[..., None]
    img.pixels.foreach_set(rgba[::-1].ravel())
    img.pack()
    return img


def gris(a):
    return np.repeat(a[..., None], 3, axis=2)


def tex_pelo(oscuro=False):
    # Fila 0 = raíz. Hebras con tinta a los lados y brillo en zigzag, como el pelo pintado
    # a mano de consola: el volumen lo da la textura, no la cantidad de polígonos.
    h, w = 32, 16
    base = 0.46 if oscuro else 0.84
    p = np.ones((h, w)) * base
    for y in range(h):
        t = y / (h - 1)
        p[y] *= 0.86 + 0.14 * min(1, t * 5)
        p[y] *= 1 - 0.34 * max(0, t - 0.78) / 0.22
    p[:, 3:5] *= 0.62
    p[:, 11:13] *= 0.62
    p[:, 7] *= 0.84
    p[:, 15] *= 0.84
    for x in range(w):
        banda = 10 + (2 if x % 4 < 2 else 0)
        p[banda:banda + 3, x] = 1.0 if oscuro else max(base + 0.14, 1.0)
    return gris(p)


def tex_tela():
    # Fila 0 = arriba. Sombra pintada abajo, dobladillo oscuro y una costura.
    h, w = 16, 16
    p = np.ones((h, w))
    for y in range(h):
        p[y] = 1.0 - 0.16 * (y / (h - 1)) ** 2
    p[-1:] = 0.5
    p[:, 0] *= 0.82
    p[:, 8] *= 0.9
    return gris(p)


def tex_cuadros():
    # Escocés grueso: se tiene que leer a 40 píxeles de pantalla.
    h, w = 32, 32
    p = np.ones((h, w))
    for y in range(h):
        for x in range(w):
            v = 1.0
            if x % 11 < 3:
                v *= 0.42
            if y % 11 < 3:
                v *= 0.42
            if x % 11 == 7 or y % 11 == 7:
                v *= 0.7
            p[y, x] = v
    return gris(p)


def tex_rayas():
    p = np.ones((8, 2))
    p[4:] = 0.16
    return gris(p)


def tex_gorra():
    # Ocho gajos con costura oscura; más claro hacia la copa.
    h, w = 16, 64
    p = np.ones((h, w))
    for y in range(h):
        p[y] = 1.0 - 0.3 * (y / (h - 1))
    p[:, ::8] *= 0.5
    return gris(p)


def tex_botas():
    # Vista superior (u: ancho, v: largo). Puntera de dos óvalos con punto, banda gris
    # y costuras punteadas, como se ve en la referencia.
    h, w = 64, 64
    yy, xx = np.mgrid[0:h, 0:w]
    p = np.ones((h, w)) * 0.97
    p[14:24] = 0.58
    p[13] = 0.28 * (xx[13] % 2 == 0) + 0.58 * (xx[13] % 2 == 1)
    p[24] = 0.28 * (xx[24] % 2 == 0) + 0.58 * (xx[24] % 2 == 1)
    p[56:] *= 0.86
    p[np.abs(xx - 32) > 25] *= 0.84
    for cy, rx, ry in ((31, 21, 6.5), (45, 23, 7.5)):
        d = ((xx - 32) / rx) ** 2 + ((yy - cy) / ry) ** 2
        p[d < 1] = 0.8
        p[(d < 1.25) & (d >= 1) & ((xx + yy) % 3 != 0)] = 0.25
        p[((xx - 32) / 4.5) ** 2 + ((yy - cy) / 4.0) ** 2 < 1] = 0.13
    return gris(p)


def tex_guante():
    # Puño oscuro: nudillos pintados, nada de dedos modelados.
    p = np.ones((16, 16)) * 0.15
    p[:6] = 0.2
    p[:, ::4] *= 0.5
    p[6] = 0.3
    return gris(p)


def tex_marinero(acento):
    # Cuello marinero: azul, doble raya blanca y estrellitas.
    h, w = 32, 32
    p = np.tile(acento, (h, w, 1))
    blanco = np.array([1.0, 1.0, 1.0])
    p[1:3, :] = blanco
    p[-3:-1, :] = blanco
    p[:, 1:3] = blanco
    p[:, -3:-1] = blanco
    for cx, cy in ((10, 10), (22, 10), (16, 19), (10, 25), (22, 25)):
        p[cy, cx - 2:cx + 3] = blanco
        p[cy - 2:cy + 3, cx] = blanco
    return p


# Ojos en pixel art, escritos a mano para que cada punto sea intencional. La figura de
# arriba es el ojo izquierdo de la pantalla; el otro se espeja. #: tinta, o: iris oscuro,
# O: iris claro, w: destello. Nada de esclerótica, pestañas sueltas ni cejas.
OJOS = {
    "dulce": [
        ".#######.",
        "#########",
        "###ooo###",
        "##ooooo##",
        "##ooooo##",
        "##oOOOo##",
        ".#oOOOo#.",
        ".##ooo##.",
        "..#####..",
    ],
    "felino": [
        "##.......",
        ".#######.",
        ".########",
        ".##oooo##",
        ".#ooooo##",
        ".#oOOOo#.",
        ".##OOO##.",
        "..#####..",
    ],
    "estrella": [
        "..#####..",
        ".#######.",
        "##oowoo##",
        "#ooowooo#",
        "#owwwwwo#",
        "#ooowooo#",
        "#oOOwOOo#",
        ".##OOO##.",
        "..#####..",
    ],
    "sueno": [
        "#########",
        "#########",
        ".###oo###",
        ".#ooooo##",
        ".#ooooo#.",
        ".#oOOOo#.",
        ".##OOO##.",
        "..#####..",
    ],
    "espiral": [
        ".#########.",
        "#.........#",
        "#.#######.#",
        "#.#.....#.#",
        "#.#.###.#.#",
        "#.#.#.#.#.#",
        "#.#.#...#.#",
        "#.#.#####.#",
        "#.#.......#",
        "#.#########",
        "...........",
    ],
}
PARPADEO = ["#.......#", ".#######."]
CONTENTA = ["..#####..", ".##...##.", "##.....##"]
BOCAS = {
    "punto": ["xx"],
    "suave": ["xxx"],
    "gatita": ["x.x", ".x."],
    "abierta": ["###", "#r#"],
    "feliz": ["####", "#rr#", ".##."],
}
CARA_S = 56  # píxeles por cuadro: la resolución real de la cara en las referencias
CARA_ALTO = 0.42  # unidades de mundo que abarca un cuadro


def tex_cara(f):
    """Tira de tres cuadros: abierta, parpadeo y contenta."""
    piel, ojos = rgb(f["piel"]), rgb(f["ojos"])
    tinta = np.array([0.1, 0.06, 0.14])
    tabla = {"#": tinta, "o": ojos * 0.62, "O": ojos, "w": np.array([1.0, 1.0, 1.0]), "x": piel * 0.55, "r": np.array([0.82, 0.32, 0.38])}
    S = CARA_S
    p = np.tile(piel, (S, S * 3, 1))
    fila_ojo = 37  # 0.68 de la cabeza
    fila_boca = 47  # 0.91 de la cabeza
    for c in range(3):
        o = c * S

        def poner(arte, cx, cy, espejo=False):
            alto, ancho = len(arte), len(arte[0])
            for y, linea in enumerate(arte):
                for x, ch in enumerate(linea[::-1] if espejo else linea):
                    if ch != ".":
                        p[cy - alto // 2 + y, o + cx - ancho // 2 + x] = tabla[ch]

        # Sombra del cuello: parche chico que usa la malla del cuello.
        p[0:2, o:o + 4] = piel * 0.84
        separa = 10
        for espejo, cx in ((False, S // 2 - separa), (True, S // 2 + separa - 1)):
            if c == 0:
                poner(OJOS[f["ojo"]], cx, fila_ojo, espejo)
                if f["ojo"] in ("dulce", "felino", "sueno"):
                    # Destello cuadrado siempre del mismo lado, como la luz de una sola fuente.
                    p[fila_ojo - 2:fila_ojo, o + cx - 2:o + cx] = (1, 1, 1)
                    p[fila_ojo + 2, o + cx + 2] = (1, 1, 1)
            elif c == 1:
                poner(PARPADEO, cx, fila_ojo + 1, espejo)
            else:
                poner(CONTENTA, cx, fila_ojo, espejo)
            if f.get("lentes"):
                # Armazón fino y oscuro, más bajo que el ojo, como lentes pintados en la piel.
                rim = rgb(f["acento"]) * 0.55
                x0, x1, y0, y1 = o + cx - 6, o + cx + 6, fila_ojo - 4, fila_ojo + 5
                p[y0, x0 + 1:x1] = rim
                p[y1, x0 + 1:x1] = rim
                p[y0 + 1:y1, x0] = rim
                p[y0 + 1:y1, x1] = rim
        if f.get("lentes"):
            p[fila_ojo - 2, o + S // 2 - 3:o + S // 2 + 3] = rgb(f["acento"]) * 0.55
        poner(BOCAS["feliz" if c == 2 else f["boca"]], S // 2, fila_boca)
    return p


def material(nombre, img, color=None):
    mat = bpy.data.materials.new(nombre)
    mat.use_nodes = True
    n = mat.node_tree
    bsdf = n.nodes["Principled BSDF"]
    tex = n.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"
    if color is not None:
        mix = n.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        c = lineal(np.array(color))
        mix.inputs["B"].default_value = (c[0], c[1], c[2], 1)
        n.links.new(tex.outputs["Color"], mix.inputs["A"])
        n.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    else:
        n.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Specular IOR Level"].default_value = 0.1
    return mat


# ------------------------------------------------------------------ malla
def spow(v, p):
    return math.copysign(abs(v) ** p, v)


def catmull(pts, n):
    P = [Vector(p) for p in pts]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    out = []
    tramos = len(P) - 3
    for i in range(n + 1):
        u = i / n * tramos
        k = min(int(u), tramos - 1)
        t = u - k
        a, b, c, d = P[k], P[k + 1], P[k + 2], P[k + 3]
        out.append(0.5 * ((2 * b) + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t))
    return out


class Malla:
    def __init__(self):
        self.v, self.f, self.uv, self.mat, self.pesos = [], [], [], [], []

    def _vert(self, p, uv, peso):
        self.v.append(tuple(p))
        self.uv.append(uv)
        self.pesos.append(peso)
        return len(self.v) - 1

    def tejer(self, anillos, mat, pesos, uvs, tapa_a=True, tapa_b=True):
        """anillos: listas de puntos del mismo largo (la última repite a la primera)."""
        base = len(self.v)
        n, m_ = len(anillos), len(anillos[0])
        for i in range(n):
            for j in range(m_):
                self._vert(anillos[i][j], uvs(i, j, n, m_), pesos[i])
        for i in range(n - 1):
            for j in range(m_ - 1):
                a = base + i * m_ + j
                self.f.append((a, a + 1, a + m_ + 1, a + m_))
                self.mat.append(mat)

        def tapa(i, inv):
            pts = anillos[i][:-1]
            c = sum((Vector(p) for p in pts), Vector()) / len(pts)
            ci = self._vert(c, uvs(i, 0, n, m_), pesos[i])
            o = base + i * m_
            for j in range(m_ - 1):
                t = (ci, o + j, o + j + 1)
                self.f.append(t[::-1] if inv else t)
                self.mat.append(mat)

        if tapa_a:
            tapa(0, True)
        if tapa_b:
            tapa(n - 1, False)

    def aros(self, aros, mat, huesos, seg=8, v=(1.0, 0.0), u_rep=1.0, pot=1.0, pliegues=0, amp=0.0, rot=None, tapa_a=True, tapa_b=True, pesos=None):
        """Anillos horizontales: (centro, rx, ry). huesos: nombre o par con mezcla."""
        anillos = []
        for c, rx, ry in aros:
            c = Vector(c)
            r = []
            for s in range(seg + 1):
                a = math.tau * s / seg
                k = 1 + (amp if pliegues and (s * pliegues * 2 // seg) % 2 else 0)
                q = Vector((spow(math.sin(a), pot) * rx * k, spow(math.cos(a), pot) * ry * k, 0))
                if rot:
                    q = rot @ q
                r.append(c + q)
            anillos.append(r)
        n = len(aros)
        par = (huesos, huesos) if isinstance(huesos, str) else huesos
        ts = pesos or [i / max(1, n - 1) for i in range(n)]
        ps = [((par[0], 1 - t), (par[1], t)) if par[0] != par[1] else ((par[0], 1.0),) for t in ts]
        self.tejer(anillos, mat, ps, lambda i, j, nn, mm: (j / (mm - 1) * u_rep, v[0] + (v[1] - v[0]) * i / max(1, nn - 1)), tapa_a, tapa_b)

    def tubo(self, pts, radios, mat, huesos, ts=None, seg=6, v=(1.0, 0.0), u_rep=1.0, ref=(0, -1, 0), tapas=(True, True)):
        """Tubo por una línea; ref orienta el radio 'b' (grosor) de cada anillo."""
        P = [Vector(p) for p in pts]
        n = len(P)
        anillos = []
        for i in range(n):
            tg = (P[min(i + 1, n - 1)] - P[max(i - 1, 0)]).normalized()
            rr = ref(P[i]) if callable(ref) else Vector(ref)
            w = tg.cross(rr)
            w = w.normalized() if w.length > 1e-4 else tg.orthogonal().normalized()
            b = w.cross(tg).normalized()
            rx, rz = radios[i] if isinstance(radios[i], (tuple, list)) else (radios[i], radios[i])
            anillos.append([P[i] + w * math.sin(math.tau * s / seg) * rx + b * math.cos(math.tau * s / seg) * rz for s in range(seg + 1)])
        par = (huesos, huesos) if isinstance(huesos, str) else huesos
        ts = ts or [i / max(1, n - 1) for i in range(n)]
        ps = [((par[0], 1 - t), (par[1], t)) if par[0] != par[1] else ((par[0], 1.0),) for t in ts]
        self.tejer(anillos, mat, ps, lambda i, j, nn, mm: (j / (mm - 1) * u_rep, v[0] + (v[1] - v[0]) * i / max(1, nn - 1)), tapas[0], tapas[1])

    def mecha(self, pts, ancho, mat="pelo", huesos="cabeza", grosor=0.38, n=4, perfil=(0.6, 1.0, 0.92, 0.55, 0.02)):
        """Mechón en cuña: sección de rombo (4 lados), arista dura y punta afilada."""
        P = catmull(pts, n)
        radios = []
        for i in range(n + 1):
            t = i / n * (len(perfil) - 1)
            k = min(int(t), len(perfil) - 2)
            r = ancho * (perfil[k] + (perfil[k + 1] - perfil[k]) * (t - k))
            radios.append((max(r, 0.002), max(r, 0.002) * grosor))
        self.tubo(P, radios, mat, huesos, seg=4, v=(0.99, 0.01), ref=lambda p: (p - Vector((0, 0, CZ))).normalized(), tapas=(False, False))

    def caja(self, c, t, mat, hueso, uv=(0.02, 0.5), rot=None):
        base = len(self.v)
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    p = Vector((sx * t[0] / 2, sy * t[1] / 2, sz * t[2] / 2))
                    if rot:
                        p = rot @ p
                    self._vert(Vector(c) + p, uv, ((hueso, 1.0),))
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.f.append(tuple(base + i for i in q))
            self.mat.append(mat)

    def plana(self, pts, normal, grosor, mat, hueso, uv=(0.02, 0.5), uvs=None):
        """Silueta extruida: alas, guitarra, estrellas, moños. uvs: una por punto."""
        base = len(self.v)
        n = len(pts)
        d = Vector(normal).normalized() * grosor / 2
        for s in (-1, 1):
            for i, p in enumerate(pts):
                self._vert(Vector(p) + d * s, uvs[i] if uvs else uv, ((hueso, 1.0),))
        self.f.append(tuple(base + i for i in range(n)))
        self.mat.append(mat)
        self.f.append(tuple(base + n + i for i in range(n - 1, -1, -1)))
        self.mat.append(mat)
        for i in range(n):
            j = (i + 1) % n
            self.f.append((base + i, base + n + i, base + n + j, base + j))
            self.mat.append(mat)


# ------------------------------------------------------------------ cuerpo
CZ = 1.175  # centro de la cabeza
HUESOS = {
    "raiz": ((0, 0, 0), (0, 0, 0.12), None),
    "cadera": ((0, 0, 0.66), (0, 0, 0.74), "raiz"),
    "pecho": ((0, 0, 0.74), (0, 0, 0.93), "cadera"),
    "cabeza": ((0, 0, 0.965), (0, 0, 1.35), "pecho"),
    "brazo.L": ((0.1, 0, 0.925), (0.165, 0, 0.8), "pecho"),
    "ante.L": ((0.165, 0, 0.8), (0.215, 0, 0.68), "brazo.L"),
    "mano.L": ((0.215, 0, 0.68), (0.24, 0, 0.62), "ante.L"),
    "brazo.R": ((-0.1, 0, 0.925), (-0.165, 0, 0.8), "pecho"),
    "ante.R": ((-0.165, 0, 0.8), (-0.215, 0, 0.68), "brazo.R"),
    "mano.R": ((-0.215, 0, 0.68), (-0.24, 0, 0.62), "ante.R"),
    "muslo.L": ((0.058, 0, 0.66), (0.09, 0, 0.46), "cadera"),
    "pierna.L": ((0.09, 0, 0.46), (0.118, 0.01, 0.17), "muslo.L"),
    "muslo.R": ((-0.058, 0, 0.66), (-0.09, 0, 0.46), "cadera"),
    "pierna.R": ((-0.09, 0, 0.46), (-0.118, 0.01, 0.17), "muslo.R"),
    "pelo.L": ((0.14, 0.03, 1.33), (0.27, 0.06, 1.06), "cabeza"),
    "pelo.R": ((-0.14, 0.03, 1.33), (-0.27, 0.06, 1.06), "cabeza"),
    "pelo.B": ((0, 0.14, 1.2), (0, 0.18, 0.86), "cabeza"),
}


def forma_cabeza(d, extra=0.0):
    """Dirección unitaria -> punto: más alta que ancha, cara plana y barbilla en U."""
    x, y, z = d
    Rx, Ry, Rz = 0.172 + extra, 0.168 + extra, 0.185 + extra
    k = 1.0
    if z < 0:
        k = 1 - 0.42 * (-z) ** 2.4
    fy = 0.8 if y < 0 else 1.05
    zz = z * Rz * (0.98 if z < 0 else 1.0)
    return Vector((x * Rx * k, y * Ry * fy * (k * 0.5 + 0.5), CZ + zz))


def direccion(az, pol):
    a, p = math.radians(az), math.radians(pol)
    return Vector((math.sin(p) * math.sin(a), -math.sin(p) * math.cos(a), math.cos(p)))


def sobre(az, pol, lift=0.014):
    return forma_cabeza(direccion(az, pol), lift)


def uv_cara(p):
    """Proyección plana sobre el primer cuadro; atrás cae a la orilla, que es solo piel."""
    v = 0.5 + (p.z - CZ) / CARA_ALTO
    if p.y > 0.03:
        return ((0.03 if p.x < 0 else 0.97) / 3, v)
    return ((0.5 + p.x / CARA_ALTO) / 3, v)


def cabeza(m):
    base = len(m.v)
    fil, col = 8, 12
    for j in range(fil + 1):
        pol = 180 * j / fil
        for i in range(col + 1):
            p = forma_cabeza(direccion(360 * i / col, pol))
            m._vert(p, uv_cara(p), (("cabeza", 1.0),))
    for j in range(fil):
        for i in range(col):
            a = base + j * (col + 1) + i
            m.f.append((a, a + 1, a + col + 2, a + col + 1))
            m.mat.append("cara")
    # Cuello fino con la sombra pintada de la barbilla.
    sombra = (0.6 / CARA_S / 3, 1 - 1 / CARA_S)
    b = len(m.v)
    m.aros([((0, 0.005, 0.945), 0.024, 0.024), ((0, 0.005, 1.01), 0.024, 0.024)], "cara", ("pecho", "cabeza"), seg=6, pesos=[0, 1])
    for k in range(b, len(m.v)):
        m.uv[k] = sombra


def casco(m, hasta=150, frente=0.05):
    """Gorro de pelo: deja libre la cara; los mechones tapan el borde."""
    base = len(m.v)
    fil, col = 6, 12
    for j in range(fil + 1):
        pol = hasta * j / fil
        for i in range(col + 1):
            p = forma_cabeza(direccion(360 * i / col, pol), 0.01)
            m._vert(p, (i / col * 4, 0.98 - 0.72 * j / fil), (("cabeza", 1.0),))
    for j in range(fil):
        for i in range(col):
            a = base + j * (col + 1) + i
            q = (a, a + 1, a + col + 2, a + col + 1)
            cy = sum(m.v[k][1] for k in q) / 4
            cz = sum(m.v[k][2] for k in q) / 4 - CZ
            if cy < 0.03 and cz < frente:
                continue
            m.f.append(q)
            m.mat.append("pelo")


def bota(m, f, s, lado):
    # Bota enorme y redonda: es lo primero que se lee de la silueta en las referencias.
    hueso = f"pierna.{lado}"
    Ax, Ay = s * 0.118, 0.012
    giro = Euler((0, 0, s * 0.16)).to_matrix()

    def llevar(p):
        return Vector((Ax, Ay, 0)) + giro @ Vector(p)

    # Estaciones de talón a puntera: (y, medio ancho, alto, piso)
    est = [(0.112, 0.05, 0.13, 0.05), (0.09, 0.098, 0.205, 0.04), (0.0, 0.114, 0.245, 0.04), (-0.09, 0.124, 0.205, 0.04), (-0.19, 0.128, 0.168, 0.04), (-0.252, 0.098, 0.135, 0.05), (-0.28, 0.04, 0.1, 0.07)]
    seg = 10
    anillos, uvplano = [], []
    for y, hw, top, piso in est:
        r, uv = [], []
        for k in range(seg + 1):
            a = math.tau * k / seg
            sx, sz = spow(math.sin(a), 0.6), spow(math.cos(a), 0.6)
            r.append(llevar((sx * hw, y, piso + (top - piso) * (0.5 + 0.5 * sz))))
            uv.append((0.5 + sx * hw / 0.3, 0.5 + (y + 0.085) / 0.42))
        anillos.append(r)
        uvplano.append(uv)
    m.tejer(anillos, "botas", [((hueso, 1.0),)] * len(est), lambda i, j, n, mm: uvplano[i][j])
    # Suela gruesa de plataforma.
    anillos = []
    for z, g_ in ((0.0, 1.0), (0.05, 1.03)):
        r = []
        for k in range(seg + 1):
            a = math.tau * k / seg
            y = -0.085 + spow(math.cos(a), 0.7) * -0.208 * g_
            hw = 0.106 + 0.03 * max(0, (-y - 0.02) / 0.25)
            r.append(llevar((spow(math.sin(a), 0.7) * hw * g_, y, z)))
        anillos.append(r)
    m.tejer(anillos, "suela", [((hueso, 1.0),)] * 2, lambda i, j, n, mm: (0.5, 0.5))
    # Caña con vuelta y correa de velcro con placa.
    C = (0, 0.03)
    m.aros([(llevar((C[0], C[1], 0.2)), 0.086, 0.086), (llevar((C[0], C[1], 0.285)), 0.078, 0.078), (llevar((C[0], C[1], 0.295)), 0.09, 0.09), (llevar((C[0], C[1], 0.335)), 0.092, 0.092), (llevar((C[0], C[1], 0.338)), 0.05, 0.05)], "botas", hueso, seg=8, v=(0.97, 0.97))
    z = 0.255
    m.aros([(llevar((C[0], C[1], z - 0.02)), 0.09, 0.09), (llevar((C[0], C[1], z + 0.02)), 0.084, 0.084)], "negro", hueso, seg=8, v=(0.5, 0.5))
    m.caja(llevar((s * 0.015, C[1] - 0.088, z)), (0.075, 0.016, 0.044), "metal", hueso, rot=giro)


def pierna(m, f, s, lado):
    # Pantorrilla corta y medias a rayas gruesas hasta perderse bajo la falda.
    m.tubo(
        [(s * 0.058, 0, 0.66), (s * 0.08, 0, 0.53), (s * 0.095, 0, 0.44), (s * 0.108, 0.006, 0.35), (s * 0.116, 0.012, 0.27)],
        [0.05, 0.05, 0.046, 0.045, 0.042],
        "rayas", (f"muslo.{lado}", f"pierna.{lado}"), ts=[0, 0, 0.5, 1, 1], seg=6, v=(0.0, 5.0), ref=(0, -1, 0),
    )
    bota(m, f, s, lado)


def mano(m, s, lado, mat="guante"):
    # Puño grande de caricatura: un bloque redondeado con pulgar; el resto va pintado.
    H = f"mano.{lado}"
    w = Vector(HUESOS[H][0])
    d = (Vector(HUESOS[H][1]) - w).normalized()
    m.tubo([w - d * 0.01, w + d * 0.018, w + d * 0.055, w + d * 0.09, w + d * 0.108], [(0.03, 0.028), (0.054, 0.046), (0.062, 0.052), (0.056, 0.048), (0.024, 0.022)], mat, H, seg=6, v=(0.9, 0.1), u_rep=1.0)
    lat = Vector((0, 1, 0)).cross(d).normalized()
    t = w + d * 0.05 + Vector((0, -0.045, 0)) - lat * s * 0.035
    m.tubo([t - d * 0.03, t, t + d * 0.03], [0.018, 0.022, 0.012], mat, H, seg=4, v=(0.5, 0.5))


def brazo(m, f, s, lado, manga, radios=(0.036, 0.034, 0.033, 0.032, 0.031)):
    S, E, W = Vector(HUESOS[f"brazo.{lado}"][0]), Vector(HUESOS[f"brazo.{lado}"][1]), Vector(HUESOS[f"ante.{lado}"][1])
    pts = [S, S.lerp(E, 0.5), E, E.lerp(W, 0.5), W]
    m.tubo(pts, list(radios), manga, (f"brazo.{lado}", f"ante.{lado}"), ts=[0, 0, 0.5, 1, 1], seg=6, v=(0.0, 3.0) if manga == "rayas" else (0.98, 0.3), ref=(0, 1, 0))
    d = (W - E).normalized()
    m.tubo([W - d * 0.03, W + d * 0.008], [radios[-1] * 1.4, radios[-1] * 1.55], "tela2", f"ante.{lado}", seg=6, v=(0.5, 0.5))
    mano(m, s, lado)


def torso(m, f, mat="ropa", ancho=1.0):
    m.aros(
        [((0, 0, 0.64), 0.085 * ancho, 0.066 * ancho), ((0, 0, 0.7), 0.08 * ancho, 0.06 * ancho), ((0, 0, 0.76), 0.066 * ancho, 0.05 * ancho), ((0, 0, 0.84), 0.072 * ancho, 0.052 * ancho), ((0, 0, 0.915), 0.098 * ancho, 0.058 * ancho), ((0, 0, 0.948), 0.062, 0.044), ((0, 0, 0.962), 0.028, 0.028)],
        mat, ("cadera", "pecho"), seg=8, v=(0.98, 0.3), pesos=[0, 0, 0.4, 1, 1, 1, 1],
    )


def falda(m, mat="cuadros", largo=0.585, vuelo=0.17, pliegues=6):
    m.aros(
        [((0, 0, 0.752), 0.07, 0.054), ((0, 0, 0.705), 0.1, 0.078), ((0, 0, largo), vuelo, vuelo * 0.86)],
        mat, "cadera", seg=pliegues * 2, u_rep=2, v=(1.0, 0.25), pliegues=pliegues, amp=0.08, tapa_b=False, tapa_a=False,
    )
    # Short interior: siempre cubiertas, se vea desde donde se vea.
    m.aros([((0, 0, 0.66), 0.088, 0.07), ((0, 0, 0.565), 0.105, 0.082)], "negro", "cadera", seg=8, v=(0.5, 0.5))


def cinturon(m, z=0.748, r=(0.074, 0.058)):
    m.aros([((0, 0, z - 0.012), r[0], r[1]), ((0, 0, z + 0.012), r[0] * 0.98, r[1] * 0.98)], "negro", "cadera", seg=8, v=(0.5, 0.5))
    m.caja((0, -r[1] - 0.003, z), (0.032, 0.01, 0.032), "metal", "cadera")


def corbata(m, z0=0.935, z1=0.81, mat="acento"):
    m.plana([(-0.014, -0.06, z0), (0.014, -0.06, z0), (0.024, -0.064, z1 + 0.02), (0, -0.064, z1), (-0.024, -0.064, z1 + 0.02)], (0, 1, 0), 0.006, mat, "pecho", uv=(0.5, 0.5))


def estrella(cx, y, cz, r, puntas=5, adentro=0.42, rot=90):
    pts = []
    for i in range(puntas * 2):
        a = math.radians(rot) + i * math.pi / puntas
        rr = r if i % 2 == 0 else r * adentro
        pts.append((cx + math.cos(a) * rr, y, cz + math.sin(a) * rr))
    return pts


def mono(m, c, tam, mat="acento", hueso="cabeza", normal=(0, 1, 0)):
    """Moño de dos lazos: silueta simple que se lee a cualquier distancia."""
    cx, cy, cz = c
    for s in (-1, 1):
        m.plana([(cx, cy, cz + tam * 0.18), (cx + s * tam, cy, cz + tam * 0.62), (cx + s * tam * 1.12, cy, cz), (cx + s * tam, cy, cz - tam * 0.62), (cx, cy, cz - tam * 0.18)], normal, tam * 0.3, mat, hueso, uv=(0.5, 0.3))


def alas(m, escala=1.0, mat="tela2", z=0.9, y=0.07, plumas=3):
    for s in (-1, 1):
        for k in range(plumas):
            t = k / max(1, plumas - 1)
            x = (0.28 - 0.07 * t) * escala
            zz = z + (0.12 - 0.19 * t) * escala
            m.plana(
                [(s * 0.04, y, z), (s * x * 0.55, y + 0.02, zz + 0.05 * escala), (s * x, y + 0.04 + k * 0.006, zz), (s * 0.06, y, z - 0.05)],
                (0, 1, 0), 0.012, mat, "pecho", uv=(0.5, 0.25),
            )


# ------------------------------------------------------------------ peinados
def fleco(m, tiras, mat="pelo", grosor=0.34):
    """Mechones anchos que nacen en la coronilla y terminan en punta sobre los ojos."""
    for az, pol, ancho, desv in tiras:
        m.mecha([sobre(az * 0.25, 8), sobre(az * 0.7, pol * 0.5, 0.018), sobre(az, pol * 0.82, 0.022), sobre(az + desv, pol, 0.026)], ancho, mat, grosor=grosor, perfil=(0.5, 0.95, 1.0, 0.62, 0.02))


def patilla(m, s, largo=0.2, ancho=0.042, mat="pelo", az=64):
    """Mechón largo que enmarca la cara: tapa la mejilla y deja visible solo el 62 %."""
    m.mecha([sobre(s * az * 0.7, 18), sobre(s * az, 62, 0.02), (s * 0.147, -0.082, CZ - 0.06), (s * 0.128, -0.094, CZ - largo)], ancho, mat, grosor=0.38, perfil=(0.8, 1.0, 1.0, 0.75, 0.02))


def faldon(m, desde=62, hasta=298, n=8, pol=112, ancho=0.075, afuera=0.0, mat="pelo"):
    """Dobladillo en zigzag alrededor de la cabeza."""
    for i in range(n):
        az = desde + (hasta - desde) * i / (n - 1)
        punta = sobre(az, pol + (6 if i % 2 else -4), 0.03 + afuera)
        m.mecha([sobre(az, 30), sobre(az, pol * 0.62, 0.018), sobre(az, pol * 0.86, 0.022 + afuera * 0.4), punta], ancho, mat, grosor=0.36, perfil=(0.7, 1.0, 1.0, 0.7, 0.02))


def mono_de_puntas(m, s, lado, puntas, mat="pelo"):
    """Moñito alto de cuñas planas: la silueta de la referencia, sin peso de geometría."""
    Z = CZ
    H = ("cabeza", f"pelo.{lado}")
    ata = Vector((s * 0.115, 0.02, Z + 0.155))
    for tx, ty, tz, an in puntas:
        fin = Vector((s * tx, ty, Z + tz))
        med = ata.lerp(fin, 0.5) + Vector((s * 0.02, 0, 0.022))
        m.mecha([ata, med, fin], an, mat, H, grosor=0.42, n=3, perfil=(0.5, 1.0, 0.7, 0.02))
    m.aros([(ata + Vector((0, 0, -0.012)), 0.024, 0.024), (ata + Vector((0, 0, 0.012)), 0.024, 0.024)], "acento", "cabeza", seg=6, v=(0.5, 0.5))


def pelo_ambar(m, f):
    casco(m)
    fleco(m, [(-46, 88, 0.056, -6), (-22, 82, 0.062, -2), (2, 80, 0.06, 4), (26, 84, 0.062, 4), (48, 90, 0.056, 6)])
    faldon(m, n=7, pol=118, ancho=0.08)
    for s in (-1, 1):
        patilla(m, s, 0.24, 0.046)
    # Melena larga en grandes cuñas onduladas.
    for i, (x, largo, fase) in enumerate(((-0.15, 0.42, 0), (-0.08, 0.54, 1), (0.0, 0.58, 2), (0.08, 0.54, 3), (0.15, 0.42, 4))):
        y = 0.1 - abs(x) * 0.25
        pts = []
        for k in range(5):
            t = k / 4
            sway = math.sin(t * 6.5 + fase) * 0.024 * t + x * t * 0.3
            pts.append((x + sway, y + 0.03 + t * 0.03, CZ + 0.04 - largo * t))
        m.mecha(pts, 0.082, "pelo2" if i in (1, 3) else "pelo", ("cabeza", "pelo.B"), grosor=0.42, n=5, perfil=(0.8, 1.0, 1.0, 0.85, 0.5, 0.02))
    mono(m, tuple(sobre(40, 30, 0.03)), 0.058, normal=(0.4, -0.8, 0.4))


def pelo_menta(m, f):
    casco(m)
    # Fleco de lado, travieso.
    fleco(m, [(-50, 92, 0.052, 4), (-28, 86, 0.062, 10), (-6, 82, 0.064, 14), (18, 80, 0.06, 18), (42, 86, 0.052, 10)])
    faldon(m, n=7, ancho=0.08)
    # Bob con puntas hacia afuera y mechas de color.
    for s in (-1, 1):
        for az, largo, mat in ((72, 0.17, "pelo"), (100, 0.19, "pelo2"), (130, 0.17, "pelo"), (158, 0.15, "pelo")):
            a = sobre(s * az, 88, 0.026)
            sal = (a - Vector((0, 0, a.z))).normalized()
            m.mecha([sobre(s * az * 0.8, 30), a, a + Vector((0, 0, -largo * 0.6)) + sal * 0.01, a + Vector((0, 0, -largo)) + sal * 0.06], 0.07, mat, grosor=0.4, perfil=(0.8, 1.0, 1.0, 0.7, 0.02))


def pelo_lira(m, f):
    casco(m)
    fleco(m, [(-44, 88, 0.052, -5), (-20, 82, 0.052, -2), (2, 80, 0.05, 0), (24, 82, 0.052, 2), (46, 88, 0.052, 5)])
    faldon(m, n=7, ancho=0.074)
    for s in (-1, 1):
        patilla(m, s, 0.17, 0.036)
    # Coletas gemelas altas: suben, abren y caen con punta rebelde.
    Z = CZ
    for s, lado in ((1, "L"), (-1, "R")):
        H = ("cabeza", f"pelo.{lado}")
        ata = Vector((s * 0.125, 0.04, Z + 0.135))
        m.mecha([ata, (s * 0.25, 0.05, Z + 0.2), (s * 0.34, 0.07, Z + 0.08), (s * 0.36, 0.09, Z - 0.13), (s * 0.31, 0.1, Z - 0.34)], 0.092, "pelo", H, grosor=0.5, n=6, perfil=(0.45, 1.0, 1.0, 0.85, 0.5, 0.02))
        m.mecha([ata, (s * 0.23, 0.0, Z + 0.15), (s * 0.3, -0.01, Z + 0.0), (s * 0.3, 0.01, Z - 0.19)], 0.068, "pelo2", H, grosor=0.5, n=5, perfil=(0.45, 1.0, 0.95, 0.7, 0.02))
        m.plana(estrella(s * 0.13, -0.012, Z + 0.135, 0.046), (0, 1, 0), 0.024, "acento", "cabeza", uv=(0.5, 0.5))


def pelo_marina(m, f):
    casco(m)
    # Como la referencia: fleco radial de seis cuñas, patillas, moñitos en punta y audífonos.
    fleco(m, [(-52, 92, 0.058, -4), (-31, 86, 0.066, -3), (-10, 82, 0.066, -1), (11, 82, 0.066, 1), (32, 86, 0.066, 3), (53, 92, 0.058, 4)])
    faldon(m, n=7, pol=108, ancho=0.08)
    for s, lado in ((1, "L"), (-1, "R")):
        patilla(m, s, 0.235, 0.044)
        mono_de_puntas(m, s, lado, [(0.31, 0.03, 0.31, 0.06), (0.345, 0.05, 0.17, 0.066), (0.3, 0.07, 0.02, 0.058), (0.205, 0.0, 0.335, 0.044)])
    Z = CZ - 0.01
    rot = Euler((0, math.pi / 2, 0)).to_matrix()
    for s in (-1, 1):
        m.aros([((s * 0.16, 0.0, Z), 0.066, 0.066), ((s * 0.198, 0.0, Z), 0.06, 0.06)], "negro", "cabeza", rot=rot, seg=8, v=(0.5, 0.5))
        m.aros([((s * 0.2, 0.0, Z), 0.04, 0.04), ((s * 0.205, 0.0, Z), 0.04, 0.04)], "metal", "cabeza", rot=rot, seg=8, v=(0.5, 0.5))


def pelo_jugador(m, f):
    casco(m)
    # Melena de hongo: fleco largo y dobladillo en zigzag alrededor, bajo la gorra.
    fleco(m, [(-50, 92, 0.06, -4), (-27, 87, 0.066, -2), (-3, 84, 0.066, 2), (21, 86, 0.066, 4), (46, 91, 0.06, 6)])
    faldon(m, desde=58, hasta=302, n=10, pol=122, ancho=0.08, afuera=0.018)
    for s in (-1, 1):
        patilla(m, s, 0.2, 0.046)


# ------------------------------------------------------------------ atuendos
def libro(m, lado):
    H = f"mano.{lado}"
    w = Vector(HUESOS[H][0])
    c = w + Vector((-0.045, -0.05, 0.03))
    for s in (-1, 1):
        rot = Euler((0.45, 0, s * 0.24)).to_matrix()
        m.caja(c + Vector((s * 0.06, 0, 0)), (0.11, 0.014, 0.15), "acento", H, rot=rot, uv=(0.5, 0.5))
        m.caja(c + Vector((s * 0.058, -0.009, 0.0)), (0.098, 0.01, 0.132), "tela2", H, rot=rot, uv=(0.5, 0.2))


def atuendo_ambar(m, f):
    # Chaleco sobre camisa, falda larga plisada y corbata.
    torso(m, f)
    corbata(m)
    falda(m, largo=0.5, vuelo=0.19, pliegues=7)
    cinturon(m)
    for s, lado in ((1, "L"), (-1, "R")):
        brazo(m, f, s, lado, "tela2", radios=(0.04, 0.038, 0.037, 0.04, 0.042))
    libro(m, "L")


def atuendo_menta(m, f):
    # Sudadera enorme: la silueta redonda es su personalidad.
    torso(m, f, ancho=1.22)
    m.aros([((0, 0, 0.64), 0.112, 0.088), ((0, 0, 0.595), 0.116, 0.092), ((0, 0, 0.575), 0.102, 0.08)], "acento", "cadera", seg=8, v=(0.5, 0.5))
    m.plana([(-0.06, -0.082, 0.7), (0.06, -0.082, 0.7), (0.082, -0.09, 0.625), (-0.082, -0.09, 0.625)], (0, 1, 0), 0.01, "acento", "cadera", uv=(0.5, 0.5))
    m.aros([((0, 0.025, 0.95), 0.08, 0.06), ((0, 0.05, 0.975), 0.09, 0.07), ((0, 0.065, 0.91), 0.074, 0.058)], "ropa", "pecho", seg=8, v=(0.9, 0.4))
    for s, lado in ((1, "L"), (-1, "R")):
        m.aros([((s * 0.06, 0, 0.63), 0.066, 0.066), ((s * 0.078, 0, 0.53), 0.064, 0.064)], "acento", f"muslo.{lado}", seg=6, v=(0.8, 0.5))
        brazo(m, f, s, lado, "ropa", radios=(0.05, 0.052, 0.052, 0.056, 0.054))
    # Audífonos con orejas de gato.
    Z = CZ - 0.005
    rot = Euler((0, math.pi / 2, 0)).to_matrix()
    for s in (-1, 1):
        m.aros([((s * 0.165, 0, Z), 0.064, 0.064), ((s * 0.2, 0, Z), 0.058, 0.058)], "negro", "cabeza", rot=rot, seg=8, v=(0.5, 0.5))
        m.aros([((s * 0.202, 0, Z), 0.038, 0.038), ((s * 0.208, 0, Z), 0.038, 0.038)], "brillo", "cabeza", rot=rot, seg=8, v=(0.5, 0.5))
        m.plana([(s * 0.075, 0.0, Z + 0.175), (s * 0.15, 0.0, Z + 0.14), (s * 0.175, 0.0, Z + 0.29)], (0, 1, 0), 0.044, "negro", "cabeza", uv=(0.5, 0.5))
        m.plana([(s * 0.097, -0.026, Z + 0.178), (s * 0.145, -0.026, Z + 0.158), (s * 0.161, -0.026, Z + 0.25)], (0, 1, 0), 0.008, "brillo", "cabeza", uv=(0.5, 0.5))
    arco = [(math.cos(math.pi * i / 6) * 0.172, 0.0, Z + math.sin(math.pi * i / 6) * 0.2) for i in range(7)]
    m.tubo(arco, [(0.018, 0.01)] * 7, "negro", "cabeza", seg=4, ref=(0, 1, 0))
    # Tableta.
    w = Vector(HUESOS["mano.L"][0]) + Vector((-0.02, -0.07, 0.07))
    m.caja(w, (0.16, 0.014, 0.115), "negro", "mano.L", rot=Euler((-0.3, 0, 0)).to_matrix(), uv=(0.5, 0.5))
    m.plana(estrella(w.x, w.y - 0.016, w.z, 0.028, 4, 0.3), (0, 1, 0), 0.005, "brillo", "mano.L", uv=(0.5, 0.5))


def atuendo_lira(m, f):
    # Vestido de dos pisos con olanes, moño al pecho y alas.
    torso(m, f)
    m.aros([((0, 0, 0.76), 0.07, 0.054), ((0, 0, 0.68), 0.105, 0.085), ((0, 0, 0.6), 0.165, 0.14), ((0, 0, 0.54), 0.195, 0.17)], "ropa", "cadera", seg=12, v=(0.95, 0.35), pliegues=6, amp=0.07, tapa_a=False, tapa_b=False)
    m.aros([((0, 0, 0.56), 0.2, 0.175), ((0, 0, 0.49), 0.232, 0.205)], "tela2", "cadera", seg=14, v=(0.9, 0.3), pliegues=7, amp=0.09, tapa_a=False, tapa_b=False)
    m.aros([((0, 0, 0.66), 0.088, 0.07), ((0, 0, 0.53), 0.105, 0.082)], "negro", "cadera", seg=8, v=(0.5, 0.5))
    cinturon(m, 0.755, (0.072, 0.056))
    mono(m, (0, -0.066, 0.875), 0.044)
    for s, lado in ((1, "L"), (-1, "R")):
        brazo(m, f, s, lado, "tela2")
        S = Vector(HUESOS[f"brazo.{lado}"][0])
        d = (Vector(HUESOS[f"brazo.{lado}"][1]) - S).normalized()
        m.tubo([S - d * 0.01, S + d * 0.035, S + d * 0.08, S + d * 0.1], [0.038, 0.062, 0.056, 0.036], "ropa", f"brazo.{lado}", seg=6, v=(0.95, 0.4))
    alas(m, 0.95)
    # Varita en la mano derecha.
    w = Vector(HUESOS["mano.R"][0]) + Vector((-0.02, -0.03, 0.04))
    m.tubo([w + Vector((0, 0, -0.1)), w + Vector((0, 0, 0.26))], [0.011, 0.011], "tela2", "mano.R", seg=4)
    m.plana(estrella(w.x, w.y, w.z + 0.34, 0.1), (0, 1, 0), 0.034, "acento", "mano.R", uv=(0.5, 0.5))


GUITARRA_O = Vector((-0.06, -0.125, 0.72))
GUITARRA_E = Vector((0.82, 0, 0.57)).normalized()
GUITARRA_P = Vector((-0.57, 0, 0.82)).normalized()


def g(a, p, dy=0.0):
    return GUITARRA_O + GUITARRA_E * a + GUITARRA_P * p + Vector((0, dy, 0))


def atuendo_marina(m, f):
    # Playera de banda, falda de cuadros, calentadores, hombreras con púas y guitarra.
    torso(m, f)
    falda(m)
    cinturon(m)
    # Gargantilla con cruz de bisutería.
    m.aros([((0, 0.005, 0.975), 0.03, 0.03), ((0, 0.005, 0.99), 0.03, 0.03)], "negro", "cabeza", seg=6, v=(0.5, 0.5))
    m.caja((0, -0.056, 0.895), (0.01, 0.006, 0.05), "metal", "pecho")
    m.caja((0, -0.056, 0.905), (0.03, 0.006, 0.01), "metal", "pecho")
    for s, lado in ((1, "L"), (-1, "R")):
        brazo(m, f, s, lado, "rayas", radios=(0.034, 0.034, 0.034, 0.036, 0.038))
        S = Vector(HUESOS[f"brazo.{lado}"][0])
        m.aros([(S + Vector((s * 0.008, 0, 0.012)), 0.048, 0.048), (S + Vector((s * 0.022, 0, -0.03)), 0.052, 0.052)], "ropa", f"brazo.{lado}", seg=6, v=(0.7, 0.5))
        # Púas en el hombro: aristas claras detrás de la silueta.
        for dx, dz, dy in ((0.17, 0.1, 0.05), (0.19, 0.02, 0.04), (0.14, 0.16, 0.06)):
            m.plana([S + Vector((0, 0.01, 0.028)), S + Vector((s * dx, dy, dz)), S + Vector((s * 0.018, 0.01, -0.03))], (0, 1, 0), 0.014, "tela2", "pecho", uv=(0.5, 0.2))
    # Guitarra angular propia: cuerpo en V, mástil y cabezal; dos manos la sostienen.
    cuerpo = [g(0.03, 0.05), g(-0.08, 0.14), g(-0.32, 0.2), g(-0.15, 0.058), g(-0.18, 0.0), g(-0.15, -0.058), g(-0.32, -0.2), g(-0.08, -0.14), g(0.03, -0.05)]
    m.plana(cuerpo, (0, 1, 0), 0.044, "guitarra", "pecho", uv=(0.5, 0.2))
    for a in (-0.09, -0.03):
        m.plana([g(a, 0.04, -0.026), g(a + 0.035, 0.04, -0.026), g(a + 0.035, -0.04, -0.026), g(a, -0.04, -0.026)], (0, 1, 0), 0.007, "metal", "pecho", uv=(0.5, 0.5))
    m.plana([g(0.03, 0.018, -0.012), g(0.44, 0.016, -0.012), g(0.44, -0.016, -0.012), g(0.03, -0.018, -0.012)], (0, 1, 0), 0.022, "negro", "pecho", uv=(0.5, 0.5))
    m.plana([g(0.43, 0.024), g(0.58, 0.07), g(0.61, 0.03), g(0.53, -0.015), g(0.43, -0.024)], (0, 1, 0), 0.024, "guitarra", "pecho", uv=(0.5, 0.2))
    # Correa por encima del hombro.
    m.tubo([g(-0.18, 0.0, 0.03), (-0.11, 0.065, 0.78), (0.09, 0.066, 0.95), (0.08, -0.04, 0.955), g(0.41, 0.0, 0.02)], [(0.015, 0.004)] * 5, "negro", "pecho", seg=4)


def atuendo_jugador(m, f):
    # Uniforme marinero blanco, cuello azul con estrellas, pañuelo, gorra y mochila con bocina.
    torso(m, f)
    m.aros([((0, 0, 0.66), 0.094, 0.074), ((0, 0, 0.59), 0.114, 0.09)], "ropa", "cadera", seg=8, v=(0.9, 0.2))
    m.aros([((0, 0, 0.6), 0.117, 0.093), ((0, 0, 0.578), 0.119, 0.094)], "acento", "cadera", seg=8, v=(0.5, 0.5))
    for s, lado in ((1, "L"), (-1, "R")):
        m.aros([((s * 0.06, 0, 0.62), 0.064, 0.064), ((s * 0.08, 0, 0.5), 0.066, 0.066)], "ropa", f"muslo.{lado}", seg=6, v=(0.8, 0.2))
        m.aros([((s * 0.08, 0, 0.51), 0.068, 0.068), ((s * 0.081, 0, 0.495), 0.068, 0.068)], "acento", f"muslo.{lado}", seg=6, v=(0.5, 0.5))
        brazo(m, f, s, lado, "ropa", radios=(0.038, 0.036, 0.035, 0.036, 0.036))
        # Solapas del cuello, de los hombros al pico del pecho.
        m.plana([(s * 0.03, -0.046, 0.965), (s * 0.104, -0.03, 0.945), (s * 0.012, -0.066, 0.825), (0, -0.066, 0.86)], (0, 1, 0.2), 0.008, "marinero", "pecho", uvs=[(0.2, 0.95), (0.95, 0.95), (0.3, 0.1), (0.1, 0.3)])
    # Faldón del cuello a la espalda.
    m.plana([(-0.095, 0.05, 0.965), (0.095, 0.05, 0.965), (0.125, 0.082, 0.795), (-0.125, 0.082, 0.795)], (0, 1, -0.1), 0.008, "marinero", "pecho", uvs=[(0.1, 0.99), (0.9, 0.99), (0.99, 0.01), (0.01, 0.01)])
    # Pañuelo: nudo y dos puntas.
    m.plana([(-0.02, -0.07, 0.86), (0.02, -0.07, 0.86), (0.016, -0.072, 0.835), (-0.016, -0.072, 0.835)], (0, 1, 0), 0.01, "acento", "pecho", uv=(0.5, 0.5))
    for s in (-1, 1):
        m.plana([(s * 0.004, -0.072, 0.84), (s * 0.03, -0.074, 0.76), (s * 0.008, -0.074, 0.775)], (0, 1, 0), 0.006, "acento", "pecho", uv=(0.5, 0.5))
    # Gorra de gajos, ladeada como en la referencia.
    Z = CZ
    rot = Euler((0.1, -0.2, 0)).to_matrix()
    o = Vector((0.018, 0, Z))

    def en_gorra(z, r, c=(0, 0)):
        return (o + rot @ Vector((c[0], c[1], z)), r, r * 0.96)

    m.aros([en_gorra(0.1, 0.168), en_gorra(0.13, 0.208), en_gorra(0.172, 0.222), en_gorra(0.218, 0.17), en_gorra(0.24, 0.06)], "gorra", "cabeza", seg=8, v=(0.98, 0.02), rot=rot, tapa_a=False)
    visera = [o + rot @ Vector(p) for p in ((-0.1, -0.13, 0.1), (0.1, -0.13, 0.1), (0.075, -0.205, 0.075), (-0.075, -0.205, 0.075))]
    m.plana(visera, rot @ Vector((0, 0.3, 1)), 0.012, "negro", "cabeza", uv=(0.5, 0.5))
    # Mochila con bocina de latón: de espaldas es lo primero que ves de ti.
    m.caja((0, 0.1, 0.85), (0.15, 0.07, 0.18), "acento", "pecho", uv=(0.5, 0.5))
    for s in (-1, 1):
        m.tubo([(s * 0.065, 0.075, 0.93), (s * 0.07, 0.0, 0.962), (s * 0.075, -0.056, 0.9), (s * 0.07, -0.055, 0.8)], [(0.011, 0.004)] * 4, "negro", "pecho", seg=4)
    eje = Vector((0.48, 0.5, 0.72)).normalized()
    b = Vector((0.05, 0.125, 0.925))
    m.tubo([b, b + eje * 0.05, b + eje * 0.11, b + eje * 0.17], [0.012, 0.018, 0.05, 0.102], "metal", "pecho", seg=8, ref=(0, -1, 0), tapas=(False, False))


PEINADOS = dict(ambar=pelo_ambar, menta=pelo_menta, lira=pelo_lira, marina=pelo_marina, jugador=pelo_jugador)
ATUENDOS = dict(ambar=atuendo_ambar, menta=atuendo_menta, lira=atuendo_lira, marina=atuendo_marina, jugador=atuendo_jugador)


# ------------------------------------------------------------------ esqueleto y acciones
def armar(nombre):
    arm = bpy.data.armatures.new(nombre + "-esqueleto")
    obj = bpy.data.objects.new(nombre + "-esqueleto", arm)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    for hueso, (a, b, padre) in HUESOS.items():
        e = arm.edit_bones.new(hueso)
        e.head, e.tail = a, b
        if padre:
            e.parent = arm.edit_bones[padre]
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def resolver_brazo(lado, objetivo, polo):
    """IK de dos huesos, en el espacio del pecho. Regresa rotaciones de figura."""
    S = Vector(HUESOS[f"brazo.{lado}"][0])
    E0 = Vector(HUESOS[f"brazo.{lado}"][1])
    W0 = Vector(HUESOS[f"ante.{lado}"][1])
    a, b = (E0 - S).length, (W0 - E0).length
    D = Vector(objetivo) - S
    d = min(D.length, a + b - 0.002)
    u = D.normalized()
    x = (a * a - b * b + d * d) / (2 * d)
    h = math.sqrt(max(a * a - x * x, 0))
    pol = Vector(polo)
    perp = (pol - u * pol.dot(u)).normalized()
    E = S + u * x + perp * h
    W = S + u * d
    Rb = (E0 - S).rotation_difference(E - S)
    Rt = (W0 - E0).rotation_difference(W - E)
    return Rb, Rb.inverted() @ Rt, Rt


def accion(obj, nombre, cuadros, curvas):
    act = bpy.data.actions.new(nombre)
    act.use_fake_user = True
    obj.animation_data_create()
    obj.animation_data.action = act
    pb = obj.pose.bones
    for i in range(cuadros + 1):
        pose = curvas(i / cuadros)
        figura = {}
        for hueso in HUESOS:
            q = Quaternion()
            for eje, ang in pose.get(hueso, []):
                q = Quaternion(Vector(eje), ang) @ q
            figura[hueso] = q
        for lado, datos in pose.get("ik", {}).items():
            Rb, Ra, Rt = resolver_brazo(lado, datos[0], datos[1])
            figura[f"brazo.{lado}"] = Rb
            figura[f"ante.{lado}"] = Ra
            # "fija": la mano y lo que carga conservan su orientación de reposo.
            figura[f"mano.{lado}"] = Rt.inverted() if len(datos) > 2 and datos[2] else figura[f"mano.{lado}"]
        for hueso in HUESOS:
            b = pb[hueso]
            m = b.bone.matrix_local.to_3x3()
            eje, ang = figura[hueso].to_axis_angle()
            b.rotation_mode = "QUATERNION"
            b.rotation_quaternion = Quaternion(m.inverted() @ eje, ang)
            b.keyframe_insert("rotation_quaternion", frame=i + 1)
            if hueso == "raiz":
                b.location = m.inverted() @ Vector(pose.get("@pos", (0, 0, 0)))
                b.keyframe_insert("location", frame=i + 1)
    track = obj.animation_data.nla_tracks.new()
    track.name = nombre
    track.strips.new(nombre, 1, act)
    obj.animation_data.action = None


X, Y, Z_ = (1, 0, 0), (0, 1, 0), (0, 0, 1)
TAU = math.tau
POLO_L, POLO_R = (0.8, 0.5, -0.5), (-0.8, 0.5, -0.5)


def base_quieta(t, ladeo=0.0, cadera=0.0):
    r = math.sin(t * TAU)
    return {
        "@pos": (cadera * 0.14, 0, r * 0.005),
        "cadera": [(Y, cadera * 0.6)],
        "pecho": [(X, r * 0.012), (Y, -cadera * 0.9)],
        "cabeza": [(Y, ladeo), (Z_, r * 0.03), (X, -r * 0.012)],
        "muslo.L": [(Y, -cadera * 0.6)],
        "muslo.R": [(Y, -cadera * 0.6)],
        "pelo.L": [(Y, -r * 0.05)],
        "pelo.R": [(Y, r * 0.05)],
        "pelo.B": [(X, r * 0.025)],
    }


def q_ambar(t):
    # Lee con calma; se lleva la mano al pecho.
    p = base_quieta(t, ladeo=0.08, cadera=0.06)
    r = math.sin(t * TAU)
    p["cabeza"].append((X, 0.08))
    p["ik"] = {
        "L": ((0.1, -0.17, 0.78 + r * 0.004), POLO_L, True),
        "R": ((-0.07, -0.13, 0.84 + r * 0.006), (-0.8, 0.2, -0.6)),
    }
    return p


def q_menta(t):
    # Mano en la cadera, mira su tableta y se burla.
    p = base_quieta(t, ladeo=-0.14, cadera=-0.1)
    r = math.sin(t * TAU)
    p["cabeza"].append((X, 0.05))
    p["ik"] = {
        "R": ((-0.14, -0.015, 0.72), (-0.9, 0.5, 0.1)),
        "L": ((0.16, -0.15, 0.76 + r * 0.006), POLO_L, True),
    }
    return p


def q_lira(t):
    # Varita al cielo y rebote de escenario.
    r = math.sin(t * TAU * 2)
    p = base_quieta(t, ladeo=0.12, cadera=0.1)
    p["@pos"] = (0.02, 0, abs(r) * 0.014)
    p["pecho"].append((X, -0.05))
    p["pelo.L"] = [(Y, abs(r) * 0.2)]
    p["pelo.R"] = [(Y, -abs(r) * 0.2)]
    p["ik"] = {
        "R": ((-0.24, -0.08, 1.07 + r * 0.01), (-0.7, 0.3, -0.6), True),
        "L": ((0.135, -0.02, 0.72), (0.9, 0.5, 0.1)),
    }
    return p


def q_marina(t):
    # Rasguea sin ganas, con la cabeza siguiendo el ritmo.
    s = math.sin(t * TAU * 2)
    p = base_quieta(t, ladeo=0.18, cadera=0.08)
    p["cabeza"].append((X, 0.06 + abs(s) * 0.05))
    p["ik"] = {
        "R": (g(-0.02, 0.015 + s * 0.02, -0.065), (-0.8, 0.4, -0.4)),
        "L": (g(0.36, 0.0, -0.045), (0.75, 0.2, -0.65)),
    }
    return p


def q_jugador(t):
    return dict(base_quieta(t, ladeo=0.05), **{"brazo.L": [(Y, 0.08)], "brazo.R": [(Y, -0.08)]})


QUIETAS = dict(ambar=q_ambar, menta=q_menta, lira=q_lira, marina=q_marina, jugador=q_jugador)


def a_camina(nombre):
    def f(t):
        s, c = math.sin(t * TAU), math.cos(t * TAU)
        d = lambda v: max(0.0, v)
        # Pasos cortos y saltarines: con estas botas no se camina de otra forma.
        p = {
            "@pos": (s * 0.012, 0, abs(c) * 0.038),
            "cadera": [(Z_, s * 0.14), (Y, -s * 0.05)],
            "pecho": [(Z_, -s * 0.22), (X, 0.05)],
            "cabeza": [(Z_, s * 0.08), (Y, s * 0.04)],
            "muslo.L": [(X, s * 0.5)],
            "muslo.R": [(X, -s * 0.5)],
            "pierna.L": [(X, -d(-c) * 0.7)],
            "pierna.R": [(X, -d(c) * 0.7)],
            "brazo.L": [(Y, 0.1), (X, -s * 0.5)],
            "brazo.R": [(Y, -0.1), (X, s * 0.5)],
            "ante.L": [(X, 0.35)],
            "ante.R": [(X, 0.35)],
            "pelo.L": [(X, -0.16 - abs(s) * 0.12), (Y, -abs(c) * 0.1)],
            "pelo.R": [(X, -0.16 - abs(s) * 0.12), (Y, abs(c) * 0.1)],
            "pelo.B": [(X, -0.14 - abs(s) * 0.1)],
        }
        if nombre == "marina":
            p["ik"] = {"R": (g(-0.02, 0.015, -0.065), (-0.8, 0.4, -0.4)), "L": (g(0.36, 0.0, -0.045), (0.75, 0.2, -0.65))}
        return p
    return f


def a_teclea(t):
    a, b = math.sin(t * TAU * 4), math.sin(t * TAU * 4 + 2)
    return {
        "pecho": [(X, 0.1)],
        "cabeza": [(X, 0.08), (Z_, math.sin(t * TAU) * 0.05)],
        "ik": {
            "L": ((0.09, -0.21, 0.77 + a * 0.012), POLO_L),
            "R": ((-0.09, -0.21, 0.77 + b * 0.012), POLO_R),
        },
    }


def a_festeja(t):
    s = abs(math.sin(t * TAU))
    w = math.sin(t * TAU * 2)
    return {
        "@pos": (0, 0, s * 0.1),
        "pecho": [(Y, w * 0.08)],
        "cabeza": [(Y, -w * 0.12)],
        "muslo.L": [(X, -s * 0.2), (Y, s * 0.12)],
        "muslo.R": [(X, -s * 0.2), (Y, -s * 0.12)],
        "pierna.L": [(X, -s * 0.5)],
        "pierna.R": [(X, -s * 0.5)],
        "pelo.L": [(Y, s * 0.35)],
        "pelo.R": [(Y, -s * 0.35)],
        "pelo.B": [(X, -s * 0.25)],
        "ik": {
            "L": ((0.24 + w * 0.02, -0.05, 1.12 + s * 0.02), (0.9, 0.3, -0.3)),
            "R": ((-0.24 + w * 0.02, -0.05, 1.12 + s * 0.02), (-0.9, 0.3, -0.3)),
        },
    }


# ------------------------------------------------------------------ ensamblado
def limpiar():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures, bpy.data.actions):
        for x in list(coll):
            coll.remove(x)


def construir(nombre, f):
    limpiar()
    m = Malla()
    cabeza(m)
    for s, lado in ((1, "L"), (-1, "R")):
        pierna(m, f, s, lado)
    ATUENDOS[nombre](m, f)
    PEINADOS[nombre](m, f)

    liso = np.ones((2, 2))
    mats = {
        "cara": material("cara", imagen("t-cara", tex_cara(f))),
        "pelo": material("pelo", imagen("t-pelo", gris(tex_pelo(f.get("oscuro", False))[..., 0])), rgb(f["pelo"])),
        "pelo2": material("pelo2", imagen("t-pelo2", gris(tex_pelo()[..., 0])), rgb(f["pelo2"])),
        "ropa": material("ropa", imagen("t-ropa", tex_tela()), rgb(f["ropa"])),
        "tela2": material("tela2", imagen("t-tela2", tex_tela()), rgb(f["tela2"])),
        "cuadros": material("cuadros", imagen("t-cuadros", tex_cuadros()), rgb(f["acento"])),
        "acento": material("acento", imagen("t-acento", gris(liso)), rgb(f["acento"])),
        "gorra": material("gorra", imagen("t-gorra", tex_gorra()), rgb(f["acento"])),
        "marinero": material("marinero", imagen("t-marinero", tex_marinero(rgb(f["acento"])))),
        "brillo": material("brillo", imagen("t-brillo", gris(liso)), rgb(f["pelo2"])),
        "rayas": material("rayas", imagen("t-rayas", tex_rayas()), rgb(f["acento"])),
        "botas": material("botas", imagen("t-botas", tex_botas()), rgb(f["botas"])),
        "suela": material("suela", imagen("t-suela", gris(liso * 0.9))),
        "guante": material("guante", imagen("t-guante", tex_guante())),
        "negro": material("negro", imagen("t-negro", gris(liso * 0.1))),
        "metal": material("metal", imagen("t-metal", gris(liso * 0.78))),
        "guitarra": material("guitarra", imagen("t-guitarra", tex_tela()), rgb(f["tela2"])),
    }
    orden = [k for k in mats if k in set(m.mat)]
    me = bpy.data.meshes.new(nombre)
    me.from_pydata(m.v, [], m.f)
    for k in orden:
        me.materials.append(mats[k])
    me.polygons.foreach_set("material_index", [orden.index(x) for x in m.mat])
    uv = me.uv_layers.new(name="UVMap")
    for pol in me.polygons:
        for li in pol.loop_indices:
            uv.data[li].uv = m.uv[me.loops[li].vertex_index]
    me.update()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    # Ángulo bajo: las aristas de pelo y ropa quedan duras, como en la consola.
    me.set_sharp_from_angle(angle=math.radians(38))

    obj = bpy.data.objects.new(nombre, me)
    bpy.context.collection.objects.link(obj)
    arm = armar(nombre)
    for hueso in HUESOS:
        obj.vertex_groups.new(name=hueso)
    for i, pesos in enumerate(m.pesos):
        for hueso, peso in pesos:
            if peso > 0:
                obj.vertex_groups[hueso].add([i], peso, "REPLACE")
    obj.parent = arm
    mod = obj.modifiers.new("Esqueleto", "ARMATURE")
    mod.object = arm

    accion(arm, "quieta", 48, QUIETAS[nombre])
    accion(arm, "camina", 20, a_camina(nombre))
    accion(arm, "teclea", 24, a_teclea)
    accion(arm, "festeja", 24, a_festeja)
    tris = sum(len(c) - 2 for c in m.f)
    print(f"[room-models] {nombre}: {len(m.v)} vértices, {tris} triángulos")
    return arm, obj


def exportar(nombre):
    os.makedirs(SALIDA, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(SALIDA, nombre + ".glb"),
        export_format="GLB",
        export_animation_mode="NLA_TRACKS",
        export_skins=True,
        export_morph=False,
        export_yup=True,
        export_apply=False,
        export_force_sampling=True,
        export_frame_step=2,
        export_cameras=False,
        export_lights=False,
    )


def previa(nombre, arm, carpeta):
    os.makedirs(carpeta, exist_ok=True)
    esc = bpy.context.scene
    esc.render.engine = "BLENDER_EEVEE"
    esc.render.resolution_x, esc.render.resolution_y = 620, 800
    esc.view_settings.view_transform = "Standard"
    w = bpy.data.worlds.new("w")
    esc.world = w
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.92, 0.72, 0.76, 1)
    w.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    sol = bpy.data.lights.new("s", "SUN")
    sol.energy = 2.2
    o = bpy.data.objects.new("s", sol)
    o.rotation_euler = (0.9, 0.2, 0.5)
    bpy.context.collection.objects.link(o)
    cam = bpy.data.cameras.new("c")
    cam.type = "ORTHO"
    cam.ortho_scale = 2.0
    ob = bpy.data.objects.new("c", cam)
    bpy.context.collection.objects.link(ob)
    esc.camera = ob
    for pista in arm.animation_data.nla_tracks:
        pista.mute = pista.name != "quieta"
    esc.frame_set(14)
    for sufijo, ang in (("frente", -0.42), ("espalda", math.pi - 0.42)):
        d = Vector((math.sin(ang) * -4, -math.cos(ang) * 4, 1.25))
        ob.location = d
        ob.rotation_euler = (Vector((0, 0, 0.76)) - d).to_track_quat("-Z", "Y").to_euler()
        esc.render.filepath = os.path.join(carpeta, f"{nombre}-{sufijo}.png")
        bpy.ops.render.render(write_still=True)


def principal():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    carpeta = args[args.index("--preview") + 1] if "--preview" in args else None
    solo = args[args.index("--solo") + 1] if "--solo" in args else None
    for nombre, f in FIGURAS.items():
        if solo and nombre != solo:
            continue
        arm, _ = construir(nombre, f)
        exportar(nombre)
        if carpeta:
            previa(nombre, arm, carpeta)


principal()
