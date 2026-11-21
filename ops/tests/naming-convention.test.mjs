import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  findings,
  operationalFindings,
  operationalNamesIn,
  spanishWords,
} from "../naming.mjs";

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

test("flags new Spanish routes, environment names, scripts and units", () => {
  assert.deepEqual(
    operationalNamesIn(
      "service/routes.mjs",
      '"POST /solicitudes/crear"; process.env.SB_AGENT; process.env.SB_NUEVA_TAREA;',
    ),
    ["env:SB_NUEVA_TAREA", "route:/solicitudes/crear"],
  );
  assert.deepEqual(
    operationalNamesIn(
      "launcher/threads/http/routes.ts",
      /^\/threads\/borrar$/.toString(),
    ),
    ["route:/threads/borrar"],
  );
  assert.deepEqual(
    operationalNamesIn("ops/notifications/segundo-aviso@.service", "[Service]"),
    [
      "ops:ops/notifications/segundo-aviso@.service",
      "unit:segundo-aviso@.service",
    ],
  );
  assert.deepEqual(
    operationalNamesIn(
      "service/http/legacy-paths.mjs",
      '"/agentes": "/agents"',
    ),
    [],
  );
});

test("the operational naming baseline only shrinks", () => {
  const allowed = JSON.parse(
    readFileSync(
      new URL("../operational-naming-legacy.json", import.meta.url),
      "utf8",
    ),
  );
  const findings = operationalFindings();
  assert.deepEqual(
    findings.filter((name) => !allowed.includes(name)),
    [],
  );
  assert.deepEqual(
    allowed.filter((/** @type {string} */ name) => !findings.includes(name)),
    [],
    "Remove legacy operational names once their last reference has been retired.",
  );
});
