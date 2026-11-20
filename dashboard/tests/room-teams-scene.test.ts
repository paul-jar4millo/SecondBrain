import { describe, it, expect } from "vitest";
import {
  figurasEsperandoOk,
  sceneTeams,
  teamSeats,
} from "../src/features/room/room-teams";
import { sceneSessions } from "../src/features/room/room-sessions";
import { fixtureThread } from "./thread-fixture";

it("seats live parent and child threads around one table and draws their links", () => {
  const threads = [
    fixtureThread("leaf", "agy", "running", "child"),
    fixtureThread("child", "codex", "waiting-user", "root"),
    fixtureThread("root", "claude", "running"),
    fixtureThread("done", "deepseek", "done", "root"),
  ];
  const { grupos, hilos } = sceneTeams(threads, sceneSessions(threads).figures);
  expect(grupos).toHaveLength(1);
  expect(hilos).toEqual([
    { de: "menta", a: "lira" },
    { de: "ambar", a: "menta" },
  ]);
  const seats = teamSeats(grupos);
  expect([...seats.keys()].sort()).toEqual(["ambar", "lira", "menta"]);
  expect(new Set([...seats.values()].map(({ x, z }) => x + "," + z)).size).toBe(
    3,
  );
  expect(seats.get("ambar")?.angle).toBeCloseTo(Math.PI, 2);
});

it("keeps independent teams at different tables", () => {
  const seats = teamSeats([
    { equipoId: "a", miembros: ["ambar", "menta"] },
    { equipoId: "b", miembros: ["lira", "marina"] },
  ]);
  expect(seats.get("ambar")?.mesa).not.toBe(seats.get("lira")?.mesa);
});

describe("aprobaciones pendientes", () => {
  const now = 1000;
  it("marca la figura del agente con una solicitud vigente", () => {
    const ids = figurasEsperandoOk(
      [
        { actor: "agente:menta", estado: "pendiente", vence: 5000 },
        { actor: "agente:lira", estado: "aprobada", vence: 5000 },
        { actor: "agente:marina", estado: "pendiente", vence: 900 },
        { actor: "mcp:claude", estado: "pendiente", vence: 5000 },
        { actor: "app", estado: "pendiente", vence: 5000 },
      ],
      now,
    );
    expect([...ids]).toEqual(["menta"]);
  });
  it("deja de esperar cuando se decide o vence", () => {
    const base = { actor: "agente:ambar", vence: 2000 };
    expect(
      figurasEsperandoOk([{ ...base, estado: "pendiente" }], now).size,
    ).toBe(1);
    expect(
      figurasEsperandoOk([{ ...base, estado: "rechazada" }], now).size,
    ).toBe(0);
    expect(
      figurasEsperandoOk([{ ...base, estado: "pendiente" }], 2000).size,
    ).toBe(0);
  });
});
