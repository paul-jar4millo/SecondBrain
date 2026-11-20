import type { AgentState } from "./room-types";

export interface ObservedSession {
  id: string;
  motor: "claude" | "codex" | "agy" | "deepseek";
  copia: number;
  estado: string;
  fase?: string | null;
  ultimaAccion?: string | null;
  equipoId?: string | null;
  padreId?: string | null;
  proyecto?: string | null;
  espacioId?: string | null;
  /** Último mensaje o entregable del equipo, registrado por el lanzador. */
  relevo?: { id: string; tipo: string; para: string } | null;
}
export interface CopiaObservada {
  id: string;
  baseId: string;
  copia: number;
  sesionId: string;
  fase?: string;
  etiqueta: string;
  equipoId?: string;
  padreId?: string;
}
const personaje = {
  claude: "ambar",
  codex: "menta",
  agy: "lira",
  deepseek: "marina",
} as const;
/** Figure id of a session: the base character, or `<base>#<copy>`. */
export function sessionFigure(
  s: Pick<ObservedSession, "motor" | "copia">,
): string | null {
  const base = personaje[s.motor];
  if (!base) return null;
  return s.copia > 0 ? `${base}#${s.copia}` : base;
}
const zona: Record<string, string> = {
  investigar: "library",
  planificar: "terrace",
  programar: "workshop",
  revisar: "workshop",
};
export function conciliarCopias(actuales: string[], deseadas: string[]) {
  const actualesSet = new Set(actuales),
    deseadasSet = new Set(deseadas);
  return {
    crear: deseadas.filter((id) => !actualesSet.has(id)),
    retirar: actuales.filter((id) => !deseadasSet.has(id)),
  };
}
export function sceneSessions(sesiones: ObservedSession[]): {
  base: AgentState[];
  copias: CopiaObservada[];
} {
  const activas = sesiones.filter(
    (s) => ["pendiente", "trabajando"].includes(s.estado) && personaje[s.motor],
  );
  const base = Object.values(personaje).map((id): AgentState => {
    const s = activas.find(
      (item) => personaje[item.motor] === id && item.copia === 0,
    );
    return {
      id,
      ocupada: !!s,
      ultimo: s
        ? {
            jobId: s.id,
            estado: "trabajando",
            project: s.espacioId || s.proyecto || undefined,
            fase: s.fase || undefined,
            actividad: {
              zona: zona[s.fase || ""] || "terrace",
              etiqueta: s.ultimaAccion || "Trabajando",
            },
          }
        : null,
    };
  });
  const copias = activas
    .filter((s) => s.copia > 0)
    .map((s) => ({
      id: `${personaje[s.motor]}#${s.copia}`,
      baseId: personaje[s.motor],
      copia: s.copia,
      sesionId: s.id,
      fase: s.fase || undefined,
      etiqueta: s.ultimaAccion || "Trabajando",
      equipoId: s.equipoId || undefined,
      padreId: s.padreId || undefined,
    }));
  return { base, copias };
}
