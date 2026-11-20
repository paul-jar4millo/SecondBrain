import { DomainError } from "./domain-error.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import {
  appendJsonLine,
  createSerialQueue,
  writeJsonAtomically,
} from "./lib/durable-store.mjs";
import path from "node:path";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const USER_REQUEST_PAYLOAD_VERSION = 1;

export const USER_REQUEST_STATUSES = new Set([
  "pendiente",
  "respuesta_recibida",
  "entregando",
  "entregada",
  "confirmada",
  "rechazada",
  "vencida",
  "cancelada",
  "entrega_incierta",
]);

export const NATIVE_CALLBACK_STATUSES = new Set([
  "open",
  "responded",
  "closed_by_turn",
  "interrupted",
  "expired",
  "not_applicable",
]);

export class UserRequestError extends DomainError {}

export class UserRequestConflictError extends UserRequestError {
  constructor(
    recibo,
    message = "La solicitud ya fue resuelta con otra decisión.",
  ) {
    super(message, 409, { recibo });
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeOperationFingerprint({
  action = "",
  recipient = "",
  contentHash = "",
  changes = "",
  cost = "",
  scope = "",
} = {}) {
  const normalized = {
    action: String(action || ""),
    recipient: String(recipient || ""),
    contentHash: String(contentHash || ""),
    changes:
      typeof changes === "string" ? changes : canonicalJson(changes ?? ""),
    cost: String(cost ?? ""),
    scope: String(scope || ""),
  };
  return createHash("sha256")
    .update(canonicalJson(normalized), "utf8")
    .digest("hex");
}

/**
 * Replays JSONL journal records and atomically strips an incomplete trailing
 * tail (or normalizes a missing final newline) before any future appends, while
 * surfacing genuine corruption located in the middle of the log.
 */
export async function replayAndRepairJournal(journalFile, onRecord) {
  let journalRaw;
  try {
    journalRaw = await readFile(journalFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { hadRecords: false, repaired: false };
    }
    throw error;
  }
  if (!journalRaw) {
    return { hadRecords: false, repaired: false };
  }

  const rawLines = journalRaw.split(/\r?\n/);
  const validLines = [];
  let truncatedTail = false;
  let hadBlankInterior = false;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) {
      if (rawLines.slice(i + 1).some((rest) => rest.trim().length > 0)) {
        hadBlankInterior = true;
      }
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      // Only an incomplete trailing tail may be dropped; middle corruption must throw.
      if (!rawLines.slice(i + 1).some((rest) => rest.trim().length > 0)) {
        truncatedTail = true;
        break;
      }
      throw error;
    }
    validLines.push(JSON.stringify(parsed));
    onRecord(parsed);
  }

  const missingFinalNewline =
    validLines.length > 0 && !journalRaw.endsWith("\n");
  const repaired = truncatedTail || missingFinalNewline || hadBlankInterior;
  if (repaired) {
    const repairedBody =
      validLines.length > 0 ? `${validLines.join("\n")}\n` : "";
    const tmp = `${journalFile}.${process.pid}.tmp`;
    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(repairedBody, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, journalFile);
  }

  return { hadRecords: validLines.length > 0, repaired };
}

