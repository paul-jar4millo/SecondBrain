import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createNavigation,
  activityFor,
  normalizeOrder,
  ZONES,
  BASE_IDS,
  puestoPara,
  interactionPrompt,
  zoneGuide,
} from "../src/features/room/room-life";

describe("living room navigation", () => {
  it("routes around furniture without cutting corners or leaving the map", () => {
    const nav = createNavigation(12, 10, [{ x0: -1, x1: 1, z0: -3, z1: 3 }]);
    const route = nav.route({ x: -3, z: 0 }, { x: 3, z: 0 });
    expect(route.length).toBeGreaterThan(0);
    expect(route.some((p) => Math.abs(p.z) > 3.25)).toBe(true);
    expect(route.every((p) => nav.free(p.x, p.z))).toBe(true);
    expect(nav.free(8, 0)).toBe(false);
  });
  it("does not send an actor through an impassable partition", () => {
    const nav = createNavigation(12, 10, [{ x0: -1, x1: 1, z0: -5, z1: 5 }]);
    expect(nav.route({ x: -3, z: 0 }, { x: 3, z: 0 })).toEqual([]);
  });
});
describe("four base agents", () => {
  it("elige un puesto por tarea y reserva un lugar distinto para cada personaje", () => {
    const research = puestoPara("ambar", {
      fase: "Investigar",
      zona: "library",
    });
    expect(research.nombre).toBe("Mesa de investigación");
    expect(
      puestoPara("ambar", { fase: "Planificar", zona: "terrace" }).nombre,
    ).toBe("Mesa de planificación");
    expect(
      puestoPara("ambar", { fase: "Revisar", zona: "workshop" }).nombre,
    ).toBe("Mesa de revisión");
    expect(
      puestoPara("ambar", { fase: "Programar", zona: "library" }).nombre,
    ).toBe("Mesa de investigación");
    const points = BASE_IDS.map((id) => puestoPara(id, { zona: "workshop" }));
    expect(new Set(points.map((p) => `${p.x},${p.z}`)).size).toBe(4);
  });
  it("honors an explicit destination before the role and uses the project for work", () => {
    expect(
      activityFor(
        "ambar",
        {
          instruction: "Investiga referencias en la biblioteca",
          project: "p1",
          mode: "work",
        },
        0,
      ).zone,
    ).toBe("library");
    expect(
      activityFor(
        "marina",
        { instruction: "Revisa el proyecto", project: "p2", mode: "work" },
        0,
      ).zone,
    ).toBe("workshop");
  });
  it("gives distinct leisure routines and ignores work instructions on a break", () => {
    expect(
      activityFor("menta", { instruction: "biblioteca", mode: "rest" }, 0).zone,
    ).toBe("garden");
    expect(activityFor("ambar", { mode: "rest" }, 0).zone).toBe("cafe");
    expect(activityFor("ambar", { mode: "rest" }, 1).zone).toBe("library");
  });
  it("rejects extra agents and invalid commands without changing existing assignments", () => {
    expect(() => normalizeOrder({ id: "custom", mode: "rest" })).toThrow();
    expect(() =>
      normalizeOrder({ id: "ambar", mode: "work", instruction: " " }),
    ).toThrow();
    expect(
      normalizeOrder({
        id: "lira",
        mode: "work",
        instruction: "  Diseña  ",
        project: "p1",
      }),
    ).toEqual({
      id: "lira",
      mode: "work",
      instruction: "Diseña",
      project: "p1",
    });
  });
});
describe("blue refuge map", () => {
  it("keeps every zone, activity spot and sign reachable from the spawn point", () => {
    const manifest = JSON.parse(
      readFileSync("public/models/sala/refugio-nav.json", "utf8"),
    );
    const nav = createNavigation(
      manifest.width,
      manifest.depth,
      manifest.obstacles,
    );
    const spawn = { x: 1, z: 3 };
    expect(nav.free(spawn.x, spawn.z)).toBe(true);
    for (const id of BASE_IDS)
      for (const fase of ["Investigar", "Planificar", "Programar", "Revisar"]) {
        const spot = puestoPara(id, { fase });
        expect(nav.free(spot.x, spot.z), `${id}: ${fase}`).toBe(true);
        const route = nav.route(spawn, spot);
        expect(route.length).toBeGreaterThan(0);
        const end = route.at(-1)!;
        expect(Math.hypot(end.x - spot.x, end.z - spot.z)).toBeLessThan(0.36);
      }
    for (const zone of ZONES) {
      expect(nav.free(zone.x, zone.z)).toBe(true);
      expect(nav.free(zone.x, zone.z - 1.8)).toBe(true);
      expect(nav.route(spawn, zone).length).toBeGreaterThan(0);
    }
    for (const id of BASE_IDS)
      for (let cycle = 0; cycle < 3; cycle++) {
        const rest = activityFor(id, { mode: "rest" }, cycle);
        expect(nav.free(rest.x, rest.z)).toBe(true);
        const work = activityFor(
          id,
          { mode: "work", instruction: "x", project: "p".repeat(cycle + 1) },
          cycle,
        );
        expect(nav.free(work.x, work.z)).toBe(true);
      }
  });
});
describe("clicks on blocked ground", () => {
  it("snaps a click on furniture to the closest free spot", () => {
    const nav = createNavigation(12, 10, [{ x0: -1, x1: 1, z0: -1, z1: 1 }]);
    const spot = nav.nearestFree({ x: 0.2, z: 0 }, 3)!;
    expect(nav.free(spot.x, spot.z)).toBe(true);
    expect(Math.hypot(spot.x - 0.2, spot.z)).toBeLessThan(1.6);
  });
  it("keeps a free click where it is", () => {
    const nav = createNavigation(12, 10, []);
    expect(nav.nearestFree({ x: 2.1, z: -1.3 }, 3)).toEqual({
      x: 2.1,
      z: -1.3,
    });
  });
  it("refuses a click far outside the floor", () => {
    const nav = createNavigation(12, 10, []);
    expect(nav.nearestFree({ x: 40, z: 0 }, 3)).toBe(null);
  });
});
describe("honest interaction prompts", () => {
  it("names the tool and the place for each zone", () => {
    expect(ZONES.find((z) => z.id === "terrace")!.tool).toBe("/team");
    expect(
      interactionPrompt(
        ZONES.find((z) => z.id === "terrace")!,
        "keyboard",
      ),
    ).toBe("E · Equipo en la Terraza");
    expect(
      interactionPrompt(
        ZONES.find((z) => z.id === "cafe")!,
        "keyboard",
      ),
    ).toBe("E · Finanzas en el Café");
    expect(
      interactionPrompt(
        ZONES.find((z) => z.id === "workshop")!,
        "keyboard",
      ),
    ).toBe("E · Proyectos en el Taller");
  });
  it("speaks touch on touch screens", () => {
    expect(interactionPrompt({ spec: { nombre: "Lira" } }, "touch")).toBe(
      "Tocar · Hablar con Lira",
    );
    expect(
      interactionPrompt(
        ZONES.find((z) => z.id === "library")!,
        "touch",
      ),
    ).toBe("Tocar · Tareas en la Biblioteca");
  });
  it("lists every zone tool in plain words for the help panel", () => {
    expect(zoneGuide()).toBe(
      "Equipo en la Terraza, Proyectos en el Taller, Tareas en la Biblioteca, Maletín en el Invernadero y Finanzas en el Café",
    );
  });
});
