import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createItems,
  createNormalizer,
  localizarTranscript,
  normalizarItems,
  resumirEntrada,
} from "../items.mjs";

const lineas = (...eventos) => eventos.map((e) => JSON.stringify(e)).join("\n");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

test("Claude: empareja tool_use con tool_result y conserva el orden", () => {
  const items = normalizarItems(
    "claude",
    lineas(
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00Z",
        message: { content: "Arregla el login" },
      },
      {
        type: "assistant",
        uuid: "a1",
        message: {
          content: [
            { type: "thinking", thinking: "oculto" },
            { type: "text", text: "Reviso el archivo." },
            {
              type: "tool_use",
              id: "tool1",
              name: "Read",
              input: { file_path: "/repo/src/login.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u2",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool1", content: "contenido" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool2",
              name: "Bash",
              input: { command: "npm test" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u3",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool2",
              is_error: true,
              content: [{ type: "text", text: "falló" }],
            },
          ],
        },
      },
      { type: "user", uuid: "u4", isMeta: true, message: { content: "meta" } },
      {
        type: "user",
        uuid: "u5",
        isSidechain: true,
        message: { content: "subagente" },
      },
      {
        type: "user",
        uuid: "u6",
        message: { content: "<system-reminder>x</system-reminder>" },
      },
      {
        type: "user",
        uuid: "u7",
        message: {
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
      },
    ),
  );
  assert.deepEqual(
    items.map((x) => [x.tipo, x.texto ?? x.herramienta.nombre]),
    [
      ["usuario", "Arregla el login"],
      ["asistente", "Reviso el archivo."],
      ["herramienta", "Read"],
      ["herramienta", "Bash"],
      ["sistema", "Turno interrumpido"],
    ],
  );
  assert.deepEqual(items[2].herramienta, {
    nombre: "Read",
    resumen: "/repo/src/login.ts",
    resultado: "contenido",
    estado: "ok",
  });
  assert.equal(items[3].herramienta.estado, "error");
  assert.equal(items[3].herramienta.resultado, "falló");
  assert.equal(items[0].ts, "2026-01-01T00:00:00Z");
  assert.equal(new Set(items.map((x) => x.id)).size, items.length);
});

test("una herramienta sin resultado queda pendiente y el resultado la actualiza con el mismo id", () => {
  const n = createNormalizer("claude");
  n.alimentar(
    lineas({
      type: "assistant",
      uuid: "a",
      message: {
        content: [{ type: "tool_use", id: "t", name: "Edit", input: {} }],
      },
    }),
  );
  const primero = n.drenar();
  assert.equal(primero.length, 1);
  assert.equal(primero[0].herramienta.estado, "pendiente");
  assert.deepEqual(n.drenar(), []);
  n.alimentar(
    lineas({
      type: "user",
      uuid: "b",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
      },
    }),
  );
  const segundo = n.drenar();
  assert.equal(segundo.length, 1);
  assert.equal(segundo[0].id, primero[0].id);
  assert.equal(segundo[0].herramienta.estado, "ok");
});

test("acota resumen a 200 y resultado a 2000 caracteres", () => {
  assert.equal(resumirEntrada({ command: "x".repeat(500) }).length, 200);
  assert.equal(resumirEntrada({ otro: [1, 2] }), '{"otro":[1,2]}');
  const [item] = normalizarItems(
    "claude",
    lineas(
      {
        type: "assistant",
        uuid: "a",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "b",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: "y".repeat(5000),
            },
          ],
        },
      },
    ),
  );
  assert.equal(item.herramienta.resultado.length, 2000);
});

