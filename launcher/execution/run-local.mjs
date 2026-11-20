// Runs one turn of a session: a structured provider conversation when the engine
// has one, otherwise the engine CLI as a child process.
import { LauncherError } from "../errors.mjs";
import { PROVIDER_BY_ENGINE } from "./process-tools.mjs";
import {
  eventActivity,
  environmentOf,
  effortEnvironment,
  readClaudeEvent,
  readGeminiEvent,
  newClaudeState,
} from "../engines.mjs";
import { buildMcpConfigForProfile } from "../tool-catalog.mjs";
import { mkdir } from "node:fs/promises";
import { sessionCommand } from "../limits.mjs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { inferPhase } from "../phases.mjs";
import { StringDecoder } from "node:string_decoder";
/** @import { LauncherSession } from "../session-types.d.ts" */
/** @import { TurnOptions } from "../types.d.ts" */
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {Pick<ReturnType<typeof import("./secrets.mjs").createSessionSecrets>, "resolveSessionEffectiveProfile"> &
 *   Pick<ReturnType<typeof import("./process-tools.mjs").createProcessTools>, "acpGeminiDirFor" | "diagnosticar" | "margenDiagnostico" | "sanitizeChildEnv" | "senalar"> &
 *   Pick<ReturnType<typeof import("./monitor.mjs").createMonitor>, "activeJob" | "vigilar"> &
 *   Pick<ReturnType<typeof import("./run-remote.mjs").createRemoteRunner>, "correrRemoto">} deps
 */
export function createLocalRunner(config, state, deps) {
  const {
    comando: command,
    conversations,
    env,
    limiteMs: limitMs,
    registro: registry,
    toolCatalog,
  } = config;
  const {
    activos: active,
    exitedProcesses,
    liveProcesses,
    materializedSkillCleanups,
    materializedSkillsBySession,
    sessionBillingGrants,
    sessionTokenFiles,
  } = state;
  const {
    acpGeminiDirFor,
    correrRemoto: runRemote,
    activeJob,
    diagnosticar: diagnose,
    margenDiagnostico: diagnosticMargin,
    resolveSessionEffectiveProfile,
    sanitizeChildEnv,
    senalar,
    vigilar: watch,
  } = deps;
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
        throw new LauncherError(
          "DeepSeek bloqueado por la política de gasto sin autorización explícita de gasto.",
          403,
        );
      }
      const proveedor = PROVIDER_BY_ENGINE[sesion.motor] || sesion.motor;
      const profile = resolveSessionEffectiveProfile(sesion);
      const sessionTokenFile = sessionTokenFiles.get(sesion.id) || null;
      const baseEnv = sanitizeChildEnv(
        {
          ...environmentOf(proveedor, env),
          ...effortEnvironment(sesion.motor, sesion.esfuerzo),
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
        watch(sesion, existingChild);
        await registry
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
          await registry.actualizar(sesion.id, {
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
                      registry.actualizar(sesion.id, {
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
              if (!active.has(sesion.id)) {
                void registry
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
            watch(sesion, child);
            void registry
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
            registry.actualizar(sesion.id, { conversacionId: id }),
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
        await registry.actualizar(sesion.id, {
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
    if (sesion.harness) return runRemote(sesion, brief, cwd);
    if (
      env.SB_REMOTE_INTERACTIVE === "1" &&
      sesion.origen === "sala" &&
      ["claude", "agy"].includes(sesion.motor)
    )
      return runRemote(sesion, brief, cwd);
    const spec = sessionCommand(
      command(sesion.motor, brief, {
        modelo: sesion.modelo,
        esfuerzo: sesion.esfuerzo,
        conversacionId: sesion.conversacionId,
      }),
      sesion.id,
      env,
    );
    const proveedor = PROVIDER_BY_ENGINE[sesion.motor] || sesion.motor;
    const childEnv = {
      ...environmentOf(proveedor, env),
      ...effortEnvironment(sesion.motor, sesion.esfuerzo),
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
    const stopWatcher = watch(sesion, hijo);
    const accumulated = newClaudeState();
    /** @type {Promise<unknown>} */
    let change = Promise.resolve();
    const lines = createInterface({ input: hijo.stdout });
    lines.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (sesion.motor === "claude" || sesion.motor === "deepseek")
        readClaudeEvent(accumulated, event);
      if (sesion.motor === "agy") readGeminiEvent(accumulated, event);
      if (
        accumulated.sessionId &&
        accumulated.sessionId !== sesion.conversacionId
      ) {
        sesion.conversacionId = accumulated.sessionId;
        change = change.then(() =>
          registry.actualizar(sesion.id, {
            conversacionId: accumulated.sessionId,
          }),
        );
      }
      if (
        sesion.motor === "codex" &&
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
      )
        accumulated.texto = String(event.item.text || "");
      const activity = eventActivity(event);
      if (activity)
        change = change.then(() =>
          registry.actualizar(sesion.id, {
            ultimaAccion: activity.etiqueta,
            fase: inferPhase(
              event.item?.type ||
                event.message?.content?.find(
                  /** @param {{type?: string, name?: string}} c */
                  (c) => c.type === "tool_use",
                )?.name ||
                "",
            ),
          }),
        );
    });
    // The engine's own diagnostics stay in the log; they never reach clients.
    let failure = "";
    const decoder = new StringDecoder("utf8");
    hijo.stderr.on("data", (chunk) => {
      failure = (failure + decoder.write(chunk)).slice(
        -diagnosticMargin(brief),
      );
    });
    let codigo;
    try {
      codigo = await new Promise((resolve, reject) => {
        hijo.once("error", reject);
        hijo.once("close", resolve);
      });
      await change;
      if ((codigo !== 0 || accumulated.error) && !job.cancelada)
        diagnose(sesion, brief, { codigo, diagnostico: failure });
      await registry.actualizar(
        sesion.id,
        job.cancelada
          ? { estado: "cancelada" }
          : job.excedida
            ? {
                estado: "error",
                error: `La sesión superó el tiempo máximo de ${Math.round(limitMs / 60000)} minutos y se canceló.`,
              }
            : codigo === 0 && !accumulated.error
              ? {
                  estado: "terminada",
                  resultado: accumulated.texto.slice(0, 100000),
                }
              : { estado: "error", error: "El motor terminó con error." },
      );
    } catch (error) {
      diagnose(sesion, brief, {
        mensaje: error?.message,
        pila: error?.stack,
      });
      await registry.actualizar(sesion.id, {
        estado: job.cancelada ? "cancelada" : "error",
        error: "No se pudo ejecutar el motor.",
      });
    } finally {
      stopWatcher();
    }
  }
  return {
    correr,
  };
}
