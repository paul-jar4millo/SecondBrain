import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createUsage,
  lineContext,
  saveUsageLine,
  readCodexUsage,
  readUsageLine,
  usageLine,
  latestCodexUsage,
  current,
} from "../usage.mjs";
import { agyWindows, claudeWindows } from "../engines.mjs";
import { prepareAgy, prepareClaude } from "../claude-config.mjs";

const event = (primary, secondary, extra = {}) =>
  JSON.stringify({
    timestamp: "2026-11-09T03:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex",
        primary,
        secondary,
        plan_type: "plus",
        ...extra,
      },
    },
  });
const cinco = {
  used_percent: 48,
  window_minutes: 300,
  resets_at: 1794191214,
};
const semana = {
  used_percent: 51,
  window_minutes: 10080,
  resets_at: 1794717096,
};

test("toma el último límite de la cuenta e ignora líneas rotas y otros límites", () => {
  const text = [
    '{"cortada":',
    event({ ...cinco, used_percent: 10 }, semana),
    event(cinco, semana),
    event({ ...cinco, used_percent: 99 }, semana, { limit_id: "otro" }),
    '{"type":"event_msg","payload":{"type":"token_count","rate_limits":null}}',
    "",
  ].join("\n");
  const usage = latestCodexUsage(text);
  assert.equal(usage.ventanas["5h"].usado, 48);
  assert.equal(usage.ventanas.semanal.usado, 51);
  assert.equal(usage.plan, "plus");
  assert.equal(latestCodexUsage("texto sin límites"), null);
});

test("una ventana ya reiniciada cuenta como vacía", () => {
  const usage = latestCodexUsage(event(cinco, semana));
  const despues = Date.parse(usage.ventanas["5h"].reinicia) + 1000;
  const now = current(usage, despues);
  assert.equal(now.ventanas["5h"].usado, 0);
  assert.equal(now.ventanas.semanal.usado, 51);
  assert.equal(current(null), null);
});

test("la línea de estado mide el contexto de Claude sin sumar facturación acumulada", () => {
  assert.deepEqual(
    lineContext({
      context_window: {
        current_usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 220000,
          cache_creation_input_tokens: 2000,
          output_tokens: 500,
        },
      },
    }),
    { usados: 223500, limite: 400000 },
  );
  assert.equal(
    lineContext({ rate_limits: { five_hour: { utilization: 0.7 } } }),
    null,
  );
});

test("lee el rollout más reciente sin devolver su contenido", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sb-uso-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dia = path.join(root, "sessions/2026/11/09");
  await mkdir(dia, { recursive: true });
  const old = path.join(dia, "rollout-a.jsonl");
  const created = path.join(dia, "rollout-b.jsonl");
  await writeFile(old, event({ ...cinco, used_percent: 5 }, semana));
  await writeFile(
    created,
    `{"type":"response_item","texto":"secreto"}\n${event(cinco, semana)}\n`,
  );
  await utimes(old, new Date(1000), new Date(1000));
  const usage = await readCodexUsage(path.join(root, "sessions"));
  assert.equal(usage.ventanas["5h"].usado, 48);
  assert.ok(!JSON.stringify(usage).includes("secreto"));
  assert.equal(await readCodexUsage(path.join(root, "no-existe")), null);
  const read = createUsage({
    env: { CODEX_HOME: root },
    ahora: () => Date.parse("2026-11-09T03:00:00Z"),
  });
  assert.equal((await read()).codex.ventanas.semanal.usado, 51);
  assert.deepEqual(await createUsage({ env: {} })(), {});
});

