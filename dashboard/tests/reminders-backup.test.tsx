// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UI } from "../src/components/ui";
import { RemindersDialog } from "../src/app/RemindersDialog";

vi.mock("../src/core/store", () => ({ save: vi.fn(async () => {}) }));
beforeAll(() => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

const ui = {
  items: [],
  edit: vi.fn(),
  trash: vi.fn(),
  notify: vi.fn(),
  ask: vi.fn(),
  openAgent: vi.fn(),
  openTeam: vi.fn(),
};

it("shows a failed backup ahead of the reminders, with the last good one", () => {
  render(
    <UI.Provider value={ui}>
      <RemindersDialog
        reminders={[]}
        backup={{ status: "failed", lastSuccess: "2026-11-19T01:34:08.941Z" }}
        onClose={() => {}}
      />
    </UI.Provider>,
  );
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("El último respaldo externo falló");
  expect(alert.textContent).toContain("Último respaldo correcto:");
  expect(screen.queryByText("No hay recordatorios pendientes.")).toBeNull();
});

it("says so when no backup ever succeeded", () => {
  render(
    <UI.Provider value={ui}>
      <RemindersDialog
        reminders={[]}
        backup={{ status: "stale", lastSuccess: null }}
        onClose={() => {}}
      />
    </UI.Provider>,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "No hay un respaldo correcto registrado.",
  );
});

it("keeps the empty state when the backup is fine", () => {
  render(
    <UI.Provider value={ui}>
      <RemindersDialog reminders={[]} onClose={() => {}} />
    </UI.Provider>,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("No hay recordatorios pendientes.")).toBeTruthy();
});
