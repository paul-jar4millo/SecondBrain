import test from "node:test";
import assert from "node:assert/strict";
import { ROUTES } from "../routes.mjs";
import { buildRoutes } from "../http/routes/index.mjs";

// Team actions are proxied to the launcher before the route map is consulted.
const TEAM_ACTION = /^POST \/equipo\//;

test("cada ruta con política tiene un manejador y viceversa", () => {
  // Building the map only creates closures; no handler runs.
  const ctx = /** @type {any} */ ({ bridges: {} });
  const req = /** @type {any} */ ({});
  const handled = new Set(Object.keys(buildRoutes(ctx, req)));
  const policies = new Set(
    [...ROUTES.keys()].filter((key) => !TEAM_ACTION.test(key)),
  );
  assert.deepEqual(
    [...policies].filter((key) => !handled.has(key)),
    [],
    "rutas con política pero sin manejador",
  );
  assert.deepEqual(
    [...handled].filter((key) => !policies.has(key)),
    [],
    "manejadores sin política",
  );
});
