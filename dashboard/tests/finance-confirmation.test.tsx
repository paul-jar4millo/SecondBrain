// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TxEditDialog } from "../src/features/finance/FinanceForms";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("eliminar un movimiento exige confirmación y cancelar conserva el editor", async () => {
  vi.stubGlobal("confirm", () => false);
  const run = vi.fn(async () => {}),
    close = vi.fn(),
    user = userEvent.setup();
  render(
    <TxEditDialog
      tx={{
        id: "t1",
        date: "2026-11-09",
        card: "synthetic",
        desc: "Ejemplo",
        amountMinor: 1000,
        type: "charge",
      }}
      categories={[]}
      run={run}
      onClose={close}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Eliminar" }));
  const decision = screen.getByRole("dialog", { name: "Confirmar acción" });
  expect(run).not.toHaveBeenCalled();
  await user.click(within(decision).getByRole("button", { name: "Cancelar" }));
  expect(screen.getByRole("dialog", { name: "Ejemplo" })).toBeTruthy();
  expect(run).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Eliminar" }));
  await user.click(
    within(screen.getByRole("dialog", { name: "Confirmar acción" })).getByRole(
      "button",
      { name: "Eliminar" },
    ),
  );
  expect(run).toHaveBeenCalledExactlyOnceWith({ op: "tx-delete", id: "t1" });
  expect(close).toHaveBeenCalledExactlyOnceWith();
});
