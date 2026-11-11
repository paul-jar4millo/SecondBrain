// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useConfirmation } from "../src/components/useConfirmation";
import { useEffect } from "react";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

function Harness({ complete }: { complete: (accepted: boolean) => void }) {
  const { confirm, confirmation } = useConfirmation();
  return (
    <>
      <button
        onClick={async () =>
          complete(
            await confirm("¿Eliminar el ejemplo?", {
              confirmLabel: "Eliminar",
            }),
          )
        }
      >
        Abrir
      </button>
      {confirmation}
    </>
  );
}

it("cancela sin ejecutar la acción y devuelve el foco al botón que abrió", async () => {
  const complete = vi.fn();
  const user = userEvent.setup();
  render(<Harness complete={complete} />);
  const opener = screen.getByRole("button", { name: "Abrir" });
  await user.click(opener);
  expect(screen.getByRole("dialog").textContent).toContain(
    "¿Eliminar el ejemplo?",
  );
  await user.click(screen.getByRole("button", { name: "Cancelar" }));
  expect(complete).toHaveBeenCalledWith(false);
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it("confirma solo después de la acción explícita", async () => {
  const complete = vi.fn();
  const user = userEvent.setup();
  render(<Harness complete={complete} />);
  await user.click(screen.getByRole("button", { name: "Abrir" }));
  expect(complete).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Eliminar" }));
  expect(complete).toHaveBeenCalledExactlyOnceWith(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("Escape cancela la confirmación", async () => {
  const complete = vi.fn();
  const user = userEvent.setup();
  render(<Harness complete={complete} />);
  await user.click(screen.getByRole("button", { name: "Abrir" }));
  await user.click(screen.getByRole("button", { name: "Cancelar" }));
  await user.click(screen.getByRole("button", { name: "Abrir" }));
  screen.getByRole("button", { name: "Cancelar" }).focus();
  await user.keyboard("{Escape}");
  expect(complete.mock.calls).toEqual([[false], [false]]);
});

it("desmontar resuelve la solicitud pendiente como cancelada", async () => {
  const complete = vi.fn();
  const user = userEvent.setup();
  const view = render(<Harness complete={complete} />);
  await user.click(screen.getByRole("button", { name: "Abrir" }));
  view.unmount();
  await waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith(false));
});

it("una llamada tardía después del desmontaje se cancela sin dejar una promesa pendiente", async () => {
  let confirm!: ReturnType<typeof useConfirmation>["confirm"];
  function LateHarness() {
    const decision = useConfirmation();
    useEffect(() => {
      confirm = decision.confirm;
    }, [decision.confirm]);
    return decision.confirmation;
  }
  const view = render(<LateHarness />);
  view.unmount();
  await expect(confirm("Solicitud tardía")).resolves.toBe(false);
});
