/** Portraits are rendered from the same original GLBs as the refuge. */
export const characters = [
  {
    id: "ambar",
    name: "Ámbar",
    provider: "Claude",
    color: "#e08a5b",
  },
  {
    id: "menta",
    name: "Menta",
    provider: "Codex",
    color: "#35c49b",
  },
  {
    id: "lira",
    name: "Lira",
    provider: "Antigravity",
    color: "#7c8cff",
  },
  {
    id: "marina",
    name: "Marina",
    provider: "DeepSeek",
    color: "#3f8cff",
  },
] as const;
export const character = (id?: string) => characters.find((a) => a.id === id);
export const teamStates: Record<string, string> = {
  trabajando: "En curso",
  compactando: "Compactando",
  listo: "Terminado",
  error: "Necesita atención",
  cancelado: "Cancelado",
  esperando: "Espera tu clic",
  "en-cola": "En cola",
  interrumpido: "Interrumpido",
  pendiente: "Pendiente",
  bloqueado: "Espera tu respuesta",
  aprobado: "Aprobado",
  rechazado: "Rechazado",
  "sin-veredicto": "Sin veredicto",
};
