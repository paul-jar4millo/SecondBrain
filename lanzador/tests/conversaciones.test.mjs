import test from "node:test";
import assert from "node:assert/strict";
import {
  leerConversacion,
  observarConversaciones,
  leerContexto,
  marcarInterna,
} from "../conversaciones.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { abrirRegistro } from "../sesiones.mjs";

test("Claude conserva los turnos humanos y respuestas, sin resultados de herramientas", () => {
  const text =
    [
      { type: "user", message: { content: "Hola" } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", content: "privado" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Respuesta" }] },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + '\n{"partial":';
  assert.deepEqual(leerConversacion("claude", text), [
    { rol: "user", texto: "Hola" },
    { rol: "assistant", texto: "Respuesta" },
  ]);
});
test("Antigravity extrae el prompt sin metadatos internos y la respuesta pública", () => {
  const text = [
    {
      type: "USER_INPUT",
      content:
        "<USER_REQUEST>\nHola\n</USER_REQUEST>\n<ADDITIONAL_METADATA>interno</ADDITIONAL_METADATA>",
    },
    { type: "PLANNER_RESPONSE", content: "Respuesta" },
    { type: "TOOL", content: "privado" },
  ]
    .map(JSON.stringify)
    .join("\n");
  assert.deepEqual(leerConversacion("agy", text), [
    { rol: "user", texto: "Hola" },
    { rol: "assistant", texto: "Respuesta" },
  ]);
});

test("Codex preserves human and assistant messages while excluding tool output", () => {
  const text = [
    { type: "session_meta", payload: { id: "provider-id" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hola" }],
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", output: "private" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Respuesta" }],
      },
    },
  ]
    .map(JSON.stringify)
    .join("\n");
  assert.deepEqual(leerConversacion("codex", text), [
    { rol: "user", texto: "Hola" },
    { rol: "assistant", texto: "Respuesta" },
  ]);
});

test("mide el contexto del último turno sin sumar todo el cache histórico", () => {
  const claude = [
    {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 100000,
          output_tokens: 500,
        },
      },
    },
    {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 2000,
          cache_read_input_tokens: 220000,
          cache_creation_input_tokens: 1000,
          output_tokens: 500,
        },
      },
    },
  ]
    .map(JSON.stringify)
    .join("\n");
  assert.deepEqual(leerContexto("claude", claude), {
    usados: 223500,
    limite: 400000,
  });
  assert.deepEqual(leerContexto("deepseek", claude), {
    usados: 223500,
    limite: 400000,
  });
  const codex = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 350000, output_tokens: 1000 },
        total_token_usage: { total_tokens: 2000000 },
      },
    },
  });
  assert.deepEqual(leerContexto("codex", codex), {
    usados: 351000,
    limite: 400000,
  });
});

test("Codex observer links an exact launcher marker to its native conversation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sb-codex-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registro = await abrirRegistro(path.join(root, "registro.json"));
  const session = await registro.crear({
    motor: "codex",
    origen: "sala",
    espacioId: "p1",
    harness: true,
  });
  const native = "a1111111-1111-4111-8111-111111111111";
  await mkdir(path.join(root, "codex/sessions/2026/01/01"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "codex/sessions/2026/01/01/rollout-test.jsonl"),
    [
      { type: "session_meta", payload: { id: native } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Contexto SecondBrain: sesión ${session.id}.\n\nHola`,
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Listo" }],
        },
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  const stop = observarConversaciones({
    registro,
    env: { HOME: root, CODEX_HOME: path.join(root, "codex") },
    proyectos: {},
    intervalo: 10,
  });
  t.after(stop);
  for (let i = 0; i < 100 && !registro.leer()[0].conversacionId; i++)
    await new Promise((r) => setTimeout(r, 10));
  const saved = registro.leer()[0];
  assert.equal(saved.conversacionId, native);
  assert.equal(saved.resultado, "Listo");
  assert.equal(registro.leer().length, 1);
});

test("una ejecución interna marcada nunca aparece como conversación", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sb-internas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registro = await abrirRegistro(path.join(root, "registro.json"));
  const claude = path.join(root, "claude/projects/p");
  await mkdir(claude, { recursive: true });
  const transcript = (texto) =>
    [
      { type: "user", message: { content: texto } },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      },
    ]
      .map(JSON.stringify)
      .join(String.fromCharCode(10));
  const interna = "e5555555-5555-4555-8555-555555555555";
  const visible = "f6666666-6666-4666-8666-666666666666";
  const env = { HOME: root, AGENTES_CLAUDE_DIR: path.join(root, "claude") };
  await marcarInterna(env, interna);
  await writeFile(
    path.join(claude, interna + ".jsonl"),
    transcript("Redacta el PR"),
  );
  await writeFile(path.join(claude, visible + ".jsonl"), transcript("Hola"));
  const stop = observarConversaciones({
    registro,
    env,
    proyectos: {},
    intervalo: 10,
  });
  t.after(stop);
  for (let i = 0; i < 100 && !registro.leer().length; i++)
    await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    registro.leer().map((s) => s.conversacionId),
    [visible],
  );
});
