#!/usr/bin/env node
// sb-hilo: threads from the terminal. Talks to the launcher's HTTP API over
// loopback with the control token; the token is read from a file and never printed.
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * True when this file is the program being run, also through a symlinked path.
 * @param {string | undefined} argv1
 * @param {string} url
 */
export function isMain(argv1, url) {
  if (!argv1) return false;
  try {
    return url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return url === pathToFileURL(argv1).href;
  }
}

/** @type {Record<string, string>} */
const AGENTS_BY_ID = {
  ambar: "claude",
  menta: "codex",
  lira: "agy",
  marina: "deepseek",
};
const NAMES = Object.fromEntries(
  Object.entries(AGENTS_BY_ID).map(([a, m]) => [m, a]),
);
const FINAL = new Set(["terminada", "error", "cancelada", "interrumpida"]);
const VALUES = new Set([
  "agente",
  "proyecto",
  "modelo",
  "esfuerzo",
  "origen",
  "timeout",
  "estado",
  "titulo",
  "descripcion",
]);
const BOOLEANS = new Set(["harness", "wait", "json", "borrador", "help"]);

/**
 * @typedef {Record<string, string | boolean> & {
 *   agente?: string,
 *   proyecto?: string,
 *   modelo?: string,
 *   esfuerzo?: string,
 *   origen?: string,
 *   timeout?: string,
 *   estado?: string,
 *   titulo?: string,
 *   descripcion?: string,
 *   harness?: boolean,
 *   wait?: boolean,
 *   json?: boolean,
 *   borrador?: boolean,
 *   help?: boolean
 * }} CliFlags
 */
/** @typedef {import("./session-types.d.ts").LauncherSession} CliSession */
/**
 * @typedef {object} CliExecutionOptions
 * @property {NodeJS.ProcessEnv} [env]
 * @property {(text: string) => unknown} [salida]
 * @property {(text: string) => unknown} [error]
 * @property {typeof fetch} [fetchFn]
 * @property {(ms: number) => Promise<unknown>} [espera]
 * @property {number} [sondeo]
 */
/**
 * @typedef {object} CliDiff
 * @property {{ estado: string, ruta: string, binario?: boolean, añadidas: number, eliminadas: number }[]} archivos
 * @property {string} [parche]
 * @property {boolean} [recortado]
 */
/**
 * @typedef {{ "/estado": CliSession[], "/sesiones": CliSession } &
 *   Record<`/sesiones/${string}/diff`, CliDiff> &
 *   Record<`/sesiones/${string}/pr`, { rama: string, commit: string, url: string }> &
 *   Record<`/sesiones/${string}/cancelar`, unknown>} CliResponses
 */

export const HELP = `Uso: sb-hilo <comando> [opciones]

Comandos:
  iniciar --agente ambar|menta|lira|marina --proyecto <id> [--modelo m] [--esfuerzo e]
          [--harness] [--origen cron] "brief"     Inicia una sesión (headless por defecto)
  enviar <id> "texto"                              Envía un mensaje a un hilo
  ver <id>                                         Estado y última respuesta
  listar [--proyecto p] [--estado e]               Lista los hilos
  detener <id>                                     Detiene el turno en marcha
  diff <id>                                        Cambios de la sesión en el repositorio
  pr <id> [--borrador] [--titulo t]                Rama, commit y PR del hilo

Opciones globales:
  --wait            Espera a que termine el turno (salida 0 bien, 1 error, 124 tiempo)
  --timeout <s>     Segundos máximos de espera con --wait (por defecto 1800)
  --json            Salida JSON en una línea
  --help            Esta ayuda

Entorno: LANZADOR_URL (http://127.0.0.1:8092) y LANZADOR_TOKEN_FILE.
`;

