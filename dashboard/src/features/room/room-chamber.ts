// Shared toon ramp for the Blender characters. The environment is refugio.glb.
import * as THREE from "three";
export const rampa = new THREE.DataTexture(
  new Uint8Array([70, 70, 70, 255, 150, 150, 150, 255, 255, 255, 255, 255]),
  3,
  1,
);
rampa.minFilter = rampa.magFilter = THREE.NearestFilter;
rampa.needsUpdate = true;
