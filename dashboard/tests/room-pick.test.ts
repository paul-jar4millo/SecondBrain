import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { cursorFor, pickTarget } from "../src/features/room/room-pick";

function rayThroughOrigin() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const rays = new THREE.Raycaster();
  rays.setFromCamera(new THREE.Vector2(0, 0), camera);
  return rays;
}
function zoneSign(tool: string) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
  sprite.scale.set(4.4, 1.1, 1);
  sprite.userData.tool = tool;
  sprite.updateMatrixWorld();
  return sprite;
}

describe("picking in the refuge", () => {
  it("lets clicks pass through a decorative phase label to the tool behind it", () => {
    const phase = zoneSign("");
    phase.position.z = 2;
    phase.updateMatrixWorld();
    const tool = zoneSign("/tasks");
    expect(
      pickTarget(rayThroughOrigin(), { actors: [], labels: [phase, tool] }),
    ).toEqual({ kind: "tool", tool: "/tasks" });
  });
  it("ignores hidden zone signs, so a click on empty space never opens a tool", () => {
    const sign = zoneSign("/team");
    sign.visible = false;
    expect(pickTarget(rayThroughOrigin(), { actors: [], labels: [sign] })).toBe(
      null,
    );
  });
  it("opens the tool of a visible sign", () => {
    const sign = zoneSign("/team");
    expect(
      pickTarget(rayThroughOrigin(), { actors: [], labels: [sign] }),
    ).toEqual({ kind: "tool", tool: "/team" });
  });
  it("ignores a sign whose parent group is hidden", () => {
    const group = new THREE.Group();
    const sign = zoneSign("/tasks");
    group.add(sign);
    group.visible = false;
    group.updateMatrixWorld();
    expect(pickTarget(rayThroughOrigin(), { actors: [], labels: [sign] })).toBe(
      null,
    );
  });
  it("still picks an agent through her invisible hit cylinder", () => {
    const root = new THREE.Group();
    const toque = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 2, 6),
      new THREE.MeshBasicMaterial(),
    );
    toque.visible = false;
    root.add(toque);
    root.updateMatrixWorld();
    const actor = { spec: { id: "lira" }, toque, raiz: root };
    expect(
      pickTarget(rayThroughOrigin(), { actors: [actor], labels: [] }),
    ).toEqual({ kind: "agent", id: "lira" });
  });
  it("does not pick an agent whose whole figure is hidden", () => {
    const root = new THREE.Group();
    const toque = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.4, 2, 6),
      new THREE.MeshBasicMaterial(),
    );
    root.add(toque);
    root.visible = false;
    root.updateMatrixWorld();
    expect(
      pickTarget(rayThroughOrigin(), {
        actors: [{ spec: { id: "lira" }, toque, raiz: root }],
        labels: [],
      }),
    ).toBe(null);
  });
});

describe("cursor over the world", () => {
  it("tells what a click would do before clicking", () => {
    expect(cursorFor({ kind: "agent", id: "lira" })).toBe("pointer");
    expect(cursorFor({ kind: "tool", tool: "/team" })).toBe("pointer");
    expect(cursorFor({ kind: "floor", reachable: true })).toBe("crosshair");
    expect(cursorFor({ kind: "floor", reachable: false })).toBe("not-allowed");
    expect(cursorFor(null)).toBe("default");
  });
});
