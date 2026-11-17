// Read-only production check under sb-agente with the service's systemd isolation.
// No model request or thread/turn is created. Never print notes or credentials.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const cli = process.env.SB_BRAIN_CLI;
assert.ok(
  cli && process.env.SB_BRAIN_TOKEN_FILE,
  "Falta el entorno del SecondBrain.",
);
function check(stdout) {
  const notes = JSON.parse(stdout);
  assert.ok(Array.isArray(notes) && notes.length === 4);
  assert.deepEqual(
    notes.map((n) => n.path),
    [
      "AGENTS.md",
      "Home.md",
      "99-Meta/Convenciones.md",
      "02-Areas/Agentes/_Agentes.md",
    ],
  );
  assert.ok(
    notes.every(
      (n) => typeof n.content === "string" && /^[a-f0-9]{64}$/.test(n.hash),
    ),
  );
}
const direct = await promisify(execFile)(
  process.execPath,
  [cli, "brain_context"],
  { timeout: 20000 },
);
check(direct.stdout);
console.log("sb-agente: brain_context correcto (4 notas; contenido omitido).");

if (process.argv.includes("--codex")) {
  const child = spawn(
    process.env.AGENTES_CODEX_BIN || "codex",
    ["app-server"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map();
  let id = 0;
  const write = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      write({ id: key, method, params });
    });
  const fail = (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  child.on("error", fail);
  child.on("close", () => fail(new Error("Codex cerró la comprobación.")));
  child.stderr.resume();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  });
  const timer = setTimeout(() => {
    fail(new Error("Comprobación de sandbox agotada."));
    child.kill();
  }, 30000);
  try {
    await request("initialize", {
      clientInfo: { name: "brain-access-check", version: "1" },
    });
    write({ method: "initialized" });
    const result = await request("command/exec", {
      command: [process.execPath, cli, "brain_context"],
      cwd: process.cwd(),
      env: {
        SB_BRAIN_CLI: cli,
        SB_BRAIN_TOKEN_FILE: process.env.SB_BRAIN_TOKEN_FILE,
        SB_BRAIN_URL:
          process.env.SB_BRAIN_URL || "http://127.0.0.1:8080/api/v1",
      },
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [process.cwd()],
        networkAccess: true,
      },
      timeoutMs: 20000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    check(result.stdout);
    console.log(
      "Codex: sandbox workspaceWrite con acceso MCP correcto, sin inferencias.",
    );
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
