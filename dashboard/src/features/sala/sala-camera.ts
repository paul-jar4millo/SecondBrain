import * as THREE from "three";

export function createThirdPersonCamera(aspect: number) {
  return new THREE.PerspectiveCamera(62, aspect, 0.06, 220);
}

export function resetCamera(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  position: THREE.Vector3,
) {
  camera.position.copy(position).add(new THREE.Vector3(0, 3.7, 5));
  target.copy(position).add(new THREE.Vector3(0, 1.2, -2));
  camera.zoom = 1;
  camera.lookAt(target);
  camera.updateProjectionMatrix();
}

// Translate the orbit with the player, preserving the user's rotation and zoom.
export function followPlayer(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  previous: THREE.Vector3,
  position: THREE.Vector3,
  dt?: number,
) {
  const alpha = dt === undefined ? 1 : 1 - Math.exp(-12 * Math.max(0, dt));
  const dx = (position.x - previous.x) * alpha;
  const dy = (position.y - previous.y) * alpha;
  const dz = (position.z - previous.z) * alpha;
  camera.position.x += dx;
  camera.position.y += dy;
  camera.position.z += dz;
  target.x += dx;
  target.y += dy;
  target.z += dz;
  previous.x += dx;
  previous.y += dy;
  previous.z += dz;
}
