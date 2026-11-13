import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { abrirRegistro } from "../sesiones.mjs";
import { abrirEquipos } from "../equipos.mjs";
import { crearEjecutor } from "../ejecucion.mjs";
import { crearServidor } from "../index.mjs";
import { createProviderConversations } from "../provider-conversations.mjs";

test("sesión estructurada de extremo a extremo: pregunta, autenticación, respuesta y reanudación", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-provider-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registro = await abrirRegistro(path.join(dir, "sessions.json"));
  let resume;
  let asked;
  let ready = new Promise((r) => {
    asked = r;
  });
  const conversations = createProviderConversations({
    directory: path.join(dir, "conversations"),
    adapters: {
      codex: async (ctx) => {
        resume = ctx.session.conversacionId;
        await ctx.nativeId("native-thread");
        const answer = ctx.ask("native-request", {
          kind: "question",
          title: "Pregunta",
          questions: [{ id: "mode", question: "Modalidad" }],
        });
        asked();
        const value = await answer;
        ctx.message("answer-" + ctx.prompt, value.mode);
      },
    },
  });
  const ejecutor = crearEjecutor({
    registro,
    proyectos: { demo: dir },
    conversations,
    env: {},
  });
  const hash = (token) => createHash("sha256").update(token).digest("hex");
  const server = crearServidor({
    registro,
    ejecutor,
    conversations,
    controlHash: hash("control"),
    hookHash: hash("hook"),
    catalogo: { validar: async () => {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, token = "control") =>
    fetch(base + url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const start = await post("/sesiones", {
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    structured: true,
    brief: "primer turno",
  });
  assert.equal(start.status, 202);
  const session = await start.json();
  await ready;
  const request = (await conversations.snapshot(session.id)).requests[0];
  const body = {
    requestId: request.id,
    responseId: randomUUID(),
    answers: { mode: "remoto" },
  };
  assert.equal(
    (await post(`/sesiones/${session.id}/conversation/answer`, body, "hook"))
      .status,
    401,
  );
  assert.equal(
    (await post(`/sesiones/${session.id}/conversation/answer`, body)).status,
    200,
  );
  await ejecutor.esperar(session.id);
  assert.equal(registro.leer()[0].resultado, "remoto");
  assert.equal(registro.leer()[0].structured, true);
  ready = new Promise((r) => {
    asked = r;
  });
  await ejecutor.continuar(session.id, "segundo turno");
  await ready;
  assert.equal(resume, "native-thread");
  const second = (await conversations.snapshot(session.id)).requests.at(-1);
  await conversations.answer(session.id, {
    requestId: second.id,
    responseId: randomUUID(),
    answers: { mode: "híbrido" },
  });
  await ejecutor.esperar(session.id);
  assert.equal((await conversations.snapshot(session.id)).requests.length, 2);
});

test("delegar conserva protocolo, modelo y esfuerzo y separa archivos incluso con el mismo motor", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-provider-team-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registro = await abrirRegistro(path.join(dir, "sessions.json"));
  const equipos = await abrirEquipos(path.join(dir, "teams"), {
    activo: (id) =>
      registro.leer().some((s) => s.id === id && s.estado === "trabajando"),
  });
  let release;
  const leaderWait = new Promise((r) => {
    release = r;
  });
  const conversations = createProviderConversations({
    directory: path.join(dir, "conversations"),
    adapters: {
      codex: async (ctx) => {
        await ctx.nativeId(randomUUID());
        if (ctx.prompt === "coordina") await leaderWait;
        ctx.message("result", "OK");
      },
    },
  });
  const ejecutor = crearEjecutor({
    registro,
    equipos,
    proyectos: { demo: dir },
    conversations,
    env: { SB_LANZADOR_DATA_DIR: path.join(dir, "runtime") },
  });
  const leader = await ejecutor.encargar({
    motor: "codex",
    origen: "sala",
    proyecto: "demo",
    structured: true,
    brief: "coordina",
  });
  const child = await ejecutor.encargarHija(leader.id, {
    motor: "codex",
    modelo: "test-model",
    esfuerzo: "high",
    brief: "investiga",
  });
  assert.equal(child.structured, true);
  assert.equal(child.modelo, "test-model");
  assert.equal(child.esfuerzo, "high");
  assert.notEqual(
    child.directorio,
    registro.leer().find((s) => s.id === leader.id).directorio,
  );
  await ejecutor.esperar(child.id);
  release();
  await ejecutor.esperar(leader.id);
});
