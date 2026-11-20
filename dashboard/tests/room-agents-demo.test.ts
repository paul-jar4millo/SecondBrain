import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { demoAgentsApi } from "../src/features/room/room-agents-demo";

let store: Record<string, string>;
beforeEach(() => {
  store = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

type DemoAgents = { conectado: boolean; agentes: { id: string }[] };
type DemoModels = { manual: boolean; modelos: { model: string }[] };

it("lista los cuatro agentes sintéticos con su configuración guardada", () => {
  store["sb-demo-agent-config"] = JSON.stringify({ menta: { modelo: "m" } });
  const data = demoAgentsApi("/agentes") as DemoAgents & {
    agentes: { id: string; configuracion: unknown }[];
  };
  expect(data.conectado).toBe(true);
  expect(data.agentes.map((a) => a.id)).toEqual([
    "ambar",
    "menta",
    "lira",
    "marina",
  ]);
  expect(data.agentes[1].configuracion).toEqual({ modelo: "m" });
});

it("devuelve equipo vacío y tres sesiones de ejemplo", () => {
  expect(demoAgentsApi("/agentes/equipo")).toEqual({ flujos: [], eventos: [] });
  expect(demoAgentsApi("/agentes/sesiones?activas=1")).toHaveLength(3);
});

it("ofrece modelos por agente y ninguno para DeepSeek, que es manual", () => {
  const menta = demoAgentsApi("/agentes/modelos?id=menta") as DemoModels;
  expect(menta.manual).toBe(false);
  expect(menta.modelos[0].model).toBe("gpt-6.1-sol");
  expect(
    (demoAgentsApi("/agentes/modelos?id=ambar") as DemoModels).modelos,
  ).toHaveLength(2);
  expect(
    (demoAgentsApi("/agentes/modelos?id=lira") as DemoModels).modelos,
  ).toHaveLength(2);
  const marina = demoAgentsApi("/agentes/modelos?id=marina") as DemoModels;
  expect(marina).toMatchObject({ manual: true, modelos: [] });
});

it("guarda la configuración en el navegador y la usa en el siguiente encargo", () => {
  expect(
    demoAgentsApi("/agentes/configuracion", {
      id: "lira",
      modelo: "gemini-flash-ejemplo-medium",
      esfuerzo: "low",
    }),
  ).toEqual({ modelo: "gemini-flash-ejemplo-medium", esfuerzo: "low" });
  const agent = demoAgentsApi("/agentes/encargos", {
    id: "lira",
    brief: "hola",
  }) as { ultimo: Record<string, unknown>; historial: unknown[] };
  expect(agent.ultimo).toMatchObject({
    estado: "listo",
    brief: "hola",
    configuracion: { modelo: "gemini-flash-ejemplo-medium" },
  });
  expect(agent.historial[0]).toBe(agent.ultimo);
});

it("rechaza agentes desconocidos y acciones que necesitan el servicio real", () => {
  expect(() => demoAgentsApi("/agentes/encargos", { id: "nadie" })).toThrow(
    /desconocido/,
  );
  expect(() => demoAgentsApi("/agentes/borrar")).toThrow(/servicio real/);
});
