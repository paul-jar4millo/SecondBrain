import * as THREE from "three";

// Overlays on existing Blender surfaces (x, height, z), never a second map.
const SURFACES = {
  workshop: { at: [-11.3, 1.55, -11.039], size: [1.39, 0.81], tilt: 0 },
  library: { at: [-0.7, 1.028, -10], size: [2.9, 0.64], tilt: -Math.PI / 2 },
  garden: { at: [10, 0.956, -10.4], size: [3.1, 0.85], tilt: -Math.PI / 2 },
  cafe: { at: [-14.1, 1.18, 7.98], size: [0.72, 0.42], tilt: -Math.PI / 2 },
  terrace: { at: [0, 1.6, 0.094], size: [1.6, 0.96], tilt: 0 },
};

function fit(ctx, text, x, y, width) {
  let value = String(text);
  while (ctx.measureText(value).width > width && value.length > 1)
    value = value.slice(0, -1);
  if (value !== text) value = value.slice(0, -1) + "…";
  ctx.fillText(value, x, y);
}

export function createWorldBoards(scene) {
  const boards = Object.entries(SURFACES).map(([id, surface]) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 512;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(...surface.size),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }),
    );
    mesh.position.set(...surface.at);
    mesh.rotation.x = surface.tilt;
    scene.add(mesh);
    return { id, canvas, texture, mesh, key: "" };
  });
  return {
    update(data = {}) {
      for (const b of boards) {
        const summary = data[b.id] || {
          headline: "Cargando datos…",
          lines: [],
        };
        const key = JSON.stringify(summary);
        if (key === b.key) continue;
        b.key = key;
        const ctx = b.canvas.getContext("2d");
        ctx.fillStyle = "#0f1a55";
        ctx.fillRect(0, 0, 1024, 512);
        ctx.fillStyle = "#78bdf8";
        ctx.fillRect(40, 44, 944, 5);
        ctx.fillStyle = "#f1f7ff";
        ctx.font = "600 64px Fredoka, sans-serif";
        fit(ctx, summary.headline, 48, 140, 928);
        ctx.font = "40px sans-serif";
        ctx.fillStyle = "#cfe6ff";
        summary.lines
          .slice(0, 3)
          .forEach((line, i) => fit(ctx, line, 48, 245 + i * 86, 928));
        b.texture.needsUpdate = true;
      }
    },
    dispose() {
      boards.forEach(({ mesh, texture }) => {
        scene.remove(mesh);
        texture.dispose();
        mesh.geometry.dispose();
        mesh.material.dispose();
      });
    },
  };
}
