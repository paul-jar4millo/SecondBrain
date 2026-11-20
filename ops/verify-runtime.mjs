/**
 * Opt-in vertical slice verifier for the production runtime (`agy` ACP + `lanzador` + `service` + synthetic MCP).
 * Requires `--live` or `SB_RUN_RUNTIME_LIVE=1`. Uses isolated temp vault/project dirs only (zero personal data or LXC access).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { arrancar } from "../lanzador/index.mjs";
import { createApplication } from "../service/index.mjs";
/** @import { Server } from "node:http" */
/** @import { ConversationReceipt } from "../lanzador/provider-conversation-types.mjs" */
/** @import { LauncherSession } from "../lanzador/session-types.d.ts" */
/** @import { ProductQuestionAnswer, RuntimeCatalog, RuntimeConversationSnapshot, RuntimeProductQuestion, RuntimeTurn, RuntimeVerificationReport, RuntimeWorkOrderDetail } from "./runtime-verification-types.d.ts" */

const execFileAsync = promisify(execFile);
/** Port of a server listening on TCP. */
const portOf = (/** @type {import("node:net").Server} */ server) =>
  /** @type {import("node:net").AddressInfo} */ (server.address()).port;

/** @param {string} value */
function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** @template T @param {() => T | null | undefined | Promise<T | null | undefined>} predicate */
async function waitFor(predicate, timeoutMs = 120_000, stepMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await predicate();
    if (res) return res;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timeout tras ${timeoutMs}ms`);
}

export async function runLiveVerification({
  timeoutMs = 240_000,
  withSkills = false,
  skillsOnly = false,
} = {}) {
  const watchdog = setTimeout(() => {
    console.error("TIMEOUT_GLOBAL_RUNTIME");
    process.exit(124);
  }, timeoutMs);
  watchdog.unref();

  const root = await mkdtemp(path.join(os.tmpdir(), "sb-runtime-live-"));
  const vaultRoot = path.join(root, "vault");
  const serviceData = path.join(root, "service-data");
  const lanzadorData = path.join(root, "lanzador-data");
  const projectDir = path.join(root, "proyecto-demo");
  const controlToken = randomBytes(24).toString("hex");
  const hookToken = randomBytes(24).toString("hex");
  const brainToken = randomBytes(24).toString("hex");

  const controlHashFile = path.join(root, "control.hash");
  const hookHashFile = path.join(root, "hook.hash");
  const brainTokenFile = path.join(root, "brain.token");
  const proyectosFile = path.join(root, "proyectos.json");

  /** @type {Awaited<ReturnType<typeof createApplication>> | null} */
  let app = null;
  /** @type {Server | null} */
  let launcher = null;
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const headCommit = await execFileAsync(
    "git",
    ["rev-parse", "--short", "HEAD"],
    {
      cwd: repoRoot,
    },
  )
    .then((r) => r.stdout.trim())
    .catch(() => "desconocido");

  try {
    await mkdir(path.join(vaultRoot, "00-Inbox"), { recursive: true });
    await mkdir(path.join(vaultRoot, "01-Proyectos"), { recursive: true });
    await mkdir(path.join(vaultRoot, "02-Areas", "Agentes"), {
      recursive: true,
    });
    await mkdir(path.join(vaultRoot, "99-Meta"), { recursive: true });
    await mkdir(serviceData, { recursive: true });
    await mkdir(lanzadorData, { recursive: true });
    await mkdir(path.join(projectDir, "informe"), { recursive: true });

    await writeFile(
      path.join(vaultRoot, "AGENTS.md"),
      "# Vault sintético\n",
      "utf8",
    );
    await writeFile(
      path.join(vaultRoot, "Home.md"),
      "# Inicio sintético\n",
      "utf8",
    );
    await writeFile(
      path.join(vaultRoot, "99-Meta", "Convenciones.md"),
      "# Convenciones\n",
      "utf8",
    );
    await writeFile(
      path.join(vaultRoot, "02-Areas", "Agentes", "_Agentes.md"),
      "# Agentes\n",
      "utf8",
    );
    await writeFile(
      path.join(vaultRoot, "01-Proyectos", "Proyecto-Demo.md"),
      "---\ntags: [proyecto]\n---\n\n# Proyecto Demo Sintético\n\nCanario runtime: `CANARIO-VERDE-2048`\n",
      "utf8",
    );
    await writeFile(
      path.join(projectDir, "README.md"),
      "# Proyecto Demo\n",
      "utf8",
    );
    await execFileAsync("git", ["init"], { cwd: projectDir });
    await execFileAsync("git", ["config", "user.name", "Test User"], {
      cwd: projectDir,
    });
    await execFileAsync(
      "git",
      ["config", "user.email", "test@example.invalid"],
      {
        cwd: projectDir,
      },
    );
    await execFileAsync("git", ["add", "."], { cwd: projectDir });
    await execFileAsync("git", ["commit", "-m", "chore: initial"], {
      cwd: projectDir,
    });

    await writeFile(controlHashFile, sha256Hex(controlToken), { mode: 0o600 });
    await writeFile(hookHashFile, sha256Hex(hookToken), { mode: 0o600 });
    await writeFile(brainTokenFile, brainToken, { mode: 0o600 });
    await writeFile(
      proyectosFile,
      JSON.stringify({ demo: projectDir }, null, 2),
      { mode: 0o600 },
    );

    /** @type {Record<string, string>} */
    const lanzadorEnv = {
      ...process.env,
      SB_LANZADOR_PORT: "0",
      SB_LANZADOR_DATA_DIR: lanzadorData,
      SB_CONTROL_HASH_FILE: controlHashFile,
      SB_HOOK_HASH_FILE: hookHashFile,
      SB_PROYECTOS_FILE: proyectosFile,
      SB_BRAIN_TOKEN_FILE: brainTokenFile,
      SB_BRAIN_URL: "http://127.0.0.1:1/api/v1",
      SB_MAX_ACTIVOS: "2",
    };

    launcher = await arrancar(lanzadorEnv);
    const launcherUrl = `http://127.0.0.1:${portOf(launcher)}`;

    app = await createApplication({
      vaultRoot,
      dataDirectory: serviceData,
      auth: false,
      agentes: { brainTokenFile },
      lanzador: { url: launcherUrl, token: controlToken },
    });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    let servicePort = portOf(app.server);
    let baseApi = `http://127.0.0.1:${servicePort}/api/v1`;
    lanzadorEnv.SB_BRAIN_URL = baseApi;
    lanzadorEnv.AGENTES_BRAIN_URL = baseApi;

    const getApiHeaders = async () => {
      const csrfRes = await fetch(`${baseApi}/auth/csrf`);
      /** @type {{ token: string }} */
      const { token } = await csrfRes.json();
      return {
        "content-type": "application/json",
        "x-csrf-token": token,
        origin: `http://127.0.0.1:${servicePort}`,
        cookie: csrfRes.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; "),
      };
    };

    let apiHeaders = await getApiHeaders();

    /** @type {RuntimeVerificationReport} */
    const report = {
      executedAt: new Date().toISOString(),
      commit: headCommit,
      models: null,
      workOrderId: null,
      turn1: null,
      nativeApprovals: [],
      productQuestion: null,
      turn2SamePid: null,
      turn3Interrupt: null,
      turn4Resume: null,
      artifactsApi: null,
      reloadPersistence: null,
      coldResume: null,
      shutdown: null,
      sseUpdates: 0,
      lastSeq: null,
      errors: [],
    };

    /** @type {{ agy?: { id: string }[] }} */
    const modelsRes = await fetch(`${baseApi}/agentes/modelos-lanzador`).then(
      (r) => r.json(),
    );
    const agyList = Array.isArray(modelsRes?.agy) ? modelsRes.agy : [];
    report.models = {
      agyCount: agyList.length,
      hasGemini38FlashMedium: agyList.some(
        (m) => m.id === "gemini-3.8-flash-medium",
      ),
    };

    // Create & start WorkOrder to verify product question + bridged artifacts
    /** @type {{ encargo: { id: string } }} */
    const woRes = await fetch(`${baseApi}/encargos`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({
        title: "Verificación vertical",
        objective:
          "Leer canario, preguntar respuesta libre y publicar artefacto v1/v2",
        acceptanceCriteria: [
          { text: "Pregunta libre de producto respondida y conservada" },
          { text: "Artefacto publicado v1 y v2 descargables por API" },
        ],
        team: [
          {
            id: "coord-ambar",
            characterId: "ambar",
            engine: "claude",
            model: "claude-opus-4-7",
            effort: "high",
            role: "Coordinadora",
            responsibility: "Coordinar verificación",
            coordinator: true,
            toolProfileId: "coordinacion",
          },
          {
            id: "exec-lira",
            characterId: "lira",
            engine: "agy",
            model: "gemini-3.8-flash-medium",
            effort: "medium",
            role: "Implementadora ACP",
            responsibility: "Leer nota, preguntar y publicar entrega",
            coordinator: false,
            toolProfileId: "ejecucion",
          },
        ],
      }),
    }).then((r) => r.json());
    const workOrderId = woRes.encargo.id;
    report.workOrderId = workOrderId;
    await fetch(`${baseApi}/encargos/iniciar`, {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ workOrderId }),
    });

    const freeTextAnswer = "azul-cobalto-sintetico-901";
    /** @type {Set<string>} */
    const answeredNative = new Set();
    /** @type {ProductQuestionAnswer | null} */
    let productQuestionAnswered = null;
    const sseAbort = new AbortController();
    let lastSseSeq = 0;

    // Background watcher: handles (1) native session/request_permission and (2) separate free-text usuario_preguntar
    const monitorLoop = (async () => {
      while (!sseAbort.signal.aborted) {
        try {
          /** @type {{ solicitudes?: RuntimeProductQuestion[] }} */
          const { solicitudes = [] } = await fetch(
            `${baseApi}/solicitudes?workOrderId=${workOrderId}&kind=question&status=pendiente`,
            { signal: sseAbort.signal },
          ).then((r) => r.json());
          for (const q of solicitudes) {
            if (productQuestionAnswered) continue;
            const resp = await fetch(`${baseApi}/solicitudes/responder`, {
              method: "POST",
              headers: apiHeaders,
              body: JSON.stringify({
                id: q.id,
                requestId: randomUUID(),
                freeText: freeTextAnswer,
              }),
            });
            /** @type {{ solicitud?: RuntimeProductQuestion }} */
            const json = await resp.json().catch(() => ({}));
            if (resp.status !== 200) {
              report.errors.push(
                `responder solicitud ${resp.status}: ${JSON.stringify(json)}`,
              );
              continue;
            }
            productQuestionAnswered = {
              id: q.id,
              kind: q.kind,
              allowFreeText: q.allowFreeText,
              httpStatus: resp.status,
              statusAfterAnswer: json?.solicitud?.status || null,
            };
          }
        } catch {
          if (sseAbort.signal.aborted) break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();

    /** @param {string} sessionId */
    const watchConversationSse = (sessionId) =>
      (async () => {
        try {
          const resp = await fetch(
            `${baseApi}/agentes/conversacion/stream?id=${sessionId}`,
            { signal: sseAbort.signal },
          );
          if (!resp.ok || !resp.body) return;
          let buf = "";
          for await (const chunk of resp.body) {
            buf += new TextDecoder().decode(chunk, { stream: true });
            const blocks = buf.split("\n\n");
            buf = blocks.pop() || "";
            for (const block of blocks) {
              const dataLine = block
                .split("\n")
                .find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              /** @type {RuntimeConversationSnapshot} */
              const snap = JSON.parse(dataLine.slice(6));
              report.sseUpdates += 1;
              lastSseSeq = snap.seq ?? lastSseSeq;
              for (const req of snap.requests || []) {
                if (
                  req.kind === "approval" &&
                  req.status === "pending" &&
                  !answeredNative.has(req.id)
                ) {
                  answeredNative.add(req.id);
                  const choice =
                    (req.choices || []).find(
                      (c) => c === "allow_once" || c.includes("allow"),
                    ) ||
                    req.choices?.[0] ||
                    "accept";
                  const ansRes = await fetch(
                    `${baseApi}/agentes/conversacion/responder`,
                    {
                      method: "POST",
                      headers: apiHeaders,
                      body: JSON.stringify({
                        id: sessionId,
                        requestId: req.id,
                        responseId: randomUUID(),
                        decision: choice,
                      }),
                    },
                  );
                  /** @type {Partial<Pick<ConversationReceipt, "status" | "delivered">>} */
                  const ansJson = await ansRes.json().catch(() => ({}));
                  report.nativeApprovals.push({
                    requestId: req.id,
                    httpStatus: ansRes.status,
                    deliveryStatus: ansJson.status || null,
                    delivered: ansJson.delivered ?? null,
                  });
                }
              }
            }
          }
        } catch (err) {
          if (err?.name !== "AbortError") {
            report.errors.push(`SSE: ${err?.message || err}`);
          }
        }
      })();

    /** @param {string} id */
    const getSession = async (id) => {
      /** @type {LauncherSession[]} */
      const list = await fetch(`${baseApi}/agentes/sesiones`).then((r) =>
        r.json(),
      );
      return list.find((s) => s.id === id);
    };

    // --- TURN 1: MCP brain_read + usuario_preguntar/esperar + workspace file v1 ---
    if (skillsOnly) {
      sseAbort.abort();
      await monitorLoop.catch(() => {});
    }
    const t1Start = Date.now();
    /** @type {Pick<LauncherSession, "id"> | null} */
    const session1 = skillsOnly
      ? null
      : await fetch(`${baseApi}/agentes/sesiones`, {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify({
            motor: "agy",
            origen: "encargo",
            proyecto: "demo",
            modelo: "gemini-3.8-flash-medium",
            structured: true,
            workOrderId,
            memberId: "exec-lira",
            toolProfileId: "ejecucion",
            brief: [
              "Sigue exactamente estos pasos en orden usando las herramientas MCP de `secondbrain` y tu herramienta de escritura de archivo:",
              '1) Llama `brain_read` con `{ "path": "01-Proyectos/Proyecto-Demo.md" }` para obtener el canario.',
              `2) Llama \`usuario_preguntar\` con \`{ "titulo": "Color cabecera", "pregunta": "¿Cuál clave exacta de estilo debo incluir?", "permiteTextoLibre": true, "workOrderId": "${workOrderId}" }\`, luego llama \`usuario_esperar_respuesta\` con ese \`id\` hasta recibir el valor del usuario.`,
              "3) Escribe el archivo `informe/entrega.md` dentro del proyecto con exactamente dos líneas: `canario=<CANARIO>` y `respuesta=<VALOR_EXACTO_RECIBIDO>`.",
              "4) Responde breve indicando el canario y el valor recibido.",
            ].join("\n"),
          }),
        }).then(async (res) => {
          const json = await res.json();
          assert.equal(res.status, 202, JSON.stringify(json));
          return json;
        });
    const sseTask = session1
      ? watchConversationSse(session1.id)
      : Promise.resolve();

    /** @type {RuntimeTurn} */
    const t1Done = session1
      ? await waitFor(async () => {
          const s = await getSession(session1.id);
          return s &&
            ["terminada", "error", "cancelada", "interrumpida"].includes(
              s.estado,
            )
            ? s
            : null;
        }, 150_000)
      : { estado: "omitida_skills_only", conversacionId: null };

    report.turn1 = session1
      ? {
          sessionId: t1Done.id,
          estado: t1Done.estado,
          error: t1Done.error || null,
          conversacionId: t1Done.conversacionId || null,
          conexion: t1Done.conexion || null,
          elapsedMs: Date.now() - t1Start,
          hasCanary: Boolean(t1Done.resultado?.includes("CANARIO-VERDE-2048")),
          receivedExactFreeText: Boolean(
            t1Done.resultado?.includes(freeTextAnswer),
          ),
        }
      : { skipped: true };
    report.productQuestion = productQuestionAnswered;

    if (session1 && t1Done.estado === "terminada" && t1Done.conversacionId) {
      // Wait briefly for Turn 1 artifact.published v1 on WorkOrder
      await waitFor(async () => {
        /** @type {RuntimeWorkOrderDetail} */
        const det = await fetch(
          `${baseApi}/encargos/detalle?id=${workOrderId}&cursor=0`,
        ).then((r) => r.json());
        return det.snapshot.artifacts.length >= 1 ? det : null;
      }, 15_000);

      // --- TURN 2: Overwrite SAME path informe/entrega.md -> artifact v2 in SAME PID ---
      const t2Start = Date.now();
      const msgRes = await fetch(`${baseApi}/agentes/conversacion/mensajes`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          id: session1.id,
          clientMessageId: randomUUID(),
          mode: "send",
          text: "Actualiza el mismo archivo `informe/entrega.md` agregando al final la línea `version=V2-ACTUALIZADA` y responde brevemente recordando la respuesta libre recibida en el turno 1.",
        }),
      });
      assert.equal(msgRes.status, 200);
      const t2Done = await waitFor(async () => {
        const s = await getSession(session1.id);
        return s && s.estado !== "trabajando" && s.estado !== "pendiente"
          ? s
          : null;
      }, 120_000);

      report.turn2SamePid = {
        estado: t2Done.estado,
        pidBefore: t1Done.conexion?.pid ?? null,
        pidAfter: t2Done.conexion?.pid ?? null,
        samePid: Boolean(
          t1Done.conexion?.pid && t1Done.conexion.pid === t2Done.conexion?.pid,
        ),
        sameNativeSession: t2Done.conversacionId === t1Done.conversacionId,
        elapsedMs: Date.now() - t2Start,
        recalledFreeText: Boolean(t2Done.resultado?.includes(freeTextAnswer)),
      };

      // --- TURN 3: Live interrupt ---
      const t3Start = Date.now();
      const prevSeq = lastSseSeq;
      const contRes = await fetch(`${baseApi}/agentes/sesiones`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          motor: "agy",
          origen: "encargo",
          proyecto: "demo",
          continuar: session1.id,
          brief:
            "Escribe un ensayo numerado paso a paso del 1 al 40 sobre tolerancia a fallos en colas de eventos.",
        }),
      });
      assert.equal(contRes.status, 202);
      await waitFor(() => lastSseSeq > prevSeq, 20_000, 100);
      await new Promise((r) => setTimeout(r, 800));
      const cancelRes = await fetch(`${baseApi}/agentes/sesiones/cancelar`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ id: session1.id }),
      });
      const t3Done = await waitFor(async () => {
        const s = await getSession(session1.id);
        return s && s.estado !== "trabajando" ? s : null;
      }, 30_000);
      report.turn3Interrupt = {
        cancelStatus: cancelRes.status,
        estado: t3Done.estado,
        samePid: Boolean(
          t1Done.conexion?.pid && t1Done.conexion.pid === t3Done.conexion?.pid,
        ),
        elapsedMs: Date.now() - t3Start,
      };

      // --- TURN 4: Continuation after interrupt ---
      const t4Start = Date.now();
      const res4 = await fetch(`${baseApi}/agentes/sesiones`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          motor: "agy",
          origen: "encargo",
          proyecto: "demo",
          continuar: session1.id,
          brief: "Responde únicamente con exactamente `CONTINUACION-OK`.",
        }),
      });
      assert.equal(res4.status, 202);
      const t4Done = await waitFor(async () => {
        const s = await getSession(session1.id);
        return s && s.estado !== "trabajando" ? s : null;
      }, 60_000);
      report.turn4Resume = {
        estado: t4Done.estado,
        reusedSamePid: Boolean(
          t1Done.conexion?.pid && t1Done.conexion.pid === t4Done.conexion?.pid,
        ),
        elapsedMs: Date.now() - t4Start,
        hasMarker: Boolean(t4Done.resultado?.includes("CONTINUACION-OK")),
      };

      // Explicit shutdown
      const shutRes = await fetch(
        `${launcherUrl}/sesiones/${session1.id}/conversation/shutdown`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${controlToken}`,
          },
          body: JSON.stringify({ reason: "Cierre antes de recarga API" }),
        },
      );
      /** @type {{ closed: boolean }} */
      const shutJson = await shutRes.json();
      const shutSess = await getSession(session1.id);
      report.shutdown = {
        httpStatus: shutRes.status,
        closed: shutJson.closed,
        finalConexion: shutSess?.conexion || null,
      };

      // Reload service cleanly and verify persisted WorkOrder + question receipt + immutable v1/v2 artifact API downloads
      sseAbort.abort();
      await monitorLoop.catch(() => {});
      await sseTask.catch(() => {});

      await app.close();
      app = await createApplication({
        vaultRoot,
        dataDirectory: serviceData,
        auth: false,
        agentes: { brainTokenFile },
        lanzador: { url: launcherUrl, token: controlToken },
      });
      app.server.listen(0, "127.0.0.1");
      await once(app.server, "listening");
      servicePort = portOf(app.server);
      baseApi = `http://127.0.0.1:${servicePort}/api/v1`;
      lanzadorEnv.SB_BRAIN_URL = baseApi;
      lanzadorEnv.AGENTES_BRAIN_URL = baseApi;
      apiHeaders = await getApiHeaders();

      /** @type {RuntimeWorkOrderDetail} */
      const detReload = await fetch(
        `${baseApi}/encargos/detalle?id=${workOrderId}&cursor=0`,
      ).then((r) => r.json());
      // Assigned by the SSE task; TypeScript cannot see writes from closures.
      const answered = /** @type {ProductQuestionAnswer | null} */ (
        productQuestionAnswered
      );
      /** @type {{ solicitud?: RuntimeProductQuestion } | null} */
      const qReload = answered
        ? await fetch(`${baseApi}/solicitudes/detalle?id=${answered.id}`).then(
            (r) => r.json(),
          )
        : null;

      const arts = detReload.snapshot.artifacts || [];
      const matchingPathArts = arts.filter(
        (a) => a.fileRef === "informe/entrega.md",
      );
      const downloads = [];
      for (const art of matchingPathArts.slice(0, 2)) {
        const dlRes = await fetch(
          `${baseApi}/encargos/artefactos/descargar?workOrderId=${workOrderId}&artifactId=${art.id}`,
        );
        const dlBytes = dlRes.ok ? await dlRes.text() : null;
        downloads.push({
          artifactId: art.id,
          version: art.version,
          httpStatus: dlRes.status,
          headerSha256: dlRes.headers.get("x-artifact-sha256"),
          computedSha256: dlBytes !== null ? sha256Hex(dlBytes) : null,
          bytesLength:
            dlBytes !== null ? Buffer.byteLength(dlBytes, "utf8") : 0,
          hasCanary: Boolean(dlBytes?.includes("CANARIO-VERDE-2048")),
          hasFreeText: Boolean(dlBytes?.includes(freeTextAnswer)),
          hasV2Line: Boolean(dlBytes?.includes("V2-ACTUALIZADA")),
        });
      }
      report.artifactsApi = {
        totalArtifacts: arts.length,
        samePathVersions: matchingPathArts.length,
        publishedEvents: detReload.events.filter(
          (e) => e.type === "artifact.published",
        ).length,
        downloads,
      };
      report.reloadPersistence = {
        questionStatus: qReload?.solicitud?.status || null,
        questionAnswerText:
          qReload?.solicitud?.response?.freeText === freeTextAnswer &&
          qReload?.solicitud?.receipt?.freeText === freeTextAnswer,
      };

      // Cold resume check after shutdown + API reload
      const coldRes = await fetch(`${baseApi}/agentes/sesiones`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          motor: "agy",
          origen: "encargo",
          proyecto: "demo",
          continuar: session1.id,
          brief:
            "Responde únicamente con `REANUDADO-OK` y recuerda la palabra canario del turno 1.",
        }),
      });
      const coldDone =
        coldRes.status === 202
          ? await waitFor(async () => {
              const s = await getSession(session1.id);
              return s && s.estado !== "trabajando" ? s : null;
            }, 60_000)
          : null;
      report.coldResume = {
        httpStatus: coldRes.status,
        estado: coldDone?.estado || null,
        newPid: coldDone?.conexion?.pid ?? null,
        pidChanged: Boolean(
          coldDone?.conexion?.pid &&
          coldDone.conexion.pid !== t1Done.conexion?.pid,
        ),
        hasMarker: Boolean(coldDone?.resultado?.includes("REANUDADO-OK")),
        recalledCanary: Boolean(
          coldDone?.resultado?.includes("CANARIO-VERDE-2048"),
        ),
      };
      await fetch(
        `${launcherUrl}/sesiones/${session1.id}/conversation/shutdown`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${controlToken}`,
          },
          body: JSON.stringify({ reason: "Limpieza final runner opt-in" }),
        },
      );
    } else {
      sseAbort.abort();
      await monitorLoop.catch(() => {});
      await sseTask.catch(() => {});
    }

    if (withSkills || skillsOnly) {
      const skillFile = path.join(
        repoRoot,
        "lanzador",
        "skills",
        "personal-context",
        "SKILL.md",
      );
      const skillBytes = await readFile(skillFile);
      const expectedSha = createHash("sha256").update(skillBytes).digest("hex");

      const catProbeRes = await fetch(
        `${baseApi}/agentes/herramientas/catalogo?motor=agy&profileId=investigacion&probe=true`,
      );
      /** @type {RuntimeCatalog} */
      const catProbe = await catProbeRes.json();
      const sbProbeEntry = (catProbe.connectors || []).find(
        (c) => c.id === "secondbrain",
      );

      const skillsCreateRes = await fetch(`${baseApi}/agentes/sesiones`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          motor: "agy",
          origen: "encargo",
          proyecto: "demo",
          modelo: "gemini-3.8-flash-medium",
          structured: true,
          workOrderId,
          memberId: "exec-lira",
          toolProfileId: "investigacion",
          skillIds: ["personal-context"],
          brief: [
            'Usa la herramienta MCP `brain_read` del servidor `secondbrain` con exactamente `{ "path": "01-Proyectos/Proyecto-Demo.md" }`.',
            "Responde únicamente con el código canario literal obtenido desde esa nota.",
          ].join("\n"),
        }),
      });
      /** @type {Pick<LauncherSession, "id">} */
      const skillsSession = await skillsCreateRes.json();
      assert.equal(skillsCreateRes.status, 202, JSON.stringify(skillsSession));

      const skillsSseAbort = new AbortController();
      /** @type {RuntimeConversationSnapshot | null} */
      let lastSkillsSnap = null;
      const skillsSseTask = (async () => {
        try {
          const resp = await fetch(
            `${baseApi}/agentes/conversacion/stream?id=${skillsSession.id}`,
            { signal: skillsSseAbort.signal },
          );
          if (!resp.ok || !resp.body) return;
          let buf = "";
          for await (const chunk of resp.body) {
            buf += new TextDecoder().decode(chunk, { stream: true });
            const blocks = buf.split("\n\n");
            buf = blocks.pop() || "";
            for (const block of blocks) {
              const dataLine = block
                .split("\n")
                .find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              /** @type {RuntimeConversationSnapshot} */
              const snap = JSON.parse(dataLine.slice(6));
              lastSkillsSnap = snap;
              for (const req of snap.requests || []) {
                if (
                  req.kind === "approval" &&
                  req.status === "pending" &&
                  !answeredNative.has(req.id)
                ) {
                  answeredNative.add(req.id);
                  const choice =
                    (req.choices || []).find(
                      (c) => c === "allow_once" || c.includes("allow"),
                    ) ||
                    req.choices?.[0] ||
                    "accept";
                  await fetch(`${baseApi}/agentes/conversacion/responder`, {
                    method: "POST",
                    headers: apiHeaders,
                    body: JSON.stringify({
                      id: skillsSession.id,
                      requestId: req.id,
                      responseId: randomUUID(),
                      decision: choice,
                    }),
                  });
                }
              }
            }
          }
        } catch {
          /* aborted */
        }
      })();

      const skillsDone = await waitFor(async () => {
        const s = await getSession(skillsSession.id);
        return s &&
          ["terminada", "error", "cancelada", "interrumpida"].includes(s.estado)
          ? s
          : null;
      }, 90_000);

      skillsSseAbort.abort();
      await skillsSseTask.catch(() => {});

      const observedNames = (skillsDone.observedSkills || []).flatMap(
        (b) => b.names || [],
      );
      const provStages = (skillsDone.skillProvenance || []).map((p) => ({
        skillId: p.skillId,
        stage: p.stage,
        sha256: p.sha256,
        source: p.evidence?.source || null,
      }));
      // Written by skillsSseTask; TypeScript cannot see writes from closures.
      const convSnap = /** @type {RuntimeConversationSnapshot | null} */ (
        lastSkillsSnap
      );

      await fetch(
        `${launcherUrl}/sesiones/${skillsSession.id}/conversation/shutdown`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${controlToken}`,
          },
          body: JSON.stringify({ reason: "Cierre verificación" }),
        },
      );
      await fetch(`${baseApi}/agentes/sesiones/eliminar`, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ id: skillsSession.id }),
      });

      let tokenFileCleaned = false;
      try {
        await access(
          path.join(
            lanzadorData,
            "session-tokens",
            `${skillsSession.id}.token`,
          ),
        );
      } catch {
        tokenFileCleaned = true;
      }

      report.skillsLive = {
        catalogSecondbrainProbed: Boolean(sbProbeEntry?.states?.probada),
        catalogSecondbrainStates: sbProbeEntry?.states || null,
        sessionId: skillsDone.id,
        estado: skillsDone.estado,
        error: skillsDone.error || null,
        pid: skillsDone.conexion?.pid ?? null,
        nativeSessionId: skillsDone.conversacionId || null,
        model: skillsDone.modelo || "gemini-3.8-flash-medium",
        toolProfileId: skillsDone.toolProfileId || null,
        skillIds: skillsDone.skillIds || [],
        expectedSha256: expectedSha,
        observedCommandsCount: [...new Set(observedNames)].length,
        observedPersonalContext: observedNames.includes("personal-context"),
        conversationHasSkillsEvent: (convSnap?.events || []).some(
          (e) => e.type === "skills.observed",
        ),
        provenanceStages: provStages,
        toolsObserved: (convSnap?.tools || []).map((t) => ({
          nombre: t.nombre,
          estado: t.estado,
        })),
        resultPreview: String(skillsDone.resultado || "").slice(0, 200),
        canaryFound: Boolean(
          skillsDone.resultado?.includes("CANARIO-VERDE-2048"),
        ),
        tokenFileCleaned,
      };
    }

    report.lastSeq = lastSseSeq;
    return report;
  } finally {
    clearTimeout(watchdog);
    if (app) await app.close().catch(() => {});
    const server = launcher;
    if (server) {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    }).catch(() => {});
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const optIn =
    process.argv.includes("--live") || process.env.SB_RUN_RUNTIME_LIVE === "1";
  const withSkills =
    process.argv.includes("--with-skills") ||
    process.env.SB_RUN_RUNTIME_SKILLS === "1";
  const skillsOnly =
    process.argv.includes("--skills") || process.argv.includes("--skills-only");
  if (!optIn) {
    console.log(
      "Runner opt-in de verificación runtime. Pasa --live (opcional --with-skills o --skills-only) o SB_RUN_RUNTIME_LIVE=1 para ejecutar contra proveedor local autenticado en entorno temporal sintético.",
    );
    process.exit(0);
  }
  const report = await runLiveVerification({ withSkills, skillsOnly });
  console.log(JSON.stringify(report, null, 2));
}
