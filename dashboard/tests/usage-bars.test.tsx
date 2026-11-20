// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UsageBars } from "../src/features/agents/UsageBars";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/core/store", () => ({ isDemo: false }));
vi.mock("../src/features/agents/agent-api", () => ({ agentApi: fixture.api }));
afterEach(() => {
  cleanup();
  fixture.api.mockReset();
});

const usage = {
  claude: { ventanas: { "5h": { usado: 25 }, semanal: { usado: 90 } } },
  agy: { ventanas: { semanal: { usado: 6.2 } } },
};

it.each([
  ["claude", "quedan 75 %"],
  ["agy", "quedan 94 %"],
])("muestra las ventanas medidas de %s", async (engine, text) => {
  fixture.api.mockResolvedValue(usage);
  render(<UsageBars motor={engine} />);
  expect(await screen.findByText(new RegExp(text))).toBeTruthy();
});

it("no pinta una ventana que el motor no informó", async () => {
  fixture.api.mockResolvedValue(usage);
  render(<UsageBars motor="agy" />);
  await screen.findByText(/Semanal/);
  expect(screen.queryByText(/5 horas/)).toBeNull();
});

it("muestra contexto sin inventar cuota del plan para DeepSeek", () => {
  fixture.api.mockResolvedValue(usage);
  const { container } = render(<UsageBars motor="deepseek" />);
  expect(fixture.api).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Contexto sin lectura");
  expect(container.textContent).not.toContain("5 horas");
});

it("muestra contexto medido y oculta un porcentaje de Claude desactualizado", async () => {
  fixture.api.mockResolvedValue({
    claude: {
      actualizado: "2020-01-01T00:00:00Z",
      ventanas: { "5h": { usado: 95 } },
    },
  });
  render(
    <UsageBars motor="claude" contexto={{ usados: 320000, limite: 400000 }} />,
  );
  expect(screen.getByText(/320 mil \/ 400 mil/)).toBeTruthy();
  expect(await screen.findByText(/sin lectura reciente/)).toBeTruthy();
  expect(screen.queryByText(/quedan 5 %/)).toBeNull();
});
