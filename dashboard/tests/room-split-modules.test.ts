import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  animateAgent,
  stepActor,
  turnToward,
  type Actor,
} from "../src/features/room/room-actors";
import { mapPercent, toPlace } from "../src/features/room/room-markup";
const actor = (over: Partial<Actor> = {}) => {
  const animations: string[] = [];
  const root = new THREE.Group();
  const value = {
    raiz: root,
    spec: { id: "ambar" },
    animar: (_dt: number, action: string) => animations.push(action),
    liberar: () => {},
    route: [],
    speed: 2,
    angle: 0,
    phase: "rest",
    remaining: 5,
    activity: { x: 0, z: 0, zone: "terrace", label: "Descansa" },
    celebrateUntil: 0,
    props: { cafe: new THREE.Object3D(), garden: new THREE.Object3D() },
    ...over,
  } as unknown as Actor;
  return { value, animations };
};

describe("room actors", () => {
  it("walks along the route and drops reached points", () => {
    const { value } = actor({
      route: [
        { x: 0, z: 0.01 },
        { x: 0, z: 1 },
      ],
    });
    expect(stepActor(value, 0.1)).toBe(true);
    expect(value.route).toHaveLength(1);
    expect(value.raiz.position.z).toBeCloseTo(0.2);
    value.route = [];
    expect(stepActor(value, 0.1)).toBe(false);
  });

  it("turns by the shortest way", () => {
    const { value } = actor({ angle: -3 });
    value.raiz.rotation.y = 3;
    turnToward(value, 1, 10);
    expect(value.raiz.rotation.y).toBeCloseTo(3 + (2 * Math.PI - 6));
  });

  it("arrives, then rests until her time is over", () => {
    const { value, animations } = actor({
      phase: "going",
      leisureMode: true,
    });
    let arrived = 0,
      restOver = 0;
    const options = {
      reducedMotion: false,
      restSeconds: 1,
      isBusy: () => false,
      onArrive: () => arrived++,
      onRestOver: () => restOver++,
    };
    expect(animateAgent(value, 0.5, 0, options)).toBe(false);
    expect(value.phase).toBe("rest");
    expect(arrived).toBe(1);
    expect(value.remaining).toBeCloseTo(0.5);
    animateAgent(value, 0.6, 0, options);
    expect(restOver).toBe(1);
    expect(animations).toEqual(["quieta", "quieta"]);
  });

  it("types while her session works and celebrates a finished one", () => {
    const { value, animations } = actor({ phase: "working", remaining: 9 });
    const options = {
      reducedMotion: false,
      restSeconds: 1,
      isBusy: () => true,
      onArrive: () => {},
      onRestOver: () => {},
    };
    animateAgent(value, 0.1, 0, options);
    value.celebrateUntil = 100;
    animateAgent(value, 0.1, 50, options);
    expect(animations).toEqual(["teclea", "festeja"]);
  });

  it("shows only the prop of the zone she rests in", () => {
    const { value } = actor({
      activity: { x: 0, z: 0, zone: "cafe", label: "" } as Actor["activity"],
    });
    animateAgent(value, 0.1, 0, {
      reducedMotion: true,
      restSeconds: 1,
      isBusy: () => false,
      onArrive: () => {},
      onRestOver: () => {},
    });
    expect(value.props.cafe.visible).toBe(true);
    expect(value.props.garden.visible).toBe(false);
  });
});

describe("room markup", () => {
  it("places world points on the 32 x 24 minimap", () => {
    expect(mapPercent(-16, -12)).toEqual({ left: "0%", top: "0%" });
    expect(mapPercent(0, 0)).toEqual({ left: "50%", top: "50%" });
  });

  it("writes Spanish destinations with the right article", () => {
    expect(toPlace({ place: "el Taller" })).toBe("al Taller");
    expect(toPlace({ place: "la Terraza" })).toBe("a la Terraza");
  });
});
