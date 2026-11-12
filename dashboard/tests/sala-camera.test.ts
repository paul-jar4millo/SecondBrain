import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  createThirdPersonCamera,
  followPlayer,
  resetCamera,
} from "../src/features/sala/sala-camera";

describe("cámara de tercera persona", () => {
  it("suaviza el seguimiento sin cambiar el giro y converge igual a 30 y 60 FPS", () => {
    const simulate = (fps: number) => {
      const camera = createThirdPersonCamera(1.6);
      const previous = new THREE.Vector3();
      const target = new THREE.Vector3();
      resetCamera(camera, target, previous);
      const offset = camera.position.clone().sub(target);
      const position = new THREE.Vector3(4, 0, 0);
      followPlayer(camera, target, previous, position, 1 / fps);
      expect(previous.x).toBeGreaterThan(0);
      expect(previous.x).toBeLessThan(4);
      for (let i = 1; i < fps; i++)
        followPlayer(camera, target, previous, position, 1 / fps);
      expect(
        camera.position.clone().sub(target).distanceTo(offset),
      ).toBeLessThan(1e-10);
      return previous.x;
    };
    expect(simulate(30)).toBeCloseTo(simulate(60), 8);
    expect(simulate(60)).toBeGreaterThan(3.99);
  });
  it("abre con el encuadre cercano elegido", () => {
    const player = new THREE.Vector3(1, 0, 3);
    const camera = createThirdPersonCamera(1.6);
    const target = new THREE.Vector3();
    resetCamera(camera, target, player);
    expect(camera.isPerspectiveCamera).toBe(true);
    expect(camera.fov).toBe(62);
    expect(camera.position.toArray()).toEqual([1, 3.7, 8]);
    expect(target.toArray()).toEqual([1, 1.2, 1]);
  });

  it("sigue al caminar sin perder el giro ni la distancia elegidos", () => {
    const camera = createThirdPersonCamera(1.6);
    const previous = new THREE.Vector3(1, 0, 3);
    const target = new THREE.Vector3();
    resetCamera(camera, target, previous);
    camera.position.set(6, 4, 7);
    const offset = camera.position.clone().sub(target);
    const position = new THREE.Vector3(-2, 0, -4);
    followPlayer(camera, target, previous, position);
    expect(target.toArray()).toEqual([-2, 1.2, -6]);
    expect(camera.position.clone().sub(target).distanceTo(offset)).toBeLessThan(
      1e-10,
    );
    expect(previous.toArray()).toEqual(position.toArray());
    const before = camera.position.clone();
    followPlayer(camera, target, previous, position);
    expect(camera.position.toArray()).toEqual(before.toArray());
  });
});
