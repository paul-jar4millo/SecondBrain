import test from "node:test";
import assert from "node:assert/strict";
import { inferirFase } from "../fases.mjs";

test("clasifica actividad de herramientas sin llamar a un modelo", () => {
  assert.equal(inferirFase("WebSearch"), "investigar");
  assert.equal(inferirFase("Read"), "investigar");
  assert.equal(inferirFase("Plan"), "planificar");
  assert.equal(inferirFase("Edit"), "programar");
  assert.equal(inferirFase("git diff"), "revisar");
  assert.equal(inferirFase("npm test"), "revisar");
  assert.equal(inferirFase("desconocido"), null);
});
