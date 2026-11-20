/** Synthetic values for `?demo=1`, which has no backend. */
export const DEMO_AGENTS = {
  conectado: true,
  agentes: [
    {
      id: "ambar",
      proveedor: "claude",
      nombre: "Claude",
      acceso: "suscripcion",
      ventanas: {
        "5h": { usado: 32, reinicia: "2026-11-07T18:00:00Z" },
        semanal: { usado: 61, reinicia: "2026-11-11T16:00:00Z" },
      },
      observado: "2026-11-07T15:00:00Z",
      contextos: { general: { usados: 48200, limite: 200000 } },
      ultimo: { estado: "listo", respuesta: "Revisé el proyecto de ejemplo." },
    },
    {
      id: "menta",
      proveedor: "chatgpt",
      nombre: "ChatGPT",
      acceso: "suscripcion",
      ventanas: {
        "5h": { usado: 94, reinicia: "2026-11-07T17:00:00Z" },
        semanal: { usado: 73, reinicia: "2026-11-12T16:00:00Z" },
      },
      contextos: {},
      ultimo: null,
    },
    {
      id: "lira",
      proveedor: "gemini",
      nombre: "Gemini",
      acceso: "suscripcion",
      ventanas: {
        "5h": { usado: 8, reinicia: "2026-11-07T19:00:00Z" },
        semanal: { usado: 21, reinicia: "2026-11-14T09:00:00Z" },
      },
      contextos: { general: { usados: 9100, limite: 1000000, estimado: true } },
      ultimo: null,
    },
    {
      id: "marina",
      proveedor: "deepseek",
      nombre: "DeepSeek",
      acceso: "api",
      saldo: { total: "4.20", moneda: "USD" },
      contextos: {},
      ultimo: { estado: "error", error: "Falta configurar la clave de API." },
    },
  ],
};

/** Explicitly synthetic showcase; this path never invokes providers. */
export function demoAgentsApi(path, body) {
  const stored = JSON.parse(
    localStorage.getItem("sb-demo-agent-config") || "{}",
  );
  if (path === "/agentes") {
    for (const a of DEMO_AGENTS.agentes) a.configuracion = stored[a.id] || {};
    return DEMO_AGENTS;
  }
  if (path === "/agentes/equipo") return { flujos: [], eventos: [] };
  if (path.split("?")[0] === "/agentes/sesiones")
    // A team of three engines: Claude leads, Codex and Gemini are her children.
    return [
      {
        id: "demo-lider",
        motor: "claude",
        copia: 0,
        estado: "trabajando",
        fase: "planificar",
        ultimaAccion: "Coordinando al equipo (ejemplo)",
        equipoId: "demo-equipo",
        padreId: null,
        proyecto: "demo",
      },
      {
        id: "demo-hija-1",
        motor: "codex",
        copia: 0,
        estado: "trabajando",
        fase: "programar",
        ultimaAccion: "Editando archivos (ejemplo)",
        equipoId: "demo-equipo",
        padreId: "demo-lider",
        proyecto: "demo",
        // Changes every 20 s so the handoff animation can be watched.
        relevo: {
          id: `demo-relevo-${Math.floor(Date.now() / 20000)}`,
          tipo: "entregable",
          para: "demo-lider",
        },
      },
      {
        id: "demo-hija-2",
        motor: "agy",
        copia: 0,
        estado: "trabajando",
        fase: "investigar",
        ultimaAccion: "Leyendo notas (ejemplo)",
        equipoId: "demo-equipo",
        padreId: "demo-lider",
        proyecto: "demo",
      },
    ];
  if (path.startsWith("/agentes/modelos?")) {
    const id = new URLSearchParams(path.split("?")[1]).get("id");
    return {
      manual: id === "marina",
      configuracion: stored[id] || {},
      modelos:
        id === "menta"
          ? [
              {
                model: "gpt-6.1-sol",
                displayName: "GPT-6.1 Sol (ejemplo)",
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [
                  { reasoningEffort: "medium" },
                  { reasoningEffort: "high" },
                ],
              },
            ]
          : id === "ambar"
            ? [
                {
                  model: "claude-sonnet-ejemplo",
                  displayName: "Sonnet (ejemplo)",
                },
                { model: "claude-opus-ejemplo", displayName: "Opus (ejemplo)" },
              ]
            : id === "lira"
              ? [
                  {
                    model: "gemini-pro-ejemplo-high",
                    displayName: "Gemini Pro High (ejemplo)",
                  },
                  {
                    model: "gemini-flash-ejemplo-medium",
                    displayName: "Gemini Flash Medium (ejemplo)",
                  },
                ]
              : [],
    };
  }
  if (path === "/agentes/configuracion") {
    stored[body.id] = { modelo: body.modelo, esfuerzo: body.esfuerzo };
    localStorage.setItem("sb-demo-agent-config", JSON.stringify(stored));
    return stored[body.id];
  }
  if (path === "/agentes/encargos") {
    const a = DEMO_AGENTS.agentes.find((a) => a.id === body.id);
    a.ultimo = {
      ...body,
      jobId: crypto.randomUUID(),
      estado: "listo",
      inicio: new Date().toISOString(),
      fin: new Date().toISOString(),
      respuesta:
        "# Demostración\n\nRespuesta sintética. En esta demo no se ejecutan modelos.",
      configuracion: stored[body.id] || {},
    };
    a.historial = [a.ultimo, ...(a.historial || [])].slice(0, 10);
    return a;
  }
  throw new Error(
    "Esta acción necesita el servicio real; la demo no ejecuta modelos.",
  );
}
