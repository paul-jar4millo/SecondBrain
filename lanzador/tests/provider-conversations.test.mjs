import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createProviderConversations } from "../provider-conversations.mjs";
import { createApplication } from "../../service/index.mjs";
import { abrirRegistro } from "../sessions.mjs";
import { crearEjecutor } from "../executor.mjs";
import { crearServidor } from "../index.mjs";

async function fixture(t, adapter) {
  const directory = await mkdtemp(path.join(tmpdir(), "sb-protocol-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const conversations = createProviderConversations({
    directory,
    adapters: { codex: adapter },
  });
  const session = { id: randomUUID(), motor: "codex" };
  return {
    directory,
    session,
    conversations,
    run: () =>
      conversations.run({
        session,
        prompt: "Investiga",
        env: {},
        cwd: directory,
        onNativeId: async () => {},
      }),
  };
}

test("la pregunta persiste sin lectores y solo una respuesta simultánea llega al proveedor", async (t) => {
  let ready;
  const asked = new Promise((r) => {
    ready = r;
  });
  let observed;
  const f = await fixture(t, async (ctx) => {
    const answer = ctx.ask("native-7", {
      kind: "question",
      title: "Modalidad",
      questions: [{ id: "mode", question: "¿Remoto?" }],
    });
    ready();
    observed = await answer;
    ctx.message("a1", "Resultado verificado");
  });
  const execution = f.run();
  await asked;
  const snapshot = await f.conversations.snapshot(f.session.id);
  const request = snapshot.requests[0];
  assert.equal(request.status, "pending");
  assert.equal(
    JSON.parse(
      await readFile(path.join(f.directory, f.session.id + ".json"), "utf8"),
    ).requests[0].id,
    request.id,
  );
  const response = {
    requestId: request.id,
    responseId: randomUUID(),
    answers: { mode: "Sí" },
  };
  const results = await Promise.allSettled([
    f.conversations.answer(f.session.id, response),
    f.conversations.answer(f.session.id, {
      ...response,
      responseId: randomUUID(),
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.deepEqual(observed, { mode: "Sí" });
  await execution;
  assert.equal(
    (await f.conversations.snapshot(f.session.id)).items.at(-1).texto,
    "Resultado verificado",
  );
  assert.equal(
    (await f.conversations.answer(f.session.id, response)).responseId,
    response.responseId,
  );
});

test("una pregunta de un proceso anterior queda vencida después de reiniciar", async (t) => {
  const f = await fixture(t, async () => {});
  const id = randomUUID();
  await writeFile(
    path.join(f.directory, f.session.id + ".json"),
    JSON.stringify({
      seq: 1,
      items: [],
      receipts: [],
      requests: [{ id, status: "pending" }],
    }),
  );
  assert.equal(
    (await f.conversations.snapshot(f.session.id)).requests[0].status,
    "expired",
  );
  await assert.rejects(
    f.conversations.answer(f.session.id, {
      requestId: id,
      responseId: randomUUID(),
      decision: "accept",
    }),
    /vigente/,
  );
});

test("el cierre nativo conserva la pregunta, sin responder al siguiente callback", async (t) => {
  const f = await fixture(t, async (ctx) => {
    const answer = ctx.ask("request-1", {
      kind: "question",
      title: "Pregunta",
      questions: [],
    });
    ctx.expire("request-1");
    await assert.rejects(answer, /venció/);
    ctx.message("result", "Continúa el historial");
  });
  await f.run();
  const state = await f.conversations.snapshot(f.session.id);
  assert.equal(state.requests[0].status, "expired");
  assert.equal(state.items.at(-1).texto, "Continúa el historial");
});

test("conserva salidas completas y empareja estados de herramientas por ID", async (t) => {
  const output = "é".repeat(5000);
  const f = await fixture(t, async (ctx) => {
    ctx.tool("tool-1", {
      nombre: "Read",
      resumen: "Fuente",
      estado: "pendiente",
    });
    ctx.tool("tool-1", { resultado: output, estado: "ok" });
    ctx.delta("message-1", "Hola ");
    ctx.delta("message-1", "Ana");
    ctx.message("message-1", "Hola Ana");
  });
  await f.run();
  const state = await f.conversations.snapshot(f.session.id);
  assert.equal(
    state.items.find((i) => i.id === "tool-1").herramienta.resultado,
    output,
  );
  assert.equal(state.items.filter((i) => i.id === "message-1").length, 1);
  assert.equal(state.items.at(-1).texto, "Hola Ana");
});

test("mensajería estructurada: idempotencia, steer en vivo, cola cancelable y limpieza síncrona de callbacks al interrumpir", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-proto-steer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let releaseTurn1;
  let turnCount = 0;
  const steers = [];
  const prompts = [];
  const conversations = createProviderConversations({
    directory: dir,
    adapters: {
      codex: async (ctx) => {
        turnCount++;
        prompts.push(ctx.prompt);
        ctx.onControl({
          supportsSteer: true,
          steer: async (text) => {
            steers.push(text);
          },
        });
        await ctx.nativeId("th-steer-1");
        if (turnCount === 1) {
          let resolveAsk;
          const aborted = new Promise((r) => {
            resolveAsk = r;
          });
          ctx.onAbort(() => resolveAsk());
          const inFlight = ctx.ask("cb-inflight", {
            kind: "question",
            title: "Duda en vuelo",
            questions: [{ id: "q", question: "¿Seguir?" }],
          });
          inFlight.catch(() => {});
          await new Promise((r) => {
            releaseTurn1 = r;
          });
          if (steers.length > 0) {
            ctx.message("m1", "Redirigido: " + steers[0]);
            return { status: "completed" };
          }
          await aborted;
          await assert.rejects(inFlight, /interrumpi/);
          return { status: "interrupted" };
        }
        ctx.message("m2", "Turno cola: " + ctx.prompt);
        return { status: "completed" };
      },
    },
  });

  const registro = await abrirRegistro(path.join(dir, "sessions.json"));
  const ejecutor = crearEjecutor({
    registro,
    proyectos: { demo: dir },
    conversations,
    env: {},
  });

  const s = await ejecutor.encargar({
    motor: "codex",
    origen: "encargo",
    proyecto: "demo",
    structured: true,
    brief: "Turno inicial",
  });
  for (let i = 0; i < 40 && !releaseTurn1; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Idempotent steer during execution
  const steer1 = await ejecutor.enviarMensaje(s.id, {
    clientMessageId: "cm-steer-1",
    text: "Cambia prioridad",
    mode: "steer",
  });
  const steerDup = await ejecutor.enviarMensaje(s.id, {
    clientMessageId: "cm-steer-1",
    text: "Cambia prioridad",
    mode: "steer",
  });
  assert.equal(steer1.modo, "steer");
  assert.equal(steer1.command.deliveryStatus, "confirmado_proveedor");
  assert.equal(steerDup.repetido, true);

  // Queue two messages, cancel the second before dispatch, keep the first
  const q1 = await ejecutor.enviarMensaje(s.id, {
    clientMessageId: "cm-queue-1",
    text: "Segundo turno en cola",
    mode: "queue",
  });
  const q2 = await ejecutor.enviarMensaje(s.id, {
    clientMessageId: "cm-queue-2",
    text: "Cancelable",
    mode: "queue",
  });
  assert.equal(q1.command.deliveryStatus, "en_cola");
  assert.equal((await ejecutor.listarCola(s.id)).length, 2);
  await ejecutor.cancelarCola(s.id, q2.command.clientMessageId);
  assert.equal((await ejecutor.listarCola(s.id)).length, 1);

  releaseTurn1();
  await ejecutor.esperar(s.id);
  // Wait briefly for queued dispatch
  for (let i = 0; i < 60 && prompts.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  await ejecutor.esperar(s.id);
  assert.deepEqual(prompts, ["Turno inicial", "Segundo turno en cola"]);
  assert.equal(
    registro.leer().find((x) => x.id === s.id).resultado,
    "Turno cola: Segundo turno en cola",
  );
});

/**
 * A turn ends in two steps: the provider layer forgets it first, the executor
 * frees the session afterwards. `gate` holds the session in between so a
 * message can land exactly there.
 */
async function turnBoundary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-proto-boundary-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prompts = [];
  const inner = createProviderConversations({
    directory: dir,
    adapters: {
      codex: async (ctx) => {
        prompts.push(ctx.prompt);
        await ctx.nativeId("th-boundary");
        ctx.message(`m${prompts.length}`, "Hecho: " + ctx.prompt);
        return { status: "completed" };
      },
    },
  });
  const gate = { hold: null, reached: false, release: () => {} };
  const conversations = {
    ...inner,
    run: async (...args) => {
      const result = await inner.run(...args);
      gate.reached = true;
      if (gate.hold) await gate.hold;
      return result;
    },
  };
  const registro = await abrirRegistro(path.join(dir, "sessions.json"));
  const ejecutor = crearEjecutor({
    registro,
    proyectos: { demo: dir },
    conversations,
    env: {},
  });
  const holdNextTurn = () => {
    gate.hold = new Promise((r) => {
      gate.release = () => {
        gate.hold = null;
        r();
      };
    });
  };
  // The provider has completed the turn; the executor still holds it.
  const turnHeld = async () => {
    for (let i = 0; i < 200 && !gate.reached; i++)
      await new Promise((r) => setTimeout(r, 5));
  };
  const deliveredSecond = async () => {
    for (let i = 0; i < 200 && prompts.length < 2; i++)
      await new Promise((r) => setTimeout(r, 5));
  };
  return {
    prompts,
    registro,
    ejecutor,
    inner,
    conversations,
    gate,
    holdNextTurn,
    turnHeld,
    deliveredSecond,
  };
}

test("un mensaje enviado justo cuando termina el turno se entrega en el siguiente", async (t) => {
  const f = await turnBoundary(t);
  f.holdNextTurn();
  const s = await f.ejecutor.encargar({
    motor: "codex",
    origen: "encargo",
    proyecto: "demo",
    structured: true,
    brief: "Primero",
  });
  await f.turnHeld();
  const sent = await f.ejecutor.enviarMensaje(s.id, {
    clientMessageId: "cm-boundary",
    text: "Segundo",
    mode: "send",
  });
  assert.equal(sent.queued, true);
  f.gate.release();
  await f.deliveredSecond();
  await f.ejecutor.esperar(s.id);
  assert.deepEqual(f.prompts, ["Primero", "Segundo"]);
  const [command] = (await f.inner.snapshot(s.id)).commands.filter(
    (c) => c.clientMessageId === "cm-boundary",
  );
  assert.ok(
    ["entregado", "confirmado_proveedor"].includes(command.deliveryStatus),
    command.deliveryStatus,
  );
});

test("un mensaje encolado después de revisar la cola no queda varado", async (t) => {
  const f = await turnBoundary(t);
  const s = await f.ejecutor.encargar({
    motor: "codex",
    origen: "encargo",
    proyecto: "demo",
    structured: true,
    brief: "Primero",
  });
  // The message is accepted while the turn runs, but reaches the queue only
  // after the executor has freed the session and found the queue empty.
  let enqueue;
  const late = new Promise((r) => (enqueue = r));
  const sendMessage = f.conversations.sendMessage;
  f.conversations.sendMessage = async (...args) => {
    await late;
    return sendMessage(...args);
  };
  const sending = f.ejecutor.enviarMensaje(s.id, {
    clientMessageId: "cm-late",
    text: "Segundo",
    mode: "send",
  });
  await f.ejecutor.esperar(s.id);
  await new Promise((r) => setTimeout(r, 20));
  enqueue();
  assert.equal((await sending).queued, true);
  await f.deliveredSecond();
  await f.ejecutor.esperar(s.id);
  assert.deepEqual(f.prompts, ["Primero", "Segundo"]);
});

test("recorrido vertical completo con puente service <-> lanzador: pregunta, respuesta, artefacto hash, interrupción sin contaminación y reanudación", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-vertical-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Sintético\n");

  const registro = await abrirRegistro(path.join(dir, "sessions.json"));
  let askReady;
  let askBarrier = new Promise((r) => {
    askReady = r;
  });
  let releaseInterrupt;
  let turnNum = 0;
  const conversations = createProviderConversations({
    directory: path.join(dir, "conversations"),
    adapters: {
      codex: async (ctx) => {
        turnNum++;
        await ctx.nativeId("th-vert-1");
        if (turnNum === 1) {
          ctx.tool("tl-1", {
            nombre: "brain_read",
            resumen: "Home.md",
            estado: "pendiente",
          });
          ctx.tool("tl-1", { resultado: "ok", estado: "ok" });
          const ansPromise = ctx.ask("nat-q-1", {
            kind: "question",
            title: "Ruta",
            questions: [{ id: "ruta", question: "¿A o B?" }],
          });
          askReady();
          const ans = await ansPromise;
          await ctx.artifact({
            fileRef: "docs/entregable.md",
            content: "Contenido " + ans.ruta,
          });
          ctx.message("msg-1", "Entregable con " + ans.ruta);
          return { status: "completed" };
        }
        if (turnNum === 2) {
          // Turn 2 opens an ask in flight and is interrupted before user replies
          const stalePromise = ctx.ask("nat-stale", {
            kind: "question",
            title: "Bloqueado",
            questions: [{ id: "x", question: "¿Interrumpir?" }],
          });
          askReady();
          await new Promise((r) => {
            releaseInterrupt = r;
          });
          await stalePromise.catch(() => {});
          return { status: "interrupted" };
        }
        ctx.message("msg-3", "Reanudado limpio tras interrupción");
        return { status: "completed" };
      },
    },
  });

  const ejecutor = crearEjecutor({
    registro,
    proyectos: { demo: dir },
    conversations,
    env: {},
  });
  const h = (v) => createHash("sha256").update(v).digest("hex");
  const launcher = crearServidor({
    registro,
    ejecutor,
    conversations,
    controlHash: h("ctrl"),
    hookHash: h("hook"),
    catalogo: { validar: async () => {} },
  });
  launcher.listen(0, "127.0.0.1");
  await once(launcher, "listening");
  t.after(() => {
    launcher.closeAllConnections();
    launcher.close();
  });

  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "service-data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    lanzador: {
      url: `http://127.0.0.1:${launcher.address().port}`,
      token: "ctrl",
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const csrfRes = await fetch(`${base}/auth/csrf`);
  const { token: csrfToken } = await csrfRes.json();
  const appHeaders = {
    "content-type": "application/json",
    "x-csrf-token": csrfToken,
    origin: base.replace("/api/v1", ""),
    cookie: csrfRes.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };

  // Create WorkOrder and launch bridged session
  const { encargo } = await fetch(`${base}/encargos`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      title: "Vertical",
      objective: "Probar recorrido vertical",
      acceptanceCriteria: [{ text: "Artefacto con hash y reanudación limpia" }],
      team: [
        {
          id: "menta-1",
          characterId: "menta",
          engine: "codex",
          model: "gpt-5.6-luna",
          role: "Ejecutora",
          responsibility: "Recorrido vertical",
          coordinator: true,
        },
      ],
    }),
  }).then((r) => r.json());

  const session = await fetch(`${base}/agentes/sesiones`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      motor: "codex",
      origen: "encargo",
      proyecto: "demo",
      structured: true,
      workOrderId: encargo.id,
      memberId: "menta-1",
      toolProfileId: "ejecucion",
      brief: "Ejecuta recorrido vertical",
    }),
  }).then((r) => r.json());

  await askBarrier;
  // Wait for native request & service UserRequest sync
  let liveSnap;
  for (let i = 0; i < 50; i++) {
    liveSnap = await conversations.snapshot(session.id);
    if (
      liveSnap.requests.length > 0 &&
      app.userRequests.list({ workOrderId: encargo.id }).length > 0
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const req = liveSnap.requests[0];
  await fetch(`${base}/agentes/conversacion/responder`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: session.id,
      requestId: req.id,
      responseId: randomUUID(),
      answers: { ruta: "Opción A" },
    }),
  });
  await ejecutor.esperar(session.id);

  // Allow SSE bridge to flush artifact & turn.completed to WorkOrder
  for (let i = 0; i < 60; i++) {
    if (app.workOrders.get(encargo.id).artifacts.length > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const afterTurn1 = app.workOrders.get(encargo.id);
  assert.equal(afterTurn1.artifacts.length, 1);
  assert.ok(afterTurn1.artifacts[0].hash.length === 64);

  // Turn 2: start, get in-flight request, interrupt -> callback cancelled synchronously, late answer rejected!
  askBarrier = new Promise((r) => {
    askReady = r;
  });
  await fetch(`${base}/agentes/conversacion/mensajes`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: session.id,
      clientMessageId: "turn-2-interrupt",
      text: "Paso 2 interrumpible",
      mode: "send",
    }),
  });
  await askBarrier;
  const staleReq = (await conversations.snapshot(session.id)).requests.at(-1);
  await ejecutor.cancelar(session.id);
  releaseInterrupt();
  await ejecutor.esperar(session.id);

  const lateRes = await fetch(`${base}/agentes/conversacion/responder`, {
    method: "POST",
    headers: appHeaders,
    body: JSON.stringify({
      id: session.id,
      requestId: staleReq.id,
      responseId: randomUUID(),
      answers: { x: "Tardía" },
    }),
  });
  assert.equal(lateRes.status, 409);

  // Turn 3: resume cleanly without contamination from cancelled turn 2 callback
  await ejecutor.continuar(session.id, "Reanuda paso final");
  await ejecutor.esperar(session.id);
  assert.equal(
    registro.leer().find((x) => x.id === session.id).resultado,
    "Reanudado limpio tras interrupción",
  );
});