export async function createUserRequestStore(
  dir,
  {
    clock = Date.now,
    approvalTimeoutMs = 1800000,
    onChange = /** @type {() => void} */ (() => {}),
    onEvent = /** @type {(workOrderId: string, payload: object) => Promise<void>} */ (
      async () => {}
    ),
  } = {},
) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const journalFile = path.join(dir, "solicitudes-journal.jsonl");
  const snapshotFile = path.join(dir, "solicitudes-snapshots.json");

  const requests = new Map();
  const byCreateRequestId = new Map();
  const receiptsByRequestId = new Map();
  const waiters = new Map();
  const timers = new Map();
  let closed = false;

  const snapRaw = await readFile(snapshotFile, "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  if (snapRaw.trim()) {
    const parsed = JSON.parse(snapRaw);
    for (const [id, req] of Object.entries(parsed.requests ?? {})) {
      requests.set(id, req);
    }
  }

  const { hadRecords, repaired } = await replayAndRepairJournal(
    journalFile,
    (rec) => {
      if (rec.op === "request.put" && rec.request?.id) {
        requests.set(rec.request.id, rec.request);
      }
    },
  );

  for (const req of requests.values()) {
    if (req.createRequestId) byCreateRequestId.set(req.createRequestId, req.id);
    if (req.receipt?.requestId) {
      receiptsByRequestId.set(req.receipt.requestId, req.receipt);
    }
  }

  const writeSnapshotAtomically = () =>
    writeJsonAtomically(snapshotFile, {
      payloadVersion: USER_REQUEST_PAYLOAD_VERSION,
      requests: Object.fromEntries(requests),
    });

  const appendJournal = (rec) => appendJsonLine(journalFile, rec);

  async function persistRequest(req) {
    requests.set(req.id, req);
    if (req.createRequestId) byCreateRequestId.set(req.createRequestId, req.id);
    if (req.receipt?.requestId) {
      receiptsByRequestId.set(req.receipt.requestId, req.receipt);
    }
    await appendJournal({ op: "request.put", request: req });
    await writeSnapshotAtomically();
  }

  const serial = createSerialQueue();

  function resolveWaiters(req) {
    const set = waiters.get(req.id);
    if (!set) return;
    for (const resolve of set) resolve(structuredClone(req));
    waiters.delete(req.id);
  }

  function clearTimer(id) {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  function scheduleExpiry(req) {
    clearTimer(req.id);
    if (req.status !== "pendiente" || typeof req.expiresAtMs !== "number") {
      return;
    }
    const delay = Math.max(1, req.expiresAtMs - clock());
    const t = setTimeout(
      () => {
        serial(async () => {
          const current = requests.get(req.id);
          if (!current || current.status !== "pendiente") return;
          if (
            typeof current.expiresAtMs === "number" &&
            clock() >= current.expiresAtMs
          ) {
            const next = {
              ...current,
              status: "vencida",
              nativeCallbackStatus:
                current.nativeCallbackStatus === "open"
                  ? "expired"
                  : current.nativeCallbackStatus,
              revision: current.revision + 1,
              updatedAt: new Date(clock()).toISOString(),
            };
            await persistRequest(next);
            resolveWaiters(next);
            onChange();
          } else {
            scheduleExpiry(current);
          }
        }).catch(() => {});
      },
      Math.min(delay, 2147483647),
    );
    t.unref();
    timers.set(req.id, t);
  }

  // On restart:
  // - Persistent product questions MUST stay "pendiente" across restarts; only live native callbacks downgrade cleanly.
  // - Ephemeral approvals bound to a dead process native callback or past expiresAt become "vencida".
  let dirtyStartup = false;
  for (const [id, req] of requests) {
    if (req.status === "pendiente") {
      if (
        req.kind === "approval" &&
        ((typeof req.expiresAtMs === "number" && clock() >= req.expiresAtMs) ||
          (req.nativeRequestId && req.nativeCallbackStatus === "open"))
      ) {
        requests.set(id, {
          ...req,
          status: "vencida",
          nativeCallbackStatus:
            req.nativeCallbackStatus === "open"
              ? "expired"
              : req.nativeCallbackStatus,
          revision: req.revision + 1,
          updatedAt: new Date(clock()).toISOString(),
        });
        dirtyStartup = true;
      } else if (
        req.kind === "question" &&
        req.nativeCallbackStatus === "open"
      ) {
        requests.set(id, {
          ...req,
          nativeCallbackStatus: "interrupted",
          requiresNewTurn: true,
          revision: req.revision + 1,
          updatedAt: new Date(clock()).toISOString(),
        });
        dirtyStartup = true;
      } else if (req.kind === "approval") {
        scheduleExpiry(req);
      }
    }
  }
  if (repaired || dirtyStartup || hadRecords) {
    await writeSnapshotAtomically();
  }

  async function emitEventSafe(workOrderId, payload) {
    if (!workOrderId) return;
    await onEvent(workOrderId, payload).catch(() => {});
  }

  function toPublicSummary(req) {
    return {
      id: req.id,
      workOrderId: req.workOrderId,
      sessionId: req.sessionId,
      memberId: req.memberId,
      kind: req.kind,
      title: req.title,
      prompt: req.prompt,
      options: req.options,
      allowFreeText: req.allowFreeText,
      status: req.status,
      revision: req.revision,
      createdAt: req.createdAt,
      updatedAt: req.updatedAt,
      expiresAt: req.expiresAt,
      requiresNewTurn: req.requiresNewTurn,
      nativeRequestId: req.nativeRequestId,
      nativeSessionId: req.nativeSessionId,
      nativeTurnId: req.nativeTurnId,
      nativeCallbackStatus: req.nativeCallbackStatus,
      ...(req.kind === "approval"
        ? {
            action: req.action,
            recipient: req.recipient,
            content: req.content ?? null,
            contentHash: req.contentHash,
            changes: req.changes,
            cost: req.cost,
            scope: req.scope,
            operationFingerprint: req.operationFingerprint,
          }
        : {}),
      response: req.response,
      receipt: req.receipt,
      ...(req.deliveryNote ? { deliveryNote: req.deliveryNote } : {}),
      payloadVersion: USER_REQUEST_PAYLOAD_VERSION,
    };
  }

  return {
    /** @param {{ workOrderId?: string, kind?: string, status?: string }} [filter] */
    list({ workOrderId, kind, status } = {}) {
      const items = [];
      for (const req of requests.values()) {
        if (workOrderId && req.workOrderId !== workOrderId) continue;
        if (kind && req.kind !== kind) continue;
        if (status && req.status !== status) continue;
        items.push(toPublicSummary(req));
      }
      return items;
    },

    get(id) {
      const req = requests.get(id);
      return req ? toPublicSummary(req) : null;
    },

    createRequest(input) {
      return serial(async () => {
        if (closed) throw new UserRequestError("Almacén cerrado.", 503);
        const createRequestId =
          input.createRequestId ?? input.requestId ?? null;
        if (createRequestId && !UUID_RE.test(createRequestId)) {
          throw new UserRequestError("requestId debe ser UUID válido.", 400);
        }

        const kind = input.kind === "approval" ? "approval" : "question";
        const prompt = String(input.prompt || "").trim();
        if (!prompt) {
          throw new UserRequestError(
            "La solicitud requiere el texto de pregunta o acción.",
            400,
          );
        }
        const normalizedOptions = Array.isArray(input.options)
          ? input.options.map((o) => String(o).trim()).filter(Boolean)
          : [];
        const opContent =
          kind === "approval" &&
          input.content !== undefined &&
          input.content !== null
            ? String(input.content)
            : null;
        if (kind === "approval" && opContent !== null && input.contentHash) {
          const computedHash = createHash("sha256")
            .update(opContent, "utf8")
            .digest("hex");
          if (String(input.contentHash).trim().toLowerCase() !== computedHash) {
            throw new UserRequestError(
              "El contentHash declarado no coincide con el contenido de la aprobación.",
              400,
            );
          }
        }
        const opFields =
          kind === "approval"
            ? {
                action: String(input.action || ""),
                recipient: String(input.recipient || ""),
                contentHash: String(
                  input.contentHash ||
                    (opContent !== null
                      ? createHash("sha256")
                          .update(opContent, "utf8")
                          .digest("hex")
                      : ""),
                ),
                changes: input.changes ?? "",
                cost: String(input.cost ?? "0"),
                scope: String(input.scope || "allow_once"),
              }
            : {};
        const operationFingerprint =
          kind === "approval" ? computeOperationFingerprint(opFields) : null;

        if (createRequestId && byCreateRequestId.has(createRequestId)) {
          const existing = requests.get(byCreateRequestId.get(createRequestId));
          const sameContext =
            existing.kind === kind &&
            (input.id ? input.id === existing.id : true) &&
            (existing.workOrderId ?? null) === (input.workOrderId ?? null) &&
            (existing.sessionId ?? null) === (input.sessionId ?? null) &&
            (existing.memberId ?? null) === (input.memberId ?? null);
          const samePayload =
            kind === "approval"
              ? existing.operationFingerprint === operationFingerprint
              : existing.prompt === prompt &&
                canonicalJson(existing.options ?? []) ===
                  canonicalJson(normalizedOptions) &&
                existing.allowFreeText === (input.allowFreeText !== false);
          if (!sameContext || !samePayload) {
            throw new UserRequestError(
              "El requestId ya fue utilizado en una solicitud u operación diferente.",
              409,
              { solicitud: toPublicSummary(existing) },
            );
          }
          return {
            solicitud: toPublicSummary(existing),
            repetido: true,
          };
        }
        const requestedId = input.id || null;
        if (requestedId && requests.has(requestedId)) {
          throw new UserRequestError(
            "El identificador de solicitud ya existe; no se puede sobrescribir otra solicitud.",
            409,
            { solicitud: toPublicSummary(requests.get(requestedId)) },
          );
        }
        const nowMs = clock();
        const nowIso = new Date(nowMs).toISOString();
        const expiresAtMs =
          kind === "approval"
            ? nowMs +
              (Number(input.ttlMs) > 0
                ? Number(input.ttlMs)
                : approvalTimeoutMs)
            : typeof input.ttlMs === "number" && input.ttlMs > 0
              ? nowMs + input.ttlMs
              : null;

        const hasNativeCallback = Boolean(input.nativeRequestId);
        const nativeCallbackStatus =
          input.nativeCallbackStatus &&
          NATIVE_CALLBACK_STATUSES.has(input.nativeCallbackStatus)
            ? input.nativeCallbackStatus
            : hasNativeCallback
              ? "open"
              : "not_applicable";

        const req = {
          payloadVersion: USER_REQUEST_PAYLOAD_VERSION,
          id: input.id || randomUUID(),
          createRequestId,
          workOrderId: input.workOrderId ?? null,
          sessionId: input.sessionId ?? null,
          memberId: input.memberId ?? null,
          kind,
          title: String(
            input.title ||
              (kind === "approval"
                ? "Aprobación requerida"
                : "Pregunta pendiente"),
          ).trim(),
          prompt,
          options: normalizedOptions,
          allowFreeText: input.allowFreeText !== false,
          status: "pendiente",
          revision: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
          expiresAtMs,
          expiresAt:
            expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null,
          requiresNewTurn: false,
          nativeRequestId: input.nativeRequestId ?? null,
          nativeSessionId: input.nativeSessionId ?? null,
          nativeTurnId: input.nativeTurnId ?? null,
          nativeCallbackStatus,
          ...opFields,
          ...(kind === "approval"
            ? { content: opContent, operationFingerprint }
            : {}),
          response: null,
          receipt: null,
        };

        // Rule: persist request BEFORE emitting event
        await persistRequest(req);
        if (req.kind === "approval") {
          scheduleExpiry(req);
        }

        await emitEventSafe(req.workOrderId, {
          sourceId: req.memberId || "service",
          sessionId: req.sessionId,
          turnId: req.nativeTurnId,
          correlationId: req.id,
          idempotencyKey: `req-created:${req.id}`,
          type:
            req.kind === "approval"
              ? "approval.created"
              : "user_request.created",
          provenance: "observed",
          payload: {
            userRequestId: req.id,
            kind: req.kind,
            title: req.title,
            prompt: req.prompt,
            options: req.options,
            nativeCallbackStatus: req.nativeCallbackStatus,
          },
        });
        try {
          onChange();
        } catch {}

        return { solicitud: toPublicSummary(req), repetido: false };
      });
    },

    markTurnClosed({ sessionId, nativeTurnId, reason = "closed_by_turn" }) {
      return serial(async () => {
        if (!["closed_by_turn", "interrupted", "expired"].includes(reason)) {
          throw new UserRequestError("Motivo de cierre inválido.", 400);
        }
        const changedIds = [];
        const nowIso = new Date(clock()).toISOString();
        for (const req of [...requests.values()]) {
          if (sessionId && req.sessionId !== sessionId) continue;
          if (nativeTurnId && req.nativeTurnId !== nativeTurnId) continue;

          if (req.kind === "question" && req.status === "pendiente") {
            // Product question SURVIVES turn close; only native callback status updates.
            if (req.nativeCallbackStatus === "open") {
              const next = {
                ...req,
                nativeCallbackStatus: reason,
                requiresNewTurn: true,
                revision: req.revision + 1,
                updatedAt: nowIso,
              };
              await persistRequest(next);
              changedIds.push(next.id);
            }
          } else if (
            req.kind === "approval" &&
            req.status === "pendiente" &&
            req.nativeRequestId &&
            req.nativeCallbackStatus === "open"
          ) {
            const next = {
              ...req,
              status: "vencida",
              nativeCallbackStatus: reason,
              revision: req.revision + 1,
              updatedAt: nowIso,
            };
            await persistRequest(next);
            clearTimer(next.id);
            resolveWaiters(next);
            changedIds.push(next.id);
          }
        }
        if (changedIds.length > 0) {
          try {
            onChange();
          } catch {}
        }
        return { updatedIds: changedIds };
      });
    },

    /**
     * @param {string} id
     * @param {{
     *   requestId?: string, option?: string, freeText?: string,
     *   approve?: boolean, by?: string, origin?: string,
     *   expectedRevision?: number, expectedNativeTurnId?: string,
     *   action?: string, recipient?: string, contentHash?: string,
     *   changes?: unknown, cost?: unknown, scope?: unknown,
     * }} [answer]
     */
    respond(
      id,
      {
        requestId,
        option,
        freeText,
        approve,
        by = "app",
        origin = "app",
        expectedRevision,
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
        if (closed) throw new UserRequestError("Almacén cerrado.", 503);
        if (!requestId || !UUID_RE.test(requestId)) {
          throw new UserRequestError(
            "Se requiere requestId UUID válido para responder.",
            400,
          );
        }

        const req = requests.get(id);
        if (!req) throw new UserRequestError("Solicitud no encontrada.", 404);

        if (req.receipt) {
          if (req.receipt.requestId === requestId) {
            return {
              solicitud: toPublicSummary(req),
              recibo: structuredClone(req.receipt),
              repetido: true,
            };
          }
          throw new UserRequestConflictError(structuredClone(req.receipt));
        }

        const priorOther = receiptsByRequestId.get(requestId);
        if (priorOther && priorOther.userRequestId !== id) {
          throw new UserRequestConflictError(
            structuredClone(priorOther),
            "El requestId ya fue utilizado en otra solicitud.",
          );
        }

        if (
          expectedNativeTurnId !== undefined &&
          req.nativeTurnId &&
          expectedNativeTurnId !== req.nativeTurnId
        ) {
          throw new UserRequestError(
            "La solicitud pertenece a otro turno nativo y no puede reutilizarse.",
            409,
          );
        }

        if (
          expectedRevision !== undefined &&
          expectedRevision !== req.revision
        ) {
          throw new UserRequestError(
            "La solicitud cambió desde la última lectura.",
            409,
            { solicitud: toPublicSummary(req) },
          );
        }

        if (req.status !== "pendiente") {
          throw new UserRequestError(
            `La solicitud ya no está pendiente (estado actual: ${req.status}).`,
            409,
            { solicitud: toPublicSummary(req) },
          );
        }

        const nowMs = clock();
        const nowIso = new Date(nowMs).toISOString();

        if (typeof req.expiresAtMs === "number" && nowMs >= req.expiresAtMs) {
          const expiredReq = {
            ...req,
            status: "vencida",
            nativeCallbackStatus:
              req.nativeCallbackStatus === "open"
                ? "expired"
                : req.nativeCallbackStatus,
            revision: req.revision + 1,
            updatedAt: nowIso,
          };
          await persistRequest(expiredReq);
          clearTimer(expiredReq.id);
          resolveWaiters(expiredReq);
          onChange();
          throw new UserRequestError(
            "La solicitud venció y permanece visible en el historial.",
            409,
            { solicitud: toPublicSummary(expiredReq) },
          );
        }

        if (req.kind === "approval") {
          if (req.nativeRequestId && req.nativeCallbackStatus !== "open") {
            const expiredReq = {
              ...req,
              status: "vencida",
              revision: req.revision + 1,
              updatedAt: nowIso,
            };
            await persistRequest(expiredReq);
            clearTimer(expiredReq.id);
            resolveWaiters(expiredReq);
            onChange();
            throw new UserRequestError(
              "El callback nativo asociado caducó; solicita una nueva aprobación.",
              409,
              { solicitud: toPublicSummary(expiredReq) },
            );
          }

          if (
            action !== undefined ||
            recipient !== undefined ||
            contentHash !== undefined ||
            changes !== undefined ||
            cost !== undefined ||
            scope !== undefined
          ) {
            const incomingFp = computeOperationFingerprint({
              action: action ?? req.action,
              recipient: recipient ?? req.recipient,
              contentHash: contentHash ?? req.contentHash,
              changes: changes ?? req.changes,
              cost: cost ?? req.cost,
              scope: scope ?? req.scope,
            });
            if (incomingFp !== req.operationFingerprint) {
              const invalidated = {
                ...req,
                status: "cancelada",
                revision: req.revision + 1,
                updatedAt: nowIso,
              };
              await persistRequest(invalidated);
              clearTimer(invalidated.id);
              resolveWaiters(invalidated);
              onChange();
              throw new UserRequestError(
                "Cambió destinatario, importe o contenido desde que se emitió la aprobación; autorización invalidada.",
                409,
                { solicitud: toPublicSummary(invalidated) },
              );
            }
          }

          if (typeof approve !== "boolean") {
            throw new UserRequestError(
              "Las aprobaciones exigen decisión booleana explícita (`approve`).",
              400,
            );
          }

          const finalStatus = approve ? "confirmada" : "rechazada";
          const receipt = {
            requestId,
            userRequestId: req.id,
            kind: "approval",
            decision: approve ? "aprobada" : "rechazada",
            operationFingerprint: req.operationFingerprint,
            by: String(by).slice(0, 60),
            origin: String(origin).slice(0, 40),
            ts: nowIso,
          };
          const next = {
            ...req,
            status: finalStatus,
            nativeCallbackStatus:
              req.nativeCallbackStatus === "open"
                ? "responded"
                : req.nativeCallbackStatus,
            response: { approve },
            receipt,
            revision: req.revision + 1,
            updatedAt: nowIso,
          };
          await persistRequest(next);
          clearTimer(next.id);
          resolveWaiters(next);
          await emitEventSafe(next.workOrderId, {
            sourceId: String(by),
            sessionId: next.sessionId,
            turnId: next.nativeTurnId,
            correlationId: next.id,
            idempotencyKey: `req-resolved:${next.id}`,
            type: "approval.resolved",
            provenance: "observed",
            payload: { userRequestId: next.id, receipt },
          });
          try {
            onChange();
          } catch {}
          return {
            solicitud: toPublicSummary(next),
            recibo: structuredClone(receipt),
            repetido: false,
          };
        }

        // Question resolution (survives closed native callbacks via requiresNewTurn)
        const cleanOption =
          typeof option === "string" && option.trim() ? option.trim() : null;
        const cleanFree =
          typeof freeText === "string" && freeText.trim()
            ? freeText.trim()
            : null;
        const answerText =
          cleanOption && cleanFree
            ? `${cleanOption}: ${cleanFree}`
            : (cleanFree ?? cleanOption);
        if (!answerText) {
          throw new UserRequestError(
            "Incluye una opción seleccionada o respuesta libre.",
            400,
          );
        }
        if (cleanFree && req.allowFreeText === false) {
          throw new UserRequestError(
            "Esta pregunta no admite texto libre.",
            400,
          );
        }
        if (
          cleanOption &&
          req.options.length > 0 &&
          !req.options.includes(cleanOption)
        ) {
          throw new UserRequestError(
            "La opción elegida no figura en la solicitud.",
            400,
          );
        }

        const callbackClosed =
          req.nativeCallbackStatus !== "open" &&
          req.nativeCallbackStatus !== "not_applicable";
        const nextStatus =
          req.nativeCallbackStatus === "open"
            ? "entregada"
            : "respuesta_recibida";

        const receipt = {
          requestId,
          userRequestId: req.id,
          kind: "question",
          decision: answerText,
          selectedOption: cleanOption,
          freeText: cleanFree,
          requiresNewTurn: callbackClosed,
          by: String(by).slice(0, 60),
          origin: String(origin).slice(0, 40),
          ts: nowIso,
        };
        const next = {
          ...req,
          status: nextStatus,
          requiresNewTurn: callbackClosed,
          nativeCallbackStatus:
            req.nativeCallbackStatus === "open"
              ? "responded"
              : req.nativeCallbackStatus,
          response: {
            option: cleanOption,
            freeText: cleanFree,
            answer: answerText,
          },
          receipt,
          revision: req.revision + 1,
          updatedAt: nowIso,
        };
        await persistRequest(next);
        clearTimer(next.id);
        resolveWaiters(next);
        await emitEventSafe(next.workOrderId, {
          sourceId: String(by),
          sessionId: next.sessionId,
          turnId: next.nativeTurnId,
          correlationId: next.id,
          idempotencyKey: `req-resolved:${next.id}`,
          type: "user_request.resolved",
          provenance: "observed",
          payload: { userRequestId: next.id, receipt },
        });
        try {
          onChange();
        } catch {}

        return {
          solicitud: toPublicSummary(next),
          recibo: structuredClone(receipt),
          repetido: false,
        };
      });
    },

    /**
     * @param {string} id
     * @param {{ status?: string, note?: string }} [state]
     */
    updateDeliveryState(id, { status, note } = {}) {
      return serial(async () => {
        if (
          ![
            "entregando",
            "entregada",
            "confirmada",
            "entrega_incierta",
          ].includes(status)
        ) {
          throw new UserRequestError("Estado de entrega inválido.", 400);
        }
        const req = requests.get(id);
        if (!req) throw new UserRequestError("Solicitud no encontrada.", 404);
        if (!req.receipt) {
          throw new UserRequestError(
            "No se puede actualizar la entrega de una solicitud sin respuesta.",
            409,
          );
        }
        const next = {
          ...req,
          status,
          ...(note ? { deliveryNote: String(note).slice(0, 300) } : {}),
          revision: req.revision + 1,
          updatedAt: new Date(clock()).toISOString(),
        };
        await persistRequest(next);
        onChange();
        return toPublicSummary(next);
      });
    },

    verifyApprovalBeforeExecute(id, opParams = {}) {
      return serial(async () => {
        const req = requests.get(id);
        if (!req || req.kind !== "approval") {
          throw new UserRequestError("Aprobación no encontrada.", 404);
        }
        if (
          req.status !== "confirmada" ||
          req.receipt?.decision !== "aprobada"
        ) {
          throw new UserRequestError(
            `La operación no tiene aprobación vigente (estado: ${req.status}).`,
            409,
          );
        }
        if (typeof req.expiresAtMs === "number" && clock() >= req.expiresAtMs) {
          const expired = {
            ...req,
            status: "vencida",
            revision: req.revision + 1,
            updatedAt: new Date(clock()).toISOString(),
          };
          await persistRequest(expired);
          throw new UserRequestError(
            "La aprobación expiró antes de ejecutarse.",
            409,
          );
        }
        const currentFp = computeOperationFingerprint({
          action: opParams.action ?? req.action,
          recipient: opParams.recipient ?? req.recipient,
          contentHash: opParams.contentHash ?? req.contentHash,
          changes: opParams.changes ?? req.changes,
          cost: opParams.cost ?? req.cost,
          scope: opParams.scope ?? req.scope,
        });
        if (currentFp !== req.operationFingerprint) {
          const invalidated = {
            ...req,
            status: "cancelada",
            revision: req.revision + 1,
            updatedAt: new Date(clock()).toISOString(),
          };
          await persistRequest(invalidated);
          onChange();
          throw new UserRequestError(
            "La operación cambió tras aprobarse; autorización invalidada.",
            409,
          );
        }
        return { authorized: true, recibo: structuredClone(req.receipt) };
      });
    },

    async waitForResponse(id, { timeoutMs = 240_000 } = {}) {
      const current = requests.get(id);
      if (!current) {
        throw new UserRequestError("Solicitud no encontrada.", 404);
      }
      if (current.status !== "pendiente") {
        return toPublicSummary(current);
      }
      const bounded = Math.max(0, Math.min(Number(timeoutMs) || 0, 240_000));
      if (bounded === 0) {
        return toPublicSummary(current);
      }
      return new Promise((resolve) => {
        let timer;
        const onDone = (updated) => {
          clearTimeout(timer);
          resolve(toPublicSummary(updated));
        };
        const set = waiters.get(id) ?? new Set();
        set.add(onDone);
        waiters.set(id, set);
        timer = setTimeout(() => {
          const s = waiters.get(id);
          if (s) {
            s.delete(onDone);
            if (s.size === 0) waiters.delete(id);
          }
          const latest = requests.get(id);
          resolve(latest ? toPublicSummary(latest) : null);
        }, bounded);
        timer.unref();
      });
    },

    async cerrar() {
      closed = true;
      await serial.drain();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      // Do NOT expire or cancel pending product questions on shutdown; only release active long-pollers cleanly.
      for (const [id, set] of waiters.entries()) {
        const latest = requests.get(id);
        for (const resolve of set) {
          if (latest) resolve(latest);
        }
      }
      waiters.clear();
    },
  };
}
