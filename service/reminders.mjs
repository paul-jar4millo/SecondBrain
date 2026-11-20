import { stableId } from "./vault.mjs";

// Notifications for vault commitments that are due, computed on read and never stored.
/**
 * @param {import("./vault-types.d.ts").VaultItem[]} items
 */
export function reminders(items) {
  const now = Date.now();
  return items
    .filter(
      (i) =>
        !i.deleted &&
        !["done", "cancelled"].includes(i.status ?? "") &&
        ["task", "event", "obligation", "statement"].includes(i.kind),
    )
    .flatMap((i) => {
      const instant = i.startsAt
        ? Date.parse(i.startsAt) - 15 * 60000
        : Date.parse(
            (i.kind === "statement" ? i.dueDate : i.date) + "T09:00:00-06:00",
          );
      if (
        !Number.isFinite(instant) ||
        instant > now ||
        instant < now - 2 * 86400000
      )
        return [];
      return [
        {
          id: stableId("notice:" + i.id + ":" + instant),
          kind: "notification",
          title: i.title,
          body: "Este compromiso del vault necesita atención.",
          source: i.id,
          status: "unread",
          version: 0,
          createdAt: new Date(instant).toISOString(),
          updatedAt: i.updatedAt,
        },
      ];
    });
}
