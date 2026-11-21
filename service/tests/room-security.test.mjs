import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApplication } from "../index.mjs";

const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

async function setupOwner(baseRoot) {
  const csrfRes = await fetch(`${baseRoot}/api/v1/auth/csrf`);
  const { token: csrfToken } = await csrfRes.json();
  let cookieHeader = csrfRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const setupRes = await fetch(`${baseRoot}/api/v1/auth/setup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader,
      "x-csrf-token": csrfToken,
      origin: baseRoot,
    },
    body: JSON.stringify({
      username: "owner",
      password: "clave-propietario-segura-999",
    }),
  });
  assert.equal(setupRes.status, 200);
  const setupCookies = setupRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]);
  const jar = new Map();
  for (const item of [...cookieHeader.split("; "), ...setupCookies]) {
    if (!item) continue;
    const i = item.indexOf("=");
    if (i > 0) jar.set(item.slice(0, i), item.slice(i + 1));
  }
  cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const csrfRes2 = await fetch(`${baseRoot}/api/v1/auth/csrf`, {
    headers: { cookie: cookieHeader },
  });
  const { token: csrf2 } = await csrfRes2.json();
  return {
    "content-type": "application/json",
    cookie: cookieHeader,
    "x-csrf-token": csrf2,
    origin: baseRoot,
  };
}

test("B/E: auth:true impone sbcap_ en fetch directo, rechaza headers falsificados, bloquea gasto y persiste tras reinicio", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-sec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const vaultRoot = path.join(dir, "vault");
  const dataDir = path.join(dir, "service-data");
  await mkdir(path.join(vaultRoot, "00-Inbox"), { recursive: true });
  await writeFile(
    path.join(vaultRoot, "Home.md"),
    "# Inicio\nTexto original.\n",
  );

  const launcherCalls = [];
  const fakeLauncher = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : null;
    launcherCalls.push({ url: req.url, method: req.method, body });
    res.writeHead(req.url === "/sesiones" ? 202 : 200, {
      "content-type": "application/json",
    });
    if (req.url === "/events") return res.end("");
    if (req.url?.startsWith("/herramientas/catalogo")) {
      return res.end(
        JSON.stringify({
          profile: {
            id: "coordinacion",
            allowedMcps: ["secondbrain", "git_workspace"],
            allowedOperations: [
              "vault.read",
              "vault.search",
              "team.coordinate",
              "user.ask",
            ],
            allowedEffectCategories: ["external_message"],
          },
        }),
      );
    }
    return res.end(JSON.stringify({ id: body?.id || randomUUID(), ok: true }));
  });
  fakeLauncher.listen(0, "127.0.0.1");
  await once(fakeLauncher, "listening");
  t.after(() => {
    fakeLauncher.closeAllConnections();
    fakeLauncher.close();
  });

  const launcherUrl = `http://127.0.0.1:${fakeLauncher.address().port}`;
  let app = await createApplication({
    vaultRoot,
    dataDirectory: dataDir,
    auth: true,
    agentes: {
      brainToken: "room-wide-secret",
      agentToken: "supervisor-secret",
    },
    lanzador: { url: launcherUrl, token: "ctrl-token" },
    operatorToolPolicy: {
      allowedOperations: [
        "vault.read",
        "vault.search",
        "file.read",
        "team.coordinate",
      ],
      allowedMcps: ["secondbrain"],
    },
  });
  t.after(() => app?.close?.());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  let baseRoot = `http://127.0.0.1:${app.server.address().port}`;
  let baseApi = `${baseRoot}/api/v1`;
  let ownerHdrs = await setupOwner(baseRoot);

  // Spending policy: DeepSeek without operator grant rejected 403 even if billingAuthorized:true is spoofed
  const dsDenied = await fetch(`${baseApi}/threads`, {
    method: "POST",
    headers: ownerHdrs,
    body: JSON.stringify({
      prompt: "gastar",
      kind: "scratch",
      agent: { engine: "deepseek" },
    }),
  });
  assert.equal(dsDenied.status, 403);

  // Mint investigacion token for direct fetch boundary testing
  const resCapInv = await fetch(`${baseApi}/agents/capabilities/token`, {
    method: "POST",
    headers: ownerHdrs,
    body: JSON.stringify({
      sessionId: "11111111-1111-4111-8111-111111111111",
      memberId: "lira-1",
      actor: "lira",
      profileId: "investigacion",
    }),
  });
  assert.equal(resCapInv.status, 201);
  const { token: invToken } = await resCapInv.json();

  // Read routes allowed
  assert.equal(
    (
      await fetch(`${baseApi}/agents/self-capability`, {
        headers: { authorization: `Bearer ${invToken}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${baseApi}/vault/note?path=Home.md`, {
        headers: { authorization: `Bearer ${invToken}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${baseApi}/vault/files`, {
        headers: { authorization: `Bearer ${invToken}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${baseApi}/finance/overview`, {
        headers: { authorization: `Bearer ${invToken}` },
      })
    ).status,
    200,
  );

  // Write / delegate / spoofed header / unknown route attacks ALL fail 403
  const spoofHeaders = {
    authorization: `Bearer ${invToken}`,
    "content-type": "application/json",
    "x-sb-tool-profile": "ejecucion",
    "x-sb-agente": "ambar",
    "x-sb-sesion": "22222222-2222-4222-8222-222222222222",
  };
  for (const [route, payload] of [
    ["POST /vault/note", { path: "Home.md", content: "# Hacks" }],
    [
      "POST /finance/ops",
      { kind: "charge", card: "Nu", amount: 100, description: "x", ref: "r" },
    ],
    [
      "POST /files",
      { area: "notas", name: "x.txt", encoding: "utf8", content: "QQ" },
    ],
    [
      "POST /effects/prepare",
      {
        category: "external_message",
        action: "send_email",
        recipient: "a@example.com",
        content: "hola",
      },
    ],
  ]) {
    const [, urlPath] = route.split(" ");
    const r = await fetch(`${baseApi}${urlPath}`, {
      method: "POST",
      headers: spoofHeaders,
      body: JSON.stringify(payload),
    });
    assert.equal(r.status, 403, `Expected 403 on spoofed ${route}`);
  }

  // Without spoofed x-sb-tool-profile, investigacion STILL fails 403 on write/ops/files/effects/delegate/unknown
  const cleanAgentHdrs = {
    authorization: `Bearer ${invToken}`,
    "content-type": "application/json",
    "x-sb-agente": "lira",
    "x-sb-sesion": "11111111-1111-4111-8111-111111111111",
  };
  for (const [method, urlPath, body] of [
    ["POST", "/vault/note", { path: "Home.md", content: "# Hacks" }],
    [
      "POST",
      "/finance/ops",
      { kind: "charge", card: "Nu", amount: 100, description: "x", ref: "r" },
    ],
    [
      "POST",
      "/files",
      { area: "notas", name: "x.txt", encoding: "utf8", content: "QQ" },
    ],
    [
      "POST",
      "/effects/prepare",
      {
        category: "external_message",
        action: "send_email",
        recipient: "a@example.com",
        content: "hola",
      },
    ],
    ["GET", "/vault/tasks", null],
  ]) {
    const r = await fetch(`${baseApi}${urlPath}`, {
      method,
      headers: cleanAgentHdrs,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, 403, `Expected 403 on ${method} ${urlPath}`);
  }

  // Verify Home.md was untouched
  assert.match(
    await readFile(path.join(vaultRoot, "Home.md"), "utf8"),
    /Texto original/,
  );

  // Restart service -> capability persistence and revocation survive restart
  await app.close();
  app = await createApplication({
    vaultRoot,
    dataDirectory: dataDir,
    auth: true,
    agentes: {
      brainToken: "room-wide-secret",
      agentToken: "supervisor-secret",
    },
    lanzador: { url: launcherUrl, token: "ctrl-token" },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  baseRoot = `http://127.0.0.1:${app.server.address().port}`;
  baseApi = `${baseRoot}/api/v1`;

  assert.equal(
    (
      await fetch(`${baseApi}/agents/self-capability`, {
        headers: { authorization: `Bearer ${invToken}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${baseApi}/vault/note`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${invToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: "Home.md", content: "# After restart" }),
      })
    ).status,
    403,
  );
});

test("F: efectos rechazan (i) hash discordante 400, (ii) 17000 chars sin truncar y verificación de bytes, (iii) id colisionado 409, e inspeccionabilidad por miembro", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-fixes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const vaultRoot = path.join(dir, "vault");
  const dataDir = path.join(dir, "service-data");
  await mkdir(path.join(vaultRoot, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vaultRoot, "Home.md"), "# Fixes\n");

  const executedPayloads = [];
  const app = await createApplication({
    vaultRoot,
    dataDirectory: dataDir,
    auth: true,
    agentes: { brainToken: "room-token", agentToken: "sup-token" },
    effects: {
      async externalRunner(payload) {
        executedPayloads.push(payload);
        return { receiptId: `ext-${payload.id}`, status: "sent" };
      },
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());

  const baseRoot = `http://127.0.0.1:${app.server.address().port}`;
  const baseApi = `${baseRoot}/api/v1`;
  const ownerHdrs = await setupOwner(baseRoot);

  // Mint coordinacion tokens (allowed effect.prepare/external_message) and verify ejecucion cannot prepare external_message
  const mintMember = async (
    memberId,
    actor,
    sessionId,
    profileId = "coordinacion",
  ) => {
    const r = await fetch(`${baseApi}/agents/capabilities/token`, {
      method: "POST",
      headers: ownerHdrs,
      body: JSON.stringify({ memberId, actor, sessionId, profileId }),
    });
    assert.equal(r.status, 201);
    return (await r.json()).token;
  };
  const execOnlyToken = await mintMember(
    "exec-only",
    "codex",
    "66666666-6666-4666-8666-666666666666",
    "ejecucion",
  );
  const blockedExec = await fetch(`${baseApi}/effects/prepare`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${execOnlyToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      category: "external_message",
      action: "send_email",
      recipient: "owner@example.com",
      content: "sin permiso de efecto externo",
    }),
  });
  assert.equal(blockedExec.status, 403);

  const mentaToken = await mintMember(
    "exec-menta",
    "menta",
    "44444444-4444-4444-8444-444444444444",
    "coordinacion",
  );
  const liraToken = await mintMember(
    "exec-lira",
    "lira",
    "55555555-5555-4555-8555-555555555555",
    "coordinacion",
  );

  // (i) Mismatched contentHash MUST fail 400
  const mismatched = await fetch(`${baseApi}/effects/prepare`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mentaToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      category: "external_message",
      action: "send_email",
      recipient: "owner@example.com",
      content: "Contenido B",
      contentHash: sha256("Contenido A"),
      scope: "once",
    }),
  });
  assert.equal(mismatched.status, 400);

  // (ii) 17000 chars MUST fail 400 without silently truncating
  const oversized = await fetch(`${baseApi}/effects/prepare`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mentaToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      category: "external_message",
      action: "send_email",
      recipient: "owner@example.com",
      content: "X".repeat(17000),
    }),
  });
  assert.equal(oversized.status, 400);

  // (iii) Explicit input.id collision with distinct requestId MUST fail 409 without overwriting original
  const fixedId = randomUUID();
  const firstPrep = await fetch(`${baseApi}/effects/prepare`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mentaToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: fixedId,
      requestId: randomUUID(),
      category: "external_message",
      action: "send_email",
      recipient: "dest1@example.com",
      content: "Primer contenido exacto",
      changes: { file: "draft.md", lines: 3 },
      scope: "una-vez",
    }),
  });
  assert.equal(firstPrep.status, 201);
  const firstJson = await firstPrep.json();
  assert.equal(
    firstJson.operacion.contentHash,
    sha256("Primer contenido exacto"),
  );

  const collision = await fetch(`${baseApi}/effects/prepare`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mentaToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: fixedId,
      requestId: randomUUID(),
      category: "external_message",
      action: "send_email",
      recipient: "evil@example.com",
      content: "Contenido sobreescrito",
    }),
  });
  assert.equal(collision.status, 409);

  // Owner inspects exact content/changes/contentHash/recipient/scope/expiresAt via /effects and /requests
  const ownerList = await (
    await fetch(`${baseApi}/effects`, { headers: ownerHdrs })
  ).json();
  const ownerOp = ownerList.operaciones.find((o) => o.id === fixedId);
  assert.equal(ownerOp.content, "Primer contenido exacto");
  assert.deepEqual(ownerOp.changes, { file: "draft.md", lines: 3 });
  assert.equal(ownerOp.contentHash, sha256("Primer contenido exacto"));
  assert.equal(ownerOp.recipient, "dest1@example.com");
  assert.equal(ownerOp.scope, "una-vez");
  assert.ok(ownerOp.expiresAt);

  const reqsJson = await (
    await fetch(`${baseApi}/requests`, { headers: ownerHdrs })
  ).json();
  const approvalReq = reqsJson.solicitudes.find(
    (s) => s.id === firstJson.operacion.approvalId,
  );
  assert.equal(approvalReq.content, "Primer contenido exacto");

  // Sibling agent lira CANNOT read menta's pending effect, solicitud, or execute it
  const siblingDetail = await fetch(`${baseApi}/effects/detail?id=${fixedId}`, {
    headers: { authorization: `Bearer ${liraToken}` },
  });
  assert.equal(siblingDetail.status, 403);
  const siblingReqDetail = await fetch(
    `${baseApi}/requests/detail?id=${firstJson.operacion.approvalId}`,
    { headers: { authorization: `Bearer ${liraToken}` } },
  );
  assert.equal(siblingReqDetail.status, 403);
  const siblingList = await (
    await fetch(`${baseApi}/effects`, {
      headers: { authorization: `Bearer ${liraToken}` },
    })
  ).json();
  assert.equal(
    siblingList.operaciones.some((o) => o.id === fixedId),
    false,
  );

  // Owner approves, menta executes, runner verifies un-truncated exact bytes + matching hash
  const exact16000 = "A".repeat(15997) + "FIN";
  const maxPrep = await (
    await fetch(`${baseApi}/effects/prepare`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mentaToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: randomUUID(),
        category: "external_message",
        action: "send_email",
        recipient: "owner@example.com",
        content: exact16000,
        contentHash: sha256(exact16000),
      }),
    })
  ).json();
  const decideRes = await fetch(`${baseApi}/requests/answer`, {
    method: "POST",
    headers: ownerHdrs,
    body: JSON.stringify({
      id: maxPrep.operacion.approvalId,
      approve: true,
      contentHash: sha256(exact16000),
      requestId: randomUUID(),
    }),
  });
  assert.equal(decideRes.status, 200);

  const execRes = await fetch(`${baseApi}/effects/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mentaToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: maxPrep.operacion.id, requestId: randomUUID() }),
  });
  assert.equal(execRes.status, 200);
  assert.equal(executedPayloads.length, 1);
  assert.equal(executedPayloads[0].content.length, 16000);
  assert.ok(executedPayloads[0].content.endsWith("FIN"));
  assert.equal(executedPayloads[0].contentHash, sha256(exact16000));
});
