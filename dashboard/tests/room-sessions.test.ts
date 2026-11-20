import { describe, expect, it } from "vitest";
import {
  sesionesEscena,
  conciliarCopias,
} from "../src/features/room/room-sessions";

describe("sesiones observadas", () => {
  it("mantiene cuatro bases y crea una figura por sesión concurrente adicional", () => {
    const estado = sesionesEscena([
      {
        id: "uno",
        motor: "codex",
        copia: 0,
        estado: "trabajando",
        fase: "revisar",
        ultimaAccion: "Ejecutando pruebas",
      },
      {
        id: "dos",
        motor: "codex",
        copia: 1,
        estado: "trabajando",
        fase: "investigar",
        ultimaAccion: "Consultando",
      },
      { id: "tres", motor: "claude", copia: 0, estado: "terminada" },
    ]);
    expect(estado.base).toHaveLength(4);
    expect(estado.base.find((s) => s.id === "menta")?.ultimo?.fase).toBe(
      "revisar",
    );
    expect(
      estado.base.find((s) => s.id === "menta")?.ultimo?.actividad?.zona,
    ).toBe("workshop");
    expect(estado.copias).toEqual([
      {
        id: "menta#1",
        baseId: "menta",
        copia: 1,
        sesionId: "dos",
        fase: "investigar",
        etiqueta: "Consultando",
        equipoId: undefined,
        padreId: undefined,
      },
    ]);
    expect(estado.base.find((s) => s.id === "ambar")?.ocupada).toBe(false);
  });
  it("crea y retira solo las copias cuyo estado cambió", () => {
    expect(
      conciliarCopias(["menta#1", "lira#1"], ["menta#1", "ambar#2"]),
    ).toEqual({ crear: ["ambar#2"], retirar: ["lira#1"] });
  });
  it("no conserva copias de sesiones terminadas ni muestra texto ausente como actividad", () => {
    const estado = sesionesEscena([
      { id: "x", motor: "agy", copia: 1, estado: "terminada" },
    ]);
    expect(estado.copias).toEqual([]);
    expect(estado.base.find((s) => s.id === "lira")?.ocupada).toBe(false);
  });
});
