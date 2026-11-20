// Starts a session: validates the request, prepares its workspace and token,
// and launches its first turn or queues it until a process slot frees up.
import path from "node:path";
import { ErrorLanzador } from "../errors.mjs";
import { validarAdjuntosMotor } from "../engines.mjs";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { runFile } from "./process-tools.mjs";
import { TOOL_PROFILES_BASE, narrowChildProfile } from "../tool-catalog.mjs";
/** @import { ExecutionRequest, TurnOptions } from "../types.d.ts" */
/** @import { LauncherSession } from "../session-types.d.ts" */
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {Pick<ReturnType<typeof import("./capacity.mjs").createCapacity>, "asegurarCupo"> &
 *   Pick<ReturnType<typeof import("./process-tools.mjs").createProcessTools>, "copiarEntradasProyecto" | "limpiarWorkspaceMiembro"> &
 *   Pick<ReturnType<typeof import("./secrets.mjs").createSessionSecrets>, "cleanupSessionRuntimeSecrets" | "writeSessionTokenFile"> &
 *   { lanzarTrabajo: (sesion: LauncherSession, brief: string, cwd: string, turnOptions?: TurnOptions) => void }} deps
 */
export function createStarter(config, state, deps) {
  const { env, equipos, espacios, proyectos, registro, toolCatalog } = config;
  const {
    queuedPromises,
    resourceQueue,
    sessionBillingGrants,
    sessionProfiles,
    takeEnqueueSeq,
  } = state;
  const {
    asegurarCupo,
    cleanupSessionRuntimeSecrets,
    copiarEntradasProyecto,
    limpiarWorkspaceMiembro,
    writeSessionTokenFile,
    lanzarTrabajo,
  } = deps;
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
    /** @type {import("../types.d.ts").ExecutionContext | null} */
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
  return {
    iniciar,
  };
}
