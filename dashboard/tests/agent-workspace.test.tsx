// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { UI } from "../src/components/ui";
import { newItem } from "../src/core/model";
import { AgentWorkspace } from "../src/features/team/AgentWorkspace";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  change: () => {},
}));
vi.mock("../src/core/store", () => ({ isDemo: false }));
vi.mock("../src/core/events", () => ({
  subscribeChanges: (fn: () => void) => {
    fixture.change = fn;
    return () => {};
  },
}));
vi.mock("../src/features/team/team-store", () => ({
  teamApi: fixture.api,
  useTeam: () => ({ agents: [] }),
}));
vi.mock("../src/features/team/ProviderConversation", () => ({
  ProviderConversation: () => <div>Conversación por protocolo</div>,
}));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  fixture.api.mockImplementation(async (route: string) =>
    route.startsWith("/agentes/sesiones")
      ? []
      : route === "/agentes/espacios"
        ? { revision: 0, vinculos: {}, repositorios: [] }
        : {},
  );
});
afterEach(() => {
  cleanup();
  fixture.api.mockReset();
  vi.unstubAllGlobals();
});

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}
function open() {
  render(
    <MemoryRouter initialEntries={["/team?project=p1&agent=ambar&chat=new"]}>
      <UI.Provider
        value={{
          items: ["p1", "p2"].map((id) => ({
            ...newItem("project"),
            id,
            title: id,
          })),
          edit: vi.fn(),
          trash: vi.fn(),
          ask: vi.fn(),
          notify: vi.fn(),
          openAgent: vi.fn(),
          openTeam: vi.fn(),
        }}
      >
        <AgentWorkspace />
        <Location />
      </UI.Provider>
    </MemoryRouter>,
  );
}

it("a delayed start never moves the user back or erases the draft of another project", async () => {
  let finish: (value: unknown) => void = () => {};
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((route: string, body?: unknown) =>
    route.startsWith("/agentes/sesiones") && body
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(route),
  );
  const user = userEvent.setup();
  open();
  await user.type(
    screen.getByRole("textbox", { name: "Mensaje para Ámbar" }),
    "Mensaje original",
  );
  await user.click(screen.getByRole("button", { name: "Abrir conversación" }));
  await user.selectOptions(screen.getByLabelText("Proyecto"), "p2");
  await user.type(
    screen.getByRole("textbox", { name: "Mensaje para Ámbar" }),
    "Borrador nuevo",
  );
  await act(async () =>
    finish({ id: "created", motor: "claude", espacioId: "p1" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Abrir conversación" }),
    ).toHaveProperty("disabled", false),
  );
  expect(screen.getByLabelText("Proyecto")).toHaveProperty("value", "p2");
  expect(
    screen.getByRole("textbox", { name: "Mensaje para Ámbar" }),
  ).toHaveProperty("value", "Borrador nuevo");
  expect(screen.getByTestId("location").textContent).toContain("project=p2");
});

it("removes the connection error after a successful reconnection", async () => {
  let disconnected = true;
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((route: string) =>
    route.startsWith("/agentes/sesiones") && disconnected
      ? Promise.reject(new Error("offline"))
      : original(route),
  );
  open();
  await screen.findByText(/No se pudo conectar/);
  disconnected = false;
  await act(async () => fixture.change());
  await waitFor(() =>
    expect(screen.queryByText(/No se pudo conectar/)).toBeNull(),
  );
});

it("offers Claude's effort with the default model and sends it", async () => {
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (route: string, body?: unknown) =>
    route === "/agentes/modelos-lanzador"
      ? {
          claude: [
            { id: "opus", nombre: "Opus", esfuerzos: ["low", "xhigh"] },
            { id: "haiku", nombre: "Haiku" },
          ],
        }
      : route.startsWith("/agentes/sesiones") && body
        ? { id: "s1" }
        : original(route),
  );
  open();
  const effort = await screen.findByLabelText("Razonamiento");
  await userEvent.selectOptions(effort, "xhigh");
  await userEvent.type(screen.getByLabelText(/Mensaje para/), "Hola");
  await userEvent.click(
    screen.getByRole("button", { name: "Abrir conversación" }),
  );
  await waitFor(() =>
    expect(fixture.api).toHaveBeenCalledWith(
      "/agentes/sesiones",
      expect.objectContaining({ motor: "claude", esfuerzo: "xhigh" }),
    ),
  );
  expect(
    fixture.api.mock.calls.find(([r, b]) => r === "/agentes/sesiones" && b)![1],
  ).not.toHaveProperty("modelo");
});

