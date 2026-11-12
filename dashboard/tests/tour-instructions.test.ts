import { expect, it } from "vitest";
import { tourInstructions } from "../src/features/sala/sala-life";

it("enseña gestos táctiles sin pedir un teclado en el primer paseo móvil", () => {
  const steps = tourInstructions(true);
  expect(steps[0]).toContain("Toca el suelo");
  expect(steps[0]).toContain("Mover");
  expect(steps.join(" ")).not.toMatch(/WASD|con E/);
  expect(steps[2]).toContain("Toca el resumen");
});

it("conserva los atajos del primer paseo para teclado", () => {
  const steps = tourInstructions(false);
  expect(steps[0]).toContain("WASD");
  expect(steps[2]).toContain("con E");
});
