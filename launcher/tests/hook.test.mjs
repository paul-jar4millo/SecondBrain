import test from "node:test";
import assert from "node:assert/strict";
import { eventHook } from "../hook.mjs";

test("el hook conserva solo el identificador de sesión y nombre de herramienta", () => {
  const result = eventHook(
    { tool_name: "Read", tool_input: { path: "/private/secreto" } },
    "sesion",
  );
  assert.deepEqual(result, { id: "sesion", herramienta: "Read" });
  assert.equal(eventHook({ tool_name: "" }, "sesion"), null);
  assert.equal(eventHook({ tool_name: "Read" }, ""), null);
});
