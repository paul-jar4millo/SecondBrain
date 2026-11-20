import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { crearCatalogo, leerModelosAgy, leerModelosCodex } from "../models.mjs";
import { comandoMotor } from "../engines.mjs";
import { crearServidor } from "../index.mjs";

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
const salidaAgy =
  "Fetching available models...\n\x1b[1mgemini-x-high\x1b[0m\tGemini X (High)\nclaude-y\tClaude Y\n--evil\tMal\n";

test("lee los catálogos de Codex y Antigravity sin ocultos ni opciones", () => {
  assert.deepEqual(leerModelosCodex(cacheCodex), [
    {
      id: "gpt-a",
      nombre: "GPT A",
      esfuerzo: "low",
      esfuerzos: ["low", "high"],
    },
  ]);
  assert.deepEqual(leerModelosAgy(salidaAgy), [
    { id: "gemini-x-high", nombre: "Gemini X (High)" },
    { id: "claude-y", nombre: "Claude Y" },
  ]);
});

test("valida modelo y esfuerzo contra lo que ofrece cada motor", async () => {
  let consultas = 0;
  const catalogo = crearCatalogo({
    env: { CODEX_HOME: "/codex" },
    leer: async () => cacheCodex,
    agy: async () => (consultas++, salidaAgy),
  });
  const todos = await catalogo.modelos();
  assert.deepEqual(
    todos.claude.map((m) => m.id),
    ["opus", "sonnet", "haiku"],
  );
  assert.deepEqual(
    todos.deepseek.map((m) => m.id),
    ["deepseek-flash[1m]"],
  );
  assert.ok(todos.claude[0].esfuerzos.includes("max"));
  await catalogo.modelos();
  assert.equal(consultas, 1, "se guarda en caché");
  await catalogo.validar("claude", undefined, undefined);
  await catalogo.validar("codex", "gpt-a", "high");
  await catalogo.validar("agy", "claude-y");
  await catalogo.validar("claude", "opus", "xhigh");
  await catalogo.validar("claude", undefined, "xhigh");
  await catalogo.validar("claude", "haiku", "high");
  await catalogo.validar("claude", "sonnet", "xhigh");
  await catalogo.validar("deepseek", "deepseek-flash[1m]", "max");
  for (const [motor, modelo, esfuerzo] of [
    ["claude", "gpt-a"],
    ["codex", "gpt-a", "max"],
    ["codex", "oculto"],
    ["deepseek", "opus"],
    ["deepseek", "deepseek-flash[1m]", "xhigh"],
    ["agy", "--evil"],
    ["claude", undefined, "ultra"],
    ["agy", undefined, "high"],
  ])
    await assert.rejects(catalogo.validar(motor, modelo, esfuerzo), {
      message: "Modelo no disponible",
    });
});

test("un fallo al consultar deja solo el predeterminado y se reintenta", async () => {
  let consultas = 0;
  const catalogo = crearCatalogo({
    env: {},
    agy: async () => {
      consultas++;
      throw new Error("sin red");
    },
  });
  assert.deepEqual((await catalogo.modelos()).agy, []);
  await catalogo.modelos();
  assert.equal(consultas, 2);
});

test("pasa el modelo a cada CLI y nunca a DeepSeek", () => {
  assert.deepEqual(
    comandoMotor("claude", "x", { modelo: "opus" }).args.slice(-2),
    ["--model", "opus"],
  );
  assert.ok(
    !comandoMotor("deepseek", "x", { modelo: "opus" }).args.includes("--model"),
  );
  assert.deepEqual(
    comandoMotor("codex", "x", {
      modelo: "gpt-a",
      esfuerzo: "high",
    }).args.slice(-5),
    ["-m", "gpt-a", "-c", 'model_reasoning_effort="high"', "x"],
  );
  assert.deepEqual(
    comandoMotor("agy", "x", { modelo: "claude-y" }).args.slice(-2),
    ["--model", "claude-y"],
  );
});

test("el servidor publica los modelos y rechaza uno que no existe", async (t) => {
  const huella = (s) => createHash("sha256").update(s).digest("hex");
  const pedidos = [];
  const server = crearServidor({
    registro: { leer: () => [], subscribe: () => () => {} },
    ejecutor: { encargar: async (x) => (pedidos.push(x), { id: "s" }) },
    catalogo: crearCatalogo({
      env: { CODEX_HOME: "/c" },
      leer: async () => cacheCodex,
      agy: async () => salidaAgy,
    }),
    controlHash: huella("control"),
    hookHash: huella("hook"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    authorization: "Bearer control",
    "content-type": "application/json",
  };
  const modelos = await (await fetch(url + "/modelos", { headers })).json();
  assert.equal(modelos.codex[0].id, "gpt-a");
  const encargar = (extra) =>
    fetch(url + "/sesiones", {
      method: "POST",
      headers,
      body: JSON.stringify({
        motor: "codex",
        origen: "sala",
        proyecto: "p",
        brief: "b",
        ...extra,
      }),
    });
  assert.equal(
    (await encargar({ modelo: "gpt-a", esfuerzo: "low" })).status,
    202,
  );
  const malo = await encargar({ modelo: "gpt-z" });
  assert.equal(malo.status, 400);
  assert.equal((await malo.json()).error, "Modelo no disponible");
  assert.equal((await encargar({ modelo: 3 })).status, 400);
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].modelo, "gpt-a");
});
