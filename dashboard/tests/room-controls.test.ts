import { expect, it } from "vitest";
import {
  advanceTour,
  thumbAxis,
  observedCompletions,
} from "../src/features/room/room-controls";
it("keeps touch drift still and caps diagonal movement at the same speed", () => {
  expect(thumbAxis(2, 2, 40)).toEqual({ x: 0, y: 0 });
  const diagonal = thumbAxis(80, -80, 40);
  expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
  expect(diagonal.x).toBeGreaterThan(0);
  expect(diagonal.y).toBeLessThan(0);
});
it("teaches walking, reading a zone and opening a tool in that order", () => {
  expect(advanceTour(0, "open")).toBe(0);
  expect(advanceTour(0, "walk")).toBe(1);
  expect(advanceTour(1, "zone")).toBe(2);
  expect(advanceTour(2, "open")).toBe(3);
  expect(advanceTour(3, "walk")).toBe(3);
});
it("celebrates only a new observed successful job, never history, errors or repeated polls", () => {
  const state = (state: string, jobId = "j1") => ({
    conectado: true,
    agentes: [{ id: "marina", ultimo: { estado: state, jobId } }],
  });
  expect(observedCompletions(null, state("listo"))).toEqual([]);
  expect(observedCompletions(state("ejecutando"), state("listo"))).toEqual([
    "marina",
  ]);
  expect(observedCompletions(state("listo"), state("listo"))).toEqual([]);
  expect(observedCompletions(state("ejecutando"), state("error"))).toEqual([]);
  expect(observedCompletions(state("listo"), state("listo", "j2"))).toEqual([
    "marina",
  ]);
  expect(
    observedCompletions({ conectado: false, agentes: [] }, state("listo")),
  ).toEqual([]);
});
