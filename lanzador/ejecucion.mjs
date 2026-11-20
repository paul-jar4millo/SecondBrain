import { rm } from "node:fs/promises";

import { validarAdjuntosMotor } from "./motores.mjs";
import {
  narrowChildProfile,
  TOOL_PROFILES_BASE,
} from "./catalogo-herramientas.mjs";

import { stopSessionScope } from "./limits.mjs";
import { ErrorLanzador } from "./errores.mjs";
import { resolveExecutorOptions } from "./execution/options.mjs";
import { createExecutionState } from "./execution/state.mjs";
import { createTerminalIo } from "./execution/terminal-io.mjs";
import { createStarter } from "./execution/start.mjs";
import { createRemoteRunner } from "./execution/run-remote.mjs";
import { createLocalRunner } from "./execution/run-local.mjs";

import { createMonitor } from "./execution/monitor.mjs";
import { createCapacity } from "./execution/capacity.mjs";
import { createSessionSecrets } from "./execution/secrets.mjs";
import { createProcessTools } from "./execution/process-tools.mjs";

/** @import { LauncherSession } from "./session-types.d.ts" */

/** @import { ActiveJob, ExecutionRequest, ExecutorOptions, TurnOptions } from "./types.d.ts" */

/** @param {ExecutorOptions} options */
export function crearEjecutor(options) {
  const config = resolveExecutorOptions(options);
  const {
    registro,
    equipos,
    proyectos,
    env,
    maxActivos,
    seguimiento,
    conversations,
    toolCatalog,
    consultarSaldo,
  } = config;
  const state = createExecutionState();
  const {
    activos,
    terminales,
    liveProcesses,
    sessionBillingGrants,
    resourceQueue,
    queuedPromises,
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
  const { correrRemoto } = createRemoteRunner(config, state, {
    activeJob,
    diagnosticar,
    margenDiagnostico,
    senalar,
    vigilar,
  });
  const { correr } = createLocalRunner(config, state, {
    acpGeminiDirFor,
    activeJob,
    correrRemoto,
    diagnosticar,
    margenDiagnostico,
    resolveSessionEffectiveProfile,
    sanitizeChildEnv,
    senalar,
    vigilar,
  });
  const { iniciar } = createStarter(config, state, {
    lanzarTrabajo,
    asegurarCupo,
    cleanupSessionRuntimeSecrets,
    copiarEntradasProyecto,
    limpiarWorkspaceMiembro,
    writeSessionTokenFile,
  });
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
  const { flujo, terminal, entrada } = createTerminalIo(config, state, {
    marcar,
  });
  return {
    flujo,
    terminal,
    entrada,
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