test("el silencio o inactividad nunca fabrica una pregunta ni usa el motor sin steering en vivo", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-silence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fakeSilent = path.join(dir, "silent.mjs");
  await writeFile(fakeSilent, "setTimeout(() => process.exit(0), 120);");

  const convDirect = createProviderConversations({
    directory: path.join(dir, "conv2"),
    adapters: {
      claude: async (ctx) => {
        ctx.onControl({ supportsSteer: false });
        const child = ctx.spawn(process.execPath, [fakeSilent]);
        await ctx.nativeId("claude-silent");
        await new Promise((resolve) => child.once("exit", resolve));
        ctx.message("c1", "Respuesta " + ctx.prompt);
        return { status: "completed" };
      },
    },
  });
  const reg2 = await abrirRegistro(path.join(dir, "sessions2.json"));
  const exec2 = crearEjecutor({
    registro: reg2,
    proyectos: { demo: dir },
    conversations: convDirect,
    env: {},
    inactividadMs: 25,
  });
  const s = await exec2.encargar({
    motor: "claude",
    origen: "encargo",
    proyecto: "demo",
    structured: true,
    brief: "Turno 1",
  });
  let sawInactivityNotice = false;
  for (let i = 0; i < 30; i++) {
    if (
      reg2.leer()[0]?.ultimaAccion ===
      "Sin actividad; puedes cancelar la sesión."
    ) {
      sawInactivityNotice = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(sawInactivityNotice, true);
  // Requesting steer on Claude falls back cleanly to queue ("en_cola"), never silent failure
  const queuedFallback = await exec2.enviarMensaje(s.id, {
    clientMessageId: "claude-fallback-q1",
    text: "Turno siguiente",
    mode: "steer",
  });
  assert.equal(queuedFallback.modo, "queue");
  assert.equal(queuedFallback.command.deliveryStatus, "en_cola");
  await exec2.esperar(s.id);
  for (let i = 0; i < 50; i++) {
    if (reg2.leer()[0].resultado === "Respuesta Turno siguiente") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await exec2.esperar(s.id);
  const snap = await convDirect.snapshot(s.id);
  assert.equal(snap.requests.length, 0);
  assert.equal(reg2.leer()[0].resultado, "Respuesta Turno siguiente");
});
