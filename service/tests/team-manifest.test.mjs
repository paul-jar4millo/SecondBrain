import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApplication } from "../index.mjs";
import { getCsrfHeaders as csrfHeaders } from "./helpers/csrf.mjs";

const SESSION = "a1111111-1111-4111-8111-111111111111";

const team = () => [
  {
    id: "coord-ambar",
    characterId: "ambar",
    engine: "claude",
    model: "modelo-coord",
    effort: "high",
    role: "Coordinadora",
    responsibility: "Integrar entregables.",
    coordinator: true,
    toolProfileId: "coordinacion",
  },
  {
    id: "exec-menta",
    characterId: "menta",
    engine: "codex",
    model: "modelo-menta",
    effort: "medium",
    role: "Implementadora",
    responsibility: "Escribir código.",
    coordinator: false,
    toolProfileId: "ejecucion",
  },
];

test("equipo_encargar recibe el manifiesto congelado del encargo y registra la integrante", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-equipo-mf-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = path.join(dir, "vault");
  await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
  await writeFile(path.join(vault, "Home.md"), "# Sintético\n");

  let workOrderId = null;
  const recibidos = [];
  const launcher = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const text = Buffer.concat(parts).toString("utf8");
    res.setHeader("content-type", "application/json");
    if (req.url === "/estado")
      return res.end(
        JSON.stringify([{ id: SESSION, motor: "claude", workOrderId }]),
      );
    if (req.url === "/equipo/encargar") {
      const data = JSON.parse(text);
      recibidos.push(data);
      return res.end(
        JSON.stringify({
          id: "b2222222-2222-4222-8222-222222222222",
          motor: data.motor,
          memberId: data.memberId,
          modelo: "modelo-menta",
          estado: "pendiente",
          enColaRecursos: true,
          workspacePath: "C:/privado/member-workspaces/x",
          workspaceKind: "directory",
        }),
      );
    }
    if (req.url === "/equipo/integrar")
      return res.end(
        JSON.stringify({
          ok: true,
          estado: "integrado",
          integracion: { id: "c3333333-3333-4333-8333-333333333333" },
          integrados: [
            {
              ruta: "a.md",
              sha256: "f".repeat(64),
              destino: "C:/privado/a.md",
            },
          ],
          conflictos: [],
        }),
      );
    res.end("[]");
  });
  launcher.listen(0, "127.0.0.1");
  await once(launcher, "listening");
  t.after(() => new Promise((r) => launcher.close(r)));

  const app = await createApplication({
    vaultRoot: vault,
    dataDirectory: path.join(dir, "data"),
    auth: false,
    agentes: { brainToken: "room-secret" },
    lanzador: {
      url: `http://127.0.0.1:${launcher.address().port}`,
      token: "ctrl",
    },
  });
  t.after(() => app.close());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const headers = await csrfHeaders(base);
  const agente = {
    authorization: "Bearer room-secret",
    "content-type": "application/json",
    "x-sb-agente": "ambar",
    "x-sb-sesion": SESSION,
  };

  const created = await fetch(`${base}/encargos`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "Equipo sintético",
      objective: "Delegar con manifiesto",
      acceptanceCriteria: [{ id: "c1", text: "Respeta modelos" }],
      team: team(),
    }),
  });
  assert.equal(created.status, 201);
  const { encargo: task } = await created.json();
  workOrderId = task.id;

  const encargar = (extra = {}) =>
    fetch(`${base}/equipo/encargar`, {
      method: "POST",
      headers: agente,
      body: JSON.stringify({
        motor: "codex",
        brief: "implementa",
        memberId: "exec-menta",
        ...extra,
      }),
    });

  // A draft without frozen manifest cannot delegate.
  assert.equal((await encargar()).status, 409);
  assert.equal(recibidos.length, 0);

  const iniciado = await fetch(`${base}/encargos/iniciar`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workOrderId }),
  });
  assert.equal(iniciado.status, 200);
  const { encargo: inProgress } = await iniciado.json();
  const sha256 = inProgress.manifest.sha256;

  // An agent cannot grant itself billing or address another work order.
  assert.equal((await encargar({ billingAuthorized: true })).status, 400);
  assert.equal(
    (await encargar({ workOrderId: "d4444444-4444-4444-8444-444444444444" }))
      .status,
    403,
  );
  assert.equal(
    (await encargar({ manifestSha256: "0".repeat(64) })).status,
    409,
  );

  const response = await encargar({ requestId: "pedido-1" });
  assert.equal(response.status, 200);
  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].workOrderId, workOrderId);
  assert.equal(recibidos[0].manifestSha256, sha256);
  assert.deepEqual(
    recibidos[0].manifest.team.map((m) => [m.id, m.model, m.effort]),
    [
      ["coord-ambar", "modelo-coord", "high"],
      ["exec-menta", "modelo-menta", "medium"],
    ],
  );

  const integrated = await fetch(`${base}/equipo/integrar`, {
    method: "POST",
    headers: agente,
    body: JSON.stringify({}),
  });
  assert.equal(integrated.status, 200);

  const detail = await fetch(
    `${base}/encargos/detalle?id=${workOrderId}&cursor=0`,
    { headers },
  );
  const cuerpo = await detail.json();
  const eventos = JSON.stringify(cuerpo);
  assert.match(eventos, /exec-menta/);
  assert.match(eventos, /integration_completed/);
  assert.match(eventos, /"enColaRecursos":true/);
  // Local paths of workspaces and integration targets stay out of events.
  assert.doesNotMatch(eventos, /privado/);
});
