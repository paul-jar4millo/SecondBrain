// Personajes de la sala: figuras adultas, vestidas y originales, modeladas en Blender
// (ops/sala-modelos.py). Aquí se cargan los GLB, se tiñen y se animan.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as clonarFigura } from "three/addons/utils/SkeletonUtils.js";
import { rampa } from "./room-chamber.js";

// Un tipo por proveedor: silueta (modelo), colores de base y forma de buscar.
export const TIPOS = {
  claude: {
    proveedor: "Claude",
    modelo: "ambar",
    color: "#e08a5b",
    lente: ["habitacion", "lofi", "luz", "diseno"],
    colores: { pelo: "#f08a58", ropa: "#f7ead6", acento: "#d4553a" },
  },
  chatgpt: {
    proveedor: "ChatGPT",
    modelo: "menta",
    color: "#35c49b",
    lente: ["interfaz", "kawaii", "anime"],
    colores: { pelo: "#59607e", ropa: "#4bd9b0", acento: "#178f70" },
  },
  gemini: {
    proveedor: "Gemini",
    modelo: "lira",
    color: "#7c8cff",
    lente: ["neon", "kawaii", "azul"],
    colores: { pelo: "#a7adff", ropa: "#5560ee", acento: "#ffcf5c" },
  },
  deepseek: {
    proveedor: "DeepSeek",
    modelo: "marina",
    color: "#3f8cff",
    lente: ["low-poly", "3d", "crt"],
    colores: { pelo: "#4a86ec", ropa: "#232f58", acento: "#3cb4ff" },
  },
};
const especie = (id, nombre, tipo, enfoque) => ({
  id,
  nombre,
  tipo,
  enfoque,
  ...TIPOS[tipo],
});
export const AGENTES = [
  especie("ambar", "Ámbar", "claude", "Composición y narrativa"),
  especie("menta", "Menta", "chatgpt", "Variedad de ideas"),
  especie("lira", "Lira", "gemini", "Color y brillo"),
  especie("marina", "Marina", "deepseek", "Detalle técnico"),
];
export const JUGADOR = {
  id: "tu",
  nombre: "Tú",
  modelo: "jugador",
  color: "#c6bdff",
};

const CUADROS_CARA = 3; // abierta, parpadeo, contenta: tira en la textura de la cara.
const TINTES = {
  pelo: "pelo",
  ropa: "ropa",
  acento: "acento",
  gorra: "acento",
  cuadros: "acento",
  rayas: "acento",
  pelo2: "acento",
  brillo: "acento",
};
const modelos = new Map();
const cargador = new GLTFLoader();

export function cargarModelo(nombre, alProgreso) {
  if (!modelos.has(nombre))
    modelos.set(
      nombre,
      cargador
        .loadAsync(
          `${import.meta.env.BASE_URL}models/sala/${nombre}.glb`,
          (e) =>
            alProgreso?.(nombre, e.loaded, e.lengthComputable ? e.total : 0),
        )
        .then((gltf) => {
          gltf.scene.traverse((o) => {
            if (o.isMesh) normalesDeContorno(o.geometry);
          });
          return gltf;
        })
        .catch((error) => {
          // A failed download must not stay cached, or "Reintentar" would replay the error.
          modelos.delete(nombre);
          throw error;
        }),
    );
  return modelos.get(nombre);
}
export const MODELOS = [
  "jugador",
  ...new Set(Object.values(TIPOS).map((t) => t.modelo)),
];
/** Loads every figure in parallel; `alProgreso(nombre, cargado, total)` reports bytes. */
export const cargarTodos = (alProgreso) =>
  Promise.all(MODELOS.map((nombre) => cargarModelo(nombre, alProgreso)));