const NOW = Date.parse("2026-11-09T03:00:00Z");
const claudeEntry = {
  session_id: "secreto-claude",
  cwd: "/ruta/secreta",
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1794200000 },
    seven_day: { used_percentage: 100, resets_at: 1794717096 },
  },
};
const agyEntry = {
  email: "persona@example.test",
  model: { id: "gemini-3-pro" },
  quota: {
    "gemini-5h": {
      remaining_fraction: 0.75,
      reset_time: "2026-11-09T05:00:00Z",
      reset_in_seconds: 7200,
    },
    "gemini-weekly": {
      remaining_fraction: 0.9378,
      reset_time: "2026-11-12T05:00:00Z",
    },
    "3p-5h": { remaining_fraction: 0.1, reset_time: "2026-11-09T04:00:00Z" },
    "3p-weekly": { remaining_amount: 3, reset_time: "2026-11-12T04:00:00Z" },
  },
};
const temporaryFolder = async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sb-uso-linea-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test("traduce las ventanas de Claude sin inventar las que faltan", () => {
  const windows = claudeWindows(claudeEntry.rate_limits);
  assert.equal(windows["5h"].usado, 23.5);
  assert.equal(windows["5h"].reinicia, new Date(1794200000000).toISOString());
  assert.equal(windows["5h"].agotada, false);
  assert.equal(windows.semanal.agotada, true);
  assert.deepEqual(Object.keys(claudeWindows({ seven_day: {} })), []);
  assert.deepEqual(claudeWindows(undefined), {});
});

test("traduce la cuota de Antigravity según la familia del modelo", () => {
  const gemini = agyWindows(agyEntry.quota, "gemini-3-pro");
  assert.equal(gemini["5h"].usado, 25);
  assert.equal(gemini.semanal.usado, 6.2);
  assert.equal(gemini.semanal.reinicia, "2026-11-12T05:00:00.000Z");
  // A bucket measured in amounts has no percentage to show.
  assert.deepEqual(Object.keys(agyWindows(agyEntry.quota, "Claude Opus")), [
    "5h",
  ]);
  assert.equal(agyWindows(agyEntry.quota, "gpt-5")["5h"].usado, 90);
  assert.deepEqual(
    agyWindows(
      { "gemini-5h": { remaining_fraction: 0.5, disabled: true } },
      "auto",
    ),
    {},
  );
  assert.deepEqual(agyWindows(undefined, null), {});
});

test("guarda solo números y conserva lo último si llega una entrada sin límites", async (t) => {
  const file = path.join(await temporaryFolder(t), "nueva/sb-uso.json");
  assert.equal(await saveUsageLine("claude", { cwd: "/x" }, file), false);
  assert.equal(await readUsageLine(file), null);
  assert.equal(await saveUsageLine("claude", claudeEntry, file, NOW), true);
  const crudo = await readFile(file, "utf8");
  assert.ok(!crudo.includes("secreto"));
  assert.ok(!crudo.includes("/ruta"));
  await saveUsageLine("claude", { rate_limits: {} }, file, NOW + 1000);
  assert.equal(
    (await readUsageLine(file)).actualizado,
    new Date(NOW).toISOString(),
  );
  // A window the CLI drops stays recorded for `vigente` to empty it.
  await saveUsageLine(
    "claude",
    { rate_limits: { five_hour: claudeEntry.rate_limits.five_hour } },
    file,
    NOW + 2000,
  );
  assert.equal((await readUsageLine(file)).ventanas.semanal.usado, 100);
  await writeFile(file, "{roto");
  assert.equal(await readUsageLine(file), null);
  await writeFile(
    file,
    JSON.stringify({
      ventanas: { "5h": { usado: "mucho" }, otra: { usado: 1 } },
    }),
  );
  assert.equal(await readUsageLine(file), null);
  assert.equal(await saveUsageLine("codex", claudeEntry, file), false);
});

