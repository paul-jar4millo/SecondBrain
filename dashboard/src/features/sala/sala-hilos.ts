import * as THREE from "three";

const ALTURA = 1.5;
/**
 * Light threads from a team leader to each live child. One two-vertex line per
 * thread, a single shared material; vertices are rewritten in place per frame.
 */
export function createHilos(scene: THREE.Scene, quieto = false) {
  const material = new THREE.LineBasicMaterial({
    color: "#9fe8ff",
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const lines = new Map<
    string,
    { line: THREE.Line; de: string; a: string; posiciones: Float32Array }
  >();
  const clave = (h: { de: string; a: string }) => `${h.de}>${h.a}`;
  return {
    /** Adds missing threads and frees those whose child ended. */
    sincronizar(hilos: { de: string; a: string }[]) {
      const deseados = new Set(hilos.map(clave));
      for (const [key, h] of lines)
        if (!deseados.has(key)) {
          scene.remove(h.line);
          h.line.geometry.dispose();
          lines.delete(key);
        }
      for (const h of hilos) {
        if (lines.has(clave(h))) continue;
        const posiciones = new Float32Array(6);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(posiciones, 3),
        );
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        line.renderOrder = 4;
        line.visible = false;
        line.name = "hilo-equipo";
        scene.add(line);
        lines.set(clave(h), { line, de: h.de, a: h.a, posiciones });
      }
    },
    actualizar(t: number, posicion: (id: string) => THREE.Vector3 | undefined) {
      if (!lines.size) return;
      if (!quieto) material.opacity = 0.65 + Math.sin(t * 2.4) * 0.2;
      for (const h of lines.values()) {
        const a = posicion(h.de),
          b = posicion(h.a);
        h.line.visible = !!a && !!b;
        if (!a || !b) continue;
        const p = h.posiciones;
        p[0] = a.x;
        p[1] = a.y + ALTURA;
        p[2] = a.z;
        p[3] = b.x;
        p[4] = b.y + ALTURA;
        p[5] = b.z;
        h.line.geometry.attributes.position.needsUpdate = true;
      }
    },
    /** Keys of live threads, for debugging and checks. */
    claves: () => [...lines.keys()],
    visibles: () => [...lines.values()].filter((h) => h.line.visible).length,
    liberar() {
      for (const h of lines.values()) {
        scene.remove(h.line);
        h.line.geometry.dispose();
      }
      lines.clear();
      material.dispose();
    },
  };
}