// Las costuras de UV separan vértices; el contorno necesita una normal única por posición.
function normalesDeContorno(geo) {
  const pos = geo.attributes.position,
    nor = geo.attributes.normal;
  const suma = new Map();
  const clave = (i) =>
    `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = clave(i);
    const s = suma.get(k) || [0, 0, 0];
    s[0] += nor.getX(i);
    s[1] += nor.getY(i);
    s[2] += nor.getZ(i);
    suma.set(k, s);
  }
  const suave = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = suma.get(clave(i));
    const n = Math.hypot(x, y, z) || 1;
    suave.set([x / n, y / n, z / n], i * 3);
  }
  geo.setAttribute("suave", new THREE.BufferAttribute(suave, 3));
}

const contorno = (() => {
  const m = new THREE.MeshBasicMaterial({
    color: "#14102a",
    side: THREE.BackSide,
  });
  m.onBeforeCompile = (s) => {
    s.vertexShader =
      "attribute vec3 suave;\n" +
      s.vertexShader.replace(
        "#include <begin_vertex>",
        "vec3 transformed = position + suave * 0.0085;",
      );
  };
  m.customProgramCacheKey = () => "contorno-figura";
  return m;
})();

// Círculo mágico bajo los pies: dibujado una vez por color y compartido.
const circulos = new Map();
function texturaCirculo(color) {
  if (circulos.has(color)) return circulos.get(color);
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.strokeStyle = color;
  g.translate(64, 64);
  for (const [r, w] of [
    [60, 3],
    [54, 1],
    [32, 2],
  ]) {
    g.lineWidth = w;
    g.beginPath();
    g.arc(0, 0, r, 0, 7);
    g.stroke();
  }
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= 5; i++) {
    const a = (i * 2 * 2 * Math.PI) / 5 - Math.PI / 2;
    g[i ? "lineTo" : "moveTo"](Math.cos(a) * 53, Math.sin(a) * 53);
  }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  circulos.set(color, t);
  return t;
}
const planoCirculo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const ESCALA = 1.18;

/** Crea una figura desde un modelo ya cargado (usar cargarTodos antes). */
export async function crearPersona(spec) {
  const gltf = await cargarModelo(spec.modelo);
  const raiz = new THREE.Group();
  const figura = clonarFigura(gltf.scene);
  figura.scale.setScalar(ESCALA);
  raiz.add(figura);
  const propios = new Map();
  const texturaCara = [];
  figura.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const nombre = o.material.name;
    if (!propios.has(nombre)) {
      // Doble cara: faldas y olanes son abiertos por abajo. La cara va sin luz, plana y
      // clara como en los juegos de portátil: sombrearla por facetas la vuelve inquietante.
      const mat =
        nombre === "cara"
          ? new THREE.MeshBasicMaterial({
              map: o.material.map,
              color: o.material.color,
              side: THREE.DoubleSide,
            })
          : new THREE.MeshToonMaterial({
              map: o.material.map,
              color: o.material.color,
              gradientMap: rampa,
              side: THREE.DoubleSide,
            });
      mat.name = nombre;
      if (nombre === "cara") {
        mat.map = o.material.map.clone();
        mat.map.needsUpdate = true;
        texturaCara.push(mat.map);
      }
      propios.set(nombre, mat);
    }
    o.material = propios.get(nombre);
    o.castShadow = true;
    o.frustumCulled = false;
    const linea = new THREE.SkinnedMesh(o.geometry, contorno);
    linea.bind(o.skeleton, o.bindMatrix);
    linea.frustumCulled = false;
    o.parent.add(linea);
  });
  const teñir = (colores = {}) => {
    for (const [mat, clave] of Object.entries(TINTES)) {
      const m = propios.get(mat);
      if (m && colores[clave]) m.color.set(colores[clave]);
    }
  };
  if (spec.colores) teñir(spec.colores);

  const circulo = new THREE.Mesh(
    planoCirculo,
    new THREE.MeshBasicMaterial({
      map: texturaCirculo(spec.color),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  circulo.scale.setScalar(1.15);
  circulo.position.y = 0.018;
  raiz.add(circulo);

  // Caja invisible para los clics: más barata y fiable que probar contra la malla animada.
  const toque = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 1.75, 6),
    new THREE.MeshBasicMaterial(),
  );
  toque.position.y = 0.875;
  toque.visible = false;
  raiz.add(toque);

  const mezclador = new THREE.AnimationMixer(figura);
  const acciones = Object.fromEntries(
    gltf.animations.map((clip) => [clip.name, mezclador.clipAction(clip)]),
  );
  let actual = null;
  const poner = (nombre) => {
    if (nombre === actual) return;
    const siguiente = acciones[nombre] || acciones.quieta;
    siguiente
      .reset()
      .fadeIn(actual ? 0.14 : 0)
      .play();
    if (actual) acciones[actual].fadeOut(0.14);
    actual = nombre;
  };
  mezclador.update(Math.random());
  poner("quieta");
  let proximoParpadeo = 2 + Math.random() * 3,
    parpadeando = 0;
  const cara = (cuadro) =>
    texturaCara.forEach((t) => (t.offset.x = cuadro / CUADROS_CARA));
  return {
    raiz,
    spec,
    toque,
    teñir,
    // accion: 'quieta' | 'camina' | 'teclea' | 'festeja'
    animar(dt, accion) {
      poner(accion);
      mezclador.update(dt);
      circulo.rotation.y += dt * 0.5;
      proximoParpadeo -= dt;
      if (proximoParpadeo < 0) {
        parpadeando = 0.13;
        proximoParpadeo = 2 + Math.random() * 4;
      }
      if (parpadeando > 0) parpadeando -= dt;
      cara(accion === "festeja" ? 2 : parpadeando > 0 ? 1 : 0);
    },
    liberar() {
      mezclador.stopAllAction();
      propios.forEach((m) => m.dispose());
      texturaCara.forEach((t) => t.dispose());
      toque.geometry.dispose();
      toque.material.dispose();
      circulo.material.dispose();
    },
  };
}
