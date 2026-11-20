import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApplication } from "../index.mjs";
import { getCsrfHeaders } from "./helpers/csrf.mjs";

let THREAD = "thr_abc1234567";
const REQUEST = "req_def1234567";

/** A launcher that answers the thread API from memory. */
async function fakeLauncher(t) {
  const seen = /** @type {any[]} */ ([]);
  /** @type {any} */
  let asked = null;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const data = text ? JSON.parse(text) : undefined;
    seen.push({ method: req.method, url: req.url, data, headers: req.headers });
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const url = req.url ?? "";
    if (url === "/threads" && req.method === "POST") {
      THREAD = data.threadId;
      return json(201, { thread: { id: THREAD, status: "running" } });
    }
    if (url.startsWith("/threads?") || url === "/threads")
      return json(200, { threads: [{ id: THREAD }] });
    if (url === `/threads/${THREAD}/ask`) {
      asked = {
        id: REQUEST,
        threadId: THREAD,
        kind: "question",
        title: data.title,
        body: data.body,
        options: (data.options ?? []).map((label, i) => ({
          id: `o${i + 1}`,
          label,
        })),
        status: "open",
        answer: null,
        origin: null,
        createdAt: "2026-11-20T10:00:00.000Z",
        answeredAt: null,
      };
      return json(201, { request: asked });
    }
    if (
      url === `/threads/${THREAD}/requests/${REQUEST}` &&
      req.method === "GET"
    )
      return json(200, { request: asked });
    if (url === `/threads/${THREAD}/requests/${REQUEST}`) {
      asked = {
        ...asked,
        status: "answered",
        answer: data.answer,
        origin: data.origin,
      };
      return json(200, { request: asked });
    }
    if (url === `/threads/${THREAD}/messages`)
      return json(409, { error: "El thread ya está cerrado.", seguro: true });
    if (url === `/threads/${THREAD}/close`)
      return json(200, { thread: { id: THREAD, status: "done" } });
    if (url.startsWith(`/threads/${THREAD}/stream`)) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end('id: 4\ndata: {"type":"event"}\n\n');
    }
    if (url === "/inbox") return json(200, { entries: [] });
    json(404, { error: "no" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    answer: () => {
      asked = {
        ...asked,
        status: "answered",
        answer: { optionId: "o2" },
        origin: "app",
      };
    },
  };
}

test("threads are relayed to the launcher with a credential per thread", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-threads-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Prueba\n");
  const launcher = await fakeLauncher(t);
  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    lanzador: { url: launcher.url, token: "ctrl" },
  });
  t.after(() => app.close());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const owner = await getCsrfHeaders(base);

  const created = await fetch(`${base}/threads`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({
      prompt: "Hola",
      kind: "scratch",
      agent: { engine: "codex" },
    }),
  });
  assert.equal(created.status, 201);
  const sent = launcher.seen.find(
    (s) => s.url === "/threads" && s.method === "POST",
  );
  assert.match(sent.data.capabilityToken, /^sbcap_[a-f0-9]{48}$/);
  assert.match(sent.data.threadId, /^thr_[0-9a-f]{20}$/);
  assert.equal(sent.headers.authorization, "Bearer ctrl");
  const agent = {
    authorization: `Bearer ${sent.data.capabilityToken}`,
    "content-type": "application/json",
  };

  // The usuario_* tools of an agent in a thread ask through the thread.
  const asked = await fetch(`${base}/solicitudes/preguntar`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({
      pregunta: "¿A o B?\nDetalle",
      opciones: ["A", "B"],
    }),
  }).then((r) => r.json());
  assert.equal(asked.solicitud.id, REQUEST);
  assert.equal(asked.solicitud.status, "pendiente");
  assert.equal(asked.solicitud.title, "¿A o B?");
  const detail = await fetch(`${base}/solicitudes/detalle?id=${REQUEST}`, {
    headers: agent,
  }).then((r) => r.json());
  assert.equal(detail.solicitud.status, "pendiente");
  launcher.answer();
  const waited = await fetch(`${base}/solicitudes/esperar`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({ id: REQUEST, timeout: 2000 }),
  }).then((r) => r.json());
  assert.equal(waited.solicitud.status, "respondida");
  assert.deepEqual(waited.solicitud.answer, { optionId: "o2" });
  const direct = await fetch(`${base}/threads/agente/preguntar`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({ title: "Formulario", options: ["x"] }),
  });
  assert.equal(direct.status, 201);

  // Agents cannot drive threads; the room token cannot ask in a thread.
  assert.equal(
    (await fetch(`${base}/threads`, { headers: agent })).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/threads/agente/preguntar`, {
        method: "POST",
        headers: { ...agent, authorization: "Bearer room-secret" },
        body: JSON.stringify({ title: "x" }),
      })
    ).status,
    403,
  );

  // Owner routes.
  const list = await fetch(`${base}/threads?status=idle,running`, {
    headers: owner,
  }).then((r) => r.json());
  assert.deepEqual(list.threads, [{ id: THREAD }]);
  assert.ok(
    launcher.seen.some((s) => s.url === "/threads?status=idle%2Crunning"),
  );
  const answered = await fetch(`${base}/threads/responder`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({
      id: THREAD,
      requestId: REQUEST,
      answer: { text: "B" },
    }),
  }).then((r) => r.json());
  assert.equal(answered.request.origin, "app");
  const refused = await fetch(`${base}/threads/mensajes`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ id: THREAD, text: "x", mode: "send" }),
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "El thread ya está cerrado.");
  assert.equal(
    (
      await fetch(`${base}/threads/mensajes`, {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ id: "../etc", text: "x", mode: "send" }),
      })
    ).status,
    400,
  );
  const stream = await fetch(`${base}/threads/flujo?id=${THREAD}&after=3`, {
    headers: { ...owner, "last-event-id": "3" },
  });
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  assert.match(await stream.text(), /^id: 4\n/);
  const upstream = launcher.seen.find((s) =>
    s.url?.startsWith(`/threads/${THREAD}/stream`),
  );
  assert.equal(upstream.url, `/threads/${THREAD}/stream?after=3`);
  assert.equal(upstream.headers["last-event-id"], "3");
  assert.deepEqual(
    await fetch(`${base}/bandeja`, { headers: owner }).then((r) => r.json()),
    { entries: [] },
  );

  // Closing (other than by PR) revokes the thread's credential.
  const closed = await fetch(`${base}/threads/cerrar`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ id: THREAD, mode: "merge" }),
  });
  assert.equal(closed.status, 200);
  const after = await fetch(`${base}/solicitudes/detalle?id=${REQUEST}`, {
    headers: agent,
  });
  assert.ok([401, 403].includes(after.status));
});
