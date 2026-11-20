import * as THREE from "three";
import { expect, it } from "vitest";
import { fadeWalls } from "../src/features/room/room-walls";

it("fades an obstructing wall without changing another surface sharing its material", () => {
  const shared = new THREE.MeshBasicMaterial();
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(), shared);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(), shared);
  expect(fadeWalls([wall], false, 1 / 60, false)).toBe(true);
  expect(wall.material.opacity).toBeGreaterThan(0);
  expect(wall.material.opacity).toBeLessThan(1);
  expect(floor.material.opacity).toBe(1);
  for (let i = 0; i < 60; i++) fadeWalls([wall], false, 1 / 60, false);
  expect(wall.visible).toBe(false);
  expect(wall.castShadow).toBe(false);
  fadeWalls([wall], true, 1 / 60, true);
  expect(wall.visible).toBe(true);
  expect(wall.material.opacity).toBe(1);
  expect(wall.material.transparent).toBe(false);
  expect(fadeWalls([wall], true, 1 / 60, true)).toBe(false);
  wall.geometry.dispose();
  floor.geometry.dispose();
  wall.material.dispose();
  shared.dispose();
});
it("preserves the original opacity and depth policy of a wall halo", () => {
  const material = new THREE.SpriteMaterial({
    opacity: 0.42,
    transparent: true,
    depthWrite: false,
  });
  const halo = new THREE.Sprite(material);
  fadeWalls([halo], false, 1 / 60, false);
  fadeWalls([halo], true, 1 / 60, true);
  expect(halo.material.opacity).toBe(0.42);
  expect(halo.material.transparent).toBe(true);
  expect(halo.material.depthWrite).toBe(false);
  halo.material.dispose();
  material.dispose();
});
