// End-to-end check of the thread runtime against a running launcher and a
// real agent (ADR 0010). Opt-in and never part of CI: it spends the agent's
// quota. Self-contained, so it can be piped into the LXC:
//
//   node ops/verify-runtime.mjs --live --repo <project> \
//     [--engine codex] [--url http://127.0.0.1:8092] \
//     [--token-file /var/lib/secondbrain/lanzador-token]
//
// <project> must be a throwaway repository registered in the launcher: the
// check merges a commit into its base branch. Steps: repo thread, a turn that
// writes a file, a steer while the next turn runs, the diff, a local merge,
// archive, and no worktree or branch left behind.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** @param {string[]} argv */
function options(argv) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`Argumento inválido: ${key}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key.slice(2)] = true;
    else out[key.slice(2)] = argv[++i];
  }
  return out;
}

const opts = options(process.argv.slice(2));
if (!opts.live && process.env.SB_RUN_RUNTIME_LIVE !== "1") {
  console.log(
    "Comprobación real omitida: usa --live (gasta cuota del agente).",
  );
  process.exit(0);
}
const repo = String(opts.repo || "");
if (!repo) {
  console.error("Falta --repo (un proyecto desechable del lanzador).");
  process.exit(2);
}
const engine = String(opts.engine || "codex");
const base = String(opts.url || "http://127.0.0.1:8092").replace(/\/$/, "");
const token = (
  await readFile(
    String(opts["token-file"] || "/var/lib/secondbrain/lanzador-token"),
    "utf8",
  )
).trim();
const TURN_MS = Number(opts["turn-timeout"] || 600_000);

/**
 * @param {string} path
 * @param {unknown} [body]
 */
async function call(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${data.error ?? ""}`);
  return data;
}

/**
 * @template T
 * @param {string} what
 * @param {() => Promise<T | null | undefined | false>} check
 */
async function until(what, check, ms = TURN_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Tiempo agotado: ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** @param {string} id */
const snapshot = (id) => call(`/threads/${id}`);

/**
 * Waits for the thread to rest, approving whatever the agent asks on the way.
 * @param {string} id
 */
async function settle(id) {
  return until("turno terminado", async () => {
    const snap = await snapshot(id);
    for (const request of snap.requests ?? [])
      if (request.status === "open") {
        const answer =
          request.kind === "approval"
            ? { approved: true }
            : { text: "Sigue con lo más simple." };
        await call(`/threads/${id}/requests/${request.id}`, {
          answer,
          origin: "app",
        });
      }
    const status = snap.thread.status;
    if (status === "failed") throw new Error("El thread falló.");
    return ["idle", "needs-decision", "ready-for-review"].includes(status)
      ? snap
      : null;
  });
}

/** Root reads the agent's repository, hence safe.directory. */
let repoDir = "";
/** @param {string[]} args */
const git = async (...args) =>
  (
    await run("git", ["-c", "safe.directory=*", "-C", repoDir, ...args])
  ).stdout.trim();

/** @type {string[]} */
const steps = [];
const step = (/** @type {string} */ name) => {
  steps.push(name);
  console.log(`ok  ${name}`);
};

const marker = `verificacion-${Date.now().toString(36)}`;
assert.ok(Array.isArray((await call("/threads")).threads));
step("API de threads");

const { thread } = await call("/threads", {
  kind: "repo",
  repoPath: repo,
  title: `Verificación ${marker}`,
  prompt: `Crea el archivo ${marker}.txt en la raíz del repositorio con la línea "uno". No cambies nada más.`,
  agent: { engine },
  autonomy: "auto-worktree",
});
const branch = thread.repo?.branch;
repoDir = String(opts["repo-dir"] || thread.repo?.path || "");
assert.match(String(branch), /^sb\//);
step(`thread de repo en ${branch}`);

await settle(thread.id);
let files = (await call(`/threads/${thread.id}/diff`)).files;
assert.ok(
  files.some((/** @type {{ path: string }} */ f) => f.path === `${marker}.txt`),
  "el diff incluye el archivo",
);
step(`turno con ${engine} y diff`);

await call(`/threads/${thread.id}/messages`, {
  text: `Añade la línea "dos" a ${marker}.txt.`,
  mode: "send",
});
await until("turno en curso", async () =>
  ["running", "waiting-user"].includes(
    (await snapshot(thread.id)).thread.status,
  ),
);
const steer = await call(`/threads/${thread.id}/messages`, {
  text: `Además añade la línea "tres" al final.`,
  mode: "steer",
});
await settle(thread.id);
step(
  `steer durante el turno (${steer.delivery ?? steer.status ?? "aceptado"})`,
);

files = (await call(`/threads/${thread.id}/diff`)).files;
assert.ok(files.length >= 1);
const closed = await call(`/threads/${thread.id}/close`, {
  mode: "merge",
  title: `chore: verificación ${marker}`,
});
assert.equal(closed.thread.status, "done");
const baseBranch = thread.repo.baseBranch;
const merged = await git("show", `${baseBranch}:${marker}.txt`);
assert.match(merged, /uno/);
step(`merge local en ${baseBranch}`);

await call(`/threads/${thread.id}/archive`, {});
assert.equal(await git("branch", "--list", branch), "");
assert.doesNotMatch(await git("worktree", "list"), new RegExp(branch));
step("archivado sin worktree ni rama");

console.log(
  JSON.stringify({ ok: true, thread: thread.id, engine, steps }, null, 2),
);
