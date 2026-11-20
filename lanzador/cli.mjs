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
export function esPrincipal(argv1, url) {
  if (!argv1) return false;
  try {
    return url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return url === pathToFileURL(argv1).href;
  }
}

/** @type {Record<string, string>} */
const AGENTES = {
  ambar: "claude",
  menta: "codex",
  lira: "agy",
  marina: "deepseek",
};
const NOMBRES = Object.fromEntries(
  Object.entries(AGENTES).map(([a, m]) => [m, a]),
);
const FINALES = new Set(["terminada", "error", "cancelada", "interrumpida"]);
const VALORES = new Set([
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
const BOOLEANOS = new Set(["harness", "wait", "json", "borrador", "help"]);

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

export const AYUDA = `Uso: sb-hilo <comando> [opciones]

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
export function analizar(argv) {
  /** @type {CliFlags} */
  const opciones = {};
  const posicionales = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      posicionales.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(a);
    if (!m) {
      posicionales.push(a);
      continue;
    }
    const [, nombre, inline] = m;
    if (BOOLEANOS.has(nombre)) opciones[nombre] = true;
    else if (VALORES.has(nombre)) {
      const valor = inline ?? argv[++i];
      if (valor === undefined)
        throw new Error(`Falta el valor de --${nombre}.`);
      opciones[nombre] = valor;
    } else throw new Error(`Opción desconocida: --${nombre}.`);
  }
  return { opciones, posicionales };
}

const ID = /^[a-f0-9-]{36}$/i;

/** @param {NodeJS.ProcessEnv} env */
function conectar(env) {
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
export async function ejecutarCli(
  argv,
  {
    env = process.env,
    salida = (t) => process.stdout.write(t),
    error = (t) => process.stderr.write(t),
    fetchFn = fetch,
    espera = (ms) => new Promise((r) => setTimeout(r, ms)),
    sondeo = 2000,
  } = {},
) {
  let analisis;
  try {
    analisis = analizar(argv);
  } catch (e) {
    error(e.message + "\n");
    return 2;
  }
  const { opciones, posicionales } = analisis;
  const [comando, ...resto] = posicionales;
  const json = !!opciones.json;
  if (opciones.help || !comando || comando === "ayuda") {
    salida(AYUDA);
    return comando || opciones.help ? 0 : 2;
  }
  /** @param {string} mensaje */
  const falla = (mensaje, codigo = 1) => {
    if (json) salida(JSON.stringify({ error: mensaje }) + "\n");
    else error(mensaje + "\n");
    return codigo;
  };
  /** @param {string} m */
  const uso = (m) => falla(`${m}\n\n${AYUDA}`.trim(), 2);

  /** @type {string} */
  let base;
  let token;
  try {
    const conexion = conectar(env);
    base = conexion.base;
    token = (await readFile(conexion.tokenFile, "utf8")).trim();
  } catch (e) {
    return falla(
      e.code === "ENOENT" ? "No se pudo leer LANZADOR_TOKEN_FILE." : e.message,
    );
  }
  const cabeceras = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  /**
   * @template {keyof CliResponses} Route
   * @param {Route} ruta
   * @param {object} [cuerpo]
   * @returns {Promise<CliResponses[Route]>}
   */
  async function pedir(ruta, cuerpo) {
    let respuesta;
    try {
      respuesta = await fetchFn(base + ruta, {
        method: cuerpo === undefined ? "GET" : "POST",
        headers: cabeceras,
        ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new Error("El lanzador no responde.");
    }
    /** @type {unknown} */
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok)
      throw new Error(
        /** @type {{ error?: string }} */ (datos).error ||
          `El lanzador rechazó la petición (${respuesta.status}).`,
      );
    return /** @type {CliResponses[Route]} */ (datos);
  }
  /** @param {string} id */
  const buscar = async (id) => {
    const sesion = (await pedir("/estado")).find((s) => s.id === id);
    if (!sesion) throw new Error("Sesión inexistente.");
    return sesion;
  };

  /**
   * Last agent reply: the saved result, the chat transcript or, for harnesses, the stream.
   * @param {CliSession} sesion
   */
  async function respuestaDe(sesion) {
    if (sesion.resultado) return sesion.resultado;
    const mensajes = (sesion.mensajes ?? []).filter(
      (m) => m.rol === "assistant",
    );
    if (mensajes.length) return mensajes[mensajes.length - 1].texto;
    if (!sesion.harness) return "";
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 5000);
    try {
      const r = await fetchFn(`${base}/sesiones/${sesion.id}/stream`, {
        headers: cabeceras,
        signal: control.signal,
      });
      if (!r.ok || !r.body) return "";
      let pendiente = "";
      for await (const trozo of r.body) {
        pendiente += new TextDecoder().decode(trozo, { stream: true });
        const eventos = pendiente.split("\n\n");
        pendiente = eventos.pop() ?? "";
        for (const evento of eventos) {
          if (!/^event: items/m.test(evento)) continue;
          /** @type {{ items?: { tipo: string, texto?: string }[] }} */
          const datos = JSON.parse(/^data: (.*)$/m.exec(evento)?.[1] ?? "{}");
          const ultimo = (datos.items ?? [])
            .filter((i) => i.tipo === "asistente")
            .at(-1);
          control.abort();
          return ultimo?.texto ?? "";
        }
      }
    } catch {
      /* the answer is optional */
    } finally {
      clearTimeout(reloj);
      control.abort();
    }
    return "";
  }

  /**
   * Waits for the session to leave pendiente/trabajando; SSE wakes it, polling backs it up.
   * @param {string} id
   * @param {number} segundos
   */
  async function esperar(id, segundos) {
    const limite = Date.now() + segundos * 1000;
    const control = new AbortController();
    /** @type {(value?: unknown) => void} */
    let despertar = () => {};
    let dormir = new Promise((r) => (despertar = r));
    (async () => {
      try {
        const r = await fetchFn(base + "/events", {
          headers: cabeceras,
          signal: control.signal,
        });
        for await (const trozo of r.body ?? []) {
          if (/^data:/m.test(new TextDecoder().decode(trozo))) {
            despertar();
            dormir = new Promise((x) => (despertar = x));
          }
        }
      } catch {
        /* polling covers a missing stream */
      }
    })();
    try {
      for (;;) {
        const sesion = await buscar(id);
        if (FINALES.has(sesion.estado)) return { sesion, vencio: false };
        if (Date.now() >= limite) return { sesion, vencio: true };
        await Promise.race([
          dormir,
          espera(Math.min(sondeo, limite - Date.now())),
        ]);
      }
    } finally {
      control.abort();
    }
  }

  /** @param {CliSession} s */
  const resumen = (s) => ({
    id: s.id,
    agente: NOMBRES[s.motor] ?? s.motor,
    estado: s.estado,
    proyecto: s.proyecto ?? null,
    modelo: s.modelo ?? null,
    harness: !!s.harness,
    creada: s.creada ?? null,
  });
  /** @param {CliSession} s */
  const linea = (s) =>
    `${s.id}  ${(NOMBRES[s.motor] ?? s.motor).padEnd(7)} ${String(s.estado).padEnd(12)} ${s.proyecto ?? "-"}  ${(s.encargo ?? "").replace(/\s+/g, " ").slice(0, 60)}`;

  /**
   * Finishes a command that started a turn: optionally waits and shows the last reply.
   * @param {CliSession} sesion
   */
  async function cerrar(sesion) {
    let final = sesion;
    let codigo = 0;
    let vencio = false;
    if (opciones.wait) {
      const segundos = Number(opciones.timeout ?? 1800);
      if (!Number.isFinite(segundos) || segundos <= 0)
        return falla(
          "--timeout debe ser un número de segundos mayor que cero.",
          2,
        );
      const r = await esperar(sesion.id, segundos);
      final = r.sesion;
      vencio = r.vencio;
      codigo = r.vencio ? 124 : final.estado === "terminada" ? 0 : 1;
    }
    const respuesta = opciones.wait ? await respuestaDe(final) : undefined;
    if (json)
      salida(
        JSON.stringify({
          ...resumen(final),
          ...(opciones.wait ? { respuesta, vencio } : {}),
          ...(final.error ? { error: final.error } : {}),
        }) + "\n",
      );
    else {
      salida(
        `Hilo ${final.id} (${NOMBRES[final.motor] ?? final.motor}): ${final.estado}\n`,
      );
      if (vencio)
        salida("Se agotó el tiempo de espera; el hilo sigue en marcha.\n");
      if (final.error) salida(`Error: ${final.error}\n`);
      if (respuesta) salida(`\n${respuesta}\n`);
    }
    return codigo;
  }

  try {
    if (comando === "iniciar") {
      const motor = opciones.agente ? AGENTES[opciones.agente] : undefined;
      if (!motor) return uso("Elige --agente ambar, menta, lira o marina.");
      if (!opciones.proyecto) return uso("Falta --proyecto.");
      const brief = resto.join(" ").trim();
      if (!brief) return uso("Falta el brief.");
      const origen = opciones.origen ?? "equipo";
      if (!["cron", "equipo"].includes(origen))
        return uso("--origen admite cron o equipo.");
      const sesion = await pedir("/sesiones", {
        motor,
        origen,
        proyecto: opciones.proyecto,
        brief,
        ...(opciones.modelo ? { modelo: opciones.modelo } : {}),
        ...(opciones.esfuerzo ? { esfuerzo: opciones.esfuerzo } : {}),
        ...(opciones.harness ? { harness: true } : {}),
      });
      return await cerrar(sesion);
    }
    if (["enviar", "ver", "detener", "diff", "pr"].includes(comando)) {
      const id = resto[0];
      if (!ID.test(id ?? "")) return uso("Indica el id del hilo.");
      if (comando === "enviar") {
        const texto = resto.slice(1).join(" ").trim();
        if (!texto) return uso("Falta el texto.");
        return await cerrar(
          await pedir("/sesiones", { continuar: id, brief: texto }),
        );
      }
      if (comando === "ver") {
        const sesion = await buscar(id);
        const respuesta = await respuestaDe(sesion);
        if (json)
          salida(
            JSON.stringify({
              ...resumen(sesion),
              respuesta,
              error: sesion.error ?? null,
            }) + "\n",
          );
        else {
          salida(`${linea(sesion)}\n`);
          if (sesion.error) salida(`Error: ${sesion.error}\n`);
          if (respuesta) salida(`\n${respuesta}\n`);
        }
        return 0;
      }
      if (comando === "detener") {
        await pedir(`/sesiones/${id}/cancelar`, {});
        salida(
          json
            ? JSON.stringify({ id, detenida: true }) + "\n"
            : `Hilo ${id}: deteniendo.\n`,
        );
        return 0;
      }
      if (comando === "diff") {
        const d = await pedir(`/sesiones/${id}/diff`);
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
      const r = await pedir(`/sesiones/${id}/pr`, {
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
      let lista = (await pedir("/estado")).filter(
        (s) =>
          (!opciones.proyecto || s.proyecto === opciones.proyecto) &&
          (!opciones.estado || s.estado === opciones.estado),
      );
      lista = lista.sort((a, b) =>
        String(b.creada).localeCompare(String(a.creada)),
      );
      if (json) salida(JSON.stringify(lista.map(resumen)) + "\n");
      else
        salida(
          lista.length ? lista.map(linea).join("\n") + "\n" : "No hay hilos.\n",
        );
      return 0;
    }
    return uso(`Comando desconocido: ${comando}.`);
  } catch (e) {
    return falla(e.message || "No se pudo completar el comando.");
  }
}

// The LXC runs it through /opt/secondbrain/current, a symlink to the release.
if (esPrincipal(process.argv[1], import.meta.url))
  process.exitCode = await ejecutarCli(process.argv.slice(2));
