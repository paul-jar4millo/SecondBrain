import { DomainError } from "./domain-error.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import {
  appendJsonLine,
  createSerialQueue,
  writeJsonAtomically,
} from "./lib/durable-store.mjs";
import path from "node:path";
import {
  computeOperationFingerprint,
  replayAndRepairJournal,
} from "./user-requests.mjs";

/** @import { Effect, EffectExecutionReceipt, EffectExecutorOptions, EffectInput, EffectJournalRecord } from "./effect-types.d.ts" */

export const EFFECTS_PAYLOAD_VERSION = 1;
export const MAX_EFFECT_CONTENT_LENGTH = 16000;

export const PROTECTED_EFFECT_CATEGORIES = new Set([
  "external_message",
  "job_application",
  "financial_spend",
  "destructive_change",
]);

export const EFFECT_STATUSES = new Set([
  "preparada",
  "ejecutando",
  "ejecutada",
  "rechazada",
  "cancelada",
  "vencida",
  "entrega_incierta",
  "fallida",
]);

/** @type {Partial<Record<string, Set<string>>>} */
const PROFILE_ALLOWED_CATEGORIES = {
  investigacion: new Set(),
  ejecucion: new Set(["destructive_change"]),
  coordinacion: new Set([
    "external_message",
    "job_application",
    "destructive_change",
  ]),
  integracion: new Set([
    "external_message",
    "job_application",
    "destructive_change",
  ]),
};

const UUID_RE = /^[a-f0-9-]{36}$/i;

export class EffectExecutorError extends DomainError {}

/** @param {unknown} value */
function sha256Text(value) {
  return createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex");
}

/**
 * @param {unknown} content
 * @param {unknown} changes
 */
function serializeEffectContentForHash(content, changes) {
  if (content !== null && content !== undefined) {
    return String(content);
  }
  if (typeof changes === "string") {
    return changes;
  }
  if (changes && typeof changes === "object") {
    return JSON.stringify(changes);
  }
  return "";
}

/**
 * @param {string} dir
 * @param {EffectExecutorOptions} options
 */
