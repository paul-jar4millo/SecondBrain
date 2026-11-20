// Characters walking and acting in the refuge, advanced once per frame.
import type * as THREE from "three";
import type { createCharacter } from "./room-characters";
import type { activityFor, Point } from "./room-life";

type Person = Awaited<ReturnType<typeof createCharacter>>;
export interface Actor extends Person {
  route: Point[];
  speed: number;
  angle: number;
  phase: string;
  remaining: number;
  walking?: boolean;
  activity: ReturnType<typeof activityFor> & { angle?: number };
  leisureMode?: boolean;
  nombreTag?: THREE.Sprite;
  cueTag?: THREE.Sprite | null;
  okTag?: THREE.Sprite | null;
  celebrateUntil: number;
  liveKey?: string;
  cueText?: string;
  props: Record<string, THREE.Object3D>;
}

/** Advances an actor along its route; returns whether it moved. */
export function stepActor(actor: Actor, dt: number) {
  let walking = false;
  while (actor.route.length) {
    const p = actor.route[0],
      position = actor.raiz.position,
      dx = p.x - position.x,
      dz = p.z - position.z,
      d = Math.hypot(dx, dz);
    if (d < 0.07) {
      actor.route.shift();
      continue;
    }
    const v = Math.min(d, dt * actor.speed);
    position.x += (dx / d) * v;
    position.z += (dz / d) * v;
    actor.angle = Math.atan2(dx, dz);
    walking = true;
    break;
  }
  return walking;
}

/** Turns an actor toward its heading by the shortest way. */
export function turnToward(actor: Actor, dt: number, rate: number) {
  actor.raiz.rotation.y +=
    Math.atan2(
      Math.sin(actor.angle - actor.raiz.rotation.y),
      Math.cos(actor.angle - actor.raiz.rotation.y),
    ) * Math.min(1, dt * rate);
}

/**
 * One frame of an agent: walk, arrive, work or rest, show the props of the
 * zone she rests in, and pick the animation. Returns whether she walked.
 */
export function animateAgent(
  actor: Actor,
  dt: number,
  now: number,
  {
    reducedMotion,
    restSeconds,
    isBusy,
    onArrive,
    onRestOver,
  }: {
    reducedMotion: boolean;
    /** Rest length after arriving, staggered per agent. */
    restSeconds: number;
    /** Whether her thread is working right now. */
    isBusy: () => boolean;
    onArrive: () => void;
    onRestOver: () => void;
  },
) {
  const walking = stepActor(actor, dt);
  let action = walking ? "camina" : "quieta";
  if (!walking && actor.phase === "going") {
    actor.phase = actor.leisureMode ? "rest" : "working";
    onArrive();
    actor.remaining = actor.phase === "working" ? 7 : restSeconds;
  }
  if (!walking && actor.phase === "working")
    actor.angle = actor.activity.angle ?? Math.PI;
  if (!walking) {
    actor.remaining -= dt;
    if (actor.phase === "working") {
      action = isBusy() ? "teclea" : "quieta";
    } else if (
      (actor.phase === "rest" || actor.phase === "done") &&
      actor.remaining <= 0 &&
      !reducedMotion
    ) {
      onRestOver();
    }
  }
  if (!walking && actor.phase === "rest" && actor.activity.zone === "library")
    action = "teclea";
  if (!walking && actor.celebrateUntil > now && !reducedMotion)
    action = "festeja";
  for (const [zone, prop] of Object.entries(actor.props)) {
    prop.visible =
      !walking &&
      (actor.phase === "rest" ||
        (actor.phase === "working" && zone === "library")) &&
      actor.activity.zone === zone;
  }
  actor.props.cafe.position.y =
    1.12 + (reducedMotion ? 0 : Math.max(0, Math.sin(now / 1000)) * 0.18);
  actor.props.garden.rotation.z = reducedMotion
    ? 0
    : Math.sin(now / 1800) * 0.18;
  actor.animar(dt, action);
  turnToward(actor, dt, 8);
  return walking;
}
