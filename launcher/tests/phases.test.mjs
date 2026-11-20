import test from "node:test";
import assert from "node:assert/strict";
import { inferPhase } from "../phases.mjs";

test("clasifica actividad de herramientas sin llamar a un modelo", () => {
  assert.equal(inferPhase("WebSearch"), "investigar");
  assert.equal(inferPhase("Read"), "investigar");
  assert.equal(inferPhase("Plan"), "planificar");
  assert.equal(inferPhase("Edit"), "programar");
  assert.equal(inferPhase("git diff"), "revisar");
  assert.equal(inferPhase("npm test"), "revisar");
  assert.equal(inferPhase("desconocido"), null);
});
