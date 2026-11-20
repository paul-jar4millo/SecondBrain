// Team delegation: a coordinator assigns a member from the approved manifest
// or starts a child session, and waits for it.
import { LauncherError } from "../errors.mjs";
import { TOOL_PROFILES_BASE, narrowChildProfile } from "../tool-catalog.mjs";
/** @import { ExecutionRequest } from "../types.d.ts" */
/** @import { ExecutorConfig } from "./options.mjs" */
/** @import { ExecutionState } from "./state.mjs" */

/**
 * @param {ExecutorConfig} config
 * @param {ExecutionState} state
 * @param {Pick<ReturnType<typeof import("./start.mjs").createStarter>, "iniciar"> &
 *   Pick<ReturnType<typeof import("./secrets.mjs").createSessionSecrets>, "resolveSessionEffectiveProfile">} deps
 */
export function createDelegation(config, state, deps) {
  const {
    consultarSaldo: queryBalance,
    env,
    equipos: teams,
    registro: registry,
    toolCatalog,
  } = config;
  const {
    activos: active,
    queuedPromises,
    serial,
    sessionBillingGrants,
  } = state;
  const { iniciar, resolveSessionEffectiveProfile } = deps;
  /** @param {ExecutionRequest} input */
  function delegate({
    id = null,
    motor: engine,
    origen: origin,
    proyecto: project,
    brief,
    modelo: model,
    esfuerzo: effort,
    espacioId: spaceId,
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
        motor: engine,
        origen: origin,
        proyecto: project,
        brief,
        modelo: model,
        esfuerzo: effort,
        espacioId: spaceId,
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
  }
  /**
   * @param {string} parentId
   * @param {Omit<ExecutionRequest, "origen">} input
   */
  function delegateChild(
    parentId,
    {
      id = null,
      motor: engine,
      proyecto: project,
      brief,
      modelo: model,
      esfuerzo: effort,
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
      if (!teams) throw new Error("Equipos no disponibles");
      const parent = registry.leer().find((s) => s.id === parentId);
      if (!parent || !active.has(parentId))
        throw new Error("Sesión padre no activa");

      if (requestId) {
        const previousMember = teams.buscarPorRequestId?.(parentId, requestId);
        if (previousMember) {
          const previousSession = registry
            .leer()
            .find((s) => s.id === previousMember.id && !s.eliminada);
          if (previousSession) {
            return { ...previousSession, repetido: true };
          }
        }
      }

      if (
        workOrderId &&
        parent.workOrderId &&
        workOrderId !== parent.workOrderId
      ) {
        throw new LauncherError(
          "La integrante no puede encargar trabajo de otro encargo.",
          403,
        );
      }

      let team;
      if (parent.equipoId) {
        team = teams.estado(parentId);
      } else {
        team = await teams.crear(parentId, {
          workOrderId: workOrderId || parent.workOrderId || null,
          manifest,
          manifestSha256: manifestSha256 || parent.manifestSha256 || null,
          motor: parent.motor,
          memberId: parent.memberId || null,
          role: parent.role || null,
          responsibility: parent.responsibility || null,
          modelo: parent.modelo || null,
          esfuerzo: parent.esfuerzo || null,
          toolProfileId: parent.toolProfileId || null,
          workspacePath: parent.workspacePath || parent.directorio || null,
          workspaceKind: parent.workspaceKind || "shared",
          directorioIntegracion: parent.directorio || null,
        });
        await registry.vincularEquipo(parentId, team.id);
      }

      const comprobacion = teams.comprobar(parentId, engine, {
        memberId,
        role,
        responsibility,
        modelo: model,
        esfuerzo: effort,
        toolProfileId,
        manifest: manifest || team.manifest || null,
        manifestSha256: manifestSha256 || parent.manifestSha256 || null,
        requestId,
      });
      const resolved = comprobacion?.resolved || {
        motor: engine,
        memberId,
        role,
        responsibility,
        modelo: model,
        esfuerzo: effort,
        toolProfileId,
        manifestSha256: manifestSha256 || parent.manifestSha256 || null,
      };

      const hasManifestOrStructured = Boolean(
        parent.structured ||
        manifest ||
        team.manifest ||
        workOrderId ||
        parent.workOrderId,
      );
      // Billing authorization is inherited from the session the user
      // started; an agent cannot grant it to itself through equipo_encargar.
      const childBillingGrant =
        (sessionBillingGrants.has(parentId)
          ? sessionBillingGrants.get(parentId) === true
          : parent.billingAuthorized === true) ||
        env.SB_ALLOW_BILLED_DEEPSEEK === "1";
      // Work orders follow the spending policy: billed DeepSeek needs explicit authorization.
      // Legacy delegation keeps its balance check unchanged.
      if (engine === "deepseek") {
        if (hasManifestOrStructured) {
          if (!childBillingGrant)
            throw new LauncherError(
              "DeepSeek bloqueado por la política de gasto sin autorización explícita de gasto.",
              403,
            );
        } else if ((await queryBalance()) < 0.2) {
          throw new Error("Saldo DeepSeek insuficiente");
        }
      }

      const parentProfile = resolveSessionEffectiveProfile(parent);
      const requestedProfileId =
        parent.toolProfileId === "investigacion"
          ? "investigacion"
          : resolved.toolProfileId || parent.toolProfileId || "investigacion";
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
        motor: engine,
        origen: "equipo",
        proyecto: project || parent.proyecto,
        espacioId: project ? null : parent.espacioId,
        contextoHeredado:
          !project && parent.directorio
            ? { cwd: parent.directorio, repositorio: parent.proyecto }
            : null,
        brief,
        modelo: resolved.modelo ?? null,
        esfuerzo: resolved.esfuerzo ?? null,
        structured: parent.structured === true,
        workOrderId:
          parent.workOrderId || team.workOrderId || workOrderId || null,
        memberId: resolved.memberId || null,
        role: resolved.role || null,
        responsibility: resolved.responsibility || null,
        manifest: manifest || team.manifest || null,
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
          team.manifest ||
          workOrderId ||
          parent.workOrderId ||
          memberId,
        ),
        equipoId: team.id,
        padreId: parentId,
      });
    });
  }
  /**
   * @param {string} parentId
   * @param {string} childId
   */
  async function waitChild(parentId, childId, timeout = 300000) {
    const child = registry
      .leer()
      .find((s) => s.id === childId && s.padreId === parentId);
    if (!child) throw new Error("Sesión hija inexistente");
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 1800000)
      throw new Error("Tiempo de espera inválido");
    const work =
      active.get(childId)?.promesa || queuedPromises.get(childId)?.promise;
    if (work) {
      let clock;
      await Promise.race([
        work,
        new Promise((resolve) => {
          clock = setTimeout(resolve, timeout);
        }),
      ]);
      clearTimeout(clock);
    }
    const actual = registry.leer().find((s) => s.id === childId);
    if (!actual) throw new Error("Sesión hija inexistente");
    return ["pendiente", "trabajando"].includes(actual.estado)
      ? { id: childId, estado: "pendiente" }
      : actual;
  }
  return {
    encargar: delegate,
    encargarHija: delegateChild,
    esperarHija: waitChild,
  };
}
