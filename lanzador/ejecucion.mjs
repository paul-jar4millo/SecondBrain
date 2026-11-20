import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import {
  comandoMotor,
  entornoDe,
  leerClaude,
  leerGemini,
  nuevoClaude,
  actividadEvento,
  entornoEsfuerzo,
  saldoDeepSeek,
  validarAdjuntosMotor,
} from "./motores.mjs";
import {
  buildMcpConfigForProfile,
  narrowChildProfile,
  TOOL_PROFILES_BASE,
} from "./catalogo-herramientas.mjs";
import { prepararAgy, prepararClaude } from "./claude-config.mjs";
import { inferirFase } from "./fases.mjs";
import { fileURLToPath } from "node:url";
import { comandoRemoto } from "./remote.mjs";
import { comandoHarness, crearTerminal, tamanoPermitido } from "./harness.mjs";
import { ocultarDiagnostico } from "./diagnostico.mjs";
import { sessionCommand, stopSessionScope } from "./limits.mjs";
import { ErrorLanzador } from "./errores.mjs";

// Bound the terminal replay kept in each session's detail file.
const PERSISTIDO = 500;
const runFile = promisify(execFile);

const SESION_MAX_MIN = 240;
function minutosConfigurados(valor, predeterminado) {
  const minutos = Number(valor);
  return (
    (Number.isFinite(minutos) && minutos > 0 ? minutos : predeterminado) * 60000
  );
}

