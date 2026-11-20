import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";

import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import {
  entornoDe,
  leerClaude,
  leerGemini,
  nuevoClaude,
  actividadEvento,
  entornoEsfuerzo,
  validarAdjuntosMotor,
} from "./motores.mjs";
import {
  buildMcpConfigForProfile,
  narrowChildProfile,
  TOOL_PROFILES_BASE,
} from "./catalogo-herramientas.mjs";

import { inferirFase } from "./fases.mjs";

import { tamanoPermitido } from "./harness.mjs";

import { sessionCommand, stopSessionScope } from "./limits.mjs";
import { ErrorLanzador } from "./errores.mjs";
import { resolveExecutorOptions } from "./execution/options.mjs";
import { createExecutionState } from "./execution/state.mjs";
import { createRemoteRunner } from "./execution/run-remote.mjs";
import { createMonitor } from "./execution/monitor.mjs";
import { createCapacity } from "./execution/capacity.mjs";
import { createSessionSecrets } from "./execution/secrets.mjs";
import {
  PROVIDER_BY_ENGINE,
  createProcessTools,
} from "./execution/process-tools.mjs";

/** @import { LauncherSession } from "./session-types.d.ts" */

/** @import { ActiveJob, ExecutionRequest, ExecutorOptions, TerminalEvent, TerminalInput, TurnOptions } from "./types.d.ts" */

const runFile = promisify(execFile);

