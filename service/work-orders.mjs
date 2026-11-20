import { DomainError } from "./domain-error.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import {
  appendJsonLine,
  createSerialQueue,
  writeJsonAtomically,
} from "./lib/durable-store.mjs";
import path from "node:path";
import { replayAndRepairJournal } from "./user-requests.mjs";

/** @import { AcceptanceCriterionInput, Recipient, ScopedItem, Viewer, WorkEvent, WorkEventInput, WorkOrder, WorkOrderCommand, WorkOrderInput, WorkOrderJournalRecord, WorkOrderMemberInput } from "./work-order-types.d.ts" */

export const WORK_ORDER_PAYLOAD_VERSION = 1;

export const WORK_ORDER_STATUSES = new Set([
  "borrador",
  "en_cola",
  "en_curso",
  "esperando_respuesta",
  "esperando_aprobacion",
  "bloqueado",
  "verificando",
  "completado",
  "cancelado",
]);

export const ACTIVE_WORK_ORDER_STATUSES = new Set([
  "en_cola",
  "en_curso",
  "esperando_respuesta",
  "esperando_aprobacion",
  "bloqueado",
  "verificando",
]);

export const DELIVERY_STATUSES = new Set([
  "recibido",
  "en_cola",
  "entregado",
  "confirmado_proveedor",
  "fallido",
  "entrega_incierta",
]);

export const EVENT_TYPES = new Set([
  "message.accepted",
  "message.queued",
  "turn.started",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.completed",
  "user_request.created",
  "user_request.resolved",
  "approval.created",
  "approval.resolved",
  "artifact.published",
  "member.status",
  "connection.status",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "verification.completed",
]);

