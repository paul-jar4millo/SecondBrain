import { expect, it } from "vitest";
import { visibleReminders } from "../src/core/reminders";
import { newItem } from "../src/core/model";
it("excludes hidden notes and deleted sources without mutating the store order", () => {
  const note = newItem("note"),
    task = newItem("task"),
    removed = { ...newItem("event"), deleted: true };
  const a = {
    ...newItem("notification"),
    source: task.id,
    createdAt: "2026-11-06",
  };
  const b = {
    ...newItem("notification"),
    source: task.id,
    createdAt: "2026-11-07",
  };
  const input = [
    note,
    task,
    removed,
    a,
    b,
    { ...newItem("notification"), source: note.id },
    { ...newItem("notification"), source: removed.id },
  ];
  expect(visibleReminders(input)).toEqual([b, a]);
  expect(input[3]).toBe(a);
});
