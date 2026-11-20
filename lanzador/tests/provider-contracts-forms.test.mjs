import assert from "node:assert/strict";
import { once } from "node:events";

import { createHash, randomUUID } from "node:crypto";

import { test } from "node:test";

import { crearServidor } from "../index.mjs";
import {
  createClaudeController,
  validateAndExtractElicitationContent,
  validateRequestedSchema,
} from "../provider-controllers.mjs";

import { createHarness, waitFor } from "./helpers/provider-fakes.mjs";

test("contrato 5: formulario content completo sin fabricar defaults + rechazos estrictos + validación HTTP lanzador", async (t) => {
  // Unit schema checks
  assert.throws(
    () =>
      validateAndExtractElicitationContent(
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        {},
      ),
    (err) => err.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(
        {
          type: "object",
          properties: { b: { type: "object", properties: {} } },
        },
        {},
      ),
    (err) => err.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(
        { type: "object", properties: { a: { type: "string" } } },
        { a: "x" },
        "url",
      ),
    (err) => err.status === 400,
  );

  // Full elicitation roundtrip via Codex & real launcher HTTP endpoint + Claude onElicitation
  const h = await createHarness(t, {
    env: { FAKE_CODEX_MODE: "elicitation" },
    claudeControllerFactory: () =>
      createClaudeController(({ prompt, options }) => {
        let resolveDone;
        const done = new Promise((r) => {
          resolveDone = r;
        });
        return {
          async interrupt() {},
          [Symbol.asyncIterator]() {
            let step = 0;
            return {
              async next() {
                if (step === 0) {
                  step = 1;
                  const iter = prompt[Symbol.asyncIterator]();
                  await iter.next();
                  const elicitResult = await options.onElicitation({
                    serverName: "synthetic",
                    mode: "form",
                    message: "Formulario Claude",
                    requestedSchema: {
                      type: "object",
                      properties: {
                        confirmar: { type: "boolean" },
                        etiqueta: { type: "string" },
                        noEnviado: { type: "boolean", default: false },
                      },
                      required: ["confirmar", "etiqueta"],
                    },
                  });
                  return {
                    value: {
                      type: "assistant",
                      message: {
                        content: [
                          {
                            type: "text",
                            text: `cl-elicit=${JSON.stringify(elicitResult)}`,
                          },
                        ],
                      },
                      session_id: "cl-elicit-1",
                    },
                    done: false,
                  };
                }
                if (step === 1) {
                  step = 2;
                  return {
                    value: {
                      type: "result",
                      subtype: "success",
                      result: "ok",
                      session_id: "cl-elicit-1",
                    },
                    done: false,
                  };
                }
                if (step === 2) {
                  step = 3;
                  resolveDone();
                  return { value: undefined, done: true };
                }
                await done;
                return { value: undefined, done: true };
              },
              return() {
                resolveDone();
                return Promise.resolve({ value: undefined, done: true });
              },
            };
          },
        };
      }),
  });

  const controlToken = "control-secret";
  const hookToken = "hook-secret";
  const launcher = crearServidor({
    registro: h.registro,
    ejecutor: h.ejecutor,
    conversations: h.conversations,
    toolCatalog: h.toolCatalog,
    catalogo: { modelos: async () => ({}), validar: async () => true },
    uso: async () => ({}),
    items: () => [],
    acciones: null,
    equipos: null,
    proyectos: { demo: h.projectDir },
    espacios: null,
    controlHash: createHash("sha256").update(controlToken).digest("hex"),
    hookHash: createHash("sha256").update(hookToken).digest("hex"),
  });
  launcher.listen(0, "127.0.0.1");
  await once(launcher, "listening");
  t.after(() => {
    launcher.closeAllConnections?.();
    launcher.close();
  });
  const base = `http://127.0.0.1:${launcher.address().port}`;
  const hdrs = {
    "content-type": "application/json",
    authorization: `Bearer ${controlToken}`,
  };

  // Test Codex elicitation through HTTP
  const sx = await h.ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    brief: "form-codex",
    structured: true,
  });
  const reqC = await waitFor(async () => {
    const snap = await h.conversations.snapshot(sx.id);
    return snap.requests.find((r) => r.status === "pending");
  });

  // Missing required field -> 400
  const badRes = await fetch(`${base}/sesiones/${sx.id}/conversation/answer`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      requestId: reqC.id,
      responseId: randomUUID(),
      decision: "accept",
      content: { entorno: "staging", reintentos: 2 },
    }),
  });
  assert.equal(badRes.status, 400);

  // Valid form omitting optional boolean `omitida` -> NOT fabricated to false!
  const goodRes = await fetch(`${base}/sesiones/${sx.id}/conversation/answer`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      requestId: reqC.id,
      responseId: randomUUID(),
      decision: "accept",
      content: { entorno: "staging", reintentos: 2, confirmar: false },
    }),
  });
  assert.equal(goodRes.status, 200);
  await h.ejecutor.esperar(sx.id);
  const doneCodex = h.registro.leer().find((r) => r.id === sx.id);
  const parsedCodex = JSON.parse(
    doneCodex.resultado.replace("elicitation=", ""),
  );
  assert.deepEqual(parsedCodex, {
    action: "accept",
    content: { entorno: "staging", reintentos: 2, confirmar: false },
    _meta: null,
  });
  assert.equal(Object.hasOwn(parsedCodex.content, "omitida"), false);

  // Test Claude onElicitation preserving full content without fabricating defaults
  const sc = await h.ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "demo",
    brief: "form-claude",
    structured: true,
  });
  const reqCl = await waitFor(async () => {
    const snap = await h.conversations.snapshot(sc.id);
    return snap.requests.find((r) => r.status === "pending");
  });
  const clRes = await fetch(`${base}/sesiones/${sc.id}/conversation/answer`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      requestId: reqCl.id,
      responseId: randomUUID(),
      decision: "accept",
      content: { confirmar: true, etiqueta: "alta" },
    }),
  });
  assert.equal(clRes.status, 200);
  await h.ejecutor.esperar(sc.id);
  const doneClaude = h.registro.leer().find((r) => r.id === sc.id);
  const parsedClaude = JSON.parse(
    doneClaude.resultado.replace("cl-elicit=", ""),
  );
  assert.deepEqual(parsedClaude, {
    action: "accept",
    content: { confirmar: true, etiqueta: "alta" },
  });
  assert.equal(Object.hasOwn(parsedClaude.content, "noEnviado"), false);

  await h.ejecutor.cerrarConexion(sx.id);
});

