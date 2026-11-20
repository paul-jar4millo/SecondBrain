import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findings, spanishWords } from "../naming.mjs";

const legacy = JSON.parse(
  readFileSync(new URL("../naming-legacy.json", import.meta.url), "utf8"),
);

test("detecta palabras en español en nombres de archivo e identificadores", () => {
  assert.deepEqual(spanishWords("crearEjecutor"), ["crear", "ejecutor"]);
  assert.deepEqual(spanishWords("sala-sesiones"), ["sala", "sesiones"]);
  assert.deepEqual(spanishWords("ErrorBoundary"), []);
  assert.deepEqual(spanishWords("createExecutor"), []);
});

test("el código nuevo usa nombres en inglés (ADR 0007)", () => {
  const current = findings();
  const known = new Set(legacy);
  assert.deepEqual(
    current.filter((item) => !known.has(item)),
    [],
    "Nombres nuevos en español: usa inglés (docs/adr/0007-english-identifiers.md)",
  );
});

test("la lista heredada solo se reduce", () => {
  const current = new Set(findings());
  assert.deepEqual(
    legacy.filter((/** @type {string} */ item) => !current.has(item)),
    [],
    "Ya no existen: quítalos de ops/naming-legacy.json",
  );
});
