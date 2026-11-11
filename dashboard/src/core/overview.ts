import { active, type Item } from "./model";

export function taskOverview(items: Item[], day: string) {
  const tasks = active(items, "task").filter((t) => t.status !== "cancelled");
  const done = tasks.filter((t) => t.status === "done").length;
  const pending = tasks.filter((t) => t.status !== "done");
  return {
    total: tasks.length,
    done,
    pending: pending.length,
    overdue: pending.filter((t) => t.date && t.date < day).length,
    today: pending.filter((t) => t.date === day || t.plannedDate === day)
      .length,
    waiting: pending.filter((t) => t.status === "waiting").length,
    percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
  };
}

export const searchableItems = (items: Item[]) =>
  items.filter(
    (x) => !x.deleted && ["task", "inbox", "project", "event"].includes(x.kind),
  );

export function projectOverview(items: Item[], id: string, day: string) {
  const tasks = active(items, "task").filter(
    (t) => t.projectId === id && t.status !== "cancelled",
  );
  return {
    ...taskOverview(tasks, day),
    next: tasks
      .filter((t) => t.status !== "done")
      .sort((a, b) =>
        (a.date || a.plannedDate || "9999").localeCompare(
          b.date || b.plannedDate || "9999",
        ),
      )[0],
  };
}

export const chartPercent = (value: number, total: number) =>
  Number.isFinite(value) && Number.isFinite(total) && total > 0
    ? Math.max(0, Math.min(100, (value / total) * 100))
    : 0;