test("cada motor con dato real aparece; el resto no recibe barras", async (t) => {
  const root = await temporaryFolder(t);
  const claudeDir = path.join(root, "claude");
  const home = path.join(root, "home");
  const env = { AGENTES_CLAUDE_DIR: claudeDir, HOME: home };
  const clock = () => NOW;
  assert.deepEqual(await createUsage({ env, ahora: clock })(), {});
  await saveUsageLine(
    "claude",
    claudeEntry,
    path.join(claudeDir, "sb-uso.json"),
    NOW,
  );
  await saveUsageLine(
    "agy",
    agyEntry,
    path.join(home, ".gemini/antigravity-cli/sb-uso.json"),
    NOW,
  );
  const usage = await createUsage({ env, ahora: clock })();
  assert.deepEqual(Object.keys(usage).sort(), ["agy", "claude"]);
  assert.equal(usage.claude.ventanas["5h"].usado, 23.5);
  assert.equal(usage.agy.ventanas["5h"].usado, 25);
  const tarde = await createUsage({
    env,
    ahora: () => Date.parse("2026-11-09T06:00:00Z"),
  })();
  assert.equal(tarde.agy.ventanas["5h"].usado, 0);
  assert.equal(tarde.agy.ventanas.semanal.usado, 6.2);
});

test("el comando de la línea guarda el uso e imprime la firma, incluso con datos rotos", async (t) => {
  const file = path.join(await temporaryFolder(t), "sb-uso.json");
  const script = fileURLToPath(new URL("../usage-line.mjs", import.meta.url));
  const run = (entry) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [script, "agy", file, "Lira · Antigravity"],
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin.end(entry);
    });
  assert.equal(await run("{roto"), "Lira · Antigravity");
  assert.equal(await readUsageLine(file), null);
  assert.equal(await run(JSON.stringify(agyEntry)), "Lira · Antigravity");
  assert.equal((await readUsageLine(file)).ventanas["5h"].usado, 25);
  assert.ok(!(await readFile(file, "utf8")).includes("persona"));
});

test("Ámbar y Lira miden sin pisar una línea propia; Marina no mide", async (t) => {
  const root = await temporaryFolder(t);
  const read = async (file) => JSON.parse(await readFile(file, "utf8"));
  const ambar = path.join(root, "claude");
  await mkdir(ambar);
  const options = { firma: "Ámbar · Claude", medir: true };
  await prepareClaude(ambar, "/w/p", options);
  const ajustes = path.join(ambar, "settings.json");
  assert.match(
    (await read(ajustes)).statusLine.command,
    /usage-line\.mjs.*'claude'/,
  );
  // A new release moves the script: the line follows it.
  const propia = await read(ajustes);
  propia.statusLine.command = "node /vieja/uso-linea.mjs";
  await writeFile(ajustes, JSON.stringify(propia));
  await prepareClaude(ambar, "/w/p", options);
  assert.ok(!(await read(ajustes)).statusLine.command.includes("/vieja"));
  const personal = { type: "command", command: "mi-linea.sh" };
  await writeFile(ajustes, JSON.stringify({ statusLine: personal }));
  await prepareClaude(ambar, "/w/p", options);
  assert.deepEqual((await read(ajustes)).statusLine, personal);

  const marina = path.join(root, "deepseek");
  await mkdir(marina);
  await prepareClaude(marina, "/w/p", { firma: "Marina · DeepSeek" });
  const marinaLine = (await read(path.join(marina, "settings.json"))).statusLine
    .command;
  assert.ok(!marinaLine.includes("uso-linea"));

  const home = path.join(root, "home");
  const folder = path.join(home, ".gemini/antigravity-cli");
  await mkdir(folder, { recursive: true });
  await prepareAgy(home, "/w/p");
  const lira = await read(path.join(folder, "settings.json"));
  assert.equal(lira.statusLine.stack_with_default, true);
  assert.equal(
    lira.statusLine.command,
    usageLine("agy", folder, "Lira · Antigravity").command,
  );
  await writeFile(
    path.join(folder, "settings.json"),
    JSON.stringify({ statusLine: personal, trustedWorkspaces: ["/w/p"] }),
  );
  await prepareAgy(home, "/w/p");
  assert.deepEqual(
    (await read(path.join(folder, "settings.json"))).statusLine,
    personal,
  );
});
