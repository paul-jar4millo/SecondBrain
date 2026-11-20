import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  createModelCatalog,
  readAgyModels,
  readCodexModels,
} from "../models.mjs";
import { engineCommand } from "../engines.mjs";
import { createLauncherServer } from "../index.mjs";

const cacheCodex = JSON.stringify({
  models: [
    {
      slug: "gpt-a",
      display_name: "GPT A",
      visibility: "list",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    },
    { slug: "oculto", display_name: "Oculto", visibility: "hide" },
    { slug: "--rm", display_name: "Malo", visibility: "list" },
  ],
});
const agyOutput =
  "Fetching available models...\n\x1b[1mgemini-x-high\x1b[0m\tGemini X (High)\nclaude-y\tClaude Y\n--evil\tMal\n";

test("lee los catálogos de Codex y Antigravity sin ocultos ni opciones", () => {
  assert.deepEqual(readCodexModels(cacheCodex), [
    {
      id: "gpt-a",
      nombre: "GPT A",
      esfuerzo: "low",
      esfuerzos: ["low", "high"],
    },
  ]);
  assert.deepEqual(readAgyModels(agyOutput), [
    { id: "gemini-x-high", nombre: "Gemini X (High)" },
    { id: "claude-y", nombre: "Claude Y" },
  ]);
});

test("valida modelo y esfuerzo contra lo que ofrece cada motor", async () => {
  let queries = 0;
  const catalog = createModelCatalog({
    env: { CODEX_HOME: "/codex" },
    leer: async () => cacheCodex,
    agy: async () => (queries++, agyOutput),
  });
  const all = await catalog.modelos();
  assert.deepEqual(
    all.claude.map((m) => m.id),
    ["opus", "sonnet", "haiku"],
  );
  assert.deepEqual(
    all.deepseek.map((m) => m.id),
    ["deepseek-flash[1m]"],
  );
  assert.ok(all.claude[0].esfuerzos.includes("max"));
  await catalog.modelos();
  assert.equal(queries, 1, "se guarda en caché");
  await catalog.validar("claude", undefined, undefined);
  await catalog.validar("codex", "gpt-a", "high");
  await catalog.validar("agy", "claude-y");
  await catalog.validar("claude", "opus", "xhigh");
  await catalog.validar("claude", undefined, "xhigh");
  await catalog.validar("claude", "haiku", "high");
  await catalog.validar("claude", "sonnet", "xhigh");
  await catalog.validar("deepseek", "deepseek-flash[1m]", "max");
  for (const [engine, model, effort] of [
    ["claude", "gpt-a"],
    ["codex", "gpt-a", "max"],
    ["codex", "oculto"],
    ["deepseek", "opus"],
    ["deepseek", "deepseek-flash[1m]", "xhigh"],
    ["agy", "--evil"],
    ["claude", undefined, "ultra"],
    ["agy", undefined, "high"],
  ])
    await assert.rejects(catalog.validar(engine, model, effort), {
      message: "Modelo no disponible",
    });
});

test("un fallo al consultar deja solo el predeterminado y se reintenta", async () => {
  let queries = 0;
  const catalog = createModelCatalog({
    env: {},
    agy: async () => {
      queries++;
      throw new Error("sin red");
    },
  });
  assert.deepEqual((await catalog.modelos()).agy, []);
  await catalog.modelos();
  assert.equal(queries, 2);
});

test("pasa el modelo a cada CLI y nunca a DeepSeek", () => {
  assert.deepEqual(
    engineCommand("claude", "x", { modelo: "opus" }).args.slice(-2),
    ["--model", "opus"],
  );
  assert.ok(
    !engineCommand("deepseek", "x", { modelo: "opus" }).args.includes(
      "--model",
    ),
  );
  assert.deepEqual(
    engineCommand("codex", "x", {
      modelo: "gpt-a",
      esfuerzo: "high",
    }).args.slice(-5),
    ["-m", "gpt-a", "-c", 'model_reasoning_effort="high"', "x"],
  );
  assert.deepEqual(
    engineCommand("agy", "x", { modelo: "claude-y" }).args.slice(-2),
    ["--model", "claude-y"],
  );
});

test("el servidor publica los modelos", async (t) => {
  const fingerprint = (s) => createHash("sha256").update(s).digest("hex");
  const server = createLauncherServer({
    catalogo: createModelCatalog({
      env: { CODEX_HOME: "/c" },
      leer: async () => cacheCodex,
      agy: async () => agyOutput,
    }),
    controlHash: fingerprint("control"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: "Bearer control" };
  const models = await (await fetch(url + "/modelos", { headers })).json();
  assert.equal(models.codex[0].id, "gpt-a");
});