test("regresión: validator aplica pattern, multipleOf, format, uniqueItems y rechaza keywords no soportados ANTES de pedir respuesta", () => {
  const patternSchema = {
    type: "object",
    properties: { x: { type: "string", pattern: "^SI$" } },
    required: ["x"],
  };
  assert.throws(
    () => validateAndExtractElicitationContent(patternSchema, { x: "NO" }),
    (e) => e.status === 400,
  );
  assert.deepEqual(
    validateAndExtractElicitationContent(patternSchema, { x: "SI" }),
    { x: "SI" },
  );

  const numSchema = {
    type: "object",
    properties: {
      paso: {
        type: "number",
        multipleOf: 0.1,
        exclusiveMinimum: 0,
        maximum: 1,
      },
      email: { type: "string", format: "email" },
      etiquetas: {
        type: "array",
        uniqueItems: true,
        items: { type: "string" },
      },
      opcional: { type: "boolean", default: false },
    },
    required: ["paso", "email"],
  };
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0.35,
        email: "a@b.co",
      }),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0,
        email: "a@b.co",
      }),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0.3,
        email: "invalido",
      }),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0.3,
        email: "a@b.co",
        etiquetas: ["a", "a"],
      }),
    (e) => e.status === 400,
  );
  const ok = validateAndExtractElicitationContent(numSchema, {
    paso: 0.3,
    email: "a@b.co",
    etiquetas: ["a", "b"],
  });
  assert.deepEqual(ok, { paso: 0.3, email: "a@b.co", etiquetas: ["a", "b"] });
  assert.equal(Object.hasOwn(ok, "opcional"), false);

  // Unsupported keywords rejected upfront in validateRequestedSchema (before asking user)
  for (const bad of [
    {
      type: "object",
      properties: { a: { type: "string" } },
      dependencies: { a: ["b"] },
    },
    { type: "object", properties: { a: { type: "string", customKeyword: 1 } } },
    {
      type: "object",
      properties: { a: { type: "string", format: "hostname" } },
    },
    {
      type: "object",
      properties: { a: { type: "string", pattern: "[invalido" } },
    },
    { type: "object", properties: { a: { type: "number", multipleOf: 0 } } },
  ]) {
    assert.throws(
      () => validateRequestedSchema(bad),
      (e) => e.status === 400,
    );
  }
});
