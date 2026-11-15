// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPanel } from "../src/features/team/SessionPanel";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/core/store", () => ({ isDemo: false }));
vi.mock("../src/core/events", () => ({ subscribeChanges: () => () => {} }));
vi.mock("../src/features/team/team-store", () => ({ teamApi: fixture.api }));
afterEach(() => {
  cleanup();
  fixture.api.mockReset();
  vi.unstubAllGlobals();
});
it("solo inicia al encargar explícitamente y muestra sesiones observadas", async () => {
  fixture.api.mockImplementation(async (route: string) =>
    route === "/agentes/proyectos-lanzador"
      ? ["proyecto"]
      : route === "/agentes/sesiones"
        ? [
            {
              id: "id",
              motor: "codex",
              estado: "trabajando",
              proyecto: "proyecto",
              copia: 0,
              ultimaAccion: "Revisando",
            },
          ]
        : {},
  );
  const user = userEvent.setup();
  render(<SessionPanel />);
  await screen.findByText("Revisando");
  expect(fixture.api.mock.calls.some((call) => call[1] !== undefined)).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "Encargar trabajo" }));
  await user.selectOptions(screen.getByLabelText("Agente"), "codex");
  await user.selectOptions(screen.getByLabelText("Repositorio"), "proyecto");
  await user.type(screen.getByLabelText("Encargo"), "Revisa el proyecto");
  await user.click(screen.getByRole("button", { name: "Iniciar encargo" }));
  expect(fixture.api).toHaveBeenCalledWith("/agentes/sesiones", {
    motor: "codex",
    origen: "sala",
    proyecto: "proyecto",
    brief: "Revisa el proyecto",
  });
});

it("encarga con el modelo y el razonamiento elegidos, y los recuerda", async () => {
  const guardado = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => guardado.get(k) ?? null,
    setItem: (k: string, v: string) => guardado.set(k, v),
  });
  fixture.api.mockImplementation(async (route: string) =>
    route === "/agentes/proyectos-lanzador"
      ? ["proyecto"]
      : route === "/agentes/sesiones"
        ? []
        : route === "/agentes/modelos-lanzador"
          ? {
              claude: [{ id: "opus", nombre: "Opus" }],
              codex: [
                {
                  id: "gpt-a",
                  nombre: "GPT A",
                  esfuerzo: "low",
                  esfuerzos: ["low", "high"],
                },
              ],
              agy: [],
              deepseek: [],
            }
          : {},
  );
  const user = userEvent.setup();
  render(<SessionPanel />);
  await user.click(
    await screen.findByRole("button", { name: "Encargar trabajo" }),
  );
  await user.selectOptions(screen.getByLabelText("Agente"), "codex");
  await screen.findByRole("option", { name: "GPT A" });
  await user.selectOptions(screen.getByLabelText("Modelo"), "gpt-a");
  // No choice yet: the program decides, and the option says what that means.
  expect(screen.getByLabelText("Razonamiento")).toHaveProperty("value", "");
  screen.getByRole("option", { name: "Predeterminado (Bajo)" });
  await user.selectOptions(screen.getByLabelText("Razonamiento"), "high");
  await user.selectOptions(screen.getByLabelText("Repositorio"), "proyecto");
  await user.type(screen.getByLabelText("Encargo"), "Hazlo");
  await user.click(screen.getByRole("button", { name: "Iniciar encargo" }));
  expect(fixture.api).toHaveBeenCalledWith("/agentes/sesiones", {
    motor: "codex",
    origen: "sala",
    proyecto: "proyecto",
    brief: "Hazlo",
    modelo: "gpt-a",
    esfuerzo: "high",
  });
  expect(JSON.parse(localStorage.getItem("sb-modelo-codex")!)).toEqual({
    modelo: "gpt-a",
    esfuerzo: "high",
  });
});
