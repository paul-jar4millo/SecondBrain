// @ts-check
import { readFile } from "node:fs/promises";

export function createLanzador(
  Failure,
  {
    url = process.env.LANZADOR_URL,
    tokenFile = process.env.LANZADOR_TOKEN_FILE,
    token,
  } = /** @type {any} */ ({}),
) {
  if (url) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("El lanzador debe estar en loopback.");
  }
  const base = url?.replace(/\/$/, "");
  async function secreto() {
    return token ?? (await readFile(tokenFile, "utf8")).trim();
  }
  /** Follows the launcher's SSE stream; every event only asks the app to re-read. */
  function suscribir(listener) {
    let stopped = false,
      controller,
      timer;
    const connect = async () => {
      controller = new AbortController();
      try {
        const response = await fetch(base + "/events", {
          headers: { authorization: `Bearer ${await secreto()}` },
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) throw new Error("Eventos no disponibles");
        listener(); // Reconcile changes that happened while disconnected.
        let pending = "";
        for await (const chunk of response.body) {
          pending += new TextDecoder().decode(chunk, { stream: true });
          const events = pending.split("\n\n");
          pending = events.pop();
          if (events.some((event) => /^data:/m.test(event))) listener();
        }
      } catch {
        /* Reconnection never retries a session. */
      }
      if (!stopped) {
        timer = setTimeout(connect, 5000);
        timer.unref();
      }
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }
  async function pedir(ruta, data, timeout = 10000) {
    if (!base) throw new Failure("El lanzador no está instalado.", 503);
    let respuesta;
    try {
      const clave = await secreto();
      respuesta = await fetch(base + ruta, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${clave}`,
          "content-type": "application/json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
      });
    } catch {
      throw new Failure("El lanzador no responde.", 503);
    }
    const contenido = await respuesta.json().catch(() => ({}));
    const conocidas = new Set([
      "Conflicto de vínculos; actualiza e inténtalo de nuevo",
      "Modelo no disponible",
      "Saldo DeepSeek insuficiente",
      "Saldo DeepSeek no disponible",
      "Límite de sesiones activas",
      "Límite del equipo alcanzado",
      "Profundidad máxima alcanzada",
      "Elige otro proveedor",
      "Detén la sesión antes de eliminarla",
      "Terminal no disponible",
      "Integrante fuera del manifiesto aprobado.",
      "La integrante del manifiesto ya tiene una sesión activa.",
      "El manifiesto del encargo no permite cambiar el motor de esta integrante.",
      "El manifiesto del encargo fija el modelo de esta integrante y no permite cambiarlo sin editar el equipo.",
      "El manifiesto del encargo fija el esfuerzo de esta integrante y no permite cambiarlo sin editar el equipo.",
      "No puedes ampliar el perfil de herramientas respecto al manifiesto aprobado.",
      "La integrante hija no puede ampliar permisos más allá del perfil autorizado.",
      "Manifiesto del encargo desactualizado; recarga el equipo.",
      "DeepSeek bloqueado por la política de gasto sin autorización explícita de gasto.",
    ]);
    if (!respuesta.ok)
      throw new Failure(
        conocidas.has(contenido.error) || contenido.seguro === true
          ? contenido.error
          : "El lanzador rechazó la petición.",
        respuesta.status,
      );
    return contenido;
  }
  const sesion = (id) => {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
      throw new Failure("Sesión inválida.", 400);
    return id;
  };
  return {
    subscribe: (listener) => (base ? suscribir(listener) : () => {}),
    leer: () => pedir("/estado"),
    proyectos: () => pedir("/proyectos"),
    modelos: () => pedir("/modelos", undefined, 30000),
    uso: () => pedir("/uso"),
    espacios: (datos) => pedir("/espacios", datos),
    /**
     * Opens the launcher's SSE stream of one harness and returns the raw
     * response; the caller pipes its body without buffering and aborts it.
     */
    flujo: async (id, signal, structured = false) => {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
        throw new Failure("Sesión inválida.", 400);
      if (!base) throw new Failure("El lanzador no está instalado.", 503);
      let respuesta;
      try {
        respuesta = await fetch(
          `${base}/sesiones/${id}/${structured ? "conversation" : "stream"}`,
          {
            headers: {
              authorization: `Bearer ${await secreto()}`,
              accept: "text/event-stream",
            },
            signal,
            redirect: "error",
          },
        );
      } catch {
        throw new Failure("El lanzador no responde.", 503);
      }
      if (!respuesta.ok || !respuesta.body) {
        const contenido = await respuesta.json().catch(() => ({}));
        await respuesta.body?.cancel().catch(() => {});
        throw new Failure(
          contenido.error === "Terminal no disponible"
            ? contenido.error
            : "El lanzador rechazó la petición.",
          respuesta.status,
        );
      }
      return respuesta;
    },
    entrada: ({ id, ...datos }) => pedir(`/sesiones/${id}/terminal`, datos),
    responder: ({ id, ...datos }) =>
      pedir(`/sesiones/${sesion(id)}/conversation/answer`, datos),
    encargar: (datos) => pedir("/sesiones", datos, 45000),
    equipo: (accion, sesion, actor, datos) =>
      pedir(
        "/equipo/" + accion,
        { ...datos, sesion, actor },
        accion === "esperar" ? 1810000 : 10000,
      ),
    capacidades: () => pedir("/capacidades"),
    catalogoHerramientas: (params = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) q.set(k, String(v));
      }
      return pedir(`/herramientas/catalogo${q.size ? "?" + q : ""}`);
    },
    actualizarPerfilHerramientas: (datos) =>
      pedir("/herramientas/perfiles", datos),
    resolverSkills: (datos) => pedir("/herramientas/skills/resolver", datos),
    enviarMensajeConversacion: ({ id, ...datos }) =>
      pedir(`/sesiones/${sesion(id)}/conversation/messages`, datos),
    colaConversacion: (id) =>
      pedir(`/sesiones/${sesion(id)}/conversation/queue`),
    cancelarColaConversacion: ({ id, clientMessageId }) =>
      pedir(`/sesiones/${sesion(id)}/conversation/queue/cancel`, {
        clientMessageId,
      }),
    descargarArtefacto: async (id, artifactId) => {
      if (
        typeof artifactId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(artifactId)
      )
        throw new Failure("Artefacto inválido.", 400);
      if (!base) throw new Failure("El lanzador no está instalado.", 503);
      let respuesta;
      try {
        respuesta = await fetch(
          `${base}/sesiones/${sesion(id)}/conversation/artifacts/${artifactId}`,
          {
            headers: { authorization: `Bearer ${await secreto()}` },
            signal: AbortSignal.timeout(30000),
            redirect: "error",
          },
        );
      } catch {
        throw new Failure("El lanzador no responde.", 503);
      }
      if (!respuesta.ok) {
        const contenido = await respuesta.json().catch(() => ({}));
        throw new Failure(
          contenido.seguro === true
            ? contenido.error
            : "No se pudo descargar el artefacto.",
          respuesta.status,
        );
      }
      return respuesta;
    },
    diff: ({ id, desde, hasta }) => {
      const consulta = new URLSearchParams();
      if (desde !== undefined) consulta.set("desde", desde);
      if (hasta !== undefined) consulta.set("hasta", hasta);
      return pedir(
        `/sesiones/${sesion(id)}/diff${consulta.size ? "?" + consulta : ""}`,
        undefined,
        60000,
      );
    },
    propuestaPr: (id) =>
      pedir(`/sesiones/${sesion(id)}/pr/propuesta`, undefined, 60000),
    revertir: ({ id, n }) =>
      pedir(`/sesiones/${sesion(id)}/revertir`, { n }, 120000),
    pr: ({ id, ...datos }) =>
      pedir(`/sesiones/${sesion(id)}/pr`, datos, 300000),
    redactarPr: (id) =>
      pedir(`/sesiones/${sesion(id)}/pr/redactar`, {}, 150000),
    cancelar: async (id) => {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
        throw new Failure("Sesión inválida.", 400);
      return pedir(`/sesiones/${id}/cancelar`, {});
    },
    eliminar: async (id) => {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
        throw new Failure("Sesión inválida.", 400);
      return pedir(`/sesiones/${id}/eliminar`, {});
    },
  };
}