test("Codex: function_call y su salida, sin mensajes internos del entorno", () => {
  const items = normalizarItems(
    "codex",
    lineas(
      { type: "session_meta", payload: { id: "native" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "reglas" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<environment_context>x</environment_context>",
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Contexto SecondBrain: sesión a1111111-1111-4111-8111-111111111111.\n\nHaz una prueba",
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: { type: "reasoning", summary: [] },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "c1",
          arguments: JSON.stringify({ command: ["bash", "-lc", "ls"] }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: JSON.stringify({
            output: "a.txt",
            metadata: { exit_code: 0 },
          }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "c2",
          arguments: "{}",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c2",
          output: JSON.stringify({
            output: "boom",
            metadata: { exit_code: 2 },
          }),
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
    ),
  );
  assert.deepEqual(
    items.map((x) => x.tipo),
    ["usuario", "herramienta", "herramienta", "asistente"],
  );
  assert.equal(items[0].texto, "Haz una prueba");
  assert.deepEqual(items[1].herramienta, {
    nombre: "shell",
    resumen: "bash -lc ls",
    resultado: "a.txt",
    estado: "ok",
  });
  assert.equal(items[2].herramienta.estado, "error");
  assert.equal(items[3].texto, "Listo");
});

test("Antigravity: texto de usuario y respuesta; pasos de herramienta degradan a genéricos", () => {
  const items = normalizarItems(
    "agy",
    lineas(
      {
        type: "USER_INPUT",
        content:
          "<USER_REQUEST>\nHola\n</USER_REQUEST><ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>",
      },
      { type: "RUN_COMMAND", content: "ls -la" },
      { type: "SYSTEM_MESSAGE", content: "interno" },
      { type: "PLANNER_RESPONSE", content: "Hecho" },
    ),
  );
  assert.deepEqual(
    items.map((x) => [x.tipo, x.texto ?? x.herramienta.resumen]),
    [
      ["usuario", "Hola"],
      ["herramienta", "ls -la"],
      ["asistente", "Hecho"],
    ],
  );
});

test("ignora líneas rotas y motores desconocidos fallan", () => {
  assert.deepEqual(normalizarItems("claude", '{"roto":\nnada'), []);
  assert.throws(() => createNormalizer("otro"));
});

async function entornoTemporal(t) {
  const raiz = await mkdtemp(path.join(tmpdir(), "sb-items-"));
  t.after(() => rm(raiz, { recursive: true, force: true }));
  return raiz;
}

test("localiza el transcript de cada proveedor desde el id de la sesión", async (t) => {
  const raiz = await entornoTemporal(t);
  const id = "a1111111-1111-4111-8111-111111111111";
  const native = "b2222222-2222-4222-8222-222222222222";
  await mkdir(path.join(raiz, "claude/projects/-w-p1"), { recursive: true });
  await writeFile(path.join(raiz, "claude/projects/-w-p1", id + ".jsonl"), "");
  await mkdir(path.join(raiz, "deepseek/projects/-w-p1"), { recursive: true });
  await writeFile(
    path.join(raiz, "deepseek/projects/-w-p1", id + ".jsonl"),
    "",
  );
  await mkdir(path.join(raiz, "codex/sessions/2026/01/01"), {
    recursive: true,
  });
  await writeFile(
    path.join(
      raiz,
      "codex/sessions/2026/01/01",
      `rollout-2026-01-01T00-00-00-${native}.jsonl`,
    ),
    "",
  );
  const agy = path.join(
    raiz,
    ".gemini/antigravity-cli/brain",
    id,
    ".system_generated/logs",
  );
  await mkdir(agy, { recursive: true });
  await writeFile(path.join(agy, "transcript.jsonl"), "");
  const env = {
    HOME: raiz,
    AGENTES_CLAUDE_DIR: path.join(raiz, "claude"),
    AGENTES_DEEPSEEK_DIR: path.join(raiz, "deepseek"),
    CODEX_HOME: path.join(raiz, "codex"),
  };
  assert.match(
    await localizarTranscript({ id, motor: "claude", conversacionId: id }, env),
    /claude[\\/]projects[\\/]-w-p1[\\/]a1111111/,
  );
  assert.match(
    await localizarTranscript(
      { id, motor: "deepseek", conversacionId: id },
      env,
    ),
    /deepseek[\\/]projects/,
  );
  assert.match(
    await localizarTranscript(
      { id, motor: "codex", conversacionId: native },
      env,
    ),
    /rollout-.*b2222222/,
  );
  assert.equal(await localizarTranscript({ id, motor: "codex" }, env), null);
  assert.match(
    await localizarTranscript({ id, motor: "agy", conversacionId: id }, env),
    /transcript\.jsonl$/,
  );
  assert.equal(
    await localizarTranscript(
      { id: "c3333333-3333-4333-8333-333333333333", motor: "claude" },
      env,
    ),
    null,
  );
});

test("sigue el transcript por offset, emite solo lo añadido y se detiene con el último lector", async (t) => {
  const raiz = await entornoTemporal(t);
  const id = "a1111111-1111-4111-8111-111111111111";
  const carpeta = path.join(raiz, "claude/projects/-w");
  await mkdir(carpeta, { recursive: true });
  const archivo = path.join(carpeta, id + ".jsonl");
  const registro = {
    leer: () => [{ id, motor: "claude", conversacionId: id }],
  };
  const items = createItems({
    registro,
    env: { HOME: raiz, AGENTES_CLAUDE_DIR: path.join(raiz, "claude") },
    intervalo: 20,
  });
  const recibido = [];
  // The file does not exist yet: the follower waits for it.
  const lector = items.suscribir(id, (lista) => recibido.push(lista));
  t.after(() => lector.off());
  assert.deepEqual(lector.ultimos(), []);
  await espera(60);
  assert.equal(recibido.length, 0);
  await writeFile(
    archivo,
    lineas({ type: "user", uuid: "u1", message: { content: "Hola" } }) + "\n",
  );
  for (let i = 0; i < 100 && !recibido.length; i++) await espera(20);
  assert.deepEqual(
    recibido.flat().map((x) => x.texto),
    ["Hola"],
  );
  // A half-written line waits for its newline.
  const parcial = lineas({
    type: "assistant",
    uuid: "a1",
    message: { content: [{ type: "text", text: "Respuesta" }] },
  });
  await appendFile(archivo, parcial.slice(0, 30));
  await espera(80);
  assert.equal(recibido.flat().length, 1);
  await appendFile(archivo, parcial.slice(30) + "\n");
  for (let i = 0; i < 100 && recibido.flat().length < 2; i++) await espera(20);
  assert.deepEqual(
    recibido.flat().map((x) => x.texto),
    ["Hola", "Respuesta"],
  );
  assert.equal(lector.ultimos(1).length, 1);
  assert.equal(items.activos(), 1);
  const segundo = items.suscribir(id, () => {});
  assert.equal(segundo.ultimos().length, 2);
  segundo.off();
  assert.equal(items.activos(), 1);
  lector.off();
  assert.equal(items.activos(), 0);
});
