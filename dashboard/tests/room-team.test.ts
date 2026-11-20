import { describe, it, expect } from "vitest";
import {
  estadoPersonaje,
  etiquetaRoster,
} from "../src/features/room/team-panel.js";
describe("resultados y estado real de la sala", () => {
  it("las acciones del proveedor mandan sobre el rol y terminar no significa seguir trabajando", () => {
    expect(
      estadoPersonaje({
        ocupada: true,
        ultimo: {
          actividad: { zona: "library", etiqueta: "Consultando información" },
        },
      }).zona,
    ).toBe("library");
    expect(
      estadoPersonaje({ ocupada: false, ultimo: { estado: "error" } }).etiqueta,
    ).toBe("Necesita atención");
    expect(
      estadoPersonaje({ ocupada: false, ultimo: { estado: "listo" } })
        .trabajando,
    ).toBe(false);
  });
});
describe("estado real de las agentes en el mundo", () => {
  it("una entrega con error queda a la vista y no manda a la agente al ocio", () => {
    const estado = estadoPersonaje({
      ocupada: false,
      personaje: { zona: "workshop" },
      ultimo: { estado: "error", fase: "Programar", jobId: "j1" },
    });
    expect(estado.atencion).toBe(true);
    expect(estado.zona).toBe("workshop");
    expect(estado.etiqueta).toBe("Necesita atención");
    expect(
      estadoPersonaje({ ocupada: false, ultimo: { estado: "interrumpido" } })
        .atencion,
    ).toBe(true);
    expect(
      estadoPersonaje({ ocupada: false, ultimo: { estado: "listo" } }).atencion,
    ).toBe(false);
  });
  it("el roster nunca dice Terminado mientras la agente camina hacia otro lado", () => {
    const terminado = estadoPersonaje({
      ocupada: false,
      ultimo: { estado: "listo" },
    });
    expect(etiquetaRoster(terminado, "Yendo al café")).toBe(
      "Encargo terminado · yendo al café",
    );
    expect(
      etiquetaRoster(
        estadoPersonaje({ ocupada: false, ultimo: undefined }),
        "Tomando un café",
      ),
    ).toBe("Tomando un café");
  });
  it("el trabajo real y la atención mandan sobre la rutina del mundo", () => {
    const trabajando = estadoPersonaje({
      ocupada: true,
      ultimo: { actividad: { zona: "library", etiqueta: "Leyendo archivos" } },
    });
    expect(etiquetaRoster(trabajando, "Yendo a la biblioteca")).toBe(
      "Leyendo archivos",
    );
    const error = estadoPersonaje({
      ocupada: false,
      ultimo: { estado: "error" },
    });
    expect(etiquetaRoster(error, "Tomando un café")).toBe("Necesita atención");
  });
  it("sin datos del servidor muestra la rutina y sin rutina el estado", () => {
    expect(etiquetaRoster(null, "Leyendo")).toBe("Leyendo");
    expect(
      etiquetaRoster(
        estadoPersonaje({ ocupada: false, ultimo: { estado: "listo" } }),
      ),
    ).toBe("Terminado");
  });
});
