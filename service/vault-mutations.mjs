import { mexicoDay } from "./finance-domain.mjs";
import { Document } from "yaml";
import { Failure } from "./vault-identity.mjs";
import {
  uuid,
  fields,
  native,
  types,
  folders,
  split,
} from "./vault-format.mjs";
import { validate } from "./vault-validation.mjs";
import path from "node:path";
/** @import { VaultMetadata, VaultMutation, VaultRecord } from "./vault-types.d.ts" */
/**
 * @this {import("./vault.mjs").Vault}
 * @param {VaultMutation} mutation
 */
export async function apply({ mutationId, baseVersion, entity }) {
  if (!uuid.test(mutationId || ""))
    throw new Failure("La operación necesita una identidad válida.");
  const snapshot = await this.snapshot();
  const old = snapshot.records.get(entity?.id);
  if (old?.sb?.lastMutation === mutationId) {
    if (old.sb.createdByApp) await this.index(old.item.id);
    if (
      old.item.kind === "task" &&
      old.item.status === "done" &&
      old.item.recurrence
    )
      await this.repeat(old.item);
    return (await this.snapshot()).records.get(old.item.id)?.item || old.item;
  }
  if (
    old &&
    (old.parts.doc.errors.length ||
      old.item.validationErrors?.includes(
        "Identificador duplicado en el vault.",
      ))
  )
    throw new Failure("Corrige el frontmatter del archivo antes de editarlo.");
  if ((old?.item.version ?? 0) !== baseVersion)
    throw new Failure(
      "El archivo cambió en Obsidian u otro dispositivo. Conserva una copia o utiliza la versión actual.",
      409,
      old?.item,
    );
  const item = structuredClone(entity);
  const errors = validate(item, snapshot.items);
  if (errors.length) throw new Failure(errors.join(" "));
  if (
    old &&
    old.item.kind !== item.kind &&
    !(old.item.kind === "inbox" && ["task", "note"].includes(item.kind))
  )
    throw new Failure("No se puede cambiar el tipo de este registro.");
  if (old?.item.kind === "transaction")
    throw new Failure(
      "Los movimientos confirmados se corrigen con otro movimiento. El archivo original se conserva.",
    );
  if (
    item.kind === "account" &&
    item.deleted &&
    snapshot.items.some(
      (t) =>
        t.kind === "transaction" &&
        (t.accountId === item.id || t.otherAccountId === item.id),
    )
  )
    throw new Failure("No se elimina una cuenta que tiene movimientos.");
  if (
    item.kind === "task" &&
    item.priority &&
    item.status !== "done" &&
    snapshot.items.filter(
      (x) =>
        x.kind === "task" &&
        !x.deleted &&
        x.id !== item.id &&
        x.priority &&
        !["done", "cancelled"].includes(x.status ?? ""),
    ).length >= 3
  )
    throw new Failure("Ya tienes tres prioridades.");
  if (
    old?.item.sourceKind === "inline-task" ||
    (!old && item.kind === "task")
  ) {
    /** @type {(Pick<VaultRecord, "relative" | "text" | "parts"> & { fileHash: string | null }) | undefined} */
    let parent = old;
    if (!parent) {
      const project = snapshot.records.get(item.projectId ?? "");
      if (project?.item.kind === "project") parent = project;
      else {
        const relative = "00-Inbox/Tareas/_Tareas.md";
        parent = snapshot.byPath.get(relative);
        if (!parent) {
          const text =
            "---\ntype: moc\nstatus: active\ntags: [moc, tareas]\n---\n\n# Tareas\n\n";
          parent = { relative, text, parts: split(text), fileHash: null };
        }
      }
    }

    /** @type {VaultMetadata} */
    const extra = {
      ...(old?.sb || {}),
      createdByApp: old ? old.sb.createdByApp === true : true,
    };
    for (const key of [
      "priority",
      "recurrence",
      "recurrenceDay",
      "projectId",
      "area",
      "body",
      "deleted",
    ])
      if (item[key] !== undefined) extra[key] = item[key];
    const marker = item.deleted
      ? "-"
      : item.status === "done"
        ? "x"
        : item.status === "cancelled"
          ? "-"
          : item.status === "doing"
            ? "/"
            : " ";
    const text = `${old?.marker || "- "}[${marker}] ${item.title}${item.date ? " 📅 " + item.date : ""}${item.plannedDate ? " ⏳ " + item.plannedDate : ""} <!-- sb-task:${JSON.stringify({ ...extra, lastMutation: mutationId }).replaceAll("-->", "--\\u003e")} --> ^sb-${item.id}`;
    const lines = parent.parts.body.split(/\r?\n/);
    if (old) lines[/** @type {number} */ (old.lineIndex)] = text;
    else {
      if (lines.at(-1) === "") lines.pop();
      lines.push(text, "");
    }
    const prefix = parent.text.slice(
      0,
      parent.text.length - parent.parts.body.length,
    );
    await this.atomic(
      parent.relative,
      prefix + lines.join(parent.parts.newline),
      parent.fileHash,
    );
  } else {
    const relative =
      old?.relative ||
      path.posix.join(
        folders[item.kind],
        (item.title
          .normalize("NFKD")
          .replace(/\p{M}/gu, "")
          .replace(/[^\p{L}\p{N}]+/gu, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 40) || "Nota") +
          "-" +
          item.id +
          ".md",
      );
    const doc =
      old?.parts.doc ||
      new Document({
        type: types[item.kind],
        status: item.status || "active",
        tags: [],
        updated: mexicoDay(),
      });
    doc.set("title", item.title);
    if (item.status !== undefined) doc.set("status", item.status);
    if (item.tags !== undefined) doc.set("tags", item.tags);
    if (item.area !== undefined) doc.set("area", item.area);
    doc.set("updated", mexicoDay());
    for (const [key, fm] of [
      ["verifiedAt", "verified"],
      ["expiresAt", "expires"],
    ])
      if (Object.hasOwn(item, key)) {
        if (item[key]) doc.set(fm, item[key]);
        else doc.delete(fm);
      }
    /** @type {VaultMetadata} */
    const sb = {
      ...(old?.sb || {}),
      id: item.id,
      kind: item.kind,
      createdAt:
        old?.item.createdAt || item.createdAt || new Date().toISOString(),
      lastMutation: mutationId,
      createdByApp: old ? old.sb.createdByApp === true : true,
    };
    for (const [key, value] of Object.entries(item))
      if (
        !native.has(key) &&
        fields.includes(key) &&
        !["startsAt", "endsAt"].includes(key) &&
        value !== undefined
      ) {
        doc.set(key, value);
        delete sb[key];
      }
    sb.deleted = item.deleted === true;
    doc.set("second_brain", sb);
    const newline = old?.parts.newline || "\n";
    let body = item.body ?? old?.parts.body ?? "";
    if (old && old.item.title !== item.title) {
      body = body.replace(/^# .+$/m, (heading) =>
        heading === "# " + old.item.title ? "# " + item.title : heading,
      );
    }
    const content =
      "---" +
      newline +
      doc.toString({ lineWidth: 0 }).trimEnd().replace(/\n/g, newline) +
      newline +
      "---" +
      newline +
      body;
    await this.atomic(relative, content, old?.fileHash ?? null);
  }
  if (!old) await this.index(item.id);
  if (
    item.kind === "task" &&
    item.status === "done" &&
    old?.item.status !== "done" &&
    item.recurrence &&
    (item.date || item.plannedDate)
  )
    await this.repeat(item);
  const latest = await this.snapshot();
  return latest.records.get(item.id)?.item || item;
}