it("deletes a finished conversation only after confirming", async () => {
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (route: string, body?: unknown) =>
    route.startsWith("/agentes/sesiones")
      ? [
          {
            id: "c1",
            motor: "claude",
            espacioId: "p1",
            estado: "terminada",
            encargo: "Vieja",
            conversacionId: "c1",
          },
        ]
      : route === "/agentes/sesiones/eliminar"
        ? { id: (body as { id: string }).id }
        : original(route),
  );
  render(
    <MemoryRouter initialEntries={["/team?project=p1&agent=ambar&chat=c1"]}>
      <UI.Provider
        value={{
          items: [{ ...newItem("project"), id: "p1", title: "p1" }],
          edit: vi.fn(),
          trash: vi.fn(),
          ask: vi.fn(),
          notify: vi.fn(),
          openAgent: vi.fn(),
          openTeam: vi.fn(),
        }}
      >
        <AgentWorkspace />
      </UI.Provider>
    </MemoryRouter>,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Eliminar conversación" }),
  );
  expect(fixture.api).not.toHaveBeenCalledWith(
    "/agentes/sesiones/eliminar",
    expect.anything(),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Confirmar: eliminar" }),
  );
  await waitFor(() =>
    expect(fixture.api).toHaveBeenCalledWith("/agentes/sesiones/eliminar", {
      id: "c1",
    }),
  );
});

it("envía el mensaje al presionar Enter", async () => {
  const session = {
    id: "a2222222-2222-4222-8222-222222222222",
    motor: "claude",
    espacioId: "p1",
    structured: true,
    conversacionId: "native-1",
    estado: "terminada",
    encargo: "Primero",
    creada: "2026-01-01",
  };
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (route: string, body?: unknown) =>
    route.startsWith("/agentes/sesiones") && !body
      ? [session]
      : original(route, body),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter
      initialEntries={["/team?project=p1&agent=ambar&chat=" + session.id]}
    >
      <UI.Provider
        value={{
          items: [{ ...newItem("project"), id: "p1", title: "p1" }],
          edit: vi.fn(),
          trash: vi.fn(),
          ask: vi.fn(),
          notify: vi.fn(),
          openAgent: vi.fn(),
          openTeam: vi.fn(),
        }}
      >
        <AgentWorkspace />
      </UI.Provider>
    </MemoryRouter>,
  );
  await screen.findByText("Conversación por protocolo");
  const textbox = await screen.findByRole("textbox", {
    name: "Mensaje para Ámbar",
  });
  await user.type(textbox, "Mensaje con enter{Enter}");
  await waitFor(() =>
    expect(fixture.api).toHaveBeenCalledWith(
      "/agentes/sesiones",
      expect.objectContaining({
        continuar: session.id,
        brief: "Mensaje con enter",
        structured: true,
      }),
    ),
  );
});

