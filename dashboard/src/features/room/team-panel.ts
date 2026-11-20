// The team desk is a view of recorded work. Scene cues and handoffs cost no model calls.
const ESTADOS: Record<string, string> = {
  trabajando: "En curso",
  compactando: "Compactando",
  listo: "Terminado",
  error: "Necesita atención",
  cancelado: "Cancelado",
  esperando: "Espera tu clic",
  "en-cola": "En cola",
  interrumpido: "Interrumpido",
  pendiente: "Pendiente",
};
const NECESITA_ATENCION = new Set(["error", "interrumpido"]);

export interface RosterAgent {
  ocupada?: boolean;
  personaje?: { zona?: string } | null;
  ultimo?: {
    estado?: string;
    fase?: string;
    jobId?: string;
    actividad?: { zona?: string; etiqueta?: string } | null;
  } | null;
}

export interface CharacterState {
  trabajando: boolean;
  atencion: boolean;
  esperando?: boolean;
  zona?: string;
  etiqueta: string;
  fase?: string;
  jobId?: string;
}

export function characterState(a: RosterAgent): CharacterState {
  if (a.ocupada)
    return {
      trabajando: true,
      atencion: false,
      zona: a.ultimo?.actividad?.zona || a.personaje?.zona || "terrace",
      etiqueta: a.ultimo?.actividad?.etiqueta || "Trabajando",
      fase: a.ultimo?.fase,
      jobId: a.ultimo?.jobId,
    };
  // A failed or interrupted delivery waits at the agent's desk until the owner looks at it.
  if (NECESITA_ATENCION.has(a.ultimo?.estado ?? ""))
    return {
      trabajando: false,
      atencion: true,
      zona: a.ultimo?.actividad?.zona || a.personaje?.zona || "terrace",
      etiqueta: "Necesita atención",
      fase: a.ultimo?.fase,
      jobId: a.ultimo?.jobId,
    };
  return {
    trabajando: false,
    atencion: false,
    etiqueta: ESTADOS[a.ultimo?.estado ?? ""] || "Disponible",
    jobId: a.ultimo?.jobId,
  };
}

/**
 * Roster line: real work, waits and failures win; otherwise the scene routine,
 * prefixed with the last delivery so "Terminado" never reads as the current action.
 */
export function etiquetaRoster(
  estado: CharacterState | null | undefined,
  actividad?: string,
) {
  if (!estado) return actividad || "";
  if (estado.trabajando || estado.esperando || estado.atencion || !actividad)
    return estado.etiqueta;
  const previo = (
    {
      Terminado: "Encargo terminado",
      Cancelado: "Encargo cancelado",
    } as Record<string, string>
  )[estado.etiqueta];
  return previo
    ? `${previo} · ${actividad.charAt(0).toLocaleLowerCase("es")}${actividad.slice(1)}`
    : actividad;
}
