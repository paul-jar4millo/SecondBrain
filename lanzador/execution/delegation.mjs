// Team delegation: a coordinator assigns a member from the approved manifest
// or starts a child session, and waits for it.
import { ErrorLanzador } from "../errores.mjs";
import {
  TOOL_PROFILES_BASE,
  narrowChildProfile,
} from "../catalogo-herramientas.mjs";
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
  const { consultarSaldo, env, equipos, registro, toolCatalog } = config;
  const { activos, queuedPromises, serial, sessionBillingGrants } = state;
  const { iniciar, resolveSessionEffectiveProfile } = deps;
  /** @param {ExecutionRequest} input */
  function encargar({
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
  }
  /**
   * @param {string} padreId
   * @param {Omit<ExecutionRequest, "origen">} input
   */
  function encargarHija(
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
        const miembroPrevio = equipos.buscarPorRequestId?.(padreId, requestId);
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
  }
  /**
   * @param {string} padreId
   * @param {string} hijaId
   */
  async function esperarHija(padreId, hijaId, timeout = 300000) {
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
  }
  return {
    encargar,
    encargarHija,
    esperarHija,
  };
}
