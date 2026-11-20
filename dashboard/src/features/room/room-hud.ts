// HUD that follows the player: zone title, minimap dots and what is nearby.
import type * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Actor } from "./room-actors";
import { ZONES } from "./room-life";
import { mapPercent } from "./room-markup";

export type Nearby = Actor | (typeof ZONES)[number] | undefined;

const closestZone = (pos: THREE.Vector3) =>
  [...ZONES].sort(
    (a, b) =>
      Math.hypot(a.x - pos.x, a.z - pos.z) -
      Math.hypot(b.x - pos.x, b.z - pos.z),
  )[0];

const place = (node: HTMLElement, x: number, z: number) => {
  const { left, top } = mapPercent(x, z);
  node.style.left = left;
  node.style.top = top;
};

/** Repaints the HUD around the player and returns what is within reach. */
export function paintHud(
  root: HTMLElement,
  {
    player,
    actors,
    camera,
    controls,
    destination,
    statusText,
  }: {
    player: THREE.Vector3;
    actors: Actor[];
    camera: THREE.Camera;
    controls: OrbitControls;
    destination: THREE.Object3D;
    statusText: (id: string) => string;
  },
): Nearby {
  const q = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  const zone = closestZone(player);
  const title = q("#room-zone");
  if (title.textContent !== zone.name) {
    title.textContent = zone.name;
    title.classList.remove("swap");
    void title.offsetWidth;
    title.classList.add("swap");
  }
  root.querySelectorAll<HTMLElement>("[data-zone]").forEach((node) => {
    node.setAttribute("aria-current", String(node.dataset.zone === zone.id));
  });
  // Keep the minimap oriented like the camera, so "up" matches the screen.
  const view = camera.position.clone().sub(controls.target);
  q(".map-stage").style.setProperty(
    "--map-turn",
    `${Math.atan2(view.x, view.z)}rad`,
  );
  place(q(".map-player"), player.x, player.z);
  for (const actor of actors) {
    const dot = q(`[data-map-agent="${actor.spec.id}"]`);
    place(dot, actor.raiz.position.x, actor.raiz.position.z);
    dot.title = `${actor.spec.nombre} · ${statusText(actor.spec.id)}`;
  }
  const target = q(".map-destination");
  target.hidden = !destination.visible;
  place(target, destination.position.x, destination.position.z);
  return (
    actors.find((a) => a.raiz.position.distanceTo(player) < 2) ||
    ZONES.find((z) => Math.hypot(z.x - player.x, z.z - 1.8 - player.z) < 2)
  );
}

/** Mexico City time on the moon dial; returns a stop function. */
export function startClock(root: HTMLElement) {
  const q = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  const update = () => {
    const now = new Date();
    q("#room-time").textContent = now.toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Mexico_City",
    });
    const [hour, minute] = q("#room-time").textContent!.split(":").map(Number);
    q("#room-orbit").style.transform =
      `rotate(${((hour * 60 + minute) / 1440) * 360}deg)`;
    q("#room-date").textContent = now.toLocaleDateString("es-MX", {
      day: "numeric",
      month: "short",
      timeZone: "America/Mexico_City",
    });
  };
  update();
  const timer = setInterval(update, 30000);
  return () => clearInterval(timer);
}