/** @param {string[]} argv */
export function analyze(argv) {
  /** @type {CliFlags} */
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(a);
    if (!m) {
      positional.push(a);
      continue;
    }
    const [, name, inline] = m;
    if (BOOLEANS.has(name)) options[name] = true;
    else if (VALUES.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`Falta el valor de --${name}.`);
      options[name] = value;
    } else throw new Error(`Opción desconocida: --${name}.`);
  }
  return { opciones: options, posicionales: positional };
}

const ID = /^[a-f0-9-]{36}$/i;

/** @param {NodeJS.ProcessEnv} env */
function connect(env) {
  const url = new URL(env.LANZADOR_URL || "http://127.0.0.1:8092");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("El lanzador debe estar en loopback.");
  const tokenFile = env.LANZADOR_TOKEN_FILE;
  if (!tokenFile) throw new Error("Falta LANZADOR_TOKEN_FILE.");
  return { base: url.origin, tokenFile };
}

/**
 * Runs one command. Returns the process exit code; output goes through `salida`/`error`.
 * @param {string[]} argv
 * @param {CliExecutionOptions} [options]
 */
export async function runCli(
  argv,
  {
    env = process.env,
    salida = (t) => process.stdout.write(t),
    error = (t) => process.stderr.write(t),
    fetchFn = fetch,
    espera = (ms) => new Promise((r) => setTimeout(r, ms)),
    sondeo: poll = 2000,
  } = {},
) {
  let analysis;
  try {
    analysis = analyze(argv);
  } catch (e) {
    error(e.message + "\n");
    return 2;
  }
  const { opciones, posicionales: positional } = analysis;
  const [comando, ...rest] = positional;
  const json = !!opciones.json;
  if (opciones.help || !comando || comando === "ayuda") {
    salida(HELP);
    return comando || opciones.help ? 0 : 2;
  }
  /** @param {string} message */
  const failure = (message, code = 1) => {
    if (json) salida(JSON.stringify({ error: message }) + "\n");
    else error(message + "\n");
    return code;
  };
  /** @param {string} m */
  const usage = (m) => failure(`${m}\n\n${HELP}`.trim(), 2);

  /** @type {string} */
  let base;
  let token;
  try {
    const connection = connect(env);
    base = connection.base;
    token = (await readFile(connection.tokenFile, "utf8")).trim();
  } catch (e) {
    return failure(
      e.code === "ENOENT" ? "No se pudo leer LANZADOR_TOKEN_FILE." : e.message,
    );
  }
  const cabeceras = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  /**
   * @template {keyof CliResponses} Route
   * @param {Route} path
   * @param {object} [cuerpo]
   * @returns {Promise<CliResponses[Route]>}
   */
  async function request(path, cuerpo) {
    let response;
    try {
      response = await fetchFn(base + path, {
        method: cuerpo === undefined ? "GET" : "POST",
        headers: cabeceras,
        ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new Error("El lanzador no responde.");
    }
    /** @type {unknown} */
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        /** @type {{ error?: string }} */ (data).error ||
          `El lanzador rechazó la petición (${response.status}).`,
      );
    return /** @type {CliResponses[Route]} */ (data);
  }
  /** @param {string} id */
  const buscar = async (id) => {
    const session = (await request("/estado")).find((s) => s.id === id);
    if (!session) throw new Error("Sesión inexistente.");
    return session;
  };

  /**
   * Last agent reply: the saved result, the chat transcript or, for harnesses, the stream.
   * @param {CliSession} session
   */
  async function responseOf(session) {
    if (session.resultado) return session.resultado;
    const messages = (session.mensajes ?? []).filter(
      (m) => m.rol === "assistant",
    );
    if (messages.length) return messages[messages.length - 1].texto;
    if (!session.harness) return "";
    const control = new AbortController();
    const clock = setTimeout(() => control.abort(), 5000);
    try {
      const r = await fetchFn(`${base}/sesiones/${session.id}/stream`, {
        headers: cabeceras,
        signal: control.signal,
      });
      if (!r.ok || !r.body) return "";
      let pending = "";
      for await (const chunk of r.body) {
        pending += new TextDecoder().decode(chunk, { stream: true });
        const events = pending.split("\n\n");
        pending = events.pop() ?? "";
        for (const evento of events) {
          if (!/^event: items/m.test(evento)) continue;
          /** @type {{ items?: { tipo: string, texto?: string }[] }} */
          const datos = JSON.parse(/^data: (.*)$/m.exec(evento)?.[1] ?? "{}");
          const last = (datos.items ?? [])
            .filter((i) => i.tipo === "asistente")
            .at(-1);
          control.abort();
          return last?.texto ?? "";
        }
      }
    } catch {
      /* the answer is optional */
    } finally {
      clearTimeout(clock);
      control.abort();
    }
    return "";
  }

  /**
   * Waits for the session to leave pendiente/trabajando; SSE wakes it, polling backs it up.
   * @param {string} id
   * @param {number} seconds
   */
  async function wait(id, seconds) {
    const limit = Date.now() + seconds * 1000;
    const control = new AbortController();
    /** @type {(value?: unknown) => void} */
    let wake = () => {};
    let sleep = new Promise((r) => (wake = r));
    (async () => {
      try {
        const r = await fetchFn(base + "/events", {
          headers: cabeceras,
          signal: control.signal,
        });
        for await (const chunk of r.body ?? []) {
          if (/^data:/m.test(new TextDecoder().decode(chunk))) {
            wake();
            sleep = new Promise((x) => (wake = x));
          }
        }
      } catch {
        /* polling covers a missing stream */
      }
    })();
    try {
      for (;;) {
        const sesion = await buscar(id);
        if (FINAL.has(sesion.estado)) return { sesion, vencio: false };
        if (Date.now() >= limit) return { sesion, vencio: true };
        await Promise.race([sleep, espera(Math.min(poll, limit - Date.now()))]);
      }
    } finally {
      control.abort();
    }
  }

  /** @param {CliSession} s */
  const summary = (s) => ({
    id: s.id,
    agente: NAMES[s.motor] ?? s.motor,
    estado: s.estado,
    proyecto: s.proyecto ?? null,
    modelo: s.modelo ?? null,
    harness: !!s.harness,
    creada: s.creada ?? null,
  });
  /** @param {CliSession} s */
  const line = (s) =>
    `${s.id}  ${(NAMES[s.motor] ?? s.motor).padEnd(7)} ${String(s.estado).padEnd(12)} ${s.proyecto ?? "-"}  ${(s.encargo ?? "").replace(/\s+/g, " ").slice(0, 60)}`;

  /**
   * Finishes a command that started a turn: optionally waits and shows the last reply.
   * @param {CliSession} session
   */
  async function close(session) {
    let final = session;
    let code = 0;
    let expired = false;
    if (opciones.wait) {
      const seconds = Number(opciones.timeout ?? 1800);
      if (!Number.isFinite(seconds) || seconds <= 0)
        return failure(
          "--timeout debe ser un número de segundos mayor que cero.",
          2,
        );
      const r = await wait(session.id, seconds);
      final = r.sesion;
      expired = r.vencio;
      code = r.vencio ? 124 : final.estado === "terminada" ? 0 : 1;
    }
    const response = opciones.wait ? await responseOf(final) : undefined;
    if (json)
      salida(
        JSON.stringify({
          ...summary(final),
          ...(opciones.wait ? { respuesta: response, vencio: expired } : {}),
          ...(final.error ? { error: final.error } : {}),
        }) + "\n",
      );
    else {
      salida(
        `Hilo ${final.id} (${NAMES[final.motor] ?? final.motor}): ${final.estado}\n`,
      );
      if (expired)
        salida("Se agotó el tiempo de espera; el hilo sigue en marcha.\n");
      if (final.error) salida(`Error: ${final.error}\n`);
      if (response) salida(`\n${response}\n`);
    }
    return code;
  }

  try {
    if (comando === "iniciar") {
      const engine = opciones.agente
        ? AGENTS_BY_ID[opciones.agente]
        : undefined;
      if (!engine) return usage("Elige --agente ambar, menta, lira o marina.");
      if (!opciones.proyecto) return usage("Falta --proyecto.");
      const brief = rest.join(" ").trim();
      if (!brief) return usage("Falta el brief.");
      const origin = opciones.origen ?? "equipo";
      if (!["cron", "equipo"].includes(origin))
        return usage("--origen admite cron o equipo.");
      const sesion = await request("/sesiones", {
        motor: engine,
        origen: origin,
        proyecto: opciones.proyecto,
        brief,
        ...(opciones.modelo ? { modelo: opciones.modelo } : {}),
        ...(opciones.esfuerzo ? { esfuerzo: opciones.esfuerzo } : {}),
        ...(opciones.harness ? { harness: true } : {}),
      });
      return await close(sesion);
    }
    if (["enviar", "ver", "detener", "diff", "pr"].includes(comando)) {
      const id = rest[0];
      if (!ID.test(id ?? "")) return usage("Indica el id del hilo.");
      if (comando === "enviar") {
        const text = rest.slice(1).join(" ").trim();
        if (!text) return usage("Falta el texto.");
        return await close(
          await request("/sesiones", { continuar: id, brief: text }),
        );
      }
      if (comando === "ver") {
        const sesion = await buscar(id);
        const respuesta = await responseOf(sesion);
        if (json)
          salida(
            JSON.stringify({
              ...summary(sesion),
              respuesta,
              error: sesion.error ?? null,
            }) + "\n",
          );
        else {
          salida(`${line(sesion)}\n`);
          if (sesion.error) salida(`Error: ${sesion.error}\n`);
          if (respuesta) salida(`\n${respuesta}\n`);
        }
        return 0;
      }
      if (comando === "detener") {
        await request(`/sesiones/${id}/cancelar`, {});
        salida(
          json
            ? JSON.stringify({ id, detenida: true }) + "\n"
            : `Hilo ${id}: deteniendo.\n`,
        );
        return 0;
      }
      if (comando === "diff") {
        const d = await request(`/sesiones/${id}/diff`);
        if (json) salida(JSON.stringify(d) + "\n");
        else {
          salida(`${d.archivos.length} archivos cambiados\n`);
          for (const a of d.archivos)
            salida(
              `  ${a.estado} ${a.ruta}${a.binario ? " (binario)" : ` (+${a.añadidas} -${a.eliminadas})`}\n`,
            );
          if (d.parche) salida(`\n${d.parche}`);
          if (d.recortado) salida("\n[parche recortado a 1 MB]\n");
        }
        return 0;
      }
      const r = await request(`/sesiones/${id}/pr`, {
        ...(opciones.titulo ? { titulo: opciones.titulo } : {}),
        ...(opciones.descripcion ? { descripcion: opciones.descripcion } : {}),
        borrador: !!opciones.borrador,
      });
      salida(
        json
          ? JSON.stringify(r) + "\n"
          : `Rama ${r.rama}\nCommit ${r.commit}\nPR ${r.url}\n`,
      );
      return 0;
    }
    if (comando === "listar") {
      let list = (await request("/estado")).filter(
        (s) =>
          (!opciones.proyecto || s.proyecto === opciones.proyecto) &&
          (!opciones.estado || s.estado === opciones.estado),
      );
      list = list.sort((a, b) =>
        String(b.creada).localeCompare(String(a.creada)),
      );
      if (json) salida(JSON.stringify(list.map(summary)) + "\n");
      else
        salida(
          list.length ? list.map(line).join("\n") + "\n" : "No hay hilos.\n",
        );
      return 0;
    }
    return usage(`Comando desconocido: ${comando}.`);
  } catch (e) {
    return failure(e.message || "No se pudo completar el comando.");
  }
}

// The LXC runs it through /opt/secondbrain/current, a symlink to the release.
if (isMain(process.argv[1], import.meta.url))
  process.exitCode = await runCli(process.argv.slice(2));