export class WorkOrderError extends DomainError {}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record).sort();
    return `{${keys
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** @param {unknown} value */
export function computeSha256(value) {
  const input = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * @param {WorkOrderMemberInput[]} team
 * @param {string} workOrderId
 */
function normalizeTeam(team, workOrderId) {
  if (!Array.isArray(team) || team.length < 1 || team.length > 4) {
    throw new WorkOrderError(
      "El equipo del encargo debe tener entre 1 y 4 integrantes.",
      400,
    );
  }
  let coordinators = 0;
  const seenIds = new Set();
  const normalized = team.map((member, index) => {
    const id = member.id || `${workOrderId}-m-${index + 1}`;
    if (seenIds.has(id)) {
      throw new WorkOrderError(
        "Cada tarjeta del equipo debe tener un identificador único.",
        400,
      );
    }
    seenIds.add(id);
    const engine = member.engine ?? member.motor;
    if (!engine || !["claude", "codex", "agy", "deepseek"].includes(engine)) {
      throw new WorkOrderError("Motor de integrante inválido.", 400);
    }
    const assigned = member.assigned !== false;
    const coordinator = Boolean(member.coordinator);
    if (assigned && coordinator) coordinators += 1;
    return {
      id,
      characterId: member.characterId,
      providerInstanceId: member.providerInstanceId ?? `${engine}:default`,
      motor: engine,
      engine,
      model: String(member.model || "").trim(),
      effort: member.effort ? String(member.effort).trim() : null,
      role: String(member.role || "").trim(),
      responsibility: String(member.responsibility || "").trim(),
      coordinator,
      toolProfileId: member.toolProfileId ?? "investigacion",
      assigned,
    };
  });
  const assignedCount = normalized.filter((m) => m.assigned).length;
  if (assignedCount < 1) {
    throw new WorkOrderError(
      "Debe haber al menos una integrante asignada al encargo.",
      400,
    );
  }
  if (coordinators !== 1) {
    throw new WorkOrderError(
      "El equipo asignado debe tener exactamente una coordinadora.",
      400,
    );
  }
  return normalized;
}

/** @param {AcceptanceCriterionInput[]} criteria */
function normalizeCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new WorkOrderError(
      "Incluye al menos un criterio de aceptación.",
      400,
    );
  }
  return criteria.map((c, index) => ({
    id: c.id || `crit-${index + 1}`,
    text: String(c.text || "").trim(),
    checked: Boolean(c.checked),
    evidenceRefs: Array.isArray(c.evidenceRefs)
      ? c.evidenceRefs.map(String)
      : [],
  }));
}

/**
 * @param {string} type
 * @param {Recipient | null} recipient
 */
function defaultVisibilityForEvent(type, recipient) {
  if (recipient?.scope === "directo" && recipient?.memberId) {
    return "directo";
  }
  if (type === "message.delta" && recipient?.scope === "directo") {
    return "directo";
  }
  return "equipo";
}

/**
 * @param {ScopedItem} item
 * @param {Viewer} [viewer]
 */
function canViewerSeeScopedItem(item, { recipientScope, memberId } = {}) {
  if (recipientScope === "todos") return true;
  if (!recipientScope && !memberId) return true;
  const isDirect =
    item?.visibility === "directo" || item?.recipient?.scope === "directo";
  if (recipientScope === "equipo") return !isDirect;
  if (memberId) {
    if (!isDirect) return true;
    return (
      item?.recipient?.memberId === memberId || item?.sourceId === memberId
    );
  }
  if (recipientScope === "directo") return !isDirect;
  return true;
}

/**
 * @param {WorkEvent[]} events
 * @param {Viewer} [viewer]
 */
function filterEventsForViewer(events, viewer = {}) {
  return events.filter((ev) => canViewerSeeScopedItem(ev, viewer));
}

/**
 * @param {WorkOrder} wo
 * @param {Viewer} [viewer]
 */
function filterSnapshotForViewer(wo, viewer = {}) {
  const snapshot = structuredClone(wo);
  if (
    viewer.recipientScope === "todos" ||
    (!viewer.recipientScope && !viewer.memberId)
  ) {
    return snapshot;
  }
  const scopedLists =
    /** @type {Record<"commands" | "handoffs" | "tasks" | "artifacts", ScopedItem[]>} */ (
      snapshot
    );
  for (const field of /** @type {const} */ ([
    "commands",
    "handoffs",
    "tasks",
    "artifacts",
  ])) {
    if (Array.isArray(scopedLists[field])) {
      scopedLists[field] = scopedLists[field].filter((item) =>
        canViewerSeeScopedItem(item, viewer),
      );
    }
  }
  return snapshot;
}

/**
 * @param {string} dir
 * @param {{ clock?: () => string, onChange?: () => void }} [options]
 */
export async function createWorkOrderStore(
  dir,
  { clock = () => new Date().toISOString(), onChange = () => {} } = {},
) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const journalFile = path.join(dir, "encargos-journal.jsonl");
  const snapshotFile = path.join(dir, "encargos-snapshots.json");

  /** @type {Map<string, WorkOrder>} */
  const orders = new Map();
  /** @type {Map<string, WorkEvent[]>} */
  const eventsByOrder = new Map();
  /** @type {Map<string, Map<string, WorkOrderCommand>>} */
  const commandIndexByOrder = new Map();
  /** @type {Map<string, Set<string>>} */
  const eventDedupeByOrder = new Map();
  let nextOrderNumber = 1;
  let closed = false;

  // Replay durable snapshot + journal records on startup
  const snapshotRaw = await readFile(snapshotFile, "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  if (snapshotRaw.trim()) {
    /** @type {{ nextOrderNumber?: number, orders?: Record<string, WorkOrder>, eventsByOrder?: Record<string, WorkEvent[]> }} */
    const parsed = JSON.parse(snapshotRaw);
    nextOrderNumber = parsed.nextOrderNumber || 1;
    for (const [id, wo] of Object.entries(parsed.orders ?? {})) {
      orders.set(id, wo);
      eventsByOrder.set(id, []);
      const commandIndex = new Map();
      commandIndexByOrder.set(id, commandIndex);
      eventDedupeByOrder.set(id, new Set());
      for (const cmd of wo.commands ?? []) {
        commandIndex.set(cmd.clientMessageId, cmd);
      }
    }
    for (const [id, list] of Object.entries(parsed.eventsByOrder ?? {})) {
      eventsByOrder.set(id, list);
      const dedupe = eventDedupeByOrder.get(id) ?? new Set();
      eventDedupeByOrder.set(id, dedupe);
      for (const ev of list) {
        dedupe.add(ev.id);
        if (ev.idempotencyKey) dedupe.add(`key:${ev.idempotencyKey}`);
      }
    }
  }

  const { hadRecords, repaired } = await replayAndRepairJournal(
    journalFile,
    /** @param {WorkOrderJournalRecord} rec */
    (rec) => {
      if (rec.op === "order.put" && rec.order?.id) {
        const wo = rec.order;
        orders.set(wo.id, wo);
        if (typeof rec.nextOrderNumber === "number") {
          nextOrderNumber = Math.max(nextOrderNumber, rec.nextOrderNumber);
        }
        if (!eventsByOrder.has(wo.id)) eventsByOrder.set(wo.id, []);
        const cmdMap = new Map();
        for (const cmd of wo.commands ?? []) {
          cmdMap.set(cmd.clientMessageId, cmd);
        }
        commandIndexByOrder.set(wo.id, cmdMap);
        if (!eventDedupeByOrder.has(wo.id))
          eventDedupeByOrder.set(wo.id, new Set());
      } else if (rec.op === "event.append" && rec.event?.workOrderId) {
        const ev = rec.event;
        const list = eventsByOrder.get(ev.workOrderId) ?? [];
        const dedupe = eventDedupeByOrder.get(ev.workOrderId) ?? new Set();
        if (!dedupe.has(ev.id)) {
          list.push(ev);
          dedupe.add(ev.id);
          if (ev.idempotencyKey) dedupe.add(`key:${ev.idempotencyKey}`);
          eventsByOrder.set(ev.workOrderId, list);
          eventDedupeByOrder.set(ev.workOrderId, dedupe);
        }
      }
    },
  );

  // Persist compact snapshot cleanly at startup if any records were replayed or repaired
  const writeSnapshotAtomically = () =>
    writeJsonAtomically(snapshotFile, {
      payloadVersion: WORK_ORDER_PAYLOAD_VERSION,
      nextOrderNumber,
      orders: Object.fromEntries(orders),
      eventsByOrder: Object.fromEntries(eventsByOrder),
    });

  if (repaired || hadRecords) {
    await writeSnapshotAtomically();
  }

  const serial = createSerialQueue();

  /** @param {WorkOrderJournalRecord} record */
  const appendJournalRecord = (record) => appendJsonLine(journalFile, record);

  function notifyObservers() {
    try {
      onChange();
    } catch {
      /* observers must not fail committed state */
    }
  }

  /** @param {WorkOrder} order */
  async function saveOrder(order) {
    orders.set(order.id, order);
    await appendJournalRecord({
      op: "order.put",
      nextOrderNumber,
      order,
    });
    await writeSnapshotAtomically();
    notifyObservers();
    return structuredClone(order);
  }

  /**
   * @param {string} workOrderId
   * @param {WorkEventInput} input
   */
  async function appendEventInternal(workOrderId, input) {
    const wo = orders.get(workOrderId);
    if (!wo) throw new WorkOrderError("Encargo no encontrado.", 404);
    if (!EVENT_TYPES.has(input.type)) {
      throw new WorkOrderError(
        `Tipo de evento no permitido: ${input.type}`,
        400,
      );
    }

    const list = eventsByOrder.get(workOrderId) ?? [];
    const dedupe = eventDedupeByOrder.get(workOrderId) ?? new Set();

    if (input.id && dedupe.has(input.id)) {
      // The dedupe set only holds ids of events in the list.
      const existing = /** @type {WorkEvent} */ (
        list.find((e) => e.id === input.id)
      );
      return { event: structuredClone(existing), duplicated: true };
    }
    if (input.idempotencyKey && dedupe.has(`key:${input.idempotencyKey}`)) {
      const existing = /** @type {WorkEvent} */ (
        list.find((e) => e.idempotencyKey === input.idempotencyKey)
      );
      return { event: structuredClone(existing), duplicated: true };
    }

    const sequence = list.length > 0 ? list[list.length - 1].sequence + 1 : 1;
    const recipient = input.recipient ?? { scope: "equipo", memberId: null };
    const visibility =
      input.visibility ?? defaultVisibilityForEvent(input.type, recipient);

    /** @type {WorkEvent} */
    const event = {
      id: input.id || randomUUID(),
      sequence,
      workOrderId,
      sourceId: input.sourceId ?? "service",
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      nativeItemId: input.nativeItemId ?? null,
      correlationId: input.correlationId ?? null,
      recipient,
      visibility,
      provenance: input.provenance ?? "observed",
      type: input.type,
      timestamp: input.timestamp ?? clock(),
      payloadVersion: WORK_ORDER_PAYLOAD_VERSION,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      payload: structuredClone(input.payload ?? {}),
    };

    await appendJournalRecord({ op: "event.append", event });
    list.push(event);
    dedupe.add(event.id);
    if (event.idempotencyKey) dedupe.add(`key:${event.idempotencyKey}`);
    eventsByOrder.set(workOrderId, list);
    eventDedupeByOrder.set(workOrderId, dedupe);

    // Apply safe side-effects on WorkOrder state without auto-completing on turn.completed
    let mutated = false;
    const updated = structuredClone(wo);
    if (input.type === "artifact.published" && input.payload?.fileRef) {
      const fileRef = input.payload.fileRef;
      const nextVersion =
        (updated.artifacts?.reduce(
          (m, a) => (a.fileRef === fileRef ? Math.max(m, a.version) : m),
          0,
        ) ?? 0) + 1;
      updated.artifacts.push({
        id: input.payload.artifactId || randomUUID(),
        workOrderId,
        sessionId: input.payload.sessionId ?? input.sessionId ?? null,
        authorId: input.payload.authorId || input.sourceId || "agente",
        fileRef: String(input.payload.fileRef),
        fileName: String(
          input.payload.fileName || path.basename(input.payload.fileRef),
        ),
        hash: String(input.payload.hash || input.payload.sha256 || ""),
        sha256: String(input.payload.sha256 || input.payload.hash || ""),
        bytesLength: input.payload.bytesLength ?? 0,
        mimeType: String(input.payload.mimeType || "application/octet-stream"),
        version: input.payload.version ?? nextVersion,
        summary: String(input.payload.summary || ""),
        comment: String(input.payload.comment || input.payload.summary || ""),
        immutable: Boolean(input.payload.immutable),
        evidenceRefs: Array.isArray(input.payload.evidenceRefs)
          ? input.payload.evidenceRefs.map(String)
          : [],
        verification: "pendiente",
        // appendEventInternal() always stamps the event (input ?? clock()).
        createdAt: /** @type {string} */ (event.timestamp),
      });
      mutated = true;
    } else if (input.type === "turn.started" && updated.status === "en_cola") {
      updated.status = "en_curso";
      mutated = true;
    } else if (
      input.type === "turn.completed" &&
      updated.status === "en_curso"
    ) {
      // Never marks "completado": moves at most to "verificando" awaiting explicit criteria verification.
      updated.status = "verificando";
      mutated = true;
    } else if (
      input.type === "turn.failed" &&
      updated.status !== "completado"
    ) {
      updated.status = "bloqueado";
      mutated = true;
    }

    if (mutated) {
      updated.revision += 1;
      updated.updatedAt = clock();
      await saveOrder(updated);
    } else {
      await writeSnapshotAtomically();
      notifyObservers();
    }

    return { event: structuredClone(event), duplicated: false };
  }

  return {
    list() {
      return structuredClone([...orders.values()]);
    },

    /** @param {string} workOrderId */
    get(workOrderId) {
      const wo = orders.get(workOrderId);
      return wo ? structuredClone(wo) : null;
    },

    /**
     * @param {string} workOrderId
     * @param {Viewer & { cursor?: number | string }} [options]
     */
    getSnapshotAndFeed(
      workOrderId,
      { cursor = 0, recipientScope, memberId } = {},
    ) {
      const wo = orders.get(workOrderId);
      if (!wo) return null;
      const numericCursor = Number(cursor);
      if (!Number.isSafeInteger(numericCursor) || numericCursor < 0) {
        throw new WorkOrderError("Cursor de eventos inválido.", 400);
      }
      const list = eventsByOrder.get(workOrderId) ?? [];
      const lastSequence = list.length > 0 ? list[list.length - 1].sequence : 0;
      const tail = list.filter((e) => e.sequence > numericCursor);
      const filtered = filterEventsForViewer(tail, {
        recipientScope,
        memberId,
      });
      return {
        snapshot: filterSnapshotForViewer(wo, { recipientScope, memberId }),
        cursor: lastSequence,
        events: structuredClone(filtered),
      };
    },

    /** @param {WorkOrderInput} input */
    createWorkOrder(input) {
      return serial(async () => {
        if (closed) throw new WorkOrderError("Almacén cerrado.", 503);
        const id = input.id || randomUUID();
        if (orders.has(id)) {
          throw new WorkOrderError("Ya existe un encargo con ese ID.", 409);
        }
        const title = String(input.title || "").trim();
        const objective = String(input.objective || "").trim();
        if (!title || !objective) {
          throw new WorkOrderError(
            "El encargo requiere título y objetivo.",
            400,
          );
        }
        const team = normalizeTeam(input.team, id);
        const acceptanceCriteria = normalizeCriteria(input.acceptanceCriteria);
        const now = clock();
        const code =
          input.code || `ENC-${String(nextOrderNumber++).padStart(3, "0")}`;

        /** @type {WorkOrder} */
        const order = {
          payloadVersion: WORK_ORDER_PAYLOAD_VERSION,
          id,
          code,
          title,
          projectId: String(input.projectId || "general").trim(),
          objective,
          expectedOutcome: String(input.expectedOutcome || "").trim(),
          acceptanceCriteria,
          teamRevision: 1,
          pendingTeamRevision: null,
          team,
          manifest: null,
          tasks: [],
          artifacts: [],
          handoffs: [],
          commands: [],
          status: "borrador",
          createdAt: now,
          updatedAt: now,
          revision: 1,
        };
        eventsByOrder.set(id, []);
        commandIndexByOrder.set(id, new Map());
        eventDedupeByOrder.set(id, new Set());
        return saveOrder(order);
      });
    },

    /**
     * @param {string} workOrderId
     * @param {{ team: WorkOrderMemberInput[], applyMode?: string, expectedRevision?: number, decisions?: unknown[], pending?: unknown[] }} options
     */
    updateTeam(
      workOrderId,
      {
        team,
        applyMode = "next_turn",
        expectedRevision,
        decisions = [],
        pending = [],
      },
    ) {
      return serial(async () => {
        const wo = orders.get(workOrderId);
        if (!wo) throw new WorkOrderError("Encargo no encontrado.", 404);
        if (
          expectedRevision !== undefined &&
          expectedRevision !== wo.revision
        ) {
          throw new WorkOrderError(
            "Conflicto de revisión al actualizar equipo.",
            409,
            { snapshot: structuredClone(wo) },
          );
        }
        if (wo.status === "completado" || wo.status === "cancelado") {
          throw new WorkOrderError(
            "No se puede editar el equipo de un encargo cerrado.",
            409,
          );
        }
        const normalizedTeam = normalizeTeam(team, workOrderId);
        const now = clock();
        const updated = structuredClone(wo);
        const prevTeamRevision = updated.teamRevision;
        updated.teamRevision += 1;
        updated.team = normalizedTeam;
        updated.revision += 1;
        updated.updatedAt = now;

        const isRunning = ACTIVE_WORK_ORDER_STATUSES.has(wo.status);
        if (isRunning) {
          updated.pendingTeamRevision = {
            teamRevision: updated.teamRevision,
            previousTeamRevision: prevTeamRevision,
            applyMode: applyMode === "handoff" ? "handoff" : "next_turn",
            registeredAt: now,
            preservesActiveManifest: true,
          };
          if (applyMode === "handoff") {
            const coord = normalizedTeam.find(
              (m) => m.assigned && m.coordinator,
            );
            updated.handoffs.push({
              id: randomUUID(),
              fromSessionId: `team-rev-${prevTeamRevision}`,
              toSessionId: coord ? `pending-${coord.id}` : "pending-next",
              teamRevision: updated.teamRevision,
              decisions: decisions.map(String),
              artifacts: updated.artifacts.map(
                (a) => `${a.fileRef}@v${a.version}`,
              ),
              pending: pending.map(String),
              acknowledgedAt: null,
              createdAt: now,
            });
          }
        }

        const saved = await saveOrder(updated);
        if (isRunning) {
          await appendEventInternal(workOrderId, {
            sourceId: "service",
            type: "member.status",
            provenance: "observed",
            payload: {
              reason: "team_revision_queued",
              previousTeamRevision: prevTeamRevision,
              teamRevision: updated.teamRevision,
              applyMode: updated.pendingTeamRevision?.applyMode,
            },
          });
        }
        return orders.get(workOrderId)
          ? structuredClone(orders.get(workOrderId))
          : saved;
      });
    },

    /**
     * @param {string} workOrderId
     * @param {{ expectedRevision?: number }} [options]
     */
    startWorkOrder(workOrderId, { expectedRevision } = {}) {
      return serial(async () => {
        const wo = orders.get(workOrderId);
        if (!wo) throw new WorkOrderError("Encargo no encontrado.", 404);
        if (
          expectedRevision !== undefined &&
          expectedRevision !== wo.revision
        ) {
          throw new WorkOrderError(
            "Conflicto de revisión al iniciar encargo.",
            409,
          );
        }
        if (wo.status !== "borrador") {
          throw new WorkOrderError(
            "Solo se puede iniciar un encargo en borrador.",
            409,
          );
        }
        const assigned = wo.team.filter((m) => m.assigned);
        const coordinator = assigned.find((m) => m.coordinator);
        if (!coordinator) {
          throw new WorkOrderError(
            "El encargo requiere una coordinadora asignada.",
            400,
          );
        }
        const now = clock();
        const manifestBase = {
          manifestVersion: 1,
          workOrderId: wo.id,
          teamRevision: wo.teamRevision,
          createdAt: now,
          projectId: wo.projectId,
          objective: wo.objective,
          expectedOutcome: wo.expectedOutcome,
          acceptanceCriteria: wo.acceptanceCriteria.map((c) => ({
            id: c.id,
            text: c.text,
          })),
          coordinatorId: coordinator.id,
          team: assigned,
        };
        const updated = structuredClone(wo);
        updated.manifest = {
          ...manifestBase,
          sha256: computeSha256(manifestBase),
        };
        updated.status = "en_curso";
        updated.revision += 1;
        updated.updatedAt = now;
        const saved = await saveOrder(updated);
        await appendEventInternal(workOrderId, {
          sourceId: "service",
          type: "turn.started",
          provenance: "observed",
          payload: {
            manifestSha256: updated.manifest.sha256,
            teamRevision: updated.teamRevision,
          },
        });
        return saved;
      });
    },

    /**
     * @param {string} workOrderId
     * @param {{ clientMessageId: string, recipient?: Recipient, mode?: string, text?: unknown, attachments?: unknown[], expectedRevision?: number }} options
     */
    enqueueMessage(
      workOrderId,
      {
        clientMessageId,
        recipient = { scope: "equipo", memberId: null },
        mode = "send",
        text,
        attachments = [],
        expectedRevision,
      },
    ) {
      return serial(async () => {
        const wo = orders.get(workOrderId);
        if (!wo) throw new WorkOrderError("Encargo no encontrado.", 404);
        if (!clientMessageId || typeof clientMessageId !== "string") {
          throw new WorkOrderError("clientMessageId obligatorio.", 400);
        }
        const cmdMap = commandIndexByOrder.get(workOrderId) ?? new Map();
        const existingCmd = cmdMap.get(clientMessageId);
        if (existingCmd) {
          return {
            command: structuredClone(existingCmd),
            snapshot: structuredClone(wo),
            repetido: true,
          };
        }
        if (
          expectedRevision !== undefined &&
          expectedRevision !== wo.revision
        ) {
          throw new WorkOrderError(
            "Conflicto de revisión al enviar mensaje.",
            409,
          );
        }
        if (wo.status === "completado" || wo.status === "cancelado") {
          throw new WorkOrderError(
            "El encargo está cerrado y no admite nuevos mensajes.",
            409,
          );
        }
        if (!["send", "steer", "queue"].includes(mode)) {
          throw new WorkOrderError("Modo de envío inválido.", 400);
        }
        const targetScope =
          recipient?.scope === "directo" ? "directo" : "equipo";
        if (
          targetScope === "directo" &&
          (!recipient?.memberId ||
            !wo.team.some((m) => m.id === recipient.memberId && m.assigned))
        ) {
          throw new WorkOrderError(
            "Destinatario directo no asignado en este encargo.",
            400,
          );
        }

        const now = clock();
        const deliveryStatus = mode === "queue" ? "en_cola" : "recibido";
        /** @type {WorkOrderCommand} */
        const command = {
          id: randomUUID(),
          workOrderId,
          clientMessageId,
          deliveryStatus,
          recipient: {
            scope: targetScope,
            memberId: targetScope === "directo" ? recipient.memberId : null,
          },
          mode,
          text: String(text || "").trim(),
          attachments: attachments.map(String),
          createdAt: now,
          updatedAt: now,
        };
        if (!command.text && command.attachments.length === 0) {
          throw new WorkOrderError("El mensaje no puede estar vacío.", 400);
        }

        const updated = structuredClone(wo);
        updated.commands.push(command);
        updated.revision += 1;
        updated.updatedAt = now;
        await saveOrder(updated);
        cmdMap.set(clientMessageId, command);
        commandIndexByOrder.set(workOrderId, cmdMap);

        const evRes = await appendEventInternal(workOrderId, {
          sourceId: "app",
          correlationId: command.id,
          idempotencyKey: `cmd:${clientMessageId}`,
          recipient: command.recipient,
          visibility: targetScope === "directo" ? "directo" : "equipo",
          provenance: "observed",
          type: mode === "queue" ? "message.queued" : "message.accepted",
          payload: {
            commandId: command.id,
            clientMessageId,
            deliveryStatus,
            mode,
            text: command.text,
            attachments: command.attachments,
          },
        });

        command.sequence = evRes.event.sequence;
        return {
          command: structuredClone(command),
          snapshot: structuredClone(orders.get(workOrderId)),
          event: evRes.event,
          repetido: false,
        };
      });
    },

    /**
     * @param {string} workOrderId
     * @param {string} commandId
     * @param {string} deliveryStatus
     */
    updateCommandDeliveryStatus(workOrderId, commandId, deliveryStatus) {
      return serial(async () => {
        if (!DELIVERY_STATUSES.has(deliveryStatus)) {
          throw new WorkOrderError("Estado de entrega inválido.", 400);
        }
        const wo = orders.get(workOrderId);
        if (!wo) throw new WorkOrderError("Encargo no encontrado.", 404);
        const updated = structuredClone(wo);
        const cmd = updated.commands.find(
          (c) => c.id === commandId || c.clientMessageId === commandId,
        );
        if (!cmd) throw new WorkOrderError("Comando no encontrado.", 404);
        cmd.deliveryStatus = deliveryStatus;
        cmd.updatedAt = clock();
        updated.revision += 1;
        updated.updatedAt = cmd.updatedAt;
        return saveOrder(updated);
      });
    },

    /**
     * @param {string} workOrderId
     * @param {WorkEventInput} eventInput
     */
    appendEvent(workOrderId, eventInput) {
      return serial(async () => {
        if (closed) throw new WorkOrderError("Almacén cerrado.", 503);
        return appendEventInternal(workOrderId, eventInput);
      });
    },

    /**
     * @param {string} workOrderId
     * @param {{ fromSessionId?: unknown, toSessionId?: unknown, decisions?: unknown, artifacts?: unknown, pending?: unknown, acknowledgedAt?: string | null }} input
     */
    createHandoff(workOrderId, input) {
      return serial(async () => {
        const wo = orders.get(workOrderId);
        if (!wo) throw new WorkOrderError("Encargo no encontrado.", 404);
        const now = clock();
        const handoff = {
          id: randomUUID(),
          fromSessionId: String(input.fromSessionId || ""),
          toSessionId: String(input.toSessionId || ""),
          teamRevision: wo.teamRevision,
          decisions: Array.isArray(input.decisions)
            ? input.decisions.map(String)
            : [],
          artifacts: Array.isArray(input.artifacts)
            ? input.artifacts.map(String)
            : [],
          pending: Array.isArray(input.pending)
            ? input.pending.map(String)
            : [],
          acknowledgedAt: input.acknowledgedAt ?? null,
          createdAt: now,
        };
        const updated = structuredClone(wo);
        updated.handoffs.push(handoff);
        updated.revision += 1;
        updated.updatedAt = now;
        const snapshot = await saveOrder(updated);
        return { handoff, snapshot };
      });
    },

    /**
     * @param {string} workOrderId
     * @param {{ criteriaUpdates?: (AcceptanceCriterionInput & { id: string })[], complete?: boolean, note?: unknown, actor?: string }} [options]
     */
    verifyWorkOrder(
      workOrderId,
      { criteriaUpdates = [], complete = false, note = "", actor = "app" } = {},
    ) {
      return serial(async () => {
        const wo = orders.get(workOrderId);
        if (!wo) throw new WorkOrderError("Encargo no encontrado.", 404);
        const updated = structuredClone(wo);
        for (const patch of criteriaUpdates) {
          const crit = updated.acceptanceCriteria.find(
            (c) => c.id === patch.id,
          );
          if (crit) {
            if (typeof patch.checked === "boolean")
              crit.checked = patch.checked;
            if (Array.isArray(patch.evidenceRefs)) {
              crit.evidenceRefs = patch.evidenceRefs.map(String);
            }
          }
        }
        const allChecked = updated.acceptanceCriteria.every((c) => c.checked);
        if (complete && !allChecked) {
          throw new WorkOrderError(
            "Faltan criterios de aceptación sin verificar antes de completar el encargo.",
            409,
          );
        }
        const now = clock();
        updated.status = complete ? "completado" : "verificando";
        updated.revision += 1;
        updated.updatedAt = now;
        await saveOrder(updated);
        if (complete) {
          await appendEventInternal(workOrderId, {
            sourceId: actor,
            type: "verification.completed",
            provenance: "observed",
            payload: {
              allCriteriaVerified: true,
              note: String(note || ""),
            },
          });
        }
        return structuredClone(orders.get(workOrderId));
      });
    },

    async close() {
      closed = true;
      await serial.drain();
    },
  };
}
