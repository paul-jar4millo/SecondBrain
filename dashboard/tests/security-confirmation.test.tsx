// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Security } from "../src/features/settings/Security";

vi.mock("../src/core/store", () => ({
  isDemo: false,
  api: async (path: string) =>
    path.endsWith("/start")
      ? { key: "SYNTHETIC" }
      : { codes: ["example-recovery-code"] },
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

it("cancelar el cierre conserva los códigos hasta confirmar que se guardaron", async () => {
  const user = userEvent.setup();
  render(<Security />);
  await user.click(screen.getByRole("button", { name: "Configurar" }));
  await user.type(screen.getByLabelText("Código de seis dígitos"), "123456");
  await user.click(screen.getByRole("button", { name: "Verificar y activar" }));
  const recovery = screen.getByRole("dialog", {
    name: "Códigos de recuperación",
  });
  await user.click(within(recovery).getByRole("button", { name: "Cerrar" }));
  await user.click(
    within(screen.getByRole("dialog", { name: "Confirmar acción" })).getByRole(
      "button",
      { name: "Cancelar" },
    ),
  );
  expect(screen.getByText("example-recovery-code")).toBeTruthy();
  await user.click(within(recovery).getByRole("button", { name: "Cerrar" }));
  await user.click(screen.getByRole("button", { name: "Ya los guardé" }));
  expect(screen.queryByText("example-recovery-code")).toBeNull();
});