it("con Ctrl+Enter salta a la siguiente línea sin enviar", async () => {
  const session = {
    id: "a3333333-3333-4333-8333-333333333333",
    motor: "claude",
    espacioId: "p1",
    structured: true,
    conversacionId: "native-1",
    estado: "terminada",
    encargo: "Primero",
    creada: "2026-01-01",
  };
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (route: string, body?: unknown) =>
    route.startsWith("/agentes/sesiones") && !body
      ? [session]
      : original(route, body),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter
      initialEntries={["/team?project=p1&agent=ambar&chat=" + session.id]}
    >
      <UI.Provider
        value={{
          items: [{ ...newItem("project"), id: "p1", title: "p1" }],
          edit: vi.fn(),
          trash: vi.fn(),
          ask: vi.fn(),
          notify: vi.fn(),
          openAgent: vi.fn(),
          openTeam: vi.fn(),
        }}
      >
        <AgentWorkspace />
      </UI.Provider>
    </MemoryRouter>,
  );
  await screen.findByText("Conversación por protocolo");
  const textbox = await screen.findByRole("textbox", {
    name: "Mensaje para Ámbar",
  });
  await user.type(textbox, "Línea 1{Control>}{Enter}{/Control}Línea 2");
  expect(textbox).toHaveProperty("value", "Línea 1\nLínea 2");
  expect(fixture.api).not.toHaveBeenCalledWith(
    "/agentes/terminal/entrada",
    expect.anything(),
  );
});

it("abre la sesión indicada al recibir ?job= o ?chat=", async () => {
  const sessions = [
    {
      id: "s-newer",
      motor: "claude",
      espacioId: "p1",
      estado: "terminada",
      encargo: "Sesión más reciente",
      resultado: "Resultado reciente",
      creada: "2026-01-02T00:00:00Z",
      conversacionId: "c-newer",
    },
    {
      id: "s-target",
      motor: "claude",
      espacioId: "p1",
      estado: "terminada",
      encargo: "Sesión objetivo",
      resultado: "Resultado objetivo",
      creada: "2026-01-01T00:00:00Z",
      conversacionId: "c-target",
    },
  ];
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (route: string, body?: unknown) =>
    route.startsWith("/agentes/sesiones") && !body
      ? sessions
      : original(route, body),
  );

  for (const param of ["job", "chat"]) {
    render(
      <MemoryRouter
        initialEntries={[`/team?project=p1&agent=ambar&${param}=s-target`]}
      >
        <UI.Provider
          value={{
            items: [{ ...newItem("project"), id: "p1", title: "p1" }],
            edit: vi.fn(),
            trash: vi.fn(),
            ask: vi.fn(),
            notify: vi.fn(),
            openAgent: vi.fn(),
            openTeam: vi.fn(),
          }}
        >
          <AgentWorkspace />
        </UI.Provider>
      </MemoryRouter>,
    );
    await screen.findByText("Resultado objetivo");
    expect(
      screen.getByRole("button", { name: /Sesión objetivo/ }).className,
    ).toContain("active");
    cleanup();
  }
});

it("con Ctrl+Enter en mitad del texto deja el cursor justo tras el salto de línea", async () => {
  const session = {
    id: "a4444444-4444-4444-8444-444444444444",
    motor: "claude",
    espacioId: "p1",
    structured: true,
    conversacionId: "native-1",
    estado: "terminada",
    encargo: "Primero",
    creada: "2026-01-01",
  };
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (route: string, body?: unknown) =>
    route.startsWith("/agentes/sesiones") && !body
      ? [session]
      : original(route, body),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter
      initialEntries={["/team?project=p1&agent=ambar&chat=" + session.id]}
    >
      <UI.Provider
        value={{
          items: [{ ...newItem("project"), id: "p1", title: "p1" }],
          edit: vi.fn(),
          trash: vi.fn(),
          ask: vi.fn(),
          notify: vi.fn(),
          openAgent: vi.fn(),
          openTeam: vi.fn(),
        }}
      >
        <AgentWorkspace />
      </UI.Provider>
    </MemoryRouter>,
  );
  await screen.findByText("Conversación por protocolo");
  const textbox = (await screen.findByRole("textbox", {
    name: "Mensaje para Ámbar",
  })) as HTMLTextAreaElement;
  await user.type(textbox, "Hola mundo");
  textbox.setSelectionRange(4, 4);
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(textbox.value).toBe("Hola\n mundo");
  expect(textbox.selectionStart).toBe(5);
  expect(textbox.selectionEnd).toBe(5);
  await user.keyboard("nuevo");
  expect(textbox.value).toBe("Hola\nnuevo mundo");
});
