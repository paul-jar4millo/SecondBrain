// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  ConversationContent,
  ProviderConversation,
  type ProviderSnapshot,
} from "../src/features/team/ProviderConversation";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/features/team/team-store", () => ({ teamApi: fixture.api }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fixture.api.mockReset();
});
const state: ProviderSnapshot = {
  seq: 1,
  status: "trabajando",
  items: [{ id: "m1", tipo: "asistente", texto: "Investigación en curso" }],
  requests: [
    {
      id: "q1",
      kind: "question",
      title: "Modalidad",
      status: "pending",
      questions: [
        {
          id: "mode",
          question: "¿Qué modalidad?",
          options: [{ label: "Remoto" }, { label: "Híbrido" }],
        },
      ],
    },
  ],
};

it("conserva la pregunta al terminar el turno y envía la respuesta al ID correcto", async () => {
  fixture.api.mockResolvedValue({ status: "delivered" });
  const { rerender } = render(
    <ConversationContent id="s1" agentName="Menta" snapshot={state} />,
  );
  rerender(
    <ConversationContent
      id="s1"
      agentName="Menta"
      snapshot={{ ...state, status: "terminada", seq: 2 }}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Remoto" }));
  await user.click(screen.getByRole("button", { name: "Confirmar respuesta" }));
  expect(fixture.api).toHaveBeenCalledWith(
    "/agentes/conversacion/responder",
    expect.objectContaining({
      id: "s1",
      requestId: "q1",
      answers: { mode: "Remoto" },
    }),
  );
  expect(await screen.findByText(/Respuesta enviada/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Confirmar respuesta" }),
  ).toBeNull();
});

it("una pregunta vencida permanece legible pero no envía respuestas a otro turno", () => {
  render(
    <ConversationContent
      id="s1"
      agentName="Menta"
      snapshot={{
        ...state,
        requests: state.requests.map((r) => ({ ...r, status: "expired" })),
      }}
    />,
  );
  expect(screen.getByText("Modalidad")).toBeTruthy();
  expect(screen.getByText(/ya no está vigente/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Confirmar respuesta" }),
  ).toBeNull();
});

it("consume el stream de protocolo y no abre conexiones a terminal", async () => {
  let listener: (event: MessageEvent) => void = () => {};
  const close = vi.fn();
  const source = vi.fn(function (this: {
    addEventListener: unknown;
    close: unknown;
  }) {
    this.addEventListener = (name: string, fn: typeof listener) => {
      if (name === "conversation") listener = fn;
    };
    this.close = close;
  });
  vi.stubGlobal("EventSource", source);
  const { unmount } = render(
    <ProviderConversation id="s1" agentName="Menta" />,
  );
  await act(async () =>
    listener(new MessageEvent("conversation", { data: JSON.stringify(state) })),
  );
  expect(screen.getByText("Investigación en curso")).toBeTruthy();
  expect(source).toHaveBeenCalledWith(
    "/api/v1/agentes/conversacion/stream?id=s1",
  );
  expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
  unmount();
  expect(close).toHaveBeenCalledOnce();
});
