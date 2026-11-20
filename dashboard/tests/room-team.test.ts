import { describe, it, expect } from "vitest";
import { characterState, rosterLabel } from "../src/features/room/team-panel";
describe("resultados y estado real de la sala", () => {
  it("las acciones del proveedor mandan sobre el rol y terminar no significa seguir trabajando", () => {
    expect(
      characterState({
        ocupada: true,
        ultimo: {
          actividad: { zona: "library", etiqueta: "Consultando información" },
        },
      }).zona,
    ).toBe("library");
    expect(
      characterState({ ocupada: false, ultimo: { estado: "error" } }).etiqueta,
    ).toBe("Necesita atención");
    expect(
      characterState({ ocupada: false, ultimo: { estado: "listo" } })
        .trabajando,
    ).toBe(false);
  });
});
describe("estado real de las agentes en el mundo", () => {
  it("una entrega con error queda a la vista y no manda a la agente al ocio", () => {
    const state = characterState({
      ocupada: false,
      personaje: { zona: "workshop" },
      ultimo: { estado: "error", fase: "Programar", jobId: "j1" },
    });
    expect(state.atencion).toBe(true);
    expect(state.zona).toBe("workshop");
    expect(state.etiqueta).toBe("Necesita atención");
    expect(
      characterState({ ocupada: false, ultimo: { estado: "interrumpido" } })
        .atencion,
    ).toBe(true);
    expect(
      characterState({ ocupada: false, ultimo: { estado: "listo" } }).atencion,
    ).toBe(false);
  });
  it("el roster nunca dice Terminado mientras la agente camina hacia otro lado", () => {
    const terminado = characterState({
      ocupada: false,
      ultimo: { estado: "listo" },
    });
    expect(rosterLabel(terminado, "Yendo al café")).toBe(
      "Encargo terminado · yendo al café",
    );
    expect(
      rosterLabel(
        characterState({ ocupada: false, ultimo: undefined }),
        "Tomando un café",
      ),
    ).toBe("Tomando un café");
  });
  it("el trabajo real y la atención mandan sobre la rutina del mundo", () => {
    const trabajando = characterState({
      ocupada: true,
      ultimo: { actividad: { zona: "library", etiqueta: "Leyendo archivos" } },
    });
    expect(rosterLabel(trabajando, "Yendo a la biblioteca")).toBe(
      "Leyendo archivos",
    );
    const error = characterState({
      ocupada: false,
      ultimo: { estado: "error" },
    });
    expect(rosterLabel(error, "Tomando un café")).toBe("Necesita atención");
  });
  it("sin datos del servidor muestra la rutina y sin rutina el estado", () => {
    expect(rosterLabel(null, "Leyendo")).toBe("Leyendo");
    expect(
      rosterLabel(
        characterState({ ocupada: false, ultimo: { estado: "listo" } }),
      ),
    ).toBe("Terminado");
  });
});
