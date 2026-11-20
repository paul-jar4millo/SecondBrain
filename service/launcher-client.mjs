import { readFile } from "node:fs/promises";
import { createThreadsClient } from "./launcher-threads-client.mjs";

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
   * Follows the launcher's global thread feed; every event only asks the app
   * to re-read.
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
        const response = await fetch(base + "/threads/stream", {
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
        /* Reconnects below. */
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
  return {
    /** @param {() => void} listener */
    subscribe: (listener) => (base ? subscribe(listener) : () => {}),
    proyectos: () => request("/proyectos"),
    modelos: () => request("/modelos", undefined, 30000),
    uso: () => request("/uso"),
    /** @param {unknown} [data] Omitted to list; an object to create one. */
    espacios: (data) => request("/espacios", data),
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
    threads: createThreadsClient({ base, secret, request, Failure }),
  };
}
