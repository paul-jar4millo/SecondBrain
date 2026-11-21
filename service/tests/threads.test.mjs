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
const SUBTASK = "req_sub1234567";

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
    const subtask = {
      id: SUBTASK,
      threadId: THREAD,
      kind: "subtask",
      title: "Sub-tarea: Docs",
      body: "",
      subtask: { title: "Docs", prompt: "b", agent: { engine: "codex" } },
      status: "open",
    };
    if (url === `/threads/${THREAD}/subtasks` && req.method === "POST")
      return json(201, { request: subtask });
    if (url === `/threads/${THREAD}/requests/${SUBTASK}`)
      return req.method === "GET"
        ? json(200, { request: subtask })
        : json(200, { request: { ...subtask, status: "answered" } });
    if (/^\/threads\/thr_[^/]+\/subtasks$/.test(url) && req.method === "GET")
      return json(200, { subtasks: [] });
    if (/^\/threads\/[^/]+\/subtasks\/thr_[^/]+\/integrate$/.test(url))
      return json(200, { integrated: true });
    if (url === `/threads/${THREAD}/review`)
      return json(201, { recorded: true, round: 1, verdict: data.verdict });
    if (url === `/threads/${THREAD}/handoff`)
      return json(202, { accepted: true, toStage: data.toStage });
    if (url === "/flows")
      return json(200, {
        flows: [
          { id: "single" },
          {
            id: "plan-implement-review",
            stages: [{ key: "plan" }, { key: "implement" }, { key: "review" }],
          },
        ],
      });
    if (url === "/usage") return json(200, { codex: { ventanas: {} } });
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

