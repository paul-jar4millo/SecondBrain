import { describe, expect, it } from "vitest";
import { newItem } from "../src/core/model";
import { plural } from "../src/core/labels";
import {
  taskOverview,
  searchableItems,
  projectOverview,
  chartPercent,
} from "../src/core/overview";

describe("quick views", () => {
  it("does not inflate progress with deleted or cancelled tasks, or notes", () => {
    const summary = taskOverview(
      [
        newItem("task", { status: "done" }),
        newItem("task", { date: "2026-11-05" }),
        newItem("task", { plannedDate: "2026-11-06" }),
        newItem("task", { status: "waiting" }),
        newItem("task", { status: "cancelled" }),
        newItem("task", { status: "done", deleted: true }),
        newItem("note", { title: "Private source", status: "done" }),
      ],
      "2026-11-06",
    );
    expect(summary).toEqual({
      total: 4,
      done: 1,
      pending: 3,
      overdue: 1,
      today: 1,
      waiting: 1,
      percent: 25,
    });
    expect(taskOverview([], "2026-11-06").percent).toBe(0);
  });
  it("search does not expose source notes or deleted records", () => {
    const task = newItem("task", { title: "Visible action" });
    const note = newItem("note", { title: "Private source" });
    expect(
      searchableItems([task, note, newItem("task", { deleted: true })]),
    ).toEqual([task]);
    expect(note.deleted).toBeUndefined();
  });
  it("finds the earliest pending action and counts completion for only the requested project", () => {
    const summary = projectOverview(
      [
        newItem("task", { projectId: "a", status: "done" }),
        newItem("task", { projectId: "a", title: "Later", date: "2026-12-01" }),
        newItem("task", { projectId: "a", title: "Next", date: "2026-11-09" }),
        newItem("task", { projectId: "a", status: "cancelled" }),
        newItem("task", { projectId: "b", status: "done" }),
      ],
      "a",
      "2026-11-06",
    );
    expect(summary.total).toBe(3);
    expect(summary.done).toBe(1);
    expect(summary.next?.title).toBe("Next");
  });
  it("keeps chart widths finite without disguising overdrawn balances", () => {
    expect(chartPercent(20, 100)).toBe(20);
    expect(chartPercent(150, 100)).toBe(100);
    expect(chartPercent(-10, 100)).toBe(0);
    expect(chartPercent(10, 0)).toBe(0);
    expect(chartPercent(NaN, 10)).toBe(0);
  });
});

describe("plural", () => {
  it("agrees with the count", () => {
    expect(plural(1, "pendiente", "pendientes")).toBe("1 pendiente");
    expect(plural(0, "pendiente", "pendientes")).toBe("0 pendientes");
    expect(plural(3, "pendiente", "pendientes")).toBe("3 pendientes");
  });
});
