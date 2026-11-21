// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalPanel } from "../src/features/finance/ApprovalPanel";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/core/store", () => ({ isDemo: false }));
vi.mock("../src/core/events", () => ({ subscribeChanges: () => () => {} }));
vi.mock("../src/features/agents/agent-api", () => ({ agentApi: fixture.api }));
afterEach(() => {
  cleanup();
  fixture.api.mockReset();
});
it("carga solicitudes, permite rechazarlas y vuelve a consultar", async () => {
  fixture.api
    .mockResolvedValueOnce([
      {
        id: "a",
        actor: "agente:lira",
        estado: "pendiente",
        vence: Date.now() + 60000,
        operacion: { op: "pago" },
      },
    ])
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce([]);
  const user = userEvent.setup();
  render(<ApprovalPanel />);
  await screen.findByText("lira solicita una operación");
  await user.click(screen.getByRole("button", { name: "Rechazar" }));
  expect(fixture.api).toHaveBeenCalledWith("/approvals/decide", {
    id: "a",
    aprobar: false,
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  expect(
    await screen.findByText("No hay solicitudes pendientes."),
  ).toBeTruthy();
});

it("reintenta con el mismo requestId tras un fallo de red y muestra el recibo", async () => {
  const receipt = {
    requestId: "11111111-1111-4111-8111-111111111111",
    aprobacionId: "a",
    decision: "aprobada",
    por: "owner",
    ts: Date.now(),
    resultado: "Aprobada: la operación continúa.",
  };
  const pending = {
    id: "a",
    actor: "agente:menta",
    estado: "pendiente",
    vence: Date.now() + 60000,
    operacion: { op: "init" },
  };
  const enviados: string[] = [];
  fixture.api.mockImplementation(
    async (path: string, body?: { requestId: string }) => {
      if (path === "/approvals")
        return enviados.length
          ? [
              {
                ...pending,
                estado: "aprobada",
                recibo: receipt,
                resuelta: Date.now(),
              },
            ]
          : [pending];
      enviados.push(body!.requestId);
      if (enviados.length === 1) throw new Error("Failed to fetch");
      return { ok: true, recibo: receipt, repetido: false };
    },
  );
  const user = userEvent.setup();
  render(<ApprovalPanel />);
  await screen.findByText("menta solicita una operación");
  await user.click(screen.getByRole("button", { name: "Revisar operación" }));
  await user.click(screen.getByRole("button", { name: "Aprobar" }));
  await waitFor(() => expect(enviados.length).toBe(2), { timeout: 3000 });
  expect(enviados[0]).toBe(enviados[1]);
  expect(
    (await screen.findAllByText(/Aprobado por owner a las/)).length,
  ).toBeGreaterThan(0);
});

it("ante un 409 con recibo informa quién resolvió la solicitud sin reintentar", async () => {
  const receipt = {
    requestId: "22222222-2222-4222-8222-222222222222",
    aprobacionId: "a",
    decision: "rechazada",
    por: "app",
    ts: Date.now(),
    resultado: "Rechazada",
  };
  let intentos = 0;
  fixture.api.mockImplementation(async (path: string) => {
    if (path === "/approvals")
      return [
        {
          id: "a",
          actor: "agente:menta",
          estado: "pendiente",
          vence: Date.now() + 60000,
          operacion: { op: "init" },
        },
      ];
    intentos++;
    throw Object.assign(
      new Error("La solicitud ya fue resuelta con otra decisión."),
      {
        status: 409,
        recibo: receipt,
      },
    );
  });
  const user = userEvent.setup();
  render(<ApprovalPanel />);
  await screen.findByText("menta solicita una operación");
  await user.click(screen.getByRole("button", { name: "Rechazar" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getAllByText(/Rechazado por ti a las/).length).toBeGreaterThan(
    0,
  );
  expect(intentos).toBe(1);
});
