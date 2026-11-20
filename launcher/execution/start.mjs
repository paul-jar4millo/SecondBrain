// Starts a session: validates the request, prepares its workspace and token,
// and launches its first turn or queues it until a process slot frees up.
import path from "node:path";
import { LauncherError } from "../errors.mjs";
import { validateEngineAttachments } from "../engines.mjs";
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
  const {
    env,
    equipos: teams,
    espacios: spaces,
    proyectos: projects,
    registro: registry,
    toolCatalog,
  } = config;
  const {
    queuedPromises,
    resourceQueue,
    sessionBillingGrants,
    sessionProfiles,
    takeEnqueueSeq,
  } = state;
  const {
    asegurarCupo: ensureSlot,
    cleanupSessionRuntimeSecrets,
    copiarEntradasProyecto: copyProjectEntries,
    limpiarWorkspaceMiembro: cleanMemberWorkspace,
    writeSessionTokenFile,
    lanzarTrabajo: launchWork,
  } = deps;
  /** @param {ExecutionRequest} input */
  async function start({
    id = null,
    motor,
    origen: origin,
    proyecto: project,
    brief,
    modelo = null,
    esfuerzo = null,
    equipoId: teamId = null,
    padreId: parentId = null,
    espacioId: spaceId = null,
    harness = false,
    structured = false,
    contextoHeredado: inheritedContext = null,
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
      (structured || origin !== "equipo" || workOrderId || manifest) &&
      motor === "deepseek" &&
      !verifiedGrant
    ) {
      throw new LauncherError(
        "DeepSeek bloqueado por la política de gasto sin autorización explícita de gasto.",
        403,
      );
    }
    /** @type {import("../types.d.ts").ExecutionContext | null} */
    let context =
      inheritedContext ||
      (spaceId && spaces ? await spaces.resolver(spaceId) : null);
    const projectKey = String(project);
    if (!context && !Object.hasOwn(projects, projectKey))
      throw new Error("Proyecto desconocido");
    if (typeof brief !== "string" || !brief.trim())
      throw new Error("Encargo vacío");
    let resolvedMemberId = memberId;
    let resolvedRole = role;
    let resolvedResponsibility = responsibility;
    let resolvedModel = modelo;
    let resolvedEffort = esfuerzo;
    let resolvedToolProfileId = toolProfileId;
    let resolvedManifestSha256 = manifestSha256 || manifest?.sha256 || null;

    if (!parentId && manifest && Array.isArray(manifest.team)) {
      const card =
        manifest.team.find(
          (c) =>
            c.assigned !== false &&
            (memberId ? c.id === memberId : c.coordinator),
        ) || null;
      if (!card) {
        throw new LauncherError(
          "Integrante fuera del manifiesto aprobado.",
          403,
        );
      }
      if ((card.motor || card.engine) !== motor) {
        throw new LauncherError(
          "El manifiesto del encargo no permite cambiar el motor de esta integrante.",
          409,
        );
      }
      if (card.model && modelo && modelo !== card.model) {
        throw new LauncherError(
          "El manifiesto del encargo fija el modelo de esta integrante y no permite cambiarlo sin editar el equipo.",
          409,
        );
      }
      if (card.effort && esfuerzo && esfuerzo !== card.effort) {
        throw new LauncherError(
          "El manifiesto del encargo fija el esfuerzo de esta integrante y no permite cambiarlo sin editar el equipo.",
          409,
        );
      }
      resolvedMemberId = resolvedMemberId || card.id || null;
      resolvedRole = resolvedRole || card.role || null;
      resolvedResponsibility =
        resolvedResponsibility || card.responsibility || null;
      resolvedModel = resolvedModel || card.model || null;
      resolvedEffort = resolvedEffort || card.effort || null;
      resolvedToolProfileId =
        resolvedToolProfileId || card.toolProfileId || null;
    }

    let queueSlot = false;
    try {
      await ensureSlot(null);
    } catch (error) {
      if (!enqueueIfFull) throw error;
      queueSlot = true;
    }

    const targetCwd = context?.cwd || projects[projectKey];
    const validatedAttachments = structured
      ? validateEngineAttachments(motor, attachments, targetCwd)
      : [];
    const isolateChild = Boolean(
      parentId &&
      (structured || workOrderId || memberId || manifest || isolateWorkspace),
    );
    let workspaceKind = "shared";
    let workspacePath = targetCwd;
    if (isolateChild) {
      const base = targetCwd;
      const scopeFolder = String(teamId || workOrderId || "solo").replace(
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
        await copyProjectEntries(base, isolated);
        workspaceKind = "directory";
      }
      workspacePath = isolated;
      context = {
        cwd: isolated,
        repositorio: context?.repositorio || project,
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
    const session = await registry.crear({
      id,
      motor,
      origen: origin,
      equipoId: teamId,
      padreId: parentId,
      proyecto: (context ? context.repositorio : project) ?? undefined,
      encargo: brief,
      modelo: resolvedModel,
      esfuerzo: resolvedEffort,
      espacioId: spaceId,
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
        (project ? projects[project] : undefined),
    });
    if (resolvedProfile) sessionProfiles.set(session.id, resolvedProfile);
    sessionBillingGrants.set(session.id, billingGrantVerified === true);
    if (capabilityToken) {
      await writeSessionTokenFile(session.id, capabilityToken);
    }
    if (parentId) {
      try {
        if (!teams || !teamId) throw new Error("Equipos no disponibles");
        await teams.agregar(teamId, parentId, session.id, motor, {
          memberId: resolvedMemberId,
          role: resolvedRole,
          responsibility: resolvedResponsibility,
          modelo: resolvedModel,
          esfuerzo: resolvedEffort,
          toolProfileId: resolvedToolProfileId,
          workOrderId,
          manifest,
          manifestSha256: resolvedManifestSha256,
          requestId,
          workspacePath,
          workspaceKind,
        });
      } catch (error) {
        await cleanupSessionRuntimeSecrets(session.id);
        await registry.actualizar(session.id, {
          estado: "error",
          enColaRecursos: false,
          error: "No se pudo unir al equipo.",
        });
        await cleanMemberWorkspace(session);
        throw error;
      }
    } else if (teams && (manifest || workOrderId)) {
      try {
        const leadTeam = await teams.crear(session.id, {
          workOrderId,
          manifest,
          manifestSha256: resolvedManifestSha256,
          motor,
          memberId: resolvedMemberId,
          role: resolvedRole,
          responsibility: resolvedResponsibility,
          modelo: resolvedModel,
          esfuerzo: resolvedEffort,
          toolProfileId: resolvedToolProfileId,
          workspacePath,
          workspaceKind,
          directorioIntegracion: targetCwd,
        });
        await registry.vincularEquipo(session.id, leadTeam.id);
      } catch (error) {
        await cleanupSessionRuntimeSecrets(session.id);
        await registry.actualizar(session.id, {
          estado: "error",
          enColaRecursos: false,
          error: "No se pudo inicializar el equipo del encargo.",
        });
        throw error;
      }
    }
    const cwdFinal = context?.cwd || projects[projectKey];
    if (queueSlot) {
      /** @type {() => void} */
      let resolvePromise = () => {};
      /** @type {Promise<void>} */
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      queuedPromises.set(session.id, { promise, resolve: resolvePromise });
      resourceQueue.push({
        sesionId: session.id,
        brief,
        cwd: cwdFinal,
        attachments: validatedAttachments,
        commandId: null,
      });
      return registry.leer().find((s) => s.id === session.id) || session;
    }
    await registry.actualizar(session.id, { estado: "trabajando" });
    launchWork(session, brief, cwdFinal, {
      attachments: validatedAttachments,
    });
    return registry.leer().find((s) => s.id === session.id) || session;
  }
  return {
    iniciar: start,
  };
}