/** @param {ExecutorOptions} options */
export function crearEjecutor(options) {
  const config = resolveExecutorOptions(options);
  const {
    registro,
    equipos,
    proyectos,
    espacios,
    env,
    comando,
    maxActivos,
    seguimiento,
    conversations,
    toolCatalog,
    consultarSaldo,
    limiteMs,
  } = config;
  const state = createExecutionState();
  const {
    activos,
    terminales,
    liveProcesses,
    exitedProcesses,
    sessionTokenFiles,
    sessionProfiles,
    sessionBillingGrants,
    materializedSkillCleanups,
    materializedSkillsBySession,
    resourceQueue,
    queuedPromises,
    takeEnqueueSeq,
    serial,
    drenando,
  } = state;
  const {
    sessionTokenDir,
    sanitizeChildEnv,
    acpGeminiDirFor,
    copiarEntradasProyecto,
    limpiarWorkspaceMiembro,
    senalar,
    marcar,
    margenDiagnostico,
    diagnosticar,
  } = createProcessTools(config);
  const {
    writeSessionTokenFile,
    cleanupSessionRuntimeSecrets,
    resolveSessionEffectiveProfile,
  } = createSessionSecrets(config, state, { sessionTokenDir });
  const {
    limpiarEviccionOciosa,
    armarEviccionOciosa,
    sesionesOcupandoCupo,
    cerrarConexion,
    evictOneIdle,
    asegurarCupo,
    cerrarTodo,
  } = createCapacity(config, state, {
    acpGeminiDirFor,
    cleanupSessionRuntimeSecrets,
  });
  async function despacharColaRecursos() {
    while (resourceQueue.length > 0) {
      if (sesionesOcupandoCupo().size >= maxActivos) {
        const evicted = await evictOneIdle(
          "Evictada para iniciar una integrante en cola",
        );
        if (!evicted) break;
      }
      const siguiente = resourceQueue.shift();
      if (!siguiente) break;
      const s = registro.leer().find((x) => x.id === siguiente.sesionId);
      const pq = queuedPromises.get(siguiente.sesionId);
      if (!s || s.eliminada || s.estado !== "pendiente") {
        if (pq) {
          queuedPromises.delete(siguiente.sesionId);
          pq.resolve();
        }
        continue;
      }
      await registro.actualizar(s.id, {
        estado: "trabajando",
        enColaRecursos: false,
        motivoCola: null,
      });
      const actualizado = registro.leer().find((x) => x.id === s.id) || {
        ...s,
        estado: "trabajando",
        enColaRecursos: false,
        motivoCola: null,
      };
      lanzarTrabajo(actualizado, siguiente.brief, siguiente.cwd, {
        attachments: siguiente.attachments || [],
        commandId: siguiente.commandId || null,
      });
      if (pq) {
        const job = activos.get(s.id);
        Promise.resolve(job?.promesa).finally(() => {
          queuedPromises.delete(s.id);
          pq.resolve();
        });
      }
    }
  }
  // Readers learn "the program is gone" from the registry; this runs after the
  // final state was saved, so the notification must follow the release.
  /** @param {string} id */
  async function liberar(id) {
    const persistentLive = Boolean(conversations?.hasLiveController?.(id));
    if (!persistentLive) {
      liveProcesses.delete(id);
      try {
        await stopSessionScope(id, env);
      } catch {
        const job = activos.get(id);
        if (job) job.cleanupFailed = true;
        await registro.actualizar(id, {
          estado: "error",
          error:
            "No se pudo confirmar el cierre del grupo de procesos. Requiere mantenimiento.",
        });
        return; // Keep its slot reserved while descendants may still exist.
      }
    }
    activos.get(id)?.detenerVigilante?.();
    activos.delete(id);
    if (persistentLive) armarEviccionOciosa(id);
    if (resourceQueue.length > 0) {
      await serial(() => despacharColaRecursos()).catch(() => {});
    }
    registro.notificar?.();
  }
  /**
   * @param {LauncherSession} sesion
   * @param {string} brief
   * @param {string} cwd
   * @param {TurnOptions} [turnOptions]
   */
  function lanzarTrabajo(sesion, brief, cwd, turnOptions = {}) {
    limpiarEviccionOciosa(sesion.id);
    /** @type {ActiveJob} */
    const job = { hijo: null, cancelada: false, promesa: null, pendientes: 0 };
    activos.set(sesion.id, job);
    job.promesa = Promise.resolve()
      .then(() => marcar(sesion.id, brief))
      .then(() => correr(sesion, brief, cwd, turnOptions))
      .catch(async (error) => {
        diagnosticar(sesion, brief, {
          mensaje: error?.message,
          pila: error?.stack,
        });
        if (
          sesion.structured &&
          conversations?.hasLiveController?.(sesion.id)
        ) {
          await conversations
            .shutdown(sesion.id, {
              reason: job.cancelada ? "Turno cancelado" : "Error en turno",
            })
            .catch(() => {});
        }
        if (job.hijo) {
          try {
            senalar(job.hijo, "SIGKILL");
          } catch {}
        }
        try {
          await registro.actualizar(sesion.id, {
            estado: job.cancelada ? "cancelada" : "error",
            interactiva: false,
            ...(sesion.structured
              ? {
                  conexion: {
                    estado: "cerrada",
                    pid: null,
                    motivo: job.cancelada
                      ? "Turno cancelado"
                      : error instanceof ErrorLanzador
                        ? error.message
                        : "Error en turno",
                  },
                }
              : {}),
            error: sesion.structured
              ? error instanceof ErrorLanzador
                ? error.message
                : "El proveedor no completó la conversación. Comprueba el ejecutable, su autenticación y la compatibilidad del protocolo en el servidor."
              : "No se pudo ejecutar el motor.",
          });
        } catch {
          diagnosticar(sesion, brief, {
            mensaje: "No se pudo persistir el estado final.",
          });
        }
      })
      .finally(async () => {
        await liberar(sesion.id);
        if (sesion.structured && !job.cancelada) await drenarCola(sesion.id);
      });
  }
  const { activeJob, vigilar } = createMonitor(config, state, { senalar });
  /**
   * @param {LauncherSession} sesion
   * @param {string} brief
   * @param {string} cwd
   * @param {TurnOptions} [turnOptions]
   */
  async function correr(sesion, brief, cwd, turnOptions = {}) {
    sesion = { ...sesion };
    if (sesion.structured) {
      if (!conversations)
        throw new Error("Integración estructurada no instalada");
      const billingGranted =
        (sessionBillingGrants.has(sesion.id)
          ? sessionBillingGrants.get(sesion.id) === true
          : sesion.billingAuthorized === true) ||
        env.SB_ALLOW_BILLED_DEEPSEEK === "1";
      if (sesion.motor === "deepseek" && !billingGranted) {
        throw new ErrorLanzador(
          "DeepSeek bloqueado por la política de gasto sin autorización explícita de gasto.",
          403,
        );
      }
      const proveedor = PROVIDER_BY_ENGINE[sesion.motor] || sesion.motor;
      const profile = resolveSessionEffectiveProfile(sesion);
      const sessionTokenFile = sessionTokenFiles.get(sesion.id) || null;
      const baseEnv = sanitizeChildEnv(
        {
          ...entornoDe(proveedor, env),
          ...entornoEsfuerzo(sesion.motor, sesion.esfuerzo),
          SB_SESSION_ID: sesion.id,
        },
        profile,
        sessionTokenFile,
        billingGranted,
        sesion.motor,
      );
      const mcpActor =
        { claude: "ambar", codex: "menta", agy: "lira", deepseek: "marina" }[
          sesion.motor
        ] ||
        sesion.memberId ||
        sesion.id;
      const mcpConfig = buildMcpConfigForProfile({
        profile,
        env: { ...env, ...baseEnv },
        memberId: mcpActor,
        sessionId: sesion.id,
        sessionTokenFile,
      });
      /** @type {NodeJS.ProcessEnv} */
      const childEnv = {
        ...baseEnv,
        ...mcpConfig.envOverrides,
      };
      const useAcpIsolation = sesion.motor === "agy" && !env.SB_AGY_ACP_ARGS;
      const geminiDir = useAcpIsolation ? acpGeminiDirFor(sesion.id) : null;
      if (geminiDir) {
        await mkdir(geminiDir, { recursive: true, mode: 0o700 });
      }
      const job = activeJob(sesion.id);
      const existingChild = liveProcesses.get(sesion.id);
      if (
        existingChild &&
        !exitedProcesses.has(existingChild) &&
        conversations?.hasLiveController?.(sesion.id)
      ) {
        job.hijo = existingChild;
        vigilar(sesion, existingChild);
        await registro
          .actualizar(sesion.id, {
            conexion: {
              estado: "activa",
              pid: existingChild.pid ?? null,
              motivo: "Reutilizando proceso persistente",
            },
          })
          .catch(() => {});
      }
      /** @type {Promise<unknown>} */
      let provenanceSync = Promise.resolve();
      try {
        const requestedSkills = Array.isArray(sesion.skillIds)
          ? sesion.skillIds
          : [];
        let provenanceList = Array.isArray(sesion.skillProvenance)
          ? [...sesion.skillProvenance]
          : [];
        let materializedMap =
          materializedSkillsBySession.get(sesion.id) || null;
        if (toolCatalog && requestedSkills.length > 0 && !materializedMap) {
          const runtimeProbes = await toolCatalog.runHealthChecks({
            targets: ["secondbrain", "git_workspace"],
            optIn: true,
            cwd,
            probeTimeoutMs: 1000,
            tokenFile:
              sessionTokenFile ||
              baseEnv.SB_BRAIN_TOKEN_FILE ||
              env.SB_BRAIN_TOKEN_FILE ||
              env.AGENTES_BRAIN_TOKEN_FILE ||
              null,
            brainUrl:
              baseEnv.SB_BRAIN_URL ||
              env.SB_BRAIN_URL ||
              env.AGENTES_BRAIN_URL ||
              env.SB_SERVICE_URL ||
              null,
          });
          const materializedRes = await toolCatalog.materializeSkillsForSession(
            {
              motor: sesion.motor,
              profileId: profile.id,
              skillIds: requestedSkills,
              cwd,
              geminiDir,
              codexHome: childEnv.CODEX_HOME || null,
              claudeConfigDir: childEnv.CLAUDE_CONFIG_DIR || null,
              runtimeProbes,
              verifiedOperatorBillingGrant: billingGranted,
            },
          );
          materializedSkillCleanups.set(sesion.id, materializedRes.cleanup);
          materializedMap = new Map(
            materializedRes.materialized.map((m) => [m.id, m]),
          );
          materializedSkillsBySession.set(sesion.id, materializedMap);
          for (const m of materializedRes.materialized) {
            provenanceList = toolCatalog.recordSkillProvenance(provenanceList, {
              skillId: m.id,
              version: m.version,
              sha256: m.sha256,
              stage: "sugerida",
              evidence: {
                source: "session_skill_selection",
                verifiedAt: new Date().toISOString(),
              },
            });
          }
          provenanceList = [...provenanceList, ...materializedRes.provenance];
          await registro.actualizar(sesion.id, {
            skillProvenance: provenanceList,
          });
        }
        const observedBuckets = Array.isArray(sesion.observedSkills)
          ? [...sesion.observedSkills]
          : [];
        const seenLoaded = new Set(
          provenanceList
            .filter((p) => p.stage === "cargada_observada")
            .map((p) => `${p.skillId}:${p.evidence?.source || ""}`),
        );
        const result = await conversations.run({
          session: sesion,
          prompt: brief,
          attachments: turnOptions.attachments || [],
          mcpServers: mcpConfig.mcpServers,
          disableInheritedMcp: env.SB_PRESERVE_CODEX_MCP !== "1",
          ...(geminiDir ? { geminiDir } : {}),
          cwd,
          env: childEnv,
          operatorEnv: env,
          toolProfile: profile,
          verifiedBillingGrant: billingGranted,
          observeSkills: Boolean(requestedSkills.length > 0),
          onSkillsObserved:
            toolCatalog && requestedSkills.length > 0
              ? /** @param {{ source: string, names: string[] }} obs */ async (
                  obs,
                ) => {
                  if (!obs || !Array.isArray(obs.names)) return;
                  const cleanNames = [...new Set(obs.names.map(String))];
                  observedBuckets.push({
                    source: obs.source || "unknown",
                    names: cleanNames,
                    ts: new Date().toISOString(),
                  });
                  for (const name of cleanNames) {
                    const mat = materializedMap?.get(name);
                    if (!mat) continue;
                    const key = `${mat.id}:${obs.source || "unknown"}`;
                    if (seenLoaded.has(key)) continue;
                    seenLoaded.add(key);
                    provenanceList = toolCatalog.recordSkillProvenance(
                      provenanceList,
                      {
                        skillId: mat.id,
                        version: mat.version,
                        sha256: mat.sha256,
                        stage: "cargada_observada",
                        evidence: {
                          source: obs.source || "unknown",
                          observedNames: cleanNames,
                          verifiedAt: new Date().toISOString(),
                        },
                      },
                    );
                  }
                  const snapshotObs = [...observedBuckets];
                  const snapshotProv = [...provenanceList];
                  provenanceSync = provenanceSync
                    .then(() =>
                      registro.actualizar(sesion.id, {
                        observedSkills: snapshotObs,
                        skillProvenance: snapshotProv,
                      }),
                    )
                    .catch(() => {});
                  await provenanceSync;
                }
              : null,
          /**
           * @param {string} bin
           * @param {string[]} args
           */
          spawn(bin, args, processEnv = childEnv) {
            const spec = sessionCommand({ bin, args }, sesion.id, env);
            const child = spawn(spec.bin, spec.args, {
              cwd,
              env: processEnv,
              detached: process.platform !== "win32",
              stdio: ["pipe", "pipe", "pipe"],
            });
            job.hijo = child;
            liveProcesses.set(sesion.id, child);
            child.once("exit", (code, signal) => {
              exitedProcesses.add(child);
              if (liveProcesses.get(sesion.id) === child) {
                liveProcesses.delete(sesion.id);
              }
              if (!activos.has(sesion.id)) {
                void registro
                  .actualizar(sesion.id, {
                    conexion: {
                      estado: "cerrada",
                      pid: null,
                      motivo: signal
                        ? `Señal ${signal}`
                        : `Proceso finalizado (${code ?? 0})`,
                    },
                  })
                  .catch(() => {});
              }
            });
            // Drain diagnostics without exposing provider credentials or prompts.
            child.stderr.on("data", () => {});
            vigilar(sesion, child);
            void registro
              .actualizar(sesion.id, {
                conexion: {
                  estado: "activa",
                  pid: child.pid ?? null,
                  motivo: "Proceso conectado",
                },
              })
              .catch(() => {});
            if (job.cancelada) senalar(child, "SIGTERM");
            return child;
          },
          /** @param {string} id */
          onNativeId: (id) =>
            registro.actualizar(sesion.id, { conversacionId: id }),
        });
        await provenanceSync;
        if (turnOptions.commandId) {
          await conversations
            .markCommandDelivery(
              sesion.id,
              turnOptions.commandId,
              "confirmado_proveedor",
            )
            .catch(() => {});
        }
        const snap = await conversations.snapshot(sesion.id);
        const liveController = conversations
          ?.liveSessions?.()
          .find((entry) => entry.id === sesion.id);
        await registro.actualizar(sesion.id, {
          estado: job.cancelada
            ? "cancelada"
            : snap.lastTurnStatus === "interrupted"
              ? "interrumpida"
              : "terminada",
          resultado: result,
          ultimaAccion:
            snap.lastTurnStatus === "interrupted"
              ? "Turno interrumpido"
              : "Turno finalizado",
          interactiva: false,
          conexion: liveController
            ? {
                estado: "ociosa",
                pid: liveController.pid,
                motivo:
                  snap.lastTurnStatus === "interrupted"
                    ? "Turno interrumpido; proceso persistente listo"
                    : "Proceso persistente listo",
              }
            : {
                estado: "cerrada",
                pid: null,
                motivo: snap?.connection?.reason || "Turno finalizado",
              },
        });
      } catch (err) {
        await provenanceSync;
        if (turnOptions.commandId) {
          await conversations
            .markCommandDelivery(
              sesion.id,
              turnOptions.commandId,
              job.cancelada ? "entrega_incierta" : "fallido",
              err?.message || null,
            )
            .catch(() => {});
        }
        throw err;
      } finally {
        const keepPersistent = conversations?.hasLiveController?.(sesion.id);
        if (
          !keepPersistent &&
          job.hijo &&
          !exitedProcesses.has(job.hijo) &&
          (job.hijo.exitCode === null || job.hijo.exitCode === undefined)
        ) {
          senalar(job.hijo, "SIGTERM");
        }
      }
      return;
    }
    if (sesion.harness) return correrRemoto(sesion, brief, cwd);
    if (
      env.SB_REMOTE_INTERACTIVE === "1" &&
      sesion.origen === "sala" &&
      ["claude", "agy"].includes(sesion.motor)
    )
      return correrRemoto(sesion, brief, cwd);
    const spec = sessionCommand(
      comando(sesion.motor, brief, {
        modelo: sesion.modelo,
        esfuerzo: sesion.esfuerzo,
        conversacionId: sesion.conversacionId,
      }),
      sesion.id,
      env,
    );
    const proveedor = PROVIDER_BY_ENGINE[sesion.motor] || sesion.motor;
    const childEnv = {
      ...entornoDe(proveedor, env),
      ...entornoEsfuerzo(sesion.motor, sesion.esfuerzo),
      SB_SESSION_ID: sesion.id,
      ...(env.SB_HOOK_TOKEN_FILE
        ? { SB_HOOK_TOKEN_FILE: env.SB_HOOK_TOKEN_FILE }
        : {}),
      ...(env.SB_LANZADOR_PORT
        ? { SB_LANZADOR_PORT: env.SB_LANZADOR_PORT }
        : {}),
    };
    const hijo = spawn(spec.bin, spec.args, {
      cwd,
      env: childEnv,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const job = activeJob(sesion.id);
    job.hijo = hijo;
    if (job.cancelada) senalar(hijo, "SIGTERM");
    const detenerVigilante = vigilar(sesion, hijo);
    const acumulado = nuevoClaude();
    /** @type {Promise<unknown>} */
    let cambio = Promise.resolve();
    const lineas = createInterface({ input: hijo.stdout });
    lineas.on("line", (linea) => {
      let evento;
      try {
        evento = JSON.parse(linea);
      } catch {
        return;
      }
      if (sesion.motor === "claude" || sesion.motor === "deepseek")
        leerClaude(acumulado, evento);
      if (sesion.motor === "agy") leerGemini(acumulado, evento);
      if (
        acumulado.sessionId &&
        acumulado.sessionId !== sesion.conversacionId
      ) {
        sesion.conversacionId = acumulado.sessionId;
        cambio = cambio.then(() =>
          registro.actualizar(sesion.id, {
            conversacionId: acumulado.sessionId,
          }),
        );
      }
      if (
        sesion.motor === "codex" &&
        evento.type === "item.completed" &&
        evento.item?.type === "agent_message"
      )
        acumulado.texto = String(evento.item.text || "");
      const actividad = actividadEvento(evento);
      if (actividad)
        cambio = cambio.then(() =>
          registro.actualizar(sesion.id, {
            ultimaAccion: actividad.etiqueta,
            fase: inferirFase(
              evento.item?.type ||
                evento.message?.content?.find(
                  /** @param {{type?: string, name?: string}} c */
                  (c) => c.type === "tool_use",
                )?.name ||
                "",
            ),
          }),
        );
    });
    // The engine's own diagnostics stay in the log; they never reach clients.
    let fallo = "";
    const decodificador = new StringDecoder("utf8");
    hijo.stderr.on("data", (chunk) => {
      fallo = (fallo + decodificador.write(chunk)).slice(
        -margenDiagnostico(brief),
      );
    });
    let codigo;
    try {
      codigo = await new Promise((resolve, reject) => {
        hijo.once("error", reject);
        hijo.once("close", resolve);
      });
      await cambio;
      if ((codigo !== 0 || acumulado.error) && !job.cancelada)
        diagnosticar(sesion, brief, { codigo, diagnostico: fallo });
      await registro.actualizar(
        sesion.id,
        job.cancelada
          ? { estado: "cancelada" }
          : job.excedida
            ? {
                estado: "error",
                error: `La sesión superó el tiempo máximo de ${Math.round(limiteMs / 60000)} minutos y se canceló.`,
              }
            : codigo === 0 && !acumulado.error
              ? {
                  estado: "terminada",
                  resultado: acumulado.texto.slice(0, 100000),
                }
              : { estado: "error", error: "El motor terminó con error." },
      );
    } catch (error) {
      diagnosticar(sesion, brief, {
        mensaje: error?.message,
        pila: error?.stack,
      });
      await registro.actualizar(sesion.id, {
        estado: job.cancelada ? "cancelada" : "error",
        error: "No se pudo ejecutar el motor.",
      });
    } finally {
      detenerVigilante();
    }
  }
  const { correrRemoto } = createRemoteRunner(config, state, {
    activeJob,
    diagnosticar,
    margenDiagnostico,
    senalar,
    vigilar,
  });
  /** @param {ExecutionRequest} input */
  async function iniciar({
    id = null,
    motor,
    origen,
    proyecto,
    brief,
    modelo = null,
    esfuerzo = null,
    equipoId = null,
    padreId = null,
    espacioId = null,
    harness = false,
    structured = false,
    contextoHeredado = null,
    workOrderId = null,
    memberId = null,
    role = null,
    responsibility = null,
    manifest = null,
    manifestSha256 = null,
    requestId = null,
    toolProfileId = null,
    effectiveProfile = null,
    skillIds = null,
    capabilityToken = null,
    billingGrantVerified = false,
    billingAuthorized: _ignoredClientBilling = false,
    enqueueIfFull = false,
    isolateWorkspace = false,
    attachments = [],
  }) {
    const verifiedGrant =
      billingGrantVerified === true || env.SB_ALLOW_BILLED_DEEPSEEK === "1";
    if (
      (structured || origen !== "equipo" || workOrderId || manifest) &&
      motor === "deepseek" &&
      !verifiedGrant
    ) {
      throw new ErrorLanzador(
        "DeepSeek bloqueado por la política de gasto sin autorización explícita de gasto.",
        403,
      );
    }
    /** @type {import("./types.d.ts").ExecutionContext | null} */
    let context =
      contextoHeredado ||
      (espacioId && espacios ? await espacios.resolver(espacioId) : null);
    const projectKey = String(proyecto);
    if (!context && !Object.hasOwn(proyectos, projectKey))
      throw new Error("Proyecto desconocido");
    if (typeof brief !== "string" || !brief.trim())
      throw new Error("Encargo vacío");
    let resolvedMemberId = memberId;
    let resolvedRole = role;
    let resolvedResponsibility = responsibility;
    let resolvedModelo = modelo;
    let resolvedEsfuerzo = esfuerzo;
    let resolvedToolProfileId = toolProfileId;
    let resolvedManifestSha256 = manifestSha256 || manifest?.sha256 || null;

    if (!padreId && manifest && Array.isArray(manifest.team)) {
      const card =
        manifest.team.find(
          (c) =>
            c.assigned !== false &&
            (memberId ? c.id === memberId : c.coordinator),
        ) || null;
      if (!card) {
        throw new ErrorLanzador(
          "Integrante fuera del manifiesto aprobado.",
          403,
        );
      }
      if ((card.motor || card.engine) !== motor) {
        throw new ErrorLanzador(
          "El manifiesto del encargo no permite cambiar el motor de esta integrante.",
          409,
        );
      }
      if (card.model && modelo && modelo !== card.model) {
        throw new ErrorLanzador(
          "El manifiesto del encargo fija el modelo de esta integrante y no permite cambiarlo sin editar el equipo.",
          409,
        );
      }
      if (card.effort && esfuerzo && esfuerzo !== card.effort) {
        throw new ErrorLanzador(
          "El manifiesto del encargo fija el esfuerzo de esta integrante y no permite cambiarlo sin editar el equipo.",
          409,
        );
      }
      resolvedMemberId = resolvedMemberId || card.id || null;
      resolvedRole = resolvedRole || card.role || null;
      resolvedResponsibility =
        resolvedResponsibility || card.responsibility || null;
      resolvedModelo = resolvedModelo || card.model || null;
      resolvedEsfuerzo = resolvedEsfuerzo || card.effort || null;
      resolvedToolProfileId =
        resolvedToolProfileId || card.toolProfileId || null;
    }

    let queueSlot = false;
    try {
      await asegurarCupo(null);
    } catch (error) {
      if (!enqueueIfFull) throw error;
      queueSlot = true;
    }

    const targetCwd = context?.cwd || proyectos[projectKey];
    const validatedAttachments = structured
      ? validarAdjuntosMotor(motor, attachments, targetCwd)
      : [];
    const isolateChild = Boolean(
      padreId &&
      (structured || workOrderId || memberId || manifest || isolateWorkspace),
    );
    let workspaceKind = "shared";
    let workspacePath = targetCwd;
    if (isolateChild) {
      const base = targetCwd;
      const scopeFolder = String(equipoId || workOrderId || "solo").replace(
        /[^a-zA-Z0-9._-]/g,
        "_",
      );
      const leafFolder = `${String(resolvedMemberId || "child").replace(/[^a-zA-Z0-9._-]/g, "_")}-${randomUUID().slice(0, 8)}`;
      const isolated = path.join(
        env.SB_LANZADOR_DATA_DIR || path.join(base, ".secondbrain"),
        "member-workspaces",
        scopeFolder,
        leafFolder,
      );
      let gitRoot = null;
      let hasHead = false;
      try {
        const inside = await runFile(
          "git",
          ["-C", base, "rev-parse", "--is-inside-work-tree"],
          { timeout: 10000 },
        );
        if (inside.stdout?.trim() === "true") {
          const top = await runFile(
            "git",
            ["-C", base, "rev-parse", "--show-toplevel"],
            { timeout: 10000 },
          );
          gitRoot = top.stdout?.trim() || base;
          try {
            await runFile(
              "git",
              ["-C", gitRoot, "rev-parse", "--verify", "HEAD"],
              {
                timeout: 10000,
              },
            );
            hasHead = true;
          } catch {
            hasHead = false;
          }
        }
      } catch {
        gitRoot = null;
      }
      await mkdir(path.dirname(isolated), { recursive: true, mode: 0o700 });
      if (gitRoot && hasHead) {
        await runFile(
          "git",
          ["-C", gitRoot, "worktree", "add", "--detach", isolated, "HEAD"],
          { timeout: 30000 },
        );
        workspaceKind = "git-worktree";
      } else {
        await mkdir(isolated, { recursive: true, mode: 0o700 });
        await copiarEntradasProyecto(base, isolated);
        workspaceKind = "directory";
      }
      workspacePath = isolated;
      context = {
        cwd: isolated,
        repositorio: context?.repositorio || proyecto,
      };
    }
    const baseProfileId = resolvedToolProfileId || "ejecucion";
    const baseProfile =
      toolCatalog?.getProfile(baseProfileId) ||
      TOOL_PROFILES_BASE[baseProfileId] ||
      TOOL_PROFILES_BASE.ejecucion;
    const resolvedProfile =
      effectiveProfile && typeof effectiveProfile === "object"
        ? narrowChildProfile(baseProfile, effectiveProfile)
        : resolvedToolProfileId
          ? structuredClone(baseProfile)
          : null;
    const enqueueOrder = queueSlot ? takeEnqueueSeq() : null;
    const sesion = await registro.crear({
      id,
      motor,
      origen,
      equipoId,
      padreId,
      proyecto: (context ? context.repositorio : proyecto) ?? undefined,
      encargo: brief,
      modelo: resolvedModelo,
      esfuerzo: resolvedEsfuerzo,
      espacioId,
      harness,
      structured,
      workOrderId,
      memberId: resolvedMemberId,
      role: resolvedRole,
      responsibility: resolvedResponsibility,
      manifestSha256: resolvedManifestSha256,
      toolProfileId: resolvedProfile?.id || resolvedToolProfileId,
      effectiveProfile: resolvedProfile,
      skillIds,
      billingGrantVerified: billingGrantVerified === true,
      workspacePath,
      workspaceKind,
      enColaRecursos: queueSlot,
      motivoCola: queueSlot ? "En cola por límite de procesos activos" : null,
      enqueueOrder,
      directorio:
        workspacePath ||
        context?.cwd ||
        (proyecto ? proyectos[proyecto] : undefined),
    });
    if (resolvedProfile) sessionProfiles.set(sesion.id, resolvedProfile);
    sessionBillingGrants.set(sesion.id, billingGrantVerified === true);
    if (capabilityToken) {
      await writeSessionTokenFile(sesion.id, capabilityToken);
    }
    if (padreId) {
      try {
        if (!equipos || !equipoId) throw new Error("Equipos no disponibles");
        await equipos.agregar(equipoId, padreId, sesion.id, motor, {
          memberId: resolvedMemberId,
          role: resolvedRole,
          responsibility: resolvedResponsibility,
          modelo: resolvedModelo,
          esfuerzo: resolvedEsfuerzo,
          toolProfileId: resolvedToolProfileId,
          workOrderId,
          manifest,
          manifestSha256: resolvedManifestSha256,
          requestId,
          workspacePath,
          workspaceKind,
        });
      } catch (error) {
        await cleanupSessionRuntimeSecrets(sesion.id);
        await registro.actualizar(sesion.id, {
          estado: "error",
          enColaRecursos: false,
          error: "No se pudo unir al equipo.",
        });
        await limpiarWorkspaceMiembro(sesion);
        throw error;
      }
    } else if (equipos && (manifest || workOrderId)) {
      try {
        const equipoLider = await equipos.crear(sesion.id, {
          workOrderId,
          manifest,
          manifestSha256: resolvedManifestSha256,
          motor,
          memberId: resolvedMemberId,
          role: resolvedRole,
          responsibility: resolvedResponsibility,
          modelo: resolvedModelo,
          esfuerzo: resolvedEsfuerzo,
          toolProfileId: resolvedToolProfileId,
          workspacePath,
          workspaceKind,
          directorioIntegracion: targetCwd,
        });
        await registro.vincularEquipo(sesion.id, equipoLider.id);
      } catch (error) {
        await cleanupSessionRuntimeSecrets(sesion.id);
        await registro.actualizar(sesion.id, {
          estado: "error",
          enColaRecursos: false,
          error: "No se pudo inicializar el equipo del encargo.",
        });
        throw error;
      }
    }
    const cwdFinal = context?.cwd || proyectos[projectKey];
    if (queueSlot) {
      /** @type {() => void} */
      let resolvePromise = () => {};
      /** @type {Promise<void>} */
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      queuedPromises.set(sesion.id, { promise, resolve: resolvePromise });
      resourceQueue.push({
        sesionId: sesion.id,
        brief,
        cwd: cwdFinal,
        attachments: validatedAttachments,
        commandId: null,
      });
      return registro.leer().find((s) => s.id === sesion.id) || sesion;
    }
    await registro.actualizar(sesion.id, { estado: "trabajando" });
    lanzarTrabajo(sesion, brief, cwdFinal, {
      attachments: validatedAttachments,
    });
    return registro.leer().find((s) => s.id === sesion.id) || sesion;
  }
  /**
   * Starts the next queued message of an idle structured session. Called when
   * a turn ends and after a message is queued, since either can happen first.
   * @param {string} id
   */
  async function drenarCola(id) {
    if (!conversations || activos.has(id) || drenando.has(id)) return;
    const sesion = registro.leer().find((s) => s.id === id && !s.eliminada);
    if (sesion?.estado !== "terminada" || !sesion.conversacionId) return;
    drenando.add(id);
    try {
      const siguiente = await conversations
        .consumeNextQueuedMessage(id)
        .catch(/** @returns {null} */ () => null);
      if (!siguiente) return;
      // A later tick lets the finished turn settle before the next one starts.
      await new Promise((r) => setImmediate(r));
      await continuar(id, siguiente.text, {
        attachments: siguiente.attachments,
        commandId: siguiente.commandId,
      }).catch((error) =>
        conversations
          .markCommandDelivery(
            id,
            siguiente.commandId,
            "entrega_incierta",
            error?.message || "No se pudo iniciar el turno en cola.",
          )
          .catch(() => {}),
      );
    } finally {
      drenando.delete(id);
    }
  }
  /**
   * @param {string} id
   * @param {string} brief
   * @param {TurnOptions} [turnOptions]
   */
  function continuar(id, brief, turnOptions = {}) {
    return serial(async () => {
      const sesion = registro.leer().find((s) => s.id === id && !s.eliminada);
      if (sesion?.structured) {
        if (activos.has(id))
          throw new ErrorLanzador(
            "Espera a que termine el turno o detenlo antes de enviar otro mensaje.",
            409,
          );
        if (!sesion.directorio || !sesion.conversacionId)
          throw new ErrorLanzador(
            "No se puede reanudar esta conversación.",
            409,
          );
        if (typeof brief !== "string" || !brief.trim())
          throw new Error("Encargo vacío");
        await asegurarCupo(id);
        const validatedAttachments = validarAdjuntosMotor(
          sesion.motor,
          turnOptions.attachments || [],
          sesion.directorio,
        );
        await registro.actualizar(id, { estado: "trabajando", error: null });
        lanzarTrabajo(sesion, brief, sesion.directorio, {
          attachments: validatedAttachments,
          commandId: turnOptions.commandId || null,
        });
        return registro.leer().find((s) => s.id === id);
      }
      if (sesion?.harness && !activos.has(id)) {
        if (!sesion.conversacionId || !sesion.directorio)
          throw new Error("Conversación no disponible");
        if (typeof brief !== "string" || !brief.trim())
          throw new Error("Encargo vacío");
        await asegurarCupo(id);
        await registro.actualizar(id, { estado: "trabajando", error: null });
        lanzarTrabajo(sesion, brief, sesion.directorio);
        return registro.leer().find((s) => s.id === id);
      }
      const nativo = activos.get(id);
      if (nativo?.nativo && sesion?.estado === "terminada") {
        const input = nativo.hijo?.stdin;
        if (!input) throw new Error("Terminal no disponible");
        if (typeof brief !== "string" || !brief.trim())
          throw new Error("Encargo vacío");
        await registro.actualizar(id, { estado: "trabajando", error: null });
        await marcar(id, brief);
        input.write(JSON.stringify({ texto: brief }) + "\n");
        return registro.leer().find((s) => s.id === id);
      }
      if (
        !sesion?.conversacionId ||
        sesion.origen === "remote" ||
        !["claude", "agy"].includes(sesion.motor) ||
        (!sesion.directorio &&
          !Object.hasOwn(proyectos, String(sesion.proyecto)))
      )
        throw new Error("Conversación no disponible");
      if (activos.has(id)) throw new Error("Límite de sesiones activas");
      await asegurarCupo(id);
      if (typeof brief !== "string" || !brief.trim())
        throw new Error("Encargo vacío");
      await registro.actualizar(id, { estado: "trabajando", error: null });
      lanzarTrabajo(
        sesion,
        brief,
        sesion.directorio || proyectos[String(sesion.proyecto)],
      );
      return registro.leer().find((s) => s.id === id);
    });
  }
  return {
    /**
     * Source of a harness screen for readers: a live terminal, or the screen
     * saved when the program last exited. `generacion` changes when the
     * program is started again, so readers know to ask for a new snapshot.
     * @param {string} id
     */
    flujo(id) {
      const session = registro.leer().find((s) => s.id === id);
      if (!session?.harness || session.eliminada)
        throw new Error("Terminal no disponible");
      const terminal = terminales.get(id);
      if (terminal)
        return {
          generacion: terminal.generacion,
          activa: () => activos.has(id),
          snapshot: () => terminal.snapshot(),
          /** @param {(event: TerminalEvent) => void} fn */
          suscribir: (fn) => terminal.suscribir(fn),
        };
      return {
        generacion: "persistida",
        activa: () => false,
        snapshot: async () => ({
          datos: session.terminal || "",
          cols: 120,
          rows: 40,
          seq: 0,
        }),
        suscribir: () => () => {},
      };
    },
    /** @param {string} id */
    async terminal(id) {
      const fuente = this.flujo(id);
      return {
        ...(await fuente.snapshot()),
        activa: fuente.activa(),
        generacion: fuente.generacion,
      };
    },
    /**
     * @param {string} id
     * @param {TerminalInput} options
     */
    entrada(id, { raw, texto, cols, rows, controlador, interrumpir }) {
      const job = activos.get(id);
      const session = registro.leer().find((s) => s.id === id);
      const input = job?.hijo?.stdin;
      if (!job?.nativo || !session?.harness || !input?.writable)
        throw new Error("Terminal no disponible");
      /** @param {unknown} valor */
      const escribir = (valor) => input.write(JSON.stringify(valor) + "\n");
      const tamano = cols !== undefined || rows !== undefined;
      if (
        [
          raw !== undefined,
          texto !== undefined,
          tamano,
          interrumpir === true,
        ].filter(Boolean).length !== 1
      )
        throw new Error("Entrada inválida");
      // Every write waits behind a pending checkpoint, so keys never overtake
      // it; with nothing pending a write goes out at once, as it always did.
      /** @param {() => unknown} fn */
      const enCola = (fn, { espera = false } = {}) => {
        if (!espera && !job.pendientes) return fn();
        job.pendientes = (job.pendientes ?? 0) + 1;
        job.cola = (job.cola ?? Promise.resolve())
          .then(fn)
          .catch(() => {
            /* the program exited while the checkpoint was taken */
          })
          .finally(() => job.pendientes--);
      };
      /** @param {string} mensaje */
      const antesDelTurno = (mensaje) => {
        job.ultimoTurno = Date.now();
        return marcar(id, mensaje);
      };
      if (raw !== undefined) {
        if (typeof raw !== "string" || raw.length > 16000)
          throw new Error("Entrada inválida");
        // Enter typed in the Terminal tab while the agent waits starts a turn
        // too. A paste may carry newlines; only a bare Enter submits.
        const suelto = raw.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, "");
        // What was typed, as a label for the turn: escapes dropped, Backspace applied.
        let tecleado = job.tecleado ?? "";
        for (const c of suelto.replace(/\x1b(\[[0-?]*[ -/]*[@-~]|O.|.)/g, ""))
          if (c === "\x7f" || c === "\b") tecleado = tecleado.slice(0, -1);
          else if (c === "\r" || /\P{C}/u.test(c)) tecleado += c;
        tecleado = tecleado.slice(-200);
        const enter = suelto.includes("\r");
        job.tecleado = enter ? "" : tecleado;
        const turno =
          enter &&
          seguimiento &&
          session.estado !== "trabajando" &&
          Date.now() - (job.ultimoTurno ?? 0) > 5000;
        if (turno) {
          const mensaje =
            tecleado.split("\r")[0].trim() || "Turno desde la terminal";
          enCola(
            async () => {
              await antesDelTurno(mensaje);
              escribir({ raw });
            },
            { espera: true },
          );
        } else enCola(() => escribir({ raw }));
      } else if (texto !== undefined) {
        if (typeof texto !== "string" || !texto.trim() || texto.length > 60000)
          throw new Error("Entrada inválida");
        // The checkpoint must exist before the agent can touch a file.
        if (seguimiento)
          enCola(
            async () => {
              await antesDelTurno(texto);
              escribir({ texto });
            },
            { espera: true },
          );
        else enCola(() => escribir({ texto }));
        // A finished turn on a live program starts another one.
        if (session.estado === "terminada")
          registro
            .actualizar(id, { estado: "trabajando", error: null })
            .catch(() => {});
      } else if (interrumpir === true) {
        // Codex reads Esc as "back"; its interrupt is Ctrl+C. The others use Esc.
        escribir({ raw: session.motor === "codex" ? "\u0003" : "\u001b" });
      } else {
        const medida = tamanoPermitido(cols, rows);
        // Phones and secondary windows never decide the screen everybody shares.
        if (controlador !== true) return { ok: true, redimensionada: false };
        escribir(medida);
        terminales.get(id)?.redimensionar(medida.cols, medida.rows);
        return { ok: true, redimensionada: true, ...medida };
      }
      return { ok: true };
    },
    /** @param {string} id */
    eliminar(id) {
      return serial(async () => {
        if (activos.has(id))
          throw new Error("Detén la sesión antes de eliminarla");
        const previa = registro.leer().find((s) => s.id === id);
        if (previa?.structured) {
          limpiarEviccionOciosa(id);
          await conversations?.remove(id);
          await stopSessionScope(id, env).catch(() => {});
          liveProcesses.delete(id);
          await rm(acpGeminiDirFor(id), { recursive: true, force: true }).catch(
            () => {},
          );
        }
        await cleanupSessionRuntimeSecrets(id);
        const resultado = await registro.eliminar(id);
        terminales.delete(id);
        await limpiarWorkspaceMiembro(previa);
        if (seguimiento && previa)
          await seguimiento
            .borrar(id, previa.directorio || proyectos[String(previa.proyecto)])
            .catch(() => {});
        return resultado;
      });
    },
    continuar,
    activos: () => sesionesOcupandoCupo().size,
    conexionesActivas: () => conversations?.liveSessions?.() ?? [],
    /**
     * @param {string} id
     * @param {string} [reason]
     */
    cerrarConexion: (id, reason) => serial(() => cerrarConexion(id, reason)),
    cerrarTodo,
    /**
     * @param {string} id
     * @param {{ clientMessageId?: string, text?: string, mode?: string, attachments?: any[] }} [message]
     */
    async enviarMensaje(
      id,
      { clientMessageId, text = "", mode = "send", attachments = [] } = {},
    ) {
      if (!conversations) {
        throw new ErrorLanzador("Integración estructurada no instalada.", 503);
      }
      const sesion = registro.leer().find((s) => s.id === id && !s.eliminada);
      if (!sesion) throw new ErrorLanzador("Sesión inexistente.", 404);
      if (!sesion.structured) {
        throw new ErrorLanzador(
          "La sesión no admite mensajería estructurada.",
          409,
        );
      }
      const validatedAttachments = validarAdjuntosMotor(
        sesion.motor,
        attachments,
        sesion.directorio || "",
      );
      const isWorking = activos.has(id);
      if (isWorking) {
        const accepted = await conversations.sendMessage(id, {
          clientMessageId,
          text,
          mode,
          attachments: validatedAttachments,
          online: true,
          queueIfIdle: true,
        });
        // The turn may have ended while the message was being queued.
        if (accepted.queued) await drenarCola(id);
        return accepted;
      }
      if (mode === "queue") {
        return conversations.sendMessage(id, {
          clientMessageId,
          text,
          mode: "queue",
          attachments: validatedAttachments,
          online: false,
        });
      }
      const accepted = await conversations.sendMessage(id, {
        clientMessageId,
        text,
        mode: "send",
        attachments: validatedAttachments,
        online: true,
      });
      if (accepted.repetido) return accepted;
      const command = accepted.command;
      if (!command) throw new Error("No se pudo aceptar el mensaje.");
      if (!sesion.conversacionId) {
        await conversations.markCommandDelivery(
          id,
          command.id,
          "entrega_incierta",
          "Falta identificador nativo de sesión para continuar.",
        );
        return {
          ...accepted,
          command: { ...command, deliveryStatus: "entrega_incierta" },
        };
      }
      await continuar(id, command.text, {
        attachments: command.attachments,
        commandId: command.id,
      });
      const updatedCmd = await conversations.markCommandDelivery(
        id,
        command.id,
        "entregado",
      );
      return { ...accepted, command: updatedCmd, started: true };
    },
    /** @param {string} id */
    listarCola: (id) => {
      if (!conversations) {
        throw new ErrorLanzador("Integración estructurada no instalada.", 503);
      }
      return conversations.listQueue(id);
    },
    /**
     * @param {string} id
     * @param {string} clientMessageId
     */
    cancelarCola: (id, clientMessageId) => {
      if (!conversations) {
        throw new ErrorLanzador("Integración estructurada no instalada.", 503);
      }
      return conversations.cancelQueuedMessage(id, clientMessageId);
    },
    /** @param {ExecutionRequest} input */
    encargar({
      id = null,
      motor,
      origen,
      proyecto,
      brief,
      modelo,
      esfuerzo,
      espacioId,
      harness,
      structured,
      workOrderId,
      memberId,
      role,
      responsibility,
      manifest,
      manifestSha256,
      toolProfileId,
      effectiveProfile = null,
      skillIds = null,
      capabilityToken = null,
      billingGrantVerified = false,
      billingAuthorized: _ignoredClientBilling = false,
      enqueueIfFull,
      attachments,
    }) {
      return serial(() =>
        iniciar({
          id,
          motor,
          origen,
          proyecto,
          brief,
          modelo,
          esfuerzo,
          espacioId,
          harness,
          structured,
          workOrderId,
          memberId,
          role,
          responsibility,
          manifest,
          manifestSha256,
          toolProfileId,
          effectiveProfile,
          skillIds,
          capabilityToken,
          billingGrantVerified: billingGrantVerified === true,
          enqueueIfFull,
          attachments,
        }),
      );
    },
    /**
     * @param {string} padreId
     * @param {Omit<ExecutionRequest, "origen">} input
     */
    encargarHija(
      padreId,
      {
        id = null,
        motor,
        proyecto,
        brief,
        modelo,
        esfuerzo,
        toolProfileId = null,
        effectiveProfile = null,
        skillIds = null,
        capabilityToken = null,
        // A child never brings its own billing grant; it inherits the verified
        // grant of the session the owner started (see childBillingGrant below).
        billingGrantVerified: _ignoredChildGrant = false,
        memberId = null,
        role = null,
        responsibility = null,
        workOrderId = null,
        manifest = null,
        manifestSha256 = null,
        requestId = null,
        enqueueIfFull = true,
        isolateWorkspace = false,
      },
    ) {
      return serial(async () => {
        if (!equipos) throw new Error("Equipos no disponibles");
        const padre = registro.leer().find((s) => s.id === padreId);
        if (!padre || !activos.has(padreId))
          throw new Error("Sesión padre no activa");

        if (requestId) {
          const miembroPrevio = equipos.buscarPorRequestId?.(
            padreId,
            requestId,
          );
          if (miembroPrevio) {
            const sesionPrevia = registro
              .leer()
              .find((s) => s.id === miembroPrevio.id && !s.eliminada);
            if (sesionPrevia) {
              return { ...sesionPrevia, repetido: true };
            }
          }
        }

        if (
          workOrderId &&
          padre.workOrderId &&
          workOrderId !== padre.workOrderId
        ) {
          throw new ErrorLanzador(
            "La integrante no puede encargar trabajo de otro encargo.",
            403,
          );
        }

        let equipo;
        if (padre.equipoId) {
          equipo = equipos.estado(padreId);
        } else {
          equipo = await equipos.crear(padreId, {
            workOrderId: workOrderId || padre.workOrderId || null,
            manifest,
            manifestSha256: manifestSha256 || padre.manifestSha256 || null,
            motor: padre.motor,
            memberId: padre.memberId || null,
            role: padre.role || null,
            responsibility: padre.responsibility || null,
            modelo: padre.modelo || null,
            esfuerzo: padre.esfuerzo || null,
            toolProfileId: padre.toolProfileId || null,
            workspacePath: padre.workspacePath || padre.directorio || null,
            workspaceKind: padre.workspaceKind || "shared",
            directorioIntegracion: padre.directorio || null,
          });
          await registro.vincularEquipo(padreId, equipo.id);
        }

        const comprobacion = equipos.comprobar(padreId, motor, {
          memberId,
          role,
          responsibility,
          modelo,
          esfuerzo,
          toolProfileId,
          manifest: manifest || equipo.manifest || null,
          manifestSha256: manifestSha256 || padre.manifestSha256 || null,
          requestId,
        });
        const resolved = comprobacion?.resolved || {
          motor,
          memberId,
          role,
          responsibility,
          modelo,
          esfuerzo,
          toolProfileId,
          manifestSha256: manifestSha256 || padre.manifestSha256 || null,
        };

        const hasManifestOrStructured = Boolean(
          padre.structured ||
          manifest ||
          equipo.manifest ||
          workOrderId ||
          padre.workOrderId,
        );
        // Billing authorization is inherited from the session the user
        // started; an agent cannot grant it to itself through equipo_encargar.
        const childBillingGrant =
          (sessionBillingGrants.has(padreId)
            ? sessionBillingGrants.get(padreId) === true
            : padre.billingAuthorized === true) ||
          env.SB_ALLOW_BILLED_DEEPSEEK === "1";
        // Work orders follow the spending policy: billed DeepSeek needs explicit authorization.
        // Legacy delegation keeps its balance check unchanged.
        if (motor === "deepseek") {
          if (hasManifestOrStructured) {
            if (!childBillingGrant)
              throw new ErrorLanzador(
                "DeepSeek bloqueado por la política de gasto sin autorización explícita de gasto.",
                403,
              );
          } else if ((await consultarSaldo()) < 0.2) {
            throw new Error("Saldo DeepSeek insuficiente");
          }
        }

        const parentProfile = resolveSessionEffectiveProfile(padre);
        const requestedProfileId =
          padre.toolProfileId === "investigacion"
            ? "investigacion"
            : resolved.toolProfileId || padre.toolProfileId || "investigacion";
        const baseChildProfile =
          toolCatalog?.getProfile(requestedProfileId) ||
          TOOL_PROFILES_BASE[requestedProfileId] ||
          TOOL_PROFILES_BASE.investigacion;
        const candidateChild =
          effectiveProfile && typeof effectiveProfile === "object"
            ? narrowChildProfile(baseChildProfile, effectiveProfile)
            : structuredClone(baseChildProfile);
        const childEffectiveProfile = narrowChildProfile(
          parentProfile,
          candidateChild,
        );
        return iniciar({
          id,
          motor,
          origen: "equipo",
          proyecto: proyecto || padre.proyecto,
          espacioId: proyecto ? null : padre.espacioId,
          contextoHeredado:
            !proyecto && padre.directorio
              ? { cwd: padre.directorio, repositorio: padre.proyecto }
              : null,
          brief,
          modelo: resolved.modelo ?? null,
          esfuerzo: resolved.esfuerzo ?? null,
          structured: padre.structured === true,
          workOrderId:
            padre.workOrderId || equipo.workOrderId || workOrderId || null,
          memberId: resolved.memberId || null,
          role: resolved.role || null,
          responsibility: resolved.responsibility || null,
          manifest: manifest || equipo.manifest || null,
          manifestSha256: resolved.manifestSha256 || null,
          requestId,
          toolProfileId: childEffectiveProfile.id,
          effectiveProfile: childEffectiveProfile,
          skillIds,
          capabilityToken,
          billingGrantVerified: childBillingGrant,
          enqueueIfFull: enqueueIfFull !== false,
          isolateWorkspace: Boolean(
            isolateWorkspace ||
            manifest ||
            equipo.manifest ||
            workOrderId ||
            padre.workOrderId ||
            memberId,
          ),
          equipoId: equipo.id,
          padreId,
        });
      });
    },
    /** @param {string} id */
    async cancelar(id, { shutdown = false, reason = "Cierre explícito" } = {}) {
      const queuedIndex = resourceQueue.findIndex(
        (item) => item.sesionId === id,
      );
      if (queuedIndex !== -1) {
        resourceQueue.splice(queuedIndex, 1);
        await registro.actualizar(id, {
          estado: "cancelada",
          enColaRecursos: false,
          motivoCola: null,
        });
        const pq = queuedPromises.get(id);
        if (pq) {
          queuedPromises.delete(id);
          pq.resolve();
        }
        return;
      }
      const sesion = registro.leer().find((s) => s.id === id && !s.eliminada);
      const job = activos.get(id);
      if (!job) {
        if (sesion?.structured && conversations?.hasLiveController?.(id)) {
          return cerrarConexion(id, reason);
        }
        throw new Error("Sesión no activa");
      }
      job.cancelada = true;
      if (job.cleanupFailed) {
        await liberar(id);
        return;
      }
      if (
        sesion?.structured &&
        conversations?.hasLiveController?.(id) &&
        !shutdown
      ) {
        conversations.abort(id);
        return;
      }
      conversations?.abort(id);
      if (sesion?.structured && shutdown) {
        await conversations?.shutdown?.(id, { reason });
      }
      if (job.hijo) {
        senalar(job.hijo, "SIGTERM");
        const reloj = setTimeout(() => {
          if (activos.has(id) && job.hijo) senalar(job.hijo, "SIGKILL");
        }, 5000);
        reloj.unref();
      }
    },
    /**
     * @param {string} padreId
     * @param {string} hijaId
     */
    async esperarHija(padreId, hijaId, timeout = 300000) {
      const hija = registro
        .leer()
        .find((s) => s.id === hijaId && s.padreId === padreId);
      if (!hija) throw new Error("Sesión hija inexistente");
      if (!Number.isFinite(timeout) || timeout < 0 || timeout > 1800000)
        throw new Error("Tiempo de espera inválido");
      const trabajo =
        activos.get(hijaId)?.promesa || queuedPromises.get(hijaId)?.promise;
      if (trabajo) {
        let reloj;
        await Promise.race([
          trabajo,
          new Promise((resolve) => {
            reloj = setTimeout(resolve, timeout);
          }),
        ]);
        clearTimeout(reloj);
      }
      const actual = registro.leer().find((s) => s.id === hijaId);
      if (!actual) throw new Error("Sesión hija inexistente");
      return ["pendiente", "trabajando"].includes(actual.estado)
        ? { id: hijaId, estado: "pendiente" }
        : actual;
    },
    /** @param {string} id */
    esperar(id) {
      return (
        activos.get(id)?.promesa ||
        queuedPromises.get(id)?.promise ||
        Promise.resolve()
      );
    },
  };
}