test("a flow's credential answers to the agent of every stage", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-threads-flow-"));
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
  // The dialog also sends its single agent, which no stage uses here.
  const created = await fetch(`${base}/threads`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({
      prompt: "Hola",
      kind: "scratch",
      agent: { engine: "agy" },
      flowTemplateId: "plan-implement-review",
      stageAgents: {
        plan: { engine: "codex" },
        implement: { engine: "codex" },
        review: { engine: "claude" },
      },
    }),
  });
  assert.equal(created.status, 201);
  const sent = launcher.seen.find(
    (s) => s.url === "/threads" && s.method === "POST",
  );
  const as = (/** @type {string} */ who) => ({
    authorization: `Bearer ${sent.data.capabilityToken}`,
    "content-type": "application/json",
    "x-sb-agente": who,
  });
  for (const who of ["menta", "ambar"]) {
    const handed = await fetch(`${base}/threads/agent/handoff`, {
      method: "POST",
      headers: as(who),
      body: JSON.stringify({ toStage: "implement", narrative: "Listo." }),
    });
    assert.equal(handed.status, 202, who);
  }
  const stranger = await fetch(`${base}/threads/agent/handoff`, {
    method: "POST",
    headers: as("lira"),
    body: JSON.stringify({ toStage: "implement", narrative: "Listo." }),
  });
  assert.equal(stranger.status, 403);
  // agent_usage works from inside a thread.
  const usage = await fetch(`${base}/agents/usage`, { headers: as("menta") });
  assert.equal(usage.status, 200);
});

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
  const billed = await fetch(`${base}/threads`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({
      prompt: "Hola",
      kind: "scratch",
      agent: { engine: "codex" },
      flowTemplateId: "plan-implement-review",
      stageAgents: { review: { engine: "deepseek" } },
    }),
  });
  assert.equal(billed.status, 403);
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
  const asked = await fetch(`${base}/requests/ask`, {
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
  const detail = await fetch(`${base}/requests/detail?id=${REQUEST}`, {
    headers: agent,
  }).then((r) => r.json());
  assert.equal(detail.solicitud.status, "pendiente");
  launcher.answer();
  const waited = await fetch(`${base}/requests/wait`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({ id: REQUEST, timeout: 2000 }),
  }).then((r) => r.json());
  assert.equal(waited.solicitud.status, "respondida");
  assert.deepEqual(waited.solicitud.answer, { optionId: "o2" });
  const direct = await fetch(`${base}/threads/agent/ask`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({ title: "Formulario", options: ["x"] }),
  });
  assert.equal(direct.status, 201);
  const handoff = await fetch(`${base}/threads/agent/handoff`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({ toStage: "implement", narrative: "Plan listo" }),
  });
  assert.equal(handoff.status, 202);
  // Subtasks: the agent asks, the owner approves and the child thread gets
  // its own credential; integrating the child revokes it.
  const asks = await fetch(`${base}/threads/agent/subtask`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({ title: "Docs", prompt: "b" }),
  });
  assert.equal(asks.status, 201);
  assert.equal((await asks.json()).solicitud.kind, "subtask");
  const approved = await fetch(`${base}/threads/answer`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({
      id: THREAD,
      requestId: SUBTASK,
      answer: { approved: true },
    }),
  });
  assert.equal(approved.status, 200);
  const approval = launcher.seen.findLast(
    (s) =>
      s.url === `/threads/${THREAD}/requests/${SUBTASK}` && s.method === "POST",
  );
  assert.match(approval.data.childId, /^thr_[0-9a-f]{20}$/);
  assert.match(approval.data.capabilityToken, /^sbcap_[a-f0-9]{48}$/);
  const childAgent = {
    authorization: `Bearer ${approval.data.capabilityToken}`,
    "content-type": "application/json",
  };
  assert.equal(
    (await fetch(`${base}/threads/agent/subtasks`, { headers: childAgent }))
      .status,
    200,
  );
  const integrated = await fetch(`${base}/threads/agent/subtasks/integrate`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({ id: approval.data.childId }),
  });
  assert.equal(integrated.status, 200);
  assert.notEqual(
    (await fetch(`${base}/threads/agent/subtasks`, { headers: childAgent }))
      .status,
    200,
  );
  const review = await fetch(`${base}/threads/agent/review`, {
    method: "POST",
    headers: agent,
    body: JSON.stringify({
      verdict: "changes-requested",
      summary: "Falta un caso",
      findings: [{ severity: "major", text: "caso vacío", line: 3 }],
    }),
  });
  assert.equal(review.status, 201);
  assert.equal((await review.json()).verdict, "changes-requested");
  assert.equal(
    (
      await fetch(`${base}/threads/agent/review`, {
        method: "POST",
        headers: agent,
        body: JSON.stringify({ verdict: "maybe", summary: "x" }),
      })
    ).status,
    400,
  );
  assert.deepEqual(await handoff.json(), {
    accepted: true,
    toStage: "implement",
  });
  assert.equal(
    (
      await fetch(`${base}/threads/agent/handoff`, {
        method: "POST",
        headers: { ...agent, authorization: "Bearer room-secret" },
        body: JSON.stringify({ toStage: "implement", narrative: "x" }),
      })
    ).status,
    403,
  );

  // Agents cannot drive threads; the room token cannot ask in a thread.
  assert.equal(
    (await fetch(`${base}/threads`, { headers: agent })).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/threads/agent/ask`, {
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
  const answered = await fetch(`${base}/threads/answer`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({
      id: THREAD,
      requestId: REQUEST,
      answer: { text: "B" },
    }),
  }).then((r) => r.json());
  assert.equal(answered.request.origin, "app");
  const refused = await fetch(`${base}/threads/messages`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ id: THREAD, text: "x", mode: "send" }),
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "El thread ya está cerrado.");
  assert.equal(
    (
      await fetch(`${base}/threads/messages`, {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ id: "../etc", text: "x", mode: "send" }),
      })
    ).status,
    400,
  );
  const stream = await fetch(`${base}/threads/stream?id=${THREAD}&after=3`, {
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
    await fetch(`${base}/inbox`, { headers: owner }).then((r) => r.json()),
    { entries: [] },
  );
  assert.deepEqual(
    (
      await fetch(`${base}/flows`, { headers: owner }).then((r) => r.json())
    ).flows.map((/** @type {{ id: string }} */ f) => f.id),
    ["single", "plan-implement-review"],
  );
  assert.deepEqual(
    await fetch(`${base}/notifications`, { headers: owner }).then((r) =>
      r.json(),
    ),
    { notifications: [], unread: 0 },
  );
  const seen = await fetch(`${base}/notifications/seen`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ upTo: 5 }),
  });
  assert.deepEqual(await seen.json(), { unread: 0 });
  assert.equal(
    (await fetch(`${base}/notifications`, { headers: agent })).status,
    403,
  );
  const key = await fetch(`${base}/push/key`, { headers: owner }).then((r) =>
    r.json(),
  );
  assert.equal(Buffer.from(key.publicKey, "base64url").length, 65);
  assert.equal(key.subscriptions, 0);
  const insecure = await fetch(`${base}/push/subscriptions`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({
      endpoint: "http://push.example.net/x",
      keys: { p256dh: "a", auth: "b" },
    }),
  });
  assert.equal(insecure.status, 400);
  assert.equal(
    (await fetch(`${base}/push/key`, { headers: agent })).status,
    403,
  );

  // Closing (other than by PR) revokes the thread's credential.
  const closed = await fetch(`${base}/threads/close`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ id: THREAD, mode: "merge" }),
  });
  assert.equal(closed.status, 200);
  const after = await fetch(`${base}/requests/detail?id=${REQUEST}`, {
    headers: agent,
  });
  assert.ok([401, 403].includes(after.status));
});
