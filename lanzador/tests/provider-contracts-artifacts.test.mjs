import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { test } from "node:test";
import { createApplication } from "../../service/index.mjs";
import { createToolCatalogStore } from "../tool-catalog.mjs";
import { crearEjecutor } from "../executor.mjs";
import { crearServidor } from "../index.mjs";
import { createCodexController } from "../provider-controllers.mjs";
import { createProviderConversations } from "../provider-conversations.mjs";
import { abrirRegistro } from "../sessions.mjs";

import {
  E2E_TIMEOUT_MS,
  waitFor,
  createStreamFakeProcess,
} from "./helpers/provider-fakes.mjs";

test("regresión: publicación productiva ctx.artifact (2 versiones inmutables en misma ruta), bloqueo traversal/symlink/.env y descarga vía API service tras recarga", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sb-art-e2e-"));
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );

  const vaultRoot = path.join(root, "vault");
  const serviceData = path.join(root, "service-data");
  const lanzadorData = path.join(root, "lanzador-data");
  const projDir = path.join(root, "proyecto");
  const outsideFile = path.join(root, "fuera.txt");
  await mkdir(path.join(vaultRoot, "00-Inbox"), { recursive: true });
  await mkdir(path.join(projDir, "informe"), { recursive: true });
  await writeFile(vaultRoot + "/Home.md", "# Vault sintético\n");
  await writeFile(outsideFile, "secreto fuera");
  await writeFile(path.join(projDir, ".env"), "SECRET=123\n");
  try {
    await symlink(outsideFile, path.join(projDir, "enlace-fuera.txt"));
  } catch {
    /* Windows without Developer Mode may disallow file symlinks; traversal + .env still verified */
  }

  let turnIdx = 0;
  // Turn 1 stays open until the next message is sent, so that message is
  // queued and runs as a follow-up turn: the race a fast agent creates.
  let releaseTurn1;
  const turn1Held = new Promise((r) => (releaseTurn1 = r));
  const registro = await abrirRegistro(
    path.join(lanzadorData, "sesiones.json"),
  );
  const toolCatalog = await createToolCatalogStore({ dataDir: lanzadorData });
  await toolCatalog.updateProfile("ejecucion", { allowedMcps: [] });

  const conversations = createProviderConversations({
    directory: path.join(lanzadorData, "conversations"),
    registro,
    adapters: {
      codex: {
        createController: () => {
          const inner = createCodexController();
          return {
            ...inner,
            runTurn: (ctx) =>
              inner.runTurn({
                ...ctx,
                spawn() {
                  return createStreamFakeProcess((msg, send) => {
                    if (msg.method === "initialize") {
                      send({ id: msg.id, result: {} });
                    } else if (msg.method === "thread/start") {
                      send({
                        id: msg.id,
                        result: { thread: { id: "th-art" } },
                      });
                    } else if (msg.method === "turn/start") {
                      turnIdx += 1;
                      const tid = `turn-art-${turnIdx}`;
                      send({ id: msg.id, result: { turn: { id: tid } } });
                      const targetFile = path.join(
                        projDir,
                        "informe",
                        "entrega.md",
                      );
                      const textContent =
                        turnIdx === 1
                          ? "Contenido version 1"
                          : "Contenido version 2 actualizado";
                      void writeFile(targetFile, textContent, "utf8").then(
                        () => {
                          send({
                            method: "item/completed",
                            params: {
                              threadId: "th-art",
                              turnId: tid,
                              item: {
                                type: "fileChange",
                                id: `fc-${turnIdx}`,
                                status: "completed",
                                changes: [
                                  { path: "../fuera.txt", kind: "update" },
                                  { path: ".env", kind: "update" },
                                  { path: "enlace-fuera.txt", kind: "update" },
                                  {
                                    path: "informe/entrega.md",
                                    kind: turnIdx === 1 ? "add" : "update",
                                  },
                                ],
                              },
                            },
                          });
                          send({
                            method: "item/completed",
                            params: {
                              threadId: "th-art",
                              turnId: tid,
                              item: {
                                type: "agentMessage",
                                id: `msg-${turnIdx}`,
                                text: `Publicado v${turnIdx}`,
                              },
                            },
                          });
                          const complete = () =>
                            send({
                              method: "turn/completed",
                              params: {
                                threadId: "th-art",
                                turn: { id: tid, status: "completed" },
                              },
                            });
                          if (tid === "turn-art-1")
                            void turn1Held.then(complete);
                          else complete();
                        },
                      );
                    }
                  });
                },
              }),
          };
        },
      },
    },
  });

  const ejecutor = crearEjecutor({
    registro,
    proyectos: { demo: projDir },
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, ".cx"),
      SB_CODEX_BIN: process.execPath,
      SB_LANZADOR_DATA_DIR: lanzadorData,
    },
    conversations,
    toolCatalog,
    registrar: () => {},
  });

  const controlToken = "ctrl-token-art";
  const launcher = crearServidor({
    registro,
    ejecutor,
    conversations,
    toolCatalog,
    catalogo: { modelos: async () => ({}), validar: async () => true },
    uso: async () => ({}),
    items: () => [],
    acciones: null,
    equipos: null,
    proyectos: { demo: projDir },
    espacios: null,
    controlHash: createHash("sha256").update(controlToken).digest("hex"),
    hookHash: createHash("sha256").update("hook-token-art").digest("hex"),
  });
  launcher.listen(0, "127.0.0.1");
  await once(launcher, "listening");
  t.after(async () => {
    await ejecutor.cerrarTodo("fin");
    launcher.closeAllConnections?.();
    await new Promise((r) => launcher.close(r));
  });

  const launcherUrl = `http://127.0.0.1:${launcher.address().port}`;
  let app = await createApplication({
    vaultRoot,
    dataDirectory: serviceData,
    auth: false,
    lanzador: { url: launcherUrl, token: controlToken },
  });
  t.after(() => app?.close?.());
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  let baseApi = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const getHeaders = async () => {
    const r = await fetch(`${baseApi}/auth/csrf`);
    const { token } = await r.json();
    return {
      "content-type": "application/json",
      "x-csrf-token": token,
      origin: baseApi.replace("/api/v1", ""),
      cookie: r.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    };
  };

  let hdrs = await getHeaders();
  const woCreate = await fetch(`${baseApi}/encargos`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      title: "Prueba artefactos inmutables",
      objective: "Publicar dos versiones",
      acceptanceCriteria: [{ text: "Dos versiones" }],
      team: [
        {
          id: "coord-ambar",
          characterId: "ambar",
          engine: "claude",
          model: "claude-opus-4-7",
          effort: "high",
          role: "Coordinadora",
          responsibility: "Coordinar entrega",
          coordinator: true,
          toolProfileId: "coordinacion",
        },
        {
          id: "exec-menta",
          characterId: "menta",
          engine: "codex",
          model: "gpt-5.4",
          effort: "high",
          role: "Implementadora",
          responsibility: "Escribir entrega.md",
          coordinator: false,
          toolProfileId: "ejecucion",
        },
      ],
    }),
  });
  const woRes = await woCreate.json();
  assert.equal(woCreate.status, 201, JSON.stringify(woRes));
  const workOrderId = woRes.encargo.id;
  await fetch(`${baseApi}/encargos/iniciar`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ workOrderId }),
  });

  // Turn 1 publishes v1
  const sRes = await fetch(`${baseApi}/agentes/sesiones`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      motor: "codex",
      origen: "encargo",
      proyecto: "demo",
      brief: "Publicar v1",
      structured: true,
      workOrderId,
      memberId: "exec-menta",
      toolProfileId: "ejecucion",
    }),
  });
  assert.equal(sRes.status, 202);
  const sess = await sRes.json();

  await waitFor(async () => {
    const det = await fetch(
      `${baseApi}/encargos/detalle?id=${workOrderId}&cursor=0`,
    ).then((r) => r.json());
    return det.snapshot.artifacts.length === 1;
  }, E2E_TIMEOUT_MS);

  // Turn 2 overwrites SAME path informe/entrega.md -> publishes v2
  const mRes = await fetch(`${baseApi}/agentes/conversacion/mensajes`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({
      id: sess.id,
      clientMessageId: randomUUID(),
      mode: "send",
      text: "Publicar v2 en misma ruta",
    }),
  });
  assert.equal(mRes.status, 200);
  assert.equal((await mRes.json()).queued, true);
  releaseTurn1();

  const detBeforeReload = await waitFor(async () => {
    const det = await fetch(
      `${baseApi}/encargos/detalle?id=${workOrderId}&cursor=0`,
    ).then((r) => r.json());
    return det.snapshot.artifacts.length === 2 ? det : null;
  }, E2E_TIMEOUT_MS);
  assert.equal(
    detBeforeReload.events.filter((e) => e.type === "artifact.published")
      .length,
    2,
  );

  // Reload service cleanly -> artifacts & immutable v1/v2 API downloads MUST still return exact bytes!
  await app.close();
  app = await createApplication({
    vaultRoot,
    dataDirectory: serviceData,
    auth: false,
    lanzador: { url: launcherUrl, token: controlToken },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  baseApi = `http://127.0.0.1:${app.server.address().port}/api/v1`;

  const detReload = await fetch(
    `${baseApi}/encargos/detalle?id=${workOrderId}&cursor=0`,
  ).then((r) => r.json());
  const [v1, v2] = detReload.snapshot.artifacts;
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(v1.fileRef, "informe/entrega.md");
  assert.equal(v2.fileRef, "informe/entrega.md");
  assert.ok(v1.evidenceRefs.includes("fc-1"));
  assert.ok(v2.evidenceRefs.includes("fc-2"));
  assert.equal(
    v1.hash,
    createHash("sha256").update("Contenido version 1").digest("hex"),
  );
  assert.equal(
    v2.hash,
    createHash("sha256")
      .update("Contenido version 2 actualizado")
      .digest("hex"),
  );

  const dl1 = await fetch(
    `${baseApi}/encargos/artefactos/descargar?workOrderId=${workOrderId}&artifactId=${v1.id}`,
  );
  assert.equal(dl1.status, 200);
  assert.equal(dl1.headers.get("x-artifact-version"), "1");
  assert.equal(dl1.headers.get("x-artifact-sha256"), v1.hash);
  assert.equal(await dl1.text(), "Contenido version 1");

  const dl2 = await fetch(
    `${baseApi}/agentes/conversacion/artefactos/descargar?id=${sess.id}&artifactId=${v2.id}`,
  );
  assert.equal(dl2.status, 200);
  assert.equal(dl2.headers.get("x-artifact-version"), "2");
  assert.equal(dl2.headers.get("x-artifact-sha256"), v2.hash);
  assert.equal(await dl2.text(), "Contenido version 2 actualizado");
});
