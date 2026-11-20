// @vitest-environment jsdom
import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ItemEditor, UI } from "../src/components/ui";
import { newItem } from "../src/core/model";
const persistence = vi.hoisted(() => ({
  save: vi.fn(async () => {}),
  get: vi.fn<(...args: unknown[]) => Promise<{ value: string } | undefined>>(
    async () => undefined,
  ),
  put: vi.fn<(draft: { key: string; value: string }) => Promise<void>>(
    async () => {},
  ),
  delete: vi.fn(async () => {}),
}));
vi.mock("../src/core/store", () => ({
  save: persistence.save,
  db: {
    meta: {
      get: persistence.get,
      put: persistence.put,
      delete: persistence.delete,
    },
  },
}));
beforeAll(() => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("keeps an invalid transfer open and saves only after choosing a different destination", async () => {
  const user = userEvent.setup(),
    close = vi.fn(),
    notify = vi.fn();
  const a = { ...newItem("account"), title: "Débito", accountType: "asset" },
    b = { ...newItem("account"), title: "Reserva", accountType: "asset" };
  const transfer = {
    ...newItem("transaction"),
    title: "Traslado",
    transactionType: "transfer",
    amountMinor: 2500,
    accountId: a.id,
  };
  render(
    <MemoryRouter>
      <UI.Provider
        value={{
          items: [a, b],
          edit: vi.fn(),
          trash: vi.fn(),
          notify,
          ask: vi.fn(),
          openThread: vi.fn(),
        }}
      >
        <ItemEditor value={transfer} onClose={close} />
      </UI.Provider>
    </MemoryRouter>,
  );
  await user.click(screen.getByRole("button", { name: "Guardar" }));
  expect(
    await screen.findByText("Elige una cuenta de destino distinta."),
  ).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  expect(persistence.save).not.toHaveBeenCalled();
  await user.selectOptions(screen.getByLabelText(/Hacia la cuenta/), b.id);
  await user.click(screen.getByRole("button", { name: "Guardar" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(persistence.save).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: a.id,
      otherAccountId: b.id,
      amountMinor: 2500,
    }),
  );
  expect(persistence.delete).toHaveBeenCalledWith("draft:" + transfer.id);
});

it("recovers the typed task after closing and reopening its local draft", async () => {
  const user = userEvent.setup();
  const value = newItem("task");
  const context = {
    items: [],
    edit: vi.fn(),
    trash: vi.fn(),
    notify: vi.fn(),
    ask: vi.fn(),
    openThread: vi.fn(),
  };
  const view = render(
    <UI.Provider value={context}>
      <ItemEditor value={value} onClose={vi.fn()} />
    </UI.Provider>,
  );
  await user.type(screen.getByLabelText("Título"), "Preparar la entrega");
  await waitFor(() => expect(persistence.put).toHaveBeenCalled());
  view.unmount();
  const draft = persistence.put.mock.calls.at(-1)![0];
  persistence.get.mockResolvedValueOnce({ value: draft.value });
  render(
    <UI.Provider value={context}>
      <ItemEditor value={value} onClose={vi.fn()} />
    </UI.Provider>,
  );
  await waitFor(() =>
    expect((screen.getByLabelText("Título") as HTMLInputElement).value).toBe(
      "Preparar la entrega",
    ),
  );
  expect(screen.getByText("Borrador local recuperado.")).toBeTruthy();
  expect(persistence.save).not.toHaveBeenCalled();
});
