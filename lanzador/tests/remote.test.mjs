import test from "node:test";
import assert from "node:assert/strict";
import { comandoRemoto } from "../remote.mjs";

test("la sala abre Claude en modo interactivo con identidad local estable y Remote Control", () => {
  const s = comandoRemoto(
    { motor: "claude", id: "test", modelo: null },
    "Hola",
  );
  assert.equal(s.bin, "claude");
  assert.ok(s.args.includes("--remote-control=SecondBrain"));
  assert.ok(s.args.includes("--session-id"));
  assert.ok(!s.args.includes("-p"));
  assert.equal(s.args.at(-1), "Hola");
});
test("Antigravity abre el prompt interactivo y activa su conexión remota", () => {
  const s = comandoRemoto({ motor: "agy", id: "test" }, "Hola");
  assert.equal(s.bin, "agy");
  assert.ok(s.args.includes("--remote-control"));
  assert.ok(!s.args.includes("--prompt-interactive"));
  assert.ok(!s.args.includes("-p"));
});