export function crearEjecutor({
  registro,
  equipos,
  proyectos,
  espacios,
  env = process.env,
  comando = comandoMotor,
  comandoInteractivo = comandoHarness,
  maxActivos = 6,
  lanzarPty = spawn,
  seguimiento = null,
  conversations = null,
  toolCatalog = null,
  consultarSaldo = () => saldoDeepSeek(env.DEEPSEEK_API_KEY),
  // A silent CLI must not hold a slot forever, including interactive harnesses.
  limiteMs = minutosConfigurados(env.SB_SESION_MAX_MIN, SESION_MAX_MIN),
  inactividadMs = minutosConfigurados(env.SB_SESION_INACTIVIDAD_MIN, 15),
  idleControllerMs = Number(env.SB_CONTROLADOR_OCIOSO_MIN || 0) > 0
    ? minutosConfigurados(env.SB_CONTROLADOR_OCIOSO_MIN, 30)
    : 0,
  programar = setTimeout,
  cancelarTemporizador = clearTimeout,
  registrar = (linea) => console.error(linea),
}) {
  const activos = new Map();
  const terminales = new Map();
  const liveProcesses = new Map();
  const idleTimers = new Map();
  const sessionTokenFiles = new Map();
  const sessionProfiles = new Map();
  const sessionBillingGrants = new Map();
  const materializedSkillCleanups = new Map();
  const materializedSkillsBySession = new Map();
  const resourceQueue = [];
  const queuedPromises = new Map();
  let nextEnqueueSeq = 1;
  let cola = Promise.resolve();
  function serial(fn) {
    const siguiente = cola.then(fn);
    cola = siguiente.catch(() => {});
    return siguiente;
  }
  function sessionTokenDir() {
    const base =
      env.SB_LANZADOR_DATA_DIR || path.join(os.tmpdir(), "sb-lanzador");
    return path.join(base, "session-tokens");
  }
  async function writeSessionTokenFile(sessionId, token) {
    const dir = sessionTokenDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${sessionId}.token`);
    await writeFile(file, String(token), { mode: 0o600 });
    sessionTokenFiles.set(sessionId, file);
    return file;
  }
  async function cleanupSessionRuntimeSecrets(sessionId) {
    const file = sessionTokenFiles.get(sessionId);
    sessionTokenFiles.delete(sessionId);
    sessionProfiles.delete(sessionId);
    sessionBillingGrants.delete(sessionId);
    materializedSkillsBySession.delete(sessionId);
    const cleanupSkills = materializedSkillCleanups.get(sessionId);
    materializedSkillCleanups.delete(sessionId);
    if (cleanupSkills) {
      await cleanupSkills().catch(() => {});
    }
    if (file) {
      await rm(file, { force: true }).catch(() => {});
    }
  }
  function resolveSessionEffectiveProfile(sesion) {
    const baseId = sesion.toolProfileId || "ejecucion";
    const baseCatalogProfile =
      toolCatalog?.getProfile(baseId) ||
      TOOL_PROFILES_BASE[baseId] ||
      TOOL_PROFILES_BASE.ejecucion;
    const override =
      sessionProfiles.get(sesion.id) || sesion.effectiveProfile || null;
    return override
      ? narrowChildProfile(baseCatalogProfile, override)
      : structuredClone(baseCatalogProfile);
  }
  function sanitizeChildEnv(
    baseEnv,
    profile,
    tokenFile,
    billingGranted,
    motor,
  ) {
    const next = { ...baseEnv };
    // Never leak supervisor / wide room tokens into agent environments.
    delete next.AGENTES_TOKEN_FILE;
    delete next.AGENTES_SECRETO;
    if (tokenFile) {
      next.SB_BRAIN_TOKEN_FILE = tokenFile;
      delete next.AGENTES_BRAIN_TOKEN_FILE;
    } else if (!profile?.allowedMcps?.includes("secondbrain")) {
      delete next.SB_BRAIN_TOKEN_FILE;
      delete next.AGENTES_BRAIN_TOKEN_FILE;
    }
    if (!profile?.allowExternalWriteSecrets) {
      for (const key of [
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "RESEND_API_KEY",
        "SMTP_PASS",
        "STRIPE_API_KEY",
      ]) {
        delete next[key];
      }
    }
    if (!(motor === "deepseek" && billingGranted)) {
      delete next.DEEPSEEK_API_KEY;
      delete next.ANTHROPIC_AUTH_TOKEN;
    }
    return next;
  }
  function acpGeminiDirFor(sessionId) {
    const base =
      env.SB_LANZADOR_DATA_DIR || path.join(os.tmpdir(), "sb-lanzador");
    return path.join(base, "acp-runtime", sessionId, "gemini");
  }
  function limpiarEviccionOciosa(id) {
    const timer = idleTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(id);
    }
  }
  function armarEviccionOciosa(id) {
    limpiarEviccionOciosa(id);
    if (!Number.isFinite(idleControllerMs) || idleControllerMs <= 0) return;
    const timer = setTimeout(() => {
      idleTimers.delete(id);
      if (activos.has(id) || !conversations?.hasLiveController?.(id)) return;
      void serial(() =>
        cerrarConexion(id, "Evictada por inactividad", {
          estadoConexion: "evictada",
        }),
      ).catch(() => {});
    }, idleControllerMs);
    timer.unref?.();
    idleTimers.set(id, timer);
  }
  function sesionesOcupandoCupo() {
    const ids = new Set(activos.keys());
    if (conversations?.liveSessions) {
      for (const live of conversations.liveSessions()) {
        ids.add(live.id);
      }
    }
    return ids;
  }
  async function cerrarConexion(
    id,
    reason = "Cierre explícito",
    { estadoConexion = "cerrada" } = {},
  ) {
    limpiarEviccionOciosa(id);
    if (activos.has(id)) {
      throw new ErrorLanzador(
        "Detén la sesión antes de cerrar su conexión.",
        409,
      );
    }
    const closed = await conversations?.shutdown?.(id, { reason });
    await stopSessionScope(id, env).catch(() => {});
    liveProcesses.delete(id);
    const exists = registro.leer().some((s) => s.id === id && !s.eliminada);
    if (exists) {
      await registro
        .actualizar(id, {
          conexion: {
            estado: estadoConexion,
            pid: null,
            motivo: reason,
          },
        })
        .catch(() => {});
    }
    registro.notificar?.();
    return closed || { closed: false, id, pid: null, reason };
  }
  async function evictOneIdle(
    reason = "Evictada por límite de procesos activos",
    excludeIds = [],
  ) {
    if (!conversations?.evictOldestIdle) return null;
    const evicted = await conversations.evictOldestIdle(reason, [
      ...activos.keys(),
      ...excludeIds,
    ]);
    if (!evicted?.closed) return null;
    limpiarEviccionOciosa(evicted.id);
    await stopSessionScope(evicted.id, env).catch(() => {});
    liveProcesses.delete(evicted.id);
    await registro
      .actualizar(evicted.id, {
        conexion: {
          estado: "evictada",
          pid: null,
          motivo: evicted.reason || reason,
        },
      })
      .catch(() => {});
    return evicted;
  }
  async function asegurarCupo(sessionId = null) {
    const ocupadas = sesionesOcupandoCupo();
    if (sessionId && ocupadas.has(sessionId)) return;
    while (sesionesOcupandoCupo().size >= maxActivos) {
      const evicted = await evictOneIdle(
        "Evictada por límite de procesos activos",
        sessionId ? [sessionId] : [],
      );
      if (!evicted) throw new Error("Límite de sesiones activas");
    }
  }
  async function cerrarTodo(reason = "Apagado del lanzador") {
    for (const id of [...idleTimers.keys()]) limpiarEviccionOciosa(id);
    const ids = new Set([
      ...sesionesOcupandoCupo(),
      ...sessionTokenFiles.keys(),
      ...materializedSkillCleanups.keys(),
    ]);
    await conversations?.shutdownAll?.(reason);
    await Promise.allSettled(
      [...ids].map(async (id) => {
        await stopSessionScope(id, env).catch(() => {});
        liveProcesses.delete(id);
        await rm(acpGeminiDirFor(id), { recursive: true, force: true }).catch(
          () => {},
        );
        await cleanupSessionRuntimeSecrets(id);
      }),
    );
  }
  async function copiarEntradasProyecto(src, dst) {
    const srcResolved = path.resolve(src);
    const dstResolved = path.resolve(dst);
    const entries = await readdir(srcResolved, { withFileTypes: true }).catch(
      () => [],
    );
    const skip = new Set([
      ".git",
      ".secondbrain",
      "node_modules",
      "member-workspaces",
    ]);
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const from = path.join(srcResolved, entry.name);
      const to = path.join(dstResolved, entry.name);
      if (dstResolved === from || dstResolved.startsWith(from + path.sep)) {
        continue;
      }
      await cp(from, to, {
        recursive: true,
        filter: (p) => !skip.has(path.basename(p)),
      }).catch(() => {});
    }
  }
  async function limpiarWorkspaceMiembro(sesion) {
    const ws = sesion?.workspacePath;
    if (!ws || !["git-worktree", "directory"].includes(sesion.workspaceKind)) {
      return;
    }
    const resolvedWs = path.resolve(ws);
    if (
      path.basename(path.dirname(path.dirname(resolvedWs))) !==
      "member-workspaces"
    ) {
      return;
    }
    if (sesion.workspaceKind === "git-worktree") {
      let repoRoot = null;
      try {
        const common = await runFile(
          "git",
          ["-C", resolvedWs, "rev-parse", "--git-common-dir"],
          { timeout: 10000 },
        );
        if (common.stdout?.trim()) {
          repoRoot = path.dirname(
            path.resolve(resolvedWs, common.stdout.trim()),
          );
        }
      } catch {
        repoRoot = sesion.proyecto ? proyectos[sesion.proyecto] || null : null;
      }
      if (repoRoot) {
        await runFile(
          "git",
          ["-C", repoRoot, "worktree", "remove", "--force", resolvedWs],
          { timeout: 15000 },
        ).catch(() => {});
        await runFile("git", ["-C", repoRoot, "worktree", "prune"], {
          timeout: 10000,
        }).catch(() => {});
      }
    }
    await rm(resolvedWs, { recursive: true, force: true }).catch(() => {});
    await rmdir(path.dirname(resolvedWs)).catch(() => {});
  }
  registro.setOnPrune?.((sesion) => limpiarWorkspaceMiembro(sesion));
  async function despacharColaRecursos() {
    while (resourceQueue.length > 0) {
      if (sesionesOcupandoCupo().size >= maxActivos) {
        const evicted = await evictOneIdle(
          "Evictada para iniciar una integrante en cola",
        );
        if (!evicted) break;
      }
      const siguiente = resourceQueue.shift();
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
  function senalar(hijo, signal) {
    if (process.platform !== "win32" && hijo.pid) {
      try {
        process.kill(-hijo.pid, signal);
        return;
      } catch {}
    }
    try {
      hijo.kill(signal);
    } catch (error) {
      try {
        registrar(
          JSON.stringify({
            evento: "lanzador.signal",
            senal: signal,
            codigo: error?.code || "UNKNOWN",
          }),
        );
      } catch {}
    }
  }
  // A checkpoint of the working tree precedes every turn; it never blocks one.
  const marcar = (id, texto) =>
    seguimiento ? seguimiento.marcar(id, texto) : Promise.resolve(null);
  // Keep enough overlap to redact a credential or assignment crossing the tail.
  const margenDiagnostico = (brief) =>
    2000 +
    Math.max(
      brief.length,
      ...Object.values(env).map((v) => (typeof v === "string" ? v.length : 0)),
    );
  function diagnosticar(sesion, brief, datos) {
    try {
      registrar(
        JSON.stringify({
          evento: "lanzador.motor",
          sesion: sesion.id,
          motor: sesion.motor,
          ...Object.fromEntries(
            Object.entries(datos).map(([key, value]) => {
              const limpio =
                typeof value === "string"
                  ? ocultarDiagnostico(value, { env, textos: [brief] })
                  : value;
              return [
                key,
                key === "diagnostico" ? limpio.slice(-2000) : limpio,
              ];
            }),
          ),
        }),
      );
    } catch {
      /* Diagnostics never reject a background job. */
    }
  }
  function lanzarTrabajo(sesion, brief, cwd, turnOptions = {}) {
    limpiarEviccionOciosa(sesion.id);
    const job = { hijo: null, cancelada: false, promesa: null };
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
  function vigilar(sesion, hijo) {
    const job = activos.get(sesion.id);
    let escalada;
    let inactivo;
    const actividad = () => {
      cancelarTemporizador(inactivo);
      if (job.inactiva) {
        job.inactiva = false;
        registro
          .actualizar(sesion.id, { ultimaAccion: "Actividad reanudada." })
          .catch(() => {});
      }
      inactivo = programar(() => {
        if (!activos.has(sesion.id) || job.cancelada) return;
        job.inactiva = true;
        registro
          .actualizar(sesion.id, {
            ultimaAccion: "Sin actividad; puedes cancelar la sesión.",
          })
          .catch(() => {});
      }, inactividadMs);
      inactivo?.unref?.();
    };
    actividad();
    hijo.stdout.on("data", actividad);
    hijo.stderr.on("data", actividad);
    const tope = programar(() => {
      if (job.cancelada || !activos.has(sesion.id)) return;
      job.excedida = true;
      senalar(hijo, "SIGTERM");
      escalada = programar(() => {
        if (activos.get(sesion.id) === job) senalar(hijo, "SIGKILL");
      }, 5000);
      escalada?.unref?.();
    }, limiteMs);
    tope?.unref?.();
    const detener = () => {
      for (const reloj of [tope, inactivo, escalada])
        cancelarTemporizador(reloj);
      hijo.stdout.off("data", actividad);
      hijo.stderr.off("data", actividad);
    };
    job.detenerVigilante = detener;
    return detener;
  }
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
      const proveedor =
        { codex: "chatgpt", agy: "gemini" }[sesion.motor] || sesion.motor;
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
      const childEnv = {
        ...baseEnv,
        ...mcpConfig.envOverrides,
      };
      const useAcpIsolation = sesion.motor === "agy" && !env.SB_AGY_ACP_ARGS;
      const geminiDir = useAcpIsolation ? acpGeminiDirFor(sesion.id) : null;
      if (geminiDir) {
        await mkdir(geminiDir, { recursive: true, mode: 0o700 });
      }
      const job = activos.get(sesion.id);
      const existingChild = liveProcesses.get(sesion.id);
      if (
        existingChild &&
        !existingChild._sbExited &&
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
              ? async (obs) => {
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
              child._sbExited = true;
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
          !job.hijo._sbExited &&
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
    const proveedor =
      { codex: "chatgpt", agy: "gemini" }[sesion.motor] || sesion.motor;
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
    const job = activos.get(sesion.id);
    job.hijo = hijo;
    if (job.cancelada) senalar(hijo, "SIGTERM");
    const detenerVigilante = vigilar(sesion, hijo);
    const acumulado = nuevoClaude();
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
                evento.message?.content?.find((c) => c.type === "tool_use")
                  ?.name ||
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
  async function correrRemoto(sesion, brief, cwd) {
    const childEnv = {
      ...entornoDe(
        { agy: "gemini", codex: "chatgpt" }[sesion.motor] || sesion.motor,
        env,
      ),
      ...entornoEsfuerzo(sesion.motor, sesion.esfuerzo),
      SB_SESSION_ID: sesion.id,
      TERM: "xterm-256color",
      ...(sesion.motor === "agy" ? { SB_INITIAL_PROMPT: brief } : {}),
      ...(!sesion.harness && sesion.motor === "agy"
        ? { SB_WAIT_REMOTE: "1" }
        : {}),
      ...(env.SB_HOOK_TOKEN_FILE
        ? { SB_HOOK_TOKEN_FILE: env.SB_HOOK_TOKEN_FILE }
        : {}),
      ...(env.SB_LANZADOR_PORT
        ? { SB_LANZADOR_PORT: env.SB_LANZADOR_PORT }
        : {}),
    };
    const nativeSpec = sesion.harness
      ? comandoInteractivo(sesion, brief, childEnv)
      : comandoRemoto(sesion, brief);
    const spec = sessionCommand(nativeSpec, sesion.id, env);
    if (sesion.harness && ["claude", "deepseek"].includes(sesion.motor))
      await prepararClaude(childEnv.CLAUDE_CONFIG_DIR, cwd, {
        firma:
          sesion.motor === "deepseek" ? "Marina · DeepSeek" : "Ámbar · Claude",
        medir: sesion.motor === "claude",
      }).catch(() => {}); // a first-run dialog is still answerable in the terminal
    if (sesion.motor === "agy")
      await prepararAgy(childEnv.HOME, cwd).catch(() => {});
    const hijo = lanzarPty(
      "python3",
      [
        fileURLToPath(new URL("./terminal.py", import.meta.url)),
        spec.bin,
        ...spec.args,
      ],
      { cwd, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const job = activos.get(sesion.id);
    job.hijo = hijo;
    job.nativo = true;
    if (job.cancelada) senalar(hijo, "SIGTERM");
    const terminal = crearTerminal();
    terminal.generacion = randomUUID();
    if (sesion.terminal) terminal.append(sesion.terminal + "\r\n");
    terminales.set(sesion.id, terminal);
    // Every reader is attached before the first await: output that arrives in
    // between would otherwise reach only the watchdog, and a fast exit would
    // never be seen.
    let pending = "";
    let changes = Promise.resolve();
    // Persisting the replay is not news: telling every client each 10 s would
    // make phones refetch the session list for nothing.
    let guardada = -1;
    const checkpoint = setInterval(() => {
      if (terminal.seq === guardada) return;
      guardada = terminal.seq;
      changes = changes.then(() =>
        registro.actualizar(
          sesion.id,
          { terminal: terminal.serializar(PERSISTIDO) },
          { silencioso: true },
        ),
      );
    }, 10000);
    checkpoint.unref();
    hijo.stdout.setEncoding("utf8");
    hijo.stdout.on("data", (chunk) => {
      terminal.append(chunk);
      pending = (pending + chunk).slice(-32000);
      const url =
        /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/.exec(pending)?.[0] ||
        /https:\/\/antigravity\.google\.com\/r\/[A-Za-z0-9_-]+(?:\?[^\s\x1b]+)?/.exec(
          pending,
        )?.[0];
      if (url && url !== sesion.remotoUrl) {
        sesion.remotoUrl = url;
        changes = changes.then(() =>
          registro.actualizar(sesion.id, { remotoUrl: url }),
        );
      }
      const providerId = /codex resume ([a-f0-9-]{36})/i.exec(pending)?.[1];
      if (providerId && !sesion.conversacionId) {
        sesion.conversacionId = providerId;
        changes = changes.then(() =>
          registro.actualizar(sesion.id, { conversacionId: providerId }),
        );
      }
    });
    // terminal.py's own failures land here; the PTY's output goes to stdout. Without
    // this trail a crash only showed up as an empty terminal.
    let fallo = "";
    hijo.stderr.setEncoding("utf8");
    hijo.stderr.on("data", (chunk) => {
      fallo = (fallo + chunk.toString()).slice(-margenDiagnostico(brief));
    });
    const cierre = new Promise((resolve, reject) => {
      hijo.once("error", reject);
      hijo.once("close", resolve);
    });
    cierre.catch(() => {});
    const detenerVigilante = vigilar(sesion, hijo);
    try {
      await registro.actualizar(sesion.id, {
        interactiva: true,
        ...(["claude", "deepseek"].includes(sesion.motor)
          ? { conversacionId: sesion.conversacionId || sesion.id }
          : {}),
      });
      const codigo = await cierre;
      if (codigo && !job.cancelada)
        diagnosticar(sesion, brief, { codigo, diagnostico: fallo });
      await changes;
      await registro.actualizar(sesion.id, {
        terminal: (await terminal.snapshot()).datos,
        interactiva: false,
        estado: job.cancelada
          ? "cancelada"
          : job.excedida
            ? "error"
            : codigo === 0
              ? "terminada"
              : "error",
        ...(job.excedida
          ? { error: "La sesión superó el tiempo máximo y se canceló." }
          : codigo && !job.cancelada
            ? { error: "La sesión interactiva terminó con error." }
            : {}),
      });
    } catch (error) {
      diagnosticar(sesion, brief, {
        mensaje: error?.message,
        pila: error?.stack,
      });
      await registro.actualizar(sesion.id, {
        interactiva: false,
        estado: "error",
        error: "No se pudo abrir la sesión interactiva.",
      });
    } finally {
      clearInterval(checkpoint);
      detenerVigilante();
    }
  }
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
    let context =
      contextoHeredado ||
      (espacioId && espacios ? await espacios.resolver(espacioId) : null);
    if (!context && !Object.hasOwn(proyectos, proyecto))
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
      resolvedMemberId = resolvedMemberId || card.id;
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

    const targetCwd = context?.cwd || proyectos[proyecto];
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
    const enqueueOrder = queueSlot ? nextEnqueueSeq++ : null;
    const sesion = await registro.crear({
      id,
      motor,
      origen,
      equipoId,
      padreId,
      proyecto: context ? context.repositorio : proyecto,
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
      directorio: workspacePath || context?.cwd || proyectos[proyecto],
    });
    if (resolvedProfile) sessionProfiles.set(sesion.id, resolvedProfile);
    sessionBillingGrants.set(sesion.id, billingGrantVerified === true);
    if (capabilityToken) {
      await writeSessionTokenFile(sesion.id, capabilityToken);
    }
    if (padreId) {
      try {
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
    const cwdFinal = context?.cwd || proyectos[proyecto];
    if (queueSlot) {
      let resolvePromise;
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
  /** Sessions whose next queued message is being started. */
  const drenando = new Set();
  /**
   * Starts the next queued message of an idle structured session. Called when
   * a turn ends and after a message is queued, since either can happen first.
   */
  async function drenarCola(id) {
    if (!conversations || activos.has(id) || drenando.has(id)) return;
    const sesion = registro.leer().find((s) => s.id === id && !s.eliminada);
    if (sesion?.estado !== "terminada" || !sesion.conversacionId) return;
    drenando.add(id);
    try {
      const siguiente = await conversations
        .consumeNextQueuedMessage(id)
        .catch(() => null);
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
        if (typeof brief !== "string" || !brief.trim())
          throw new Error("Encargo vacío");
        await registro.actualizar(id, { estado: "trabajando", error: null });
        await marcar(id, brief);
        nativo.hijo.stdin.write(JSON.stringify({ texto: brief }) + "\n");
        return registro.leer().find((s) => s.id === id);
      }
      if (
        !sesion?.conversacionId ||
        sesion.origen === "remote" ||
        !["claude", "agy"].includes(sesion.motor) ||
        (!sesion.directorio && !Object.hasOwn(proyectos, sesion.proyecto))
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
        sesion.directorio || proyectos[sesion.proyecto],
      );
      return registro.leer().find((s) => s.id === id);
    });
  }
  return {
    /**
     * Source of a harness screen for readers: a live terminal, or the screen
     * saved when the program last exited. `generacion` changes when the
     * program is started again, so readers know to ask for a new snapshot.
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
    async terminal(id) {
      const fuente = this.flujo(id);
      return {
        ...(await fuente.snapshot()),
        activa: fuente.activa(),
        generacion: fuente.generacion,
      };
    },
    entrada(id, { raw, texto, cols, rows, controlador, interrumpir }) {
      const job = activos.get(id);
      const session = registro.leer().find((s) => s.id === id);
      if (!job?.nativo || !session?.harness || !job.hijo?.stdin?.writable)
        throw new Error("Terminal no disponible");
      const escribir = (valor) =>
        job.hijo.stdin.write(JSON.stringify(valor) + "\n");
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
            .borrar(id, previa.directorio || proyectos[previa.proyecto])
            .catch(() => {});
        return resultado;
      });
    },
    continuar,
    activos: () => sesionesOcupandoCupo().size,
    conexionesActivas: () => conversations?.liveSessions?.() ?? [],
    cerrarConexion: (id, reason) => serial(() => cerrarConexion(id, reason)),
    cerrarTodo,
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
      if (!sesion.conversacionId) {
        await conversations.markCommandDelivery(
          id,
          accepted.command.id,
          "entrega_incierta",
          "Falta identificador nativo de sesión para continuar.",
        );
        return {
          ...accepted,
          command: { ...accepted.command, deliveryStatus: "entrega_incierta" },
        };
      }
      await continuar(id, accepted.command.text, {
        attachments: accepted.command.attachments,
        commandId: accepted.command.id,
      });
      const updatedCmd = await conversations.markCommandDelivery(
        id,
        accepted.command.id,
        "entregado",
      );
      return { ...accepted, command: updatedCmd, started: true };
    },
    listarCola: (id) => {
      if (!conversations) {
        throw new ErrorLanzador("Integración estructurada no instalada.", 503);
      }
      return conversations.listQueue(id);
    },
    cancelarCola: (id, clientMessageId) => {
      if (!conversations) {
        throw new ErrorLanzador("Integración estructurada no instalada.", 503);
      }
      return conversations.cancelQueuedMessage(id, clientMessageId);
    },
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
          if (activos.has(id)) senalar(job.hijo, "SIGKILL");
        }, 5000);
        reloj.unref();
      }
    },
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
      return ["pendiente", "trabajando"].includes(actual.estado)
        ? { id: hijaId, estado: "pendiente" }
        : actual;
    },
    esperar(id) {
      return (
        activos.get(id)?.promesa ||
        queuedPromises.get(id)?.promise ||
        Promise.resolve()
      );
    },
  };
}
