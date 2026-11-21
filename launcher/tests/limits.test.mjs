import test from "node:test";
import assert from "node:assert/strict";
import { readLimits, sessionCommand } from "../limits.mjs";
import { environmentOf } from "../engines.mjs";

test("the real provider environment carries only the local user's scope runtime", () => {
  const runtime = "/run/user/" + (process.getuid?.() ?? 1000);
  assert.equal(
    environmentOf("chatgpt", {
      SB_SESSION_SCOPES: "1",
      XDG_RUNTIME_DIR: runtime,
    }).XDG_RUNTIME_DIR,
    runtime,
  );
  assert.throws(
    () =>
      environmentOf("chatgpt", {
        SB_SESSION_SCOPES: "1",
        XDG_RUNTIME_DIR: "tcp:remote-host",
      }),
    /ejecución/,
  );
});

test("configured concurrency and retention reject malformed or zero values", () => {
  assert.deepEqual(
    readLimits({ SB_MAX_ACTIVE_TURNS: "2" }),
    { maxActiveTurns: 2 },
  );
  for (const env of [
    { SB_MAX_ACTIVE_TURNS: "0" },
    { SB_MAX_ACTIVE_TURNS: "2;bad" },
    { SB_MAX_ACTIVE_TURNS: "17" },
  ])
    assert.throws(() => readLimits(env), /Límite/);
});
test("scoped CLI retains every argument without invoking a shell", () => {
  const command = sessionCommand(
    { bin: "claude", args: ["-p", "literal; $(never-run)", "--json"] },
    "session-123",
    { SB_SESSION_SCOPES: "1" },
  );
  assert.equal(command.bin, "/usr/bin/systemd-run");
  assert.deepEqual(command.args.slice(-5), [
    "--",
    "claude",
    "-p",
    "literal; $(never-run)",
    "--json",
  ]);
  assert.ok(command.args.includes("--property=MemoryMax=1G"));
  assert.ok(command.args.includes("--collect"));
  assert.throws(
    () =>
      sessionCommand({ bin: "claude", args: [] }, "../../bad", {
        SB_SESSION_SCOPES: "1",
      }),
    /sesión/,
  );
});