export async function createEffectsExecutor(
  dir,
  {
    userRequests,
    workOrders = null,
    externalRunner = null,
    operatorBillingPolicy = { allowBilledApi: false },
    maxContentLength = MAX_EFFECT_CONTENT_LENGTH,
    clock = () => Date.now(),
    onChange = () => {},
  },
) {
  if (!userRequests) {
    throw new Error("createEffectsExecutor requiere userRequests.");
  }
  const hasExternalRunner = typeof externalRunner === "function";
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const journalFile = path.join(dir, "efectos-journal.jsonl");
  const snapshotFile = path.join(dir, "efectos-snapshots.json");

  /** @type {Map<string, Effect>} */
  const effects = new Map();
  /** An effect whose id the caller already found in `effects`. */
  const knownEffect = (/** @type {string} */ id) =>
    /** @type {Effect} */ (effects.get(id));
  /** @type {Map<string, EffectExecutionReceipt>} */
  const receiptsByRequestId = new Map();
  /** @type {Map<string, string>} */
  const effectsByRequestId = new Map();
  /** @type {Map<string, string>} */
  const effectsByApprovalId = new Map();
  let closed = false;

  const snapRaw = await readFile(snapshotFile, "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  if (snapRaw.trim()) {
    /** @type {{ effects?: Record<string, Effect> }} */
    const parsed = JSON.parse(snapRaw);
    for (const [id, eff] of Object.entries(parsed.effects ?? {})) {
      effects.set(id, eff);
    }
  }

  const { hadRecords, repaired } = await replayAndRepairJournal(
    journalFile,
    /** @param {EffectJournalRecord} rec */
    (rec) => {
      if (rec.op === "effect.put" && rec.effect?.id) {
        effects.set(rec.effect.id, rec.effect);
      }
    },
  );

  for (const eff of effects.values()) {
    if (eff.executionReceipt?.requestId) {
      receiptsByRequestId.set(
        eff.executionReceipt.requestId,
        eff.executionReceipt,
      );
    }
    if (eff.prepareRequestId) {
      effectsByRequestId.set(eff.prepareRequestId, eff.id);
    }
    if (eff.approvalId && !effectsByApprovalId.has(eff.approvalId)) {
      effectsByApprovalId.set(eff.approvalId, eff.id);
    }
  }

  const writeSnapshotAtomically = () =>
    writeJsonAtomically(snapshotFile, {
      payloadVersion: EFFECTS_PAYLOAD_VERSION,
      effects: Object.fromEntries(effects),
    });

  if (repaired || hadRecords) {
    await writeSnapshotAtomically();
  }

  const serial = createSerialQueue();

  /** @param {EffectJournalRecord} record */
  const appendJournal = (record) => appendJsonLine(journalFile, record);

  /** @param {Effect} effect */
  async function saveEffect(effect) {
    effects.set(effect.id, effect);
    if (effect.executionReceipt?.requestId) {
      receiptsByRequestId.set(
        effect.executionReceipt.requestId,
        effect.executionReceipt,
      );
    }
    if (effect.prepareRequestId) {
      effectsByRequestId.set(effect.prepareRequestId, effect.id);
    }
    if (effect.approvalId) {
      effectsByApprovalId.set(effect.approvalId, effect.id);
    }
    await appendJournal({ op: "effect.put", effect });
    await writeSnapshotAtomically();
    try {
      onChange();
    } catch {
      /* observers must not abort persistence */
    }
    return structuredClone(effect);
  }

  // Crash recovery: an effect left in "ejecutando" during/after external invocation
  // must transition durably to "entrega_incierta" before accepting any new execution.
  for (const eff of [...effects.values()]) {
    if (eff.status === "ejecutando") {
      const recovered = await saveEffect({
        ...eff,
        status: "entrega_incierta",
        lastError:
          eff.lastError ||
          "Ejecución interrumpida antes de confirmar recibo tras reinicio del servicio; requiere conciliación explícita.",
        revision: (eff.revision || 1) + 1,
        updatedAt: new Date(clock()).toISOString(),
      });
      if (eff.approvalId) {
        await userRequests
          .updateDeliveryState(eff.approvalId, {
            status: "entrega_incierta",
            note: recovered.lastError,
          })
          .catch(() => {});
      }
    }
  }

  /**
   * @param {EffectInput} input
   * @param {number} numericCost
   */
  function hasVerifiedBillingAuthorization(input, numericCost) {
    if (
      operatorBillingPolicy?.allowBilledApi === true &&
      input.fromAgent !== true
    ) {
      return true;
    }
    const approvalId = input.billingApprovalId;
    if (!approvalId || typeof approvalId !== "string") return false;
    const grantReq = userRequests.get(approvalId);
    if (
      !grantReq ||
      grantReq.kind !== "approval" ||
      grantReq.status !== "confirmada" ||
      grantReq.receipt?.decision !== "aprobada"
    ) {
      return false;
    }
    if (grantReq.expiresAt && Date.parse(grantReq.expiresAt) <= clock()) {
      return false;
    }
    const approver = String(grantReq.receipt?.by || "");
    if (!approver || approver.startsWith("agente")) return false;
    const grantedCost = Number(grantReq.cost ?? 0);
    if (
      Number.isFinite(numericCost) &&
      numericCost > 0 &&
      grantedCost < numericCost
    ) {
      return false;
    }
    return /billing|financial_spend|deepseek|api_facturada/i.test(
      `${grantReq.action || ""} ${grantReq.scope || ""}`,
    );
  }

  /** @param {Effect} eff */
  function toPublicEffect(eff, { includeSensitive = true } = {}) {
    const linkedApproval = eff.approvalId
      ? userRequests.get(eff.approvalId)
      : null;
    return {
      payloadVersion: EFFECTS_PAYLOAD_VERSION,
      id: eff.id,
      category: eff.category,
      action: eff.action,
      recipient: eff.recipient,
      ...(includeSensitive
        ? {
            content: eff.content ?? null,
            changes: eff.changes,
          }
        : {
            sensitiveRedacted: true,
          }),
      contentHash: eff.contentHash,
      cost: eff.cost,
      scope: eff.scope,
      expiresAt: linkedApproval?.expiresAt ?? eff.expiresAt ?? null,
      operationFingerprint: eff.operationFingerprint,
      workOrderId: eff.workOrderId,
      sessionId: eff.sessionId ?? null,
      memberId: eff.memberId,
      toolProfileId: eff.toolProfileId,
      approvalId: eff.approvalId,
      status: eff.status,
      connectorAvailable: hasExternalRunner,
      executionMode: hasExternalRunner ? "conector" : "manual_sin_conector",
      executionReceipt: eff.executionReceipt,
      pendingExecutionRequestId: eff.pendingExecutionRequestId ?? null,
      lastError: eff.lastError ?? null,
      revision: eff.revision,
      createdAt: eff.createdAt,
      updatedAt: eff.updatedAt,
    };
  }

  return {
    /** @param {{ workOrderId?: string, status?: string, includeSensitive?: boolean }} [filter] */
    list({ workOrderId, status, includeSensitive = true } = {}) {
      const items = [];
      for (const eff of effects.values()) {
        if (workOrderId && eff.workOrderId !== workOrderId) continue;
        if (status && eff.status !== status) continue;
        items.push(toPublicEffect(eff, { includeSensitive }));
      }
      return items;
    },

    /** @param {string} id */
    get(id, { includeSensitive = true } = {}) {
      const eff = effects.get(id);
      return eff ? toPublicEffect(eff, { includeSensitive }) : null;
    },

    /** @param {EffectInput} input */
    prepareEffect(input) {
      return serial(async () => {
        if (closed) throw new EffectExecutorError("Ejecutor cerrado.", 503);
        const category = String(input.category || "").trim();
        if (!PROTECTED_EFFECT_CATEGORIES.has(category)) {
          throw new EffectExecutorError(
            "Categoría de efecto protegido inválida.",
            400,
          );
        }
        const toolProfileId = String(
          input.toolProfileId || "coordinacion",
        ).trim();
        const allowedForProfile = PROFILE_ALLOWED_CATEGORIES[toolProfileId];
        if (!allowedForProfile) {
          throw new EffectExecutorError(
            `Perfil de herramientas inválido: ${toolProfileId}`,
            400,
          );
        }

        const action = String(input.action || "").trim();
        const recipient = String(input.recipient || "").trim();
        if (!action || !recipient) {
          throw new EffectExecutorError(
            "La operación protegida requiere acción y destinatario exactos.",
            400,
          );
        }

        const numericCost = Number(input.cost ?? 0);
        const usesBilledRoute =
          category === "financial_spend" ||
          (Number.isFinite(numericCost) && numericCost > 0) ||
          /billed|api_facturada|paid|deepseek/i.test(action);
        if (
          usesBilledRoute &&
          !hasVerifiedBillingAuthorization(input, numericCost)
        ) {
          throw new EffectExecutorError(
            "Operación con costo bloqueada por la política de gasto sin autorización humana o de operador validada. Usa la alternativa gratuita o de suscripción configurada.",
            403,
          );
        }

        const effectiveAllowedCategories = Array.isArray(
          input.allowedCategoriesOverride,
        )
          ? new Set(input.allowedCategoriesOverride)
          : allowedForProfile;
        if (!effectiveAllowedCategories.has(category)) {
          throw new EffectExecutorError(
            `El perfil «${toolProfileId}» no permite preparar efectos de categoría «${category}».`,
            403,
          );
        }

        const scope = String(input.scope || "allow_once").trim();
        if (scope === "*" || scope === "all") {
          throw new EffectExecutorError(
            "Las aprobaciones protegidas requieren alcance acotado, nunca comodín.",
            400,
          );
        }

        const hasExplicitContent =
          input.content !== undefined && input.content !== null;
        const exactContent = hasExplicitContent ? String(input.content) : null;
        if (exactContent !== null && exactContent.length > maxContentLength) {
          throw new EffectExecutorError(
            `El contenido excede el límite máximo permitido (${maxContentLength} caracteres, recibidos ${exactContent.length}); divídelo sin truncar.`,
            400,
          );
        }
        const changes = input.changes ?? "";
        if (typeof changes === "string" && changes.length > maxContentLength) {
          throw new EffectExecutorError(
            `El detalle de cambios excede el límite máximo permitido (${maxContentLength} caracteres).`,
            400,
          );
        }

        const serverContentHash = sha256Text(
          serializeEffectContentForHash(exactContent, changes),
        );
        if (input.contentHash !== undefined && input.contentHash !== null) {
          const declaredHash = String(input.contentHash).trim().toLowerCase();
          if (declaredHash !== serverContentHash) {
            throw new EffectExecutorError(
              "El contentHash declarado no coincide con los bytes exactos del contenido de la operación.",
              400,
            );
          }
        }
        const contentHash = serverContentHash;
        const cost = String(input.cost ?? "0");
        const opFields = {
          action,
          recipient,
          contentHash,
          changes,
          cost,
          scope,
        };
        const operationFingerprint = computeOperationFingerprint(opFields);

        if (input.id !== undefined && input.id !== null) {
          if (typeof input.id !== "string" || !UUID_RE.test(input.id)) {
            throw new EffectExecutorError(
              "El identificador de efecto debe ser UUID válido.",
              400,
            );
          }
        }

        const prepareRequestId = input.requestId ?? null;
        if (prepareRequestId !== null) {
          if (!UUID_RE.test(prepareRequestId)) {
            throw new EffectExecutorError(
              "requestId debe ser UUID válido.",
              400,
            );
          }
          const priorEffectId = effectsByRequestId.get(prepareRequestId);
          if (priorEffectId) {
            const existing = effects.get(priorEffectId);
            const sameContext =
              existing &&
              existing.category === category &&
              existing.operationFingerprint === operationFingerprint &&
              (existing.workOrderId ?? null) === (input.workOrderId ?? null) &&
              (existing.sessionId ?? null) === (input.sessionId ?? null) &&
              (existing.memberId ?? null) === (input.memberId ?? null) &&
              (existing.toolProfileId ?? null) === toolProfileId &&
              (input.id ? existing.id === input.id : true);
            if (!sameContext) {
              throw new EffectExecutorError(
                "El requestId de preparación ya fue utilizado en otra operación o contexto.",
                409,
                existing ? { operacion: toPublicEffect(existing) } : {},
              );
            }
            return {
              operacion: toPublicEffect(existing),
              solicitud: userRequests.get(existing.approvalId),
              repetido: true,
            };
          }
        }

        if (input.id && effects.has(input.id)) {
          throw new EffectExecutorError(
            "El identificador de efecto ya existe; no se puede sobrescribir otra operación ni alterar su aprobación.",
            409,
            { operacion: toPublicEffect(knownEffect(input.id)) },
          );
        }

        const nowIso = new Date(clock()).toISOString();
        const effectId = input.id || randomUUID();
        /** @type {Effect} */
        const baseEffect = {
          payloadVersion: EFFECTS_PAYLOAD_VERSION,
          id: effectId,
          prepareRequestId,
          category,
          action,
          recipient,
          content: exactContent,
          contentHash,
          changes,
          cost,
          scope,
          billingApprovalId: input.billingApprovalId ?? null,
          operationFingerprint,
          workOrderId: input.workOrderId ?? null,
          sessionId: input.sessionId ?? null,
          memberId: input.memberId ?? null,
          toolProfileId,
          approvalId: null,
          status: "preparada",
          executionReceipt: null,
          pendingExecutionRequestId: null,
          lastError: null,
          revision: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        const { solicitud, repetido } = await userRequests.createRequest({
          kind: "approval",
          requestId: prepareRequestId ?? undefined,
          workOrderId: baseEffect.workOrderId,
          sessionId: baseEffect.sessionId,
          memberId: baseEffect.memberId,
          title:
            input.title || `Aprobar ${category}: ${action} -> ${recipient}`,
          prompt:
            input.prompt ||
            `Autorizar ${action} hacia «${recipient}» (costo: ${cost}, alcance: ${scope}).`,
          content: exactContent,
          ...opFields,
          nativeRequestId: input.nativeRequestId ?? null,
          nativeSessionId: input.nativeSessionId ?? null,
          nativeTurnId: input.nativeTurnId ?? null,
          ttlMs: input.ttlMs,
        });

        const boundEffectId = effectsByApprovalId.get(solicitud.id);
        if (
          (boundEffectId && boundEffectId !== baseEffect.id) ||
          solicitud.kind !== "approval" ||
          solicitud.operationFingerprint !== baseEffect.operationFingerprint
        ) {
          throw new EffectExecutorError(
            "La solicitud de aprobación ya pertenece a otra operación diferente.",
            409,
          );
        }

        baseEffect.approvalId = solicitud.id;
        await saveEffect(baseEffect);

        return {
          operacion: toPublicEffect(baseEffect),
          solicitud,
          repetido: Boolean(repetido),
        };
      });
    },

    /**
     * @param {string} effectId
     * @param {{
     *   requestId?: string, actor?: string, expectedNativeTurnId?: string,
     *   action?: string, recipient?: string, contentHash?: string,
     *   changes?: unknown, cost?: unknown, scope?: unknown,
     * }} [approval]
     */
    executeEffect(
      effectId,
      {
        requestId,
        actor = "app",
        expectedNativeTurnId,
        action,
        recipient,
        contentHash,
        changes,
        cost,
        scope,
      } = {},
    ) {
      return serial(async () => {
        if (closed) throw new EffectExecutorError("Ejecutor cerrado.", 503);
        if (!requestId || !UUID_RE.test(requestId)) {
          throw new EffectExecutorError(
            "Se requiere requestId UUID válido para ejecutar efecto protegido.",
            400,
          );
        }

        const priorReceipt = receiptsByRequestId.get(requestId);
        if (priorReceipt) {
          if (priorReceipt.effectId !== effectId) {
            throw new EffectExecutorError(
              "El requestId de ejecución ya fue utilizado en otra operación.",
              409,
              { recibo: structuredClone(priorReceipt) },
            );
          }
          const current = effects.get(effectId);
          return {
            ok: true,
            repetido: true,
            operacion: current ? toPublicEffect(current) : null,
            recibo: structuredClone(priorReceipt),
          };
        }

        const eff = effects.get(effectId);
        if (!eff) {
          throw new EffectExecutorError(
            "Operación protegida no encontrada; prepárala y solicita aprobación del usuario primero.",
            404,
          );
        }

        if (!eff.approvalId) {
          throw new EffectExecutorError(
            "La operación carece de solicitud de aprobación vinculada.",
            403,
          );
        }

        if (eff.status === "entrega_incierta" || eff.status === "ejecutando") {
          throw new EffectExecutorError(
            "La ejecución previa quedó pendiente o en «entrega_incierta»; concíliala explícitamente antes de reintentar para no duplicar efectos.",
            409,
            { operacion: toPublicEffect(eff) },
          );
        }

        if (eff.status === "ejecutada" && eff.executionReceipt) {
          throw new EffectExecutorError(
            "Esta operación ya fue ejecutada.",
            409,
            { recibo: structuredClone(eff.executionReceipt) },
          );
        }

        if (["cancelada", "vencida", "rechazada"].includes(eff.status)) {
          throw new EffectExecutorError(
            `La operación ya no admite ejecución (estado: ${eff.status}).`,
            409,
            { operacion: toPublicEffect(eff) },
          );
        }

        const persistedFp = computeOperationFingerprint({
          action: eff.action,
          recipient: eff.recipient,
          contentHash: eff.contentHash,
          changes: eff.changes,
          cost: eff.cost,
          scope: eff.scope,
        });
        if (persistedFp !== eff.operationFingerprint) {
          throw new EffectExecutorError(
            "La operación persistida no coincide con su huella registrada.",
            409,
            { operacion: toPublicEffect(eff) },
          );
        }

        const linkedRequest = userRequests.get(eff.approvalId);
        if (!linkedRequest || linkedRequest.kind !== "approval") {
          throw new EffectExecutorError(
            "La operación carece de aprobación válida vinculada.",
            409,
            { operacion: toPublicEffect(eff) },
          );
        }
        const boundEffect = effectsByApprovalId.get(eff.approvalId);
        if (
          (boundEffect && boundEffect !== eff.id) ||
          linkedRequest.operationFingerprint !== eff.operationFingerprint ||
          (linkedRequest.workOrderId ?? null) !== (eff.workOrderId ?? null) ||
          (linkedRequest.sessionId ?? null) !== (eff.sessionId ?? null) ||
          linkedRequest.action !== eff.action ||
          linkedRequest.recipient !== eff.recipient ||
          linkedRequest.contentHash !== eff.contentHash ||
          String(linkedRequest.cost ?? "") !== String(eff.cost ?? "") ||
          linkedRequest.scope !== eff.scope
        ) {
          throw new EffectExecutorError(
            "La aprobación vinculada no coincide exactamente con la operación ni con su contexto.",
            409,
            { operacion: toPublicEffect(eff) },
          );
        }

        if (
          expectedNativeTurnId !== undefined &&
          linkedRequest?.nativeTurnId &&
          expectedNativeTurnId !== linkedRequest.nativeTurnId
        ) {
          throw new EffectExecutorError(
            "La aprobación pertenece a otro turno nativo y no puede reutilizarse.",
            409,
          );
        }

        const computedStoredContentHash = sha256Text(
          serializeEffectContentForHash(eff.content, eff.changes),
        );
        if (computedStoredContentHash !== eff.contentHash) {
          throw new EffectExecutorError(
            "Los bytes persistidos de la operación ya no coinciden con el hash aprobado.",
            409,
            { operacion: toPublicEffect(eff) },
          );
        }

        const numericStoredCost = Number(eff.cost ?? 0);
        const execUsesBilled =
          eff.category === "financial_spend" ||
          (Number.isFinite(numericStoredCost) && numericStoredCost > 0) ||
          /billed|api_facturada|paid|deepseek/i.test(eff.action);
        if (
          execUsesBilled &&
          !hasVerifiedBillingAuthorization(
            { billingApprovalId: eff.billingApprovalId },
            numericStoredCost,
          )
        ) {
          throw new EffectExecutorError(
            "La operación con costo ya no cuenta con autorización de gasto vigente.",
            403,
            { operacion: toPublicEffect(eff) },
          );
        }

        if (!hasExternalRunner) {
          throw new EffectExecutorError(
            "No hay conector externo configurado en este entorno; la ejecución automática no está disponible y la operación queda en preparación manual.",
            503,
            {
              code: "CONNECTOR_UNAVAILABLE",
              manualPreparation: true,
              operacion: toPublicEffect(eff),
            },
          );
        }

        const verifyParams = {
          action: action !== undefined ? action : eff.action,
          recipient: recipient !== undefined ? recipient : eff.recipient,
          contentHash:
            contentHash !== undefined ? contentHash : eff.contentHash,
          changes: changes !== undefined ? changes : eff.changes,
          cost: cost !== undefined ? cost : eff.cost,
          scope: scope !== undefined ? scope : eff.scope,
        };

        let verification;
        try {
          verification = await userRequests.verifyApprovalBeforeExecute(
            eff.approvalId,
            verifyParams,
          );
        } catch (err) {
          const updatedApproval = userRequests.get(eff.approvalId);
          if (
            updatedApproval &&
            ["cancelada", "vencida", "rechazada"].includes(
              updatedApproval.status,
            ) &&
            eff.status !== updatedApproval.status
          ) {
            await saveEffect({
              ...eff,
              status: updatedApproval.status,
              lastError: err.message,
              revision: eff.revision + 1,
              updatedAt: new Date(clock()).toISOString(),
            });
          }
          throw new EffectExecutorError(err.message, err.status || 409, {
            operacion: toPublicEffect(knownEffect(effectId)),
          });
        }
        if (
          verification.recibo?.operationFingerprint !== eff.operationFingerprint
        ) {
          throw new EffectExecutorError(
            "El recibo de aprobación no coincide con la huella de la operación.",
            409,
            { operacion: toPublicEffect(eff) },
          );
        }

        const executing = {
          ...eff,
          status: "ejecutando",
          pendingExecutionRequestId: requestId,
          revision: eff.revision + 1,
          updatedAt: new Date(clock()).toISOString(),
        };
        await saveEffect(executing);

        let runnerOutcome;
        try {
          runnerOutcome = await externalRunner({
            effectId: eff.id,
            category: eff.category,
            action: eff.action,
            recipient: eff.recipient,
            content: eff.content,
            contentHash: eff.contentHash,
            changes: eff.changes,
            cost: eff.cost,
            scope: eff.scope,
            requestId,
            approvalReceipt: verification.recibo,
          });
        } catch (err) {
          const isAmbiguous =
            err?.ambiguous !== false &&
            (err?.ambiguous === true ||
              err?.name === "TimeoutError" ||
              err?.name === "AbortError" ||
              err?.code === "ETIMEDOUT" ||
              /timeout|tiempo/i.test(String(err?.message || "")));

          const failStatus = isAmbiguous ? "entrega_incierta" : "fallida";
          const failedEffect = await saveEffect({
            ...knownEffect(effectId),
            status: failStatus,
            pendingExecutionRequestId: isAmbiguous ? requestId : null,
            lastError: String(err?.message || "Fallo en ejecutor externo"),
            revision: knownEffect(effectId).revision + 1,
            updatedAt: new Date(clock()).toISOString(),
          });
          if (isAmbiguous) {
            await userRequests
              .updateDeliveryState(eff.approvalId, {
                status: "entrega_incierta",
                note: failedEffect.lastError,
              })
              .catch(() => {});
            throw new EffectExecutorError(
              "Tiempo agotado en ejecutor externo; la entrega quedó en estado incierto y debe conciliarse antes de reintentar.",
              504,
              { operacion: toPublicEffect(failedEffect) },
            );
          }
          throw new EffectExecutorError(
            failedEffect.lastError ?? "Fallo en ejecutor externo",
            err?.status || 502,
            { operacion: toPublicEffect(failedEffect) },
          );
        }

        const nowIso = new Date(clock()).toISOString();
        const executionReceipt = {
          requestId,
          effectId: eff.id,
          approvalId: eff.approvalId,
          approvalRequestId: verification.recibo.requestId,
          operationFingerprint: eff.operationFingerprint,
          category: eff.category,
          action: eff.action,
          recipient: eff.recipient,
          status: "confirmada",
          outcome: runnerOutcome ?? { ok: true },
          by: String(actor).slice(0, 60),
          ts: nowIso,
        };

        const completed = await saveEffect({
          ...knownEffect(effectId),
          status: "ejecutada",
          executionReceipt,
          pendingExecutionRequestId: null,
          lastError: null,
          revision: knownEffect(effectId).revision + 1,
          updatedAt: nowIso,
        });

        await userRequests
          .updateDeliveryState(eff.approvalId, {
            status: "confirmada",
            note: "Efecto ejecutado y confirmado con recibo",
          })
          .catch(() => {});

        if (workOrders && eff.workOrderId) {
          await workOrders
            .appendEvent(eff.workOrderId, {
              sourceId: actor,
              type: "tool.completed",
              correlationId: eff.id,
              idempotencyKey: `effect-exec:${eff.id}:${requestId}`,
              provenance: "observed",
              payload: {
                nombre: eff.action,
                resumen: `Efecto ejecutado hacia ${eff.recipient}`,
                estado: "ok",
                recibo: executionReceipt,
              },
            })
            .catch(() => {});
        }

        return {
          ok: true,
          repetido: false,
          operacion: toPublicEffect(completed),
          recibo: structuredClone(executionReceipt),
        };
      });
    },

    /**
     * @param {string} effectId
     * @param {{ requestId?: string, outcome?: string, note?: string, actor?: string }} [result]
     */
    reconcileEffect(
      effectId,
      { requestId, outcome, note = "", actor = "app" } = {},
    ) {
      return serial(async () => {
        if (!requestId || !UUID_RE.test(requestId)) {
          throw new EffectExecutorError(
            "Se requiere requestId UUID válido.",
            400,
          );
        }
        if (!outcome || !["confirmada", "fallida"].includes(outcome)) {
          throw new EffectExecutorError(
            "El resultado de conciliación debe ser «confirmada» o «fallida».",
            400,
          );
        }
        const eff = effects.get(effectId);
        if (!eff)
          throw new EffectExecutorError("Operación no encontrada.", 404);
        if (eff.status !== "entrega_incierta") {
          throw new EffectExecutorError(
            "Solo se pueden conciliar operaciones en estado «entrega_incierta».",
            409,
          );
        }
        const nowIso = new Date(clock()).toISOString();
        const reqIdForReceipt = eff.pendingExecutionRequestId || requestId;
        const reconciledReceipt =
          outcome === "confirmada"
            ? {
                requestId: reqIdForReceipt,
                effectId: eff.id,
                approvalId: eff.approvalId,
                operationFingerprint: eff.operationFingerprint,
                category: eff.category,
                action: eff.action,
                recipient: eff.recipient,
                status: "confirmada",
                reconciled: true,
                note: String(note).slice(0, 300),
                by: String(actor).slice(0, 60),
                ts: nowIso,
              }
            : null;
        const saved = await saveEffect({
          ...eff,
          status: outcome === "confirmada" ? "ejecutada" : "fallida",
          executionReceipt: reconciledReceipt,
          pendingExecutionRequestId: null,
          lastError: note ? String(note).slice(0, 300) : eff.lastError,
          revision: eff.revision + 1,
          updatedAt: nowIso,
        });
        if (eff.approvalId) {
          await userRequests
            .updateDeliveryState(eff.approvalId, {
              status:
                outcome === "confirmada" ? "confirmada" : "entrega_incierta",
              note: String(note || `Conciliado como ${outcome}`).slice(0, 300),
            })
            .catch(() => {});
        }
        return {
          ok: true,
          operacion: toPublicEffect(saved),
          recibo: reconciledReceipt ? structuredClone(reconciledReceipt) : null,
        };
      });
    },

    async close() {
      closed = true;
      await serial.drain();
    },
  };
}
