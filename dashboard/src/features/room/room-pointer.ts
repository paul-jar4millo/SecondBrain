// Pointer: pick what is drawn, walk to the closest free spot, refuse the sea.
import * as THREE from "three";
import type { Actor } from "./room-actors";
import type { createNavigation, Point } from "./room-life";
import { cursorFor, pickTarget } from "./room-pick";

/** The parts of a loaded world the pointer reads. */
export interface PointerWorld {
  camera: THREE.Camera;
  nav: ReturnType<typeof createNavigation> | null;
  actors: Actor[];
  labels: THREE.Sprite[];
}

export function createPointer({
  canvas,
  world,
  canClick,
  onAgent,
  onTool,
  onFloor,
  onSea,
}: {
  canvas: () => HTMLCanvasElement;
  world: () => PointerWorld;
  /** False while loading or while a field or dialog has the input. */
  canClick: () => boolean;
  onAgent: (id: string) => void;
  onTool: (tool: string) => void;
  /** A free spot near the click. */
  onFloor: (spot: Point) => void;
  /** Nothing walkable near the click. */
  onSea: (point: THREE.Vector3) => void;
}) {
  const rays = new THREE.Raycaster(),
    mouse = new THREE.Vector2(),
    plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    floorPoint = new THREE.Vector3();
  let pointerStart: { x: number; y: number; button: number } | null = null;
  const hover = { x: 0, y: 0, pending: false };

  function aim(clientX: number, clientY: number) {
    const rect = canvas().getBoundingClientRect();
    mouse.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      (-(clientY - rect.top) / rect.height) * 2 + 1,
    );
    rays.setFromCamera(mouse, world().camera);
  }
  function floorUnderRay() {
    const { nav } = world();
    if (!nav) return null;
    if (!rays.ray.intersectPlane(plane, floorPoint)) return null;
    return {
      point: floorPoint,
      spot: nav.nearestFree({ x: floorPoint.x, z: floorPoint.z }, 2.5),
    };
  }
  const pick = () => {
    const { actors, labels } = world();
    return pickTarget(rays, { actors, labels });
  };

  return {
    down(e: PointerEvent) {
      pointerStart = { x: e.clientX, y: e.clientY, button: e.button };
    },
    /** A short left click: open what was hit, or walk toward the floor. */
    up(e: PointerEvent, ready: boolean) {
      if (!ready) return;
      const start = pointerStart;
      pointerStart = null;
      if (
        !canClick() ||
        !start ||
        start.button !== 0 ||
        Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8
      )
        return;
      aim(e.clientX, e.clientY);
      const target = pick();
      if (target?.kind === "agent") return onAgent(target.id);
      if (target?.kind === "tool") return onTool(target.tool);
      const floor = floorUnderRay();
      if (!floor) return;
      if (floor.spot) onFloor(floor.spot);
      else onSea(floor.point);
    },
    move(e: PointerEvent) {
      if (e.pointerType !== "mouse" || e.buttons) return;
      hover.x = e.clientX;
      hover.y = e.clientY;
      hover.pending = true;
    },
    /** Once per frame: the cursor tells what a click would do. */
    updateCursor() {
      if (!hover.pending) return;
      hover.pending = false;
      aim(hover.x, hover.y);
      const target = pick();
      let cursor;
      if (target) cursor = cursorFor(target);
      else {
        const floor = floorUnderRay();
        cursor = cursorFor(
          floor ? { kind: "floor", reachable: !!floor.spot } : null,
        );
      }
      const node = canvas();
      if (node.style.cursor !== cursor) node.style.cursor = cursor;
    },
  };
}
