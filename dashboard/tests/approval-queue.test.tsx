// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalQueue } from "../src/features/team/ApprovalQueue";

afterEach(cleanup);
it("oculta los detalles hasta revisarlos y solo entonces permite aprobar", async () => {
  const decide = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(
    <ApprovalQueue
      solicitudes={[
        {
          id: "solicitud",
          actor: "agente:menta",
          estado: "pendiente",
          vence: Date.now() + 60000,
          operacion: { op: "pago", amount: 1234 },
        },
      ]}
      onDecision={decide}
    />,
  );
  expect(screen.queryByText("1234")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Aprobar" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Revisar operación" }));
  expect(screen.getByText("1234")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Aprobar" }));
  expect(decide).toHaveBeenCalledWith("solicitud", true);
});

it("impide aprobar una solicitud vencida", async () => {
  const decide = vi.fn();
  const user = userEvent.setup();
  render(
    <ApprovalQueue
      solicitudes={[
        {
          id: "vencida",
          actor: "agente:lira",
          estado: "pendiente",
          vence: Date.now() - 1,
          operacion: { op: "pago" },
        },
      ]}
      onDecision={decide}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Revisar operación" }));
  expect(
    (screen.getByRole("button", { name: "Aprobar" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText("Tiempo agotado")).toBeTruthy();
  expect(decide).not.toHaveBeenCalled();
});
