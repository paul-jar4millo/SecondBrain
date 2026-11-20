// Renderer, lights, camera and orbit controls of the refuge.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { resetCamera } from "./room-camera";
import { FONDO } from "./room-world";

export function createStage(
  canvas: HTMLCanvasElement,
  { antialias }: { antialias: boolean },
) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias,
    powerPreference: "high-performance",
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // The map is static: shadows are redrawn only when something moves.
  renderer.shadowMap.autoUpdate = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(FONDO);
  scene.add(new THREE.HemisphereLight("#c9d8ff", "#3d52c4", 2));
  const sun = new THREE.DirectionalLight("#fff3df", 1.35);
  sun.position.set(13, 26, 19);
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -24,
    right: 24,
    top: 22,
    bottom: -22,
    near: 1,
    far: 80,
  });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);
  return { renderer, scene, sun };
}

export function createOrbit(
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
  reducedMotion: boolean,
) {
  const controls = new OrbitControls(camera, canvas);
  resetCamera(camera, controls.target, new THREE.Vector3(1, 0, 3));
  controls.enableDamping = !reducedMotion;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 3;
  controls.maxDistance = 14;
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = 1.45;
  controls.mouseButtons = {
    LEFT: null,
    MIDDLE: null,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_ROTATE,
  };
  controls.update();
  return controls;
}

/** Zoom, turn or recenter from the HUD camera buttons. */
export function nudgeCamera(
  action: string | undefined,
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  player: THREE.Vector3 | null,
) {
  if (action === "in" || action === "out") {
    const offset = camera.position.clone().sub(controls.target);
    offset.setLength(
      THREE.MathUtils.clamp(
        offset.length() * (action === "in" ? 1 / 1.2 : 1.2),
        controls.minDistance,
        controls.maxDistance,
      ),
    );
    camera.position.copy(controls.target).add(offset);
  }
  if (action === "left" || action === "right") {
    const offset = camera.position
      .clone()
      .sub(controls.target)
      .applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        action === "left" ? 0.35 : -0.35,
      );
    camera.position.copy(controls.target).add(offset);
  }
  if (action === "home" && player) {
    resetCamera(camera, controls.target, player);
  }
  controls.update();
}
