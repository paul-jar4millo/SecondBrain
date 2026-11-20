import * as THREE from "three";
import { fadeWalls } from "./room-walls";

// Scene dressing for the Blender map: toon materials, ink lines, the faceted sea,
// glow halos and the small animated pieces. Group names are set in ops/room-refuge.py.
export const FONDO = "#0a1238";

function gradiente() {
  // Three hard steps: the anime cel look of the references, no soft falloff.
  const data = new Uint8Array([120, 190, 255]);
  const textura = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  textura.minFilter = textura.magFilter = THREE.NearestFilter;
  textura.needsUpdate = true;
  return textura;
}

function crearMar() {
  const geometria = new THREE.PlaneGeometry(300, 300, 110, 110);
  geometria.rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    uniforms: { tiempo: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float tiempo;
      varying vec3 vMundo;
      void main() {
        vec3 p = position;
        p.y += sin(p.x * .31 + tiempo * .7) * .28 + cos(p.z * .27 - tiempo * .55) * .28
             + sin((p.x + p.z) * .17 + tiempo * .35) * .22;
        vMundo = p;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vMundo;
      void main() {
        vec3 n = normalize(cross(dFdx(vMundo), dFdy(vMundo)));
        if (n.y < 0.) n = -n;
        float luz = dot(n, normalize(vec3(.42, .8, .5)));
        float banda = floor(clamp((luz - .62) * 6.4, 0., 2.999));
        vec3 color = mix(vec3(.043, .102, .392), vec3(.09, .22, .68), banda / 2.);
        // Stepped shallows around the pedestal.
        vec2 q = abs(vMundo.xz) - vec2(18.8, 14.8);
        float orilla = length(max(q, 0.)) + min(max(q.x, q.y), 0.);
        orilla += sin(atan(vMundo.z, vMundo.x) * 22.) * .5;
        float cerca = 1. - clamp(floor(orilla / 2.4) / 4., 0., 1.);
        color = mix(color, vec3(.2, .52, .95), cerca * .55);
        if (orilla < .5) color = vec3(.82, .92, 1.);
        // The far sea sinks into the night.
        float lejos = clamp((length(vMundo.xz) - 44.) / 60., 0., 1.);
        color = mix(color, vec3(.039, .07, .22), floor(lejos * 5.) / 5.);
        gl_FragColor = vec4(color, 1.);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometria, material);
  mesh.position.y = -2.05;
  mesh.name = "Mar";
  return mesh;
}

function texturaHalo() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,.9)");
  r.addColorStop(0.22, "rgba(255,255,255,.34)");
  r.addColorStop(0.6, "rgba(255,255,255,.08)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// One LineSegments per visibility group keeps the ink pass at three draw calls.
function lineasDeTinta(mapa) {
  const grupos = new Map();
  mapa.updateMatrixWorld(true);
  mapa.traverse((o) => {
    if (!o.isMesh) return;
    const nombre = o.name;
    const material = o.material.name || "";
    if (
      nombre.startsWith("Anim") ||
      nombre.startsWith("Mar") ||
      /^(glow_|leaf|floor)/.test(material)
    )
      return;
    const grupo = nombre.startsWith("Wall") ? nombre.slice(0, 5) : "World";
    const aristas = new THREE.EdgesGeometry(o.geometry, 38);
    aristas.applyMatrix4(o.matrixWorld);
    if (!grupos.has(grupo)) grupos.set(grupo, []);
    grupos.get(grupo).push(aristas.attributes.position.array);
    aristas.dispose();
  });
  const material = new THREE.LineBasicMaterial({
    color: "#0b1450",
    transparent: true,
    opacity: 0.5,
  });
  const lineas = [];
  for (const [grupo, partes] of grupos) {
    const total = partes.reduce((n, p) => n + p.length, 0);
    const posiciones = new Float32Array(total);
    let offset = 0;
    for (const p of partes) {
      posiciones.set(p, offset);
      offset += p.length;
    }
    const geometria = new THREE.BufferGeometry();
    geometria.setAttribute(
      "position",
      new THREE.BufferAttribute(posiciones, 3),
    );
    const linea = new THREE.LineSegments(geometria, material);
    linea.name = `${grupo}__tinta`;
    linea.frustumCulled = false;
    lineas.push(linea);
  }
  return lineas;
}

export function dressWorld(scene, mapa, manifiesto, { quieto = false } = {}) {
  const rampa = gradiente();
  const reemplazos = new Map();
  const propio = (original) => {
    if (reemplazos.has(original)) return reemplazos.get(original);
    const nombre = original.name || "";
    const material = nombre.startsWith("glow_")
      ? new THREE.MeshBasicMaterial({ color: original.color })
      : new THREE.MeshToonMaterial({
          color: original.color,
          map: original.map,
          gradientMap: rampa,
          side: nombre.startsWith("leaf") ? THREE.DoubleSide : THREE.FrontSide,
        });
    material.name = nombre;
    reemplazos.set(original, material);
    original.dispose();
    return material;
  };
  const muros = { WallN: [], WallW: [], norte: null, oeste: null };
  const giran = [],
    flotan = [];
  mapa.traverse((o) => {
    if (!o.isMesh) return;
    o.material = propio(o.material);
    const brilla = o.material.name.startsWith("glow_");
    o.castShadow = !brilla && !/^(Mar|Anim_Bob)/.test(o.name);
    o.receiveShadow = !brilla;
    if (o.name.startsWith("WallN")) muros.WallN.push(o);
    if (o.name.startsWith("WallW")) muros.WallW.push(o);
    if (o.name.startsWith("Anim_Spin")) giran.push(o);
    if (o.name.startsWith("Anim_Bob"))
      flotan.push({ o, y: o.position.y, fase: o.name.includes("_b") ? 2 : 0 });
  });
  const material = mapa.getObjectByName("World_floor")?.material;
  if (material?.map) material.map.anisotropy = 4;
  const tinta = lineasDeTinta(mapa);
  for (const linea of tinta) {
    scene.add(linea);
    if (linea.name.startsWith("WallN")) muros.WallN.push(linea);
    if (linea.name.startsWith("WallW")) muros.WallW.push(linea);
  }
  const mar = crearMar();
  scene.add(mar);
  const halo = texturaHalo();
  const halos = (manifiesto.halos || []).map((h) => {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: halo,
        color: h.color,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }),
    );
    sprite.position.set(h.x, h.y, h.z);
    sprite.scale.setScalar(h.size);
    sprite.renderOrder = 2;
    if (h.wall) muros[h.wall].push(sprite);
    scene.add(sprite);
    return sprite;
  });
  // One document travels only for recorded handoffs or explicit replay.
  const paper = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.22),
    new THREE.MeshBasicMaterial({ color: "#fff2c4" }),
  );
  paper.visible = false;
  scene.add(paper);
  const trail = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 33 }, () => new THREE.Vector3()),
    ),
    new THREE.LineBasicMaterial({
      color: "#78bdf8",
      transparent: true,
      opacity: 0.6,
    }),
  );
  trail.visible = false;
  scene.add(trail);
  let relay = null;
  const a = new THREE.Vector3(),
    b = new THREE.Vector3();
  function relayPoint(t, target) {
    target.lerpVectors(a, b, t);
    target.y += Math.sin(t * Math.PI) * 2;
    if (a.distanceToSquared(b) < 0.1)
      target.x += Math.sin(t * Math.PI * 2) * 0.8;
    return target;
  }
  const point = new THREE.Vector3();
  return {
    relevo(from, to) {
      relay = { from, to, elapsed: 0 };
      paper.visible = true;
      trail.visible = !quieto;
    },
    detenerRelevo() {
      relay = null;
      paper.visible = false;
      trail.visible = false;
    },
    actualizar(t, dt, camera, target) {
      // Walls stand only behind the action, never between camera and floor.
      const norte = camera.position.z > target.z,
        oeste = camera.position.x > target.x;
      // Hidden walls stop casting shadows, so the caller refreshes the shadow map.
      let murosCambian = norte !== muros.norte || oeste !== muros.oeste;
      muros.norte = norte;
      muros.oeste = oeste;
      murosCambian = fadeWalls(muros.WallN, norte, dt, quieto) || murosCambian;
      murosCambian = fadeWalls(muros.WallW, oeste, dt, quieto) || murosCambian;
      if (relay) {
        relay.elapsed += dt;
        a.copy(relay.from.position);
        a.y += 2.2;
        b.copy(relay.to.position);
        b.y += 2.2;
        const progress = Math.min(1, relay.elapsed / 3.5);
        relayPoint(quieto ? 1 : progress, paper.position);
        if (!quieto) {
          paper.rotation.y = t * 2;
          const attr = trail.geometry.attributes.position;
          for (let i = 0; i < 33; i++) {
            relayPoint(i / 32, point);
            attr.setXYZ(i, point.x, point.y, point.z);
          }
          attr.needsUpdate = true;
          trail.geometry.computeBoundingSphere();
        }
        if (relay.elapsed >= 4) {
          relay = null;
          paper.visible = false;
          trail.visible = false;
        }
      }
      if (quieto) return murosCambian;
      mar.material.uniforms.tiempo.value = t;
      for (const o of giran)
        o.rotation.y += dt * (o.name.includes("disc") ? 2.6 : 0.42);
      for (const f of flotan)
        f.o.position.y = f.y + Math.sin(t * 0.5 + f.fase) * 0.32;
      halos.forEach((s, i) => {
        s.material.opacity =
          (0.38 + Math.sin(t * 0.9 + i * 1.7) * 0.05) *
          (s.userData.wallFade?.factor ?? 1);
      });
      return murosCambian;
    },
    liberar() {
      paper.geometry.dispose();
      paper.material.dispose();
      trail.geometry.dispose();
      trail.material.dispose();
      rampa.dispose();
      halo.dispose();
      mar.geometry.dispose();
      mar.material.dispose();
      halos.forEach((s) => s.material.dispose());
      tinta.forEach((l) => l.geometry.dispose());
      new Set(tinta.map((l) => l.material)).forEach((m) => m.dispose());
      reemplazos.forEach((m) => {
        m.map?.dispose();
        m.dispose();
      });
    },
  };
}
