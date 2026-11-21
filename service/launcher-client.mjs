import { readFile } from "node:fs/promises";
import { createThreadsClient } from "./launcher-threads-client.mjs";
import {
  canonicalWorkspaces,
  legacyLauncherPaths,
  legacyWorkspaceUpdate,
} from "./launcher-wire.mjs";

const oldCatalogPaths = new Map(
  Array.from(legacyLauncherPaths, ([old, canonical]) => [canonical, old]),
);

/**
 * @param {typeof import("./vault.mjs").Failure} Failure
 * @param {{ url?: string, tokenFile?: string, token?: string }} [options]
 */
export function createLauncherClient(
  Failure,
  {
    url = process.env.SB_LAUNCHER_URL ?? process.env.LANZADOR_URL,
    tokenFile = process.env.SB_LAUNCHER_TOKEN_FILE ??
      process.env.LANZADOR_TOKEN_FILE,
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
   * @param {number} [timeout]
   * @param {{ path: string, data: unknown }} [fallback]
   */
  async function request(path, data, timeout = 10000, fallback) {
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
    // A service can be upgraded while a running launcher still uses old paths.
    // Retry only the older server's explicit "no such route" response.
    if (
      fallback &&
      response.status === 404 &&
      contenido.error === "Ruta no encontrada."
    )
      return request(fallback.path, fallback.data, timeout);
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
  /** @param {string} resource @param {unknown} [data] @param {number} [timeout] @param {string} [query] */
  function catalog(resource, data, timeout, query = "") {
    const legacy = oldCatalogPaths.get(resource);
    const fallback =
      legacy && process.env.SB_LEGACY_HTTP_ROUTES !== "off"
        ? {
            path: legacy + query,
            data:
              resource === "/workspaces" && data !== undefined
                ? legacyWorkspaceUpdate(
                    /** @type {Parameters<typeof legacyWorkspaceUpdate>[0]} */ (
                      data
                    ),
                  )
                : data,
          }
        : undefined;
    return request(resource + query, data, timeout, fallback);
  }
  return {
    /** @param {() => void} listener */
    subscribe: (listener) => (base ? subscribe(listener) : () => {}),
    proyectos: () => catalog("/projects"),
    modelos: () => catalog("/models", undefined, 30000),
    uso: () => catalog("/usage"),
    /** @param {unknown} [data] Omitted to list; an object to create one. */
    espacios: (data) => catalog("/workspaces", data).then(canonicalWorkspaces),
    capacidades: () => catalog("/capabilities"),
    catalogoHerramientas: (params = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) q.set(k, String(v));
      }
      return catalog(
        "/tools/catalog",
        undefined,
        undefined,
        q.size ? "?" + q : "",
      );
    },
    /** @param {unknown} data */
    actualizarPerfilHerramientas: (data) => catalog("/tools/profiles", data),
    /** @param {unknown} data */
    resolverSkills: (data) => catalog("/tools/skills/resolve", data),
    threads: createThreadsClient({ base, secret, request, Failure }),
  };
}
