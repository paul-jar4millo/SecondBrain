import * as THREE from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dressWorld } from "../src/features/room/room-world";

// The halo is drawn on a 2D canvas; node has none, so a recording fake stands in.
beforeEach(() => {
  const ctx = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "createRadialGradient"
          ? () => ({ addColorStop() {} })
          : () => {},
      set: () => true,
    },
  );
  vi.stubGlobal("document", {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  });
});
afterEach(() => vi.unstubAllGlobals());

function map() {
  const root = new THREE.Group();
  const add = (name: string, material = "stone") => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ name: material }),
    );
    mesh.name = name;
    root.add(mesh);
    return mesh;
  };
  add("WallN_a");
  add("WallW_a");
  add("World_floor", "floor");
  add("World_rock");
  add("Anim_Spin_disc", "glow_disc");
  add("Anim_Bob_b");
  return root;
}

it("viste el mapa: tinta por grupo, mar, halos y muros que se ocultan frente a la cámara", () => {
  const scene = new THREE.Scene();
  const world = dressWorld(scene, map(), {
    halos: [{ color: "#fff", x: 0, y: 1, z: 0, size: 2, wall: "WallN" }],
  });
  const names = scene.children.map((o) => o.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "WallN__tinta",
      "WallW__tinta",
      "World__tinta",
      "Mar",
    ]),
  );
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(-10, 10, -10);
  // Camera on the north-west side: both walls stand between it and the floor.
  expect(world.actualizar(0, 1, camera, new THREE.Vector3())).toBe(true);
  for (let i = 0; i < 40; i++)
    world.actualizar(i / 10, 0.1, camera, new THREE.Vector3());
  const wall = scene.getObjectByName("WallN__tinta") as THREE.Object3D;
  expect(wall.visible).toBe(false);
  world.liberar();
});

it("anima un relevo entre dos agentes y lo termina solo", () => {
  const scene = new THREE.Scene();
  const world = dressWorld(scene, map(), {});
  const from = new THREE.Object3D(),
    to = new THREE.Object3D();
  to.position.set(4, 0, 0);
  world.relevo(from, to);
  const paper = scene.children.find(
    (o) => (o as THREE.Mesh).geometry instanceof THREE.OctahedronGeometry,
  ) as THREE.Object3D;
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(10, 10, 10);
  world.actualizar(0, 1, camera, new THREE.Vector3());
  expect(paper.visible).toBe(true);
  expect(paper.position.y).toBeGreaterThan(2);
  world.actualizar(1, 3.5, camera, new THREE.Vector3());
  expect(paper.visible).toBe(false);
  world.relevo(from, to);
  world.detenerRelevo();
  expect(paper.visible).toBe(false);
  world.liberar();
});

it("en modo quieto coloca el relevo al final y no anima", () => {
  const scene = new THREE.Scene();
  const world = dressWorld(scene, map(), {}, { quieto: true });
  const from = new THREE.Object3D(),
    to = new THREE.Object3D();
  to.position.set(0, 0, 6);
  world.relevo(from, to);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(10, 10, 10);
  world.actualizar(0, 0.1, camera, new THREE.Vector3());
  const paper = scene.children.find(
    (o) => (o as THREE.Mesh).geometry instanceof THREE.OctahedronGeometry,
  ) as THREE.Object3D;
  expect(paper.position.z).toBeCloseTo(6);
  world.liberar();
});
