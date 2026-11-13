import test from "node:test";
import assert from "node:assert/strict";
import { eventoHook } from "../hook.mjs";

test("el hook conserva solo el identificador de sesión y nombre de herramienta", () => {
  const result = eventoHook(
    { tool_name: "Read", tool_input: { path: "/private/secreto" } },
    "sesion",
  );
  assert.deepEqual(result, { id: "sesion", herramienta: "Read" });
  assert.equal(eventoHook({ tool_name: "" }, "sesion"), null);
  assert.equal(eventoHook({ tool_name: "Read" }, ""), null);
});
