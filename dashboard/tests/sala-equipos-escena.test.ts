import { describe, expect, it } from "vitest";
import {
  equiposEscena,
  figurasEsperandoOk,
  puestosEquipo,
  relevosNuevos,
} from "../src/features/sala/sala-equipos";
import { figuraDeSesion } from "../src/features/sala/sala-sesiones";
import type { SesionObservada } from "../src/features/sala/sala-sesiones";

const sesion = (
  id: string,
  motor: SesionObservada["motor"],
  extra: Partial<SesionObservada> = {},
): SesionObservada => ({
  id,
  motor,
  copia: 0,
  estado: "trabajando",
  ...extra,
});
const equipo = [
  sesion("lider", "claude", { equipoId: "e1" }),
  sesion("h1", "codex", { equipoId: "e1", padreId: "lider" }),
  sesion("h2", "agy", { equipoId: "e1", padreId: "lider" }),
];

describe("figuras de sesión", () => {
  it("usa el personaje base y marca las copias", () => {
    expect(figuraDeSesion({ motor: "codex", copia: 0 })).toBe("menta");
    expect(figuraDeSesion({ motor: "codex", copia: 2 })).toBe("menta#2");
  });
});

describe("agrupación por equipo", () => {
  it("agrupa a la líder primero y une cada hija con un hilo", () => {
    const { grupos, hilos } = equiposEscena([...equipo].reverse());
    expect(grupos).toEqual([
      { equipoId: "e1", miembros: ["ambar", "lira", "menta"] },
    ]);
    expect(hilos.map((h) => [h.de, h.a]).sort()).toEqual([
      ["ambar", "lira"],
      ["ambar", "menta"],
    ]);
  });

  it("el hilo desaparece cuando la hija termina", () => {
    const terminada = equipo.map((s) =>
      s.id === "h2" ? { ...s, estado: "terminada" } : s,
    );
    const { grupos, hilos } = equiposEscena(terminada);
    expect(hilos.map((h) => h.hijaSesionId)).toEqual(["h1"]);
    expect(grupos[0].miembros).toEqual(["ambar", "menta"]);
  });

  it("no agrupa una sesión sola ni sesiones sin equipo", () => {
    const solas = [
      sesion("a", "claude", { equipoId: "e1" }),
      sesion("b", "codex"),
      sesion("c", "agy", { equipoId: "e2", estado: "error" }),
    ];
    expect(equiposEscena(solas)).toEqual({ grupos: [], hilos: [] });
  });

  it("separa equipos distintos y ubica cada copia con su figura", () => {
    const dos = [
      ...equipo,
      sesion("l2", "deepseek", { equipoId: "e2" }),
      sesion("c2", "claude", {
        equipoId: "e2",
        padreId: "l2",
        copia: 1,
      }),
    ];
    const { grupos, hilos } = equiposEscena(dos);
    expect(grupos.map((g) => g.equipoId)).toEqual(["e1", "e2"]);
    expect(hilos.find((h) => h.equipoId === "e2")).toMatchObject({
      de: "marina",
      a: "ambar#1",
    });
  });

  it("ignora hijas cuya madre ya no está activa", () => {
    const huerfana = [
      sesion("lider", "claude", { equipoId: "e1", estado: "terminada" }),
      sesion("h1", "codex", { equipoId: "e1", padreId: "lider" }),
      sesion("h2", "agy", { equipoId: "e1", padreId: "lider" }),
    ];
    expect(equiposEscena(huerfana).hilos).toEqual([]);
  });
});

describe("puestos alrededor de la mesa", () => {
  it("reparte a cada miembro en un círculo distinto mirando a la mesa", () => {
    const { grupos } = equiposEscena(equipo);
    const puestos = puestosEquipo(grupos);
    expect([...puestos.keys()].sort()).toEqual(["ambar", "lira", "menta"]);
    const coords = [...puestos.values()].map((p) => `${p.x},${p.z}`);
    expect(new Set(coords).size).toBe(3);
    for (const p of puestos.values()) expect(p.mesa).toBe("revisar");
    // The leader sits on the south side, facing north (angle π).
    expect(puestos.get("ambar")!.angle).toBeCloseTo(Math.PI, 2);
  });

  it("usa mesas distintas para equipos distintos", () => {
    const puestos = puestosEquipo([
      { equipoId: "a", miembros: ["ambar", "menta"] },
      { equipoId: "b", miembros: ["lira", "marina"] },
    ]);
    expect(puestos.get("ambar")!.mesa).not.toBe(puestos.get("lira")!.mesa);
  });
});

describe("relevos reales del lanzador", () => {
  const conRelevo = equipo.map((s) =>
    s.id === "h1"
      ? { ...s, relevo: { id: "r1", tipo: "entregable", para: "lider" } }
      : s,
  );
  it("devuelve solo relevos nuevos entre figuras activas", () => {
    const { nuevos, ids } = relevosNuevos(conRelevo, new Set());
    expect(ids).toEqual(["r1"]);
    expect(nuevos).toEqual([
      { id: "r1", tipo: "entregable", de: "menta", para: "ambar" },
    ]);
    expect(relevosNuevos(conRelevo, new Set(["r1"])).nuevos).toEqual([]);
  });
  it("no inventa relevos y descarta los de sesiones terminadas", () => {
    expect(relevosNuevos(equipo, new Set()).nuevos).toEqual([]);
    const fin = conRelevo.map((s) =>
      s.id === "lider" ? { ...s, estado: "terminada" } : s,
    );
    const r = relevosNuevos(fin, new Set());
    expect(r.nuevos).toEqual([]);
    expect(r.ids).toEqual(["r1"]);
  });
});

describe("aprobaciones pendientes", () => {
  const ahora = 1000;
  it("marca la figura del agente con una solicitud vigente", () => {
    const ids = figurasEsperandoOk(
      [
        { actor: "agente:menta", estado: "pendiente", vence: 5000 },
        { actor: "agente:lira", estado: "aprobada", vence: 5000 },
        { actor: "agente:marina", estado: "pendiente", vence: 900 },
        { actor: "mcp:claude", estado: "pendiente", vence: 5000 },
        { actor: "app", estado: "pendiente", vence: 5000 },
      ],
      ahora,
    );
    expect([...ids]).toEqual(["menta"]);
  });
  it("deja de esperar cuando se decide o vence", () => {
    const base = { actor: "agente:ambar", vence: 2000 };
    expect(
      figurasEsperandoOk([{ ...base, estado: "pendiente" }], ahora).size,
    ).toBe(1);
    expect(
      figurasEsperandoOk([{ ...base, estado: "rechazada" }], ahora).size,
    ).toBe(0);
    expect(
      figurasEsperandoOk([{ ...base, estado: "pendiente" }], 2000).size,
    ).toBe(0);
  });
});
