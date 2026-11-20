import { readFile } from "node:fs/promises";
import { createThreadsClient } from "./launcher-threads-client.mjs";

/** @import { LauncherSessionSummary } from "./types.d.ts" */

/**
 * @param {typeof import("./vault.mjs").Failure} Failure
 * @param {{ url?: string, tokenFile?: string, token?: string }} [options]
 */
export function createLauncherClient(
  Failure,
  {
    url = process.env.LANZADOR_URL,
    tokenFile = process.env.LANZADOR_TOKEN_FILE,
    token,
  } = {},
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
  async function secret() {
    // The constructor requires either token or tokenFile.
    return (
      token ??
      (await readFile(/** @type {string} */ (tokenFile), "utf8")).trim()
    );
  }
  /**
   * Follows the launcher's SSE stream; every event only asks the app to re-read.
   * @param {() => void} listener
   */
  function subscribe(listener) {
    let stopped = false;
    /** @type {AbortController | undefined} */
    let controller;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const connect = async () => {
      controller = new AbortController();
      try {
        const response = await fetch(base + "/events", {
          headers: { authorization: `Bearer ${await secret()}` },
          signal: controller.signal,
          redirect: "error",
        });
        if (!response.ok) throw new Error("Eventos no disponibles");
        listener(); // Reconcile changes that happened while disconnected.
        let pending = "";
        for await (const chunk of response.body ?? []) {
          pending += new TextDecoder().decode(chunk, { stream: true });
          const events = pending.split("\n\n");
          pending = events.pop() ?? "";
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
  /**
   * @param {string} path
   * @param {unknown} [data]
   */
  async function request(path, data, timeout = 10000) {
    if (!base) throw new Failure("El lanzador no está instalado.", 503);
    let response;
    try {
      const key = await secret();
      response = await fetch(base + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
      });
    } catch {
      throw new Failure("El lanzador no responde.", 503);
    }
    const contenido = await response.json().catch(() => ({}));
    const known = new Set([
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
    if (!response.ok)
      throw new Failure(
        known.has(contenido.error) || contenido.seguro === true
          ? contenido.error
          : "El lanzador rechazó la petición.",
        response.status,
      );
    return contenido;
  }
  /** @param {unknown} id */
  const sesion = (id) => {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
      throw new Failure("Sesión inválida.", 400);
    return id;
  };
  return {
    /** @param {() => void} listener */
    subscribe: (listener) => (base ? subscribe(listener) : () => {}),
    /** @returns {Promise<LauncherSessionSummary[] | { sesiones: LauncherSessionSummary[] }>} */
    leer: () => request("/estado"),
    proyectos: () => request("/proyectos"),
    modelos: () => request("/modelos", undefined, 30000),
    uso: () => request("/uso"),
    /** @param {unknown} [data] Omitted to list; an object to create one. */
    espacios: (data) => request("/espacios", data),
    /**
     * Opens the launcher's SSE stream of one harness and returns the raw
     * response; the caller pipes its body without buffering and aborts it.
     * @param {unknown} id
     * @param {AbortSignal} signal
     */
    flujo: async (id, signal, structured = false) => {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
        throw new Failure("Sesión inválida.", 400);
      if (!base) throw new Failure("El lanzador no está instalado.", 503);
      let response;
      try {
        response = await fetch(
          `${base}/sesiones/${id}/${structured ? "conversation" : "stream"}`,
          {
            headers: {
              authorization: `Bearer ${await secret()}`,
              accept: "text/event-stream",
            },
            signal,
            redirect: "error",
          },
        );
      } catch {
        throw new Failure("El lanzador no responde.", 503);
      }
      if (!response.ok || !response.body) {
        const content = await response.json().catch(() => ({}));
        await response.body?.cancel().catch(() => {});
        throw new Failure(
          content.error === "Terminal no disponible"
            ? content.error
            : "El lanzador rechazó la petición.",
          response.status,
        );
      }
      return response;
    },
    /** @param {{ id: string } & Record<string, unknown>} input */
    entrada: ({ id, ...data }) => request(`/sesiones/${id}/terminal`, data),
    /** @param {{ id: string } & Record<string, unknown>} input */
    responder: ({ id, ...data }) =>
      request(`/sesiones/${sesion(id)}/conversation/answer`, data),
    /** @param {unknown} data */
    encargar: (data) => request("/sesiones", data, 45000),
    /**
     * @param {string} action
     * @param {string} session
     * @param {string | undefined} actor
     * @param {object} data
     */
    equipo: (action, session, actor, data) =>
      request(
        "/equipo/" + action,
        { ...data, sesion: session, actor },
        action === "esperar" ? 1810000 : 10000,
      ),
    capacidades: () => request("/capacidades"),
    catalogoHerramientas: (params = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) q.set(k, String(v));
      }
      return request(`/herramientas/catalogo${q.size ? "?" + q : ""}`);
    },
    /** @param {unknown} data */
    actualizarPerfilHerramientas: (data) =>
      request("/herramientas/perfiles", data),
    /** @param {unknown} data */
    resolverSkills: (data) => request("/herramientas/skills/resolver", data),
    /** @param {{ id: string } & Record<string, unknown>} input */
    enviarMensajeConversacion: ({ id, ...data }) =>
      request(`/sesiones/${sesion(id)}/conversation/messages`, data),
    /** @param {unknown} id */
    colaConversacion: (id) =>
      request(`/sesiones/${sesion(id)}/conversation/queue`),
    /** @param {{ id: string, clientMessageId: string }} input */
    cancelarColaConversacion: ({ id, clientMessageId }) =>
      request(`/sesiones/${sesion(id)}/conversation/queue/cancel`, {
        clientMessageId,
      }),
    /**
     * @param {unknown} id
     * @param {unknown} artifactId
     */
    descargarArtefacto: async (id, artifactId) => {
      if (
        typeof artifactId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(artifactId)
      )
        throw new Failure("Artefacto inválido.", 400);
      if (!base) throw new Failure("El lanzador no está instalado.", 503);
      let response;
      try {
        response = await fetch(
          `${base}/sesiones/${sesion(id)}/conversation/artifacts/${artifactId}`,
          {
            headers: { authorization: `Bearer ${await secret()}` },
            signal: AbortSignal.timeout(30000),
            redirect: "error",
          },
        );
      } catch {
        throw new Failure("El lanzador no responde.", 503);
      }
      if (!response.ok) {
        const content = await response.json().catch(() => ({}));
        throw new Failure(
          content.seguro === true
            ? content.error
            : "No se pudo descargar el artefacto.",
          response.status,
        );
      }
      return response;
    },
    /** @param {{ id: string, desde?: string, hasta?: string }} input */
    diff: ({ id, desde: from, hasta: until }) => {
      const query = new URLSearchParams();
      if (from !== undefined) query.set("desde", from);
      if (until !== undefined) query.set("hasta", until);
      return request(
        `/sesiones/${sesion(id)}/diff${query.size ? "?" + query : ""}`,
        undefined,
        60000,
      );
    },
    /** @param {unknown} id */
    propuestaPr: (id) =>
      request(`/sesiones/${sesion(id)}/pr/propuesta`, undefined, 60000),
    /** @param {{ id: string, n?: number }} input */
    revertir: ({ id, n }) =>
      request(`/sesiones/${sesion(id)}/revertir`, { n }, 120000),
    /** @param {{ id: string } & Record<string, unknown>} input */
    pr: ({ id, ...data }) =>
      request(`/sesiones/${sesion(id)}/pr`, data, 300000),
    /** @param {unknown} id */
    redactarPr: (id) =>
      request(`/sesiones/${sesion(id)}/pr/redactar`, {}, 150000),
    /** @param {unknown} id */
    cancelar: async (id) => {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
        throw new Failure("Sesión inválida.", 400);
      return request(`/sesiones/${id}/cancelar`, {});
    },
    /** @param {unknown} id */
    eliminar: async (id) => {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
        throw new Failure("Sesión inválida.", 400);
      return request(`/sesiones/${id}/eliminar`, {});
    },
    threads: createThreadsClient({ base, secret, request, Failure }),
  };
}
