import { watch } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Structured conversation for the dashboard: provider transcripts become a flat
 * list of items (user, assistant, tool, error, system) with tool calls paired to
 * their results. `leerConversacion` (conversaciones.mjs) keeps feeding
 * `sesion.mensajes`; this module is the live, richer view.
 */

const MAX_RESUMEN = 200;
const MAX_RESULTADO = 2000;
const MAX_TEXTO = 100000;
const MAX_ITEMS = 1000;
export const LOTE_INICIAL = 300;
// A transcript this large is read from its tail: the oldest turns are not live.
const MAX_LECTURA = 8 * 1024 * 1024;

/**
 * @typedef {object} TranscriptItem
 * @property {string} id
 * @property {"usuario" | "asistente" | "herramienta" | "error" | "sistema"} tipo
 * @property {string | null} ts
 * @property {string} [texto]
 * @property {TranscriptTool} [herramienta]
 */
/**
 * @typedef {object} TranscriptTool
 * @property {string} nombre
 * @property {string} resumen
 * @property {"pendiente" | "error" | "ok"} estado
 * @property {string} [resultado]
 */
/** @typedef {TranscriptItem & { tipo: "herramienta", herramienta: TranscriptTool }} TranscriptToolItem */
/**
 * @typedef {object} TranscriptBlock
 * @property {string} [type]
 * @property {string} [text]
 * @property {string} [id]
 * @property {string} [name]
 * @property {unknown} [input]
 * @property {string} [tool_use_id]
 * @property {unknown} [content]
 * @property {boolean} [is_error]
 */
/**
 * @typedef {object} CodexTranscriptPayload
 * @property {string} [type]
 * @property {string} [message]
 * @property {string} [role]
 * @property {TranscriptBlock[]} [content]
 * @property {string} [id]
 * @property {string} [call_id]
 * @property {string} [name]
 * @property {unknown} [arguments]
 * @property {unknown} [input]
 * @property {unknown} [action]
 * @property {unknown} [output]
 */
/**
 * @typedef {object} TranscriptEvent
 * @property {string} [type]
 * @property {string} [subtype]
 * @property {string | number} [id]
 * @property {string | number} [step_id]
 * @property {string} [uuid]
 * @property {string} [timestamp]
 * @property {string} [created_at]
 * @property {string} [content]
 * @property {unknown} [error]
 * @property {{ content?: string | TranscriptBlock[] }} [message]
 * @property {boolean} [isSidechain]
 * @property {boolean} [isMeta]
 * @property {boolean} [isApiErrorMessage]
 * @property {CodexTranscriptPayload} [payload]
 * @property {string} [tool_name]
 * @property {string} [toolName]
 * @property {string} [name]
 * @property {unknown} [args]
 * @property {unknown} [input]
 */
/** @typedef {ReturnType<typeof crearAcumulador>} Accumulator */
/** @typedef {Pick<import("./session-types.d.ts").LauncherSession, "id" | "motor" | "conversacionId">} TranscriptSession */
/** @typedef {(items: TranscriptItem[]) => void} TranscriptListener */

/**
 * @param {unknown} texto
 * @param {number} max
 */
const corto = (texto, max) => {
  const valor = String(texto ?? "");
  return valor.length > max ? valor.slice(0, max - 1) + "…" : valor;
};

const CLAVES_RESUMEN = [
  "command",
  "cmd",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
];

/**
 * Short, single-line description of a tool input.
 * @param {unknown} entrada
 */
export function resumirEntrada(entrada) {
  if (entrada === null || entrada === undefined) return "";
  if (typeof entrada === "string")
    return corto(entrada.replace(/\s+/g, " ").trim(), MAX_RESUMEN);
  if (Array.isArray(entrada) && entrada.every((x) => typeof x === "string"))
    return corto(entrada.join(" "), MAX_RESUMEN);
  if (typeof entrada === "object") {
    const objeto = /** @type {Record<string, unknown>} */ (entrada);
    for (const clave of CLAVES_RESUMEN) {
      const valor = objeto[clave];
      if (typeof valor === "string" && valor.trim())
        return corto(valor.replace(/\s+/g, " ").trim(), MAX_RESUMEN);
      if (Array.isArray(valor) && valor.length)
        return corto(valor.join(" "), MAX_RESUMEN);
    }
    try {
      return corto(JSON.stringify(entrada), MAX_RESUMEN);
    } catch {
      return "";
    }
  }
  return corto(entrada, MAX_RESUMEN);
}

/** @param {unknown} contenido */
function textoDe(contenido) {
  if (typeof contenido === "string") return contenido;
  if (Array.isArray(contenido))
    return /** @type {(string | TranscriptBlock)[]} */ (contenido)
      .map((x) =>
        typeof x === "string"
          ? x
          : typeof x?.text === "string"
            ? x.text
            : x?.type === "image"
              ? "[imagen]"
              : "",
      )
      .filter(Boolean)
      .join("\n");
  if (contenido && typeof contenido === "object") {
    const bloque = /** @type {TranscriptBlock} */ (contenido);
    return typeof bloque.text === "string"
      ? bloque.text
      : typeof bloque.content === "string"
        ? bloque.content
        : JSON.stringify(contenido);
  }
  return "";
}

/** State shared by the per-provider readers: ordered items plus changed ids. */
function crearAcumulador() {
  /** @type {Map<string, TranscriptItem>} */
  const items = new Map();
  /** @type {Set<string>} */
  const cambiados = new Set();
  /** @type {Map<string, TranscriptToolItem>} */
  const herramientas = new Map();
  return {
    herramientas,
    /** @param {TranscriptItem} item */
    poner(item) {
      items.set(item.id, item);
      cambiados.add(item.id);
      if (items.size > MAX_ITEMS) {
        const viejo = items.keys().next().value;
        items.delete(viejo);
        cambiados.delete(viejo);
      }
    },
    /** @param {string} id */
    existe: (id) => items.has(id),
    todos: () => [...items.values()].map((x) => structuredClone(x)),
    drenar() {
      const lista = [...cambiados]
        .map((id) => items.get(id))
        .filter(Boolean)
        .map((x) => structuredClone(x));
      cambiados.clear();
      return lista;
    },
  };
}

/**
 * @param {string} id
 * @param {unknown} nombre
 * @param {unknown} entrada
 * @param {string | null} ts
 * @returns {TranscriptToolItem}
 */
const herramienta = (id, nombre, entrada, ts) => ({
  id,
  tipo: "herramienta",
  herramienta: {
    nombre: String(nombre || "herramienta").slice(0, 80),
    resumen: resumirEntrada(entrada),
    estado: "pendiente",
  },
  ts,
});

/**
 * @param {Accumulator} acc
 * @param {string} clave
 * @param {string} texto
 * @param {boolean} error
 * @param {string | null} ts
 */
function cerrarHerramienta(acc, clave, texto, error, ts) {
  const item = acc.herramientas.get(clave);
  if (!item) return;
  item.herramienta.resultado = corto(texto, MAX_RESULTADO);
  item.herramienta.estado = error ? "error" : "ok";
  if (ts) item.ts ??= ts;
  acc.poner(item);
}

const INTERNO_CLAUDE = /^<(?:command-|local-command|system-reminder|bash-)/;

/**
 * @param {TranscriptEvent} e
 * @param {Accumulator} acc
 * @param {number} linea
 */
function leerClaude(e, acc, linea) {
  if (e.isSidechain || e.isMeta) return;
  const ts = e.timestamp ?? null;
  if (e.type === "system" && e.subtype === "api_error") {
    acc.poner({
      id: `${e.uuid ?? "l" + linea}:error`,
      tipo: "error",
      texto: corto(
        /** @type {{ message?: unknown }} */ (e.error)?.message ||
          e.content ||
          "El proveedor devolvió un error.",
        2000,
      ),
      ts,
    });
    return;
  }
  if (e.type !== "user" && e.type !== "assistant") return;
  const contenido = e.message?.content;
  const bloques =
    typeof contenido === "string"
      ? [{ type: "text", text: contenido }]
      : Array.isArray(contenido)
        ? contenido
        : [];
  bloques.forEach((bloque, i) => {
    const id = `${e.uuid ?? "l" + linea}:${i}`;
    if (bloque.type === "text" && typeof bloque.text === "string") {
      const texto = bloque.text.trim();
      if (!texto) return;
      if (e.type === "user") {
        if (/^\[Request interrupted by user/.test(texto))
          acc.poner({ id, tipo: "sistema", texto: "Turno interrumpido", ts });
        else if (!INTERNO_CLAUDE.test(texto))
          acc.poner({
            id,
            tipo: "usuario",
            texto: corto(texto, MAX_TEXTO),
            ts,
          });
      } else
        acc.poner({
          id,
          tipo: e.isApiErrorMessage ? "error" : "asistente",
          texto: corto(texto, MAX_TEXTO),
          ts,
        });
    } else if (bloque.type === "tool_use" && bloque.id) {
      const item = herramienta(`h:${bloque.id}`, bloque.name, bloque.input, ts);
      acc.herramientas.set(bloque.id, item);
      acc.poner(item);
    } else if (bloque.type === "tool_result" && bloque.tool_use_id) {
      cerrarHerramienta(
        acc,
        bloque.tool_use_id,
        textoDe(bloque.content),
        bloque.is_error === true,
        ts,
      );
    }
  });
}

const INTERNO_CODEX = /^<(?:environment_context|user_instructions|ide-context)/;
const PREFIJO_LANZADOR = /^Contexto SecondBrain: sesión [a-f0-9-]+\.\s*/i;

/**
 * @param {unknown} valor
 * @returns {unknown}
 */
function argumentos(valor) {
  if (typeof valor !== "string") return valor;
  try {
    return JSON.parse(valor);
  } catch {
    return valor;
  }
}

/**
 * Codex wraps shell output as {"output": "...", "metadata": {"exit_code": n}}.
 * @param {unknown} salida
 */
function resultadoCodex(salida) {
  let valor = salida;
  if (typeof valor === "string" && valor.trimStart().startsWith("{"))
    try {
      valor = JSON.parse(valor);
    } catch {
      /* plain text that merely starts with a brace */
    }
  if (valor && typeof valor === "object" && !Array.isArray(valor)) {
    const objeto =
      /** @type {{ metadata?: { exit_code?: unknown }, output?: unknown, content?: unknown, success?: boolean }} */ (
        valor
      );
    const codigo = objeto.metadata?.exit_code;
    return {
      texto: textoDe(objeto.output ?? objeto.content ?? valor),
      error:
        (typeof codigo === "number" && codigo !== 0) ||
        objeto.success === false,
    };
  }
  return { texto: textoDe(valor), error: false };
}

/**
 * @param {TranscriptEvent} e
 * @param {Accumulator} acc
 * @param {number} linea
 */
function leerCodex(e, acc, linea) {
  if (e.type === "event_msg" && e.payload?.type === "error") {
    acc.poner({
      id: `l${linea}`,
      tipo: "error",
      texto: corto(e.payload.message || "Codex devolvió un error.", 2000),
      ts: e.timestamp ?? null,
    });
    return;
  }
  if (e.type !== "response_item") return;
  const p = e.payload ?? {};
  const ts = e.timestamp ?? null;
  if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
    let texto = (p.content ?? [])
      .filter((c) => ["input_text", "output_text"].includes(c.type))
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (p.role === "user") {
      if (INTERNO_CODEX.test(texto)) return;
      texto = texto.replace(PREFIJO_LANZADOR, "").trim();
    }
    if (!texto) return;
    acc.poner({
      id: p.id ?? `l${linea}`,
      tipo: p.role === "user" ? "usuario" : "asistente",
      texto: corto(texto, MAX_TEXTO),
      ts,
    });
  } else if (
    ["function_call", "custom_tool_call", "local_shell_call"].includes(p.type)
  ) {
    const clave = p.call_id ?? p.id ?? `l${linea}`;
    const item = herramienta(
      `h:${clave}`,
      p.name ?? (p.type === "local_shell_call" ? "shell" : "herramienta"),
      argumentos(p.arguments ?? p.input ?? p.action),
      ts,
    );
    acc.herramientas.set(clave, item);
    acc.poner(item);
  } else if (
    ["function_call_output", "custom_tool_call_output"].includes(p.type) &&
    p.call_id
  ) {
    const { texto, error } = resultadoCodex(p.output);
    cerrarHerramienta(acc, p.call_id, texto, error, ts);
  }
}

// Antigravity's transcript is only known for these entries; anything that looks
// like a tool step degrades to a generic tool item, the rest is ignored.
const PASO_HERRAMIENTA =
  /TOOL|COMMAND|FILE|SEARCH|GREP|LIST_DIR|VIEW|MCP|BROWSER/i;

/**
 * @param {TranscriptEvent} e
 * @param {Accumulator} acc
 * @param {number} linea
 */
function leerAgy(e, acc, linea) {
  const id = String(e.id ?? e.step_id ?? `l${linea}`);
  const ts = e.timestamp ?? e.created_at ?? null;
  if (e.type === "USER_INPUT") {
    const texto = (
      /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(
        e.content || "",
      )?.[1] ??
      e.content ??
      ""
    ).trim();
    if (texto)
      acc.poner({ id, tipo: "usuario", texto: corto(texto, MAX_TEXTO), ts });
  } else if (e.type === "PLANNER_RESPONSE") {
    const texto = String(e.content ?? "").trim();
    if (texto)
      acc.poner({ id, tipo: "asistente", texto: corto(texto, MAX_TEXTO), ts });
  } else if (typeof e.type === "string" && PASO_HERRAMIENTA.test(e.type)) {
    const item = herramienta(
      `h:${id}`,
      e.tool_name ?? e.toolName ?? e.name ?? e.type,
      e.args ?? e.input ?? e.content,
      ts,
    );
    item.herramienta.estado = e.error ? "error" : "ok";
    acc.poner(item);
  }
}

/** @type {Record<string, (event: TranscriptEvent, acc: Accumulator, line: number) => void>} */
const LECTORES = {
  claude: leerClaude,
  deepseek: leerClaude,
  codex: leerCodex,
  agy: leerAgy,
};

/**
 * Incremental reader: `alimentar` takes whole lines (never a partial one) and
 * `drenar` returns only the items that were created or updated since.
 * @param {string} motor
 */
export function crearNormalizador(motor) {
  const leer = LECTORES[motor];
  if (!leer) throw new Error("Motor desconocido");
  const acc = crearAcumulador();
  let linea = 0;
  return {
    /** @param {string} texto */
    alimentar(texto) {
      for (const cruda of texto.split("\n")) {
        linea++;
        if (!cruda.trim()) continue;
        /** @type {TranscriptEvent} */
        let evento;
        try {
          evento = JSON.parse(cruda);
        } catch {
          continue;
        }
        if (evento && typeof evento === "object") leer(evento, acc, linea);
      }
    },
    drenar: acc.drenar,
    todos: acc.todos,
  };
}

/**
 * Whole-transcript convenience used by tests and one-off reads.
 * @param {string} motor
 * @param {string} texto
 */
export function normalizarItems(motor, texto) {
  const normalizador = crearNormalizador(motor);
  normalizador.alimentar(texto);
  return normalizador.todos();
}

// --- Locating and following the provider's file ---------------------------

const UUID = /^[a-f0-9-]{36}$/i;

/**
 * @param {string} raiz
 * @param {string} id
 */
async function buscarCodex(raiz, id) {
  /** @type {string[]} */
  const hallado = [];
  /**
   * @param {string} dir
   * @param {number} profundidad
   */
  async function recorrer(dir, profundidad) {
    if (profundidad > 4 || hallado.length) return;
    for (const entrada of await readdir(dir, { withFileTypes: true }).catch(
      /** @returns {[]} */ () => [],
    )) {
      if (entrada.isSymbolicLink()) continue;
      const completa = path.join(dir, entrada.name);
      if (entrada.isDirectory()) await recorrer(completa, profundidad + 1);
      else if (
        entrada.isFile() &&
        /^rollout-.*\.jsonl$/.test(entrada.name) &&
        entrada.name.includes(id)
      )
        hallado.push(completa);
    }
  }
  await recorrer(raiz, 0);
  return hallado[0] ?? null;
}

/**
 * Path of the provider transcript of a session, or null while it does not exist.
 * @param {TranscriptSession} sesion
 * @param {NodeJS.ProcessEnv} env
 */
export async function localizarTranscript(sesion, env) {
  const ids = [sesion.conversacionId, sesion.id].filter(
    (id, i, todos) =>
      typeof id === "string" && UUID.test(id) && todos.indexOf(id) === i,
  );
  const casa = env.HOME ?? "";
  if (sesion.motor === "claude" || sesion.motor === "deepseek") {
    const raiz = path.join(
      (sesion.motor === "deepseek"
        ? env.AGENTES_DEEPSEEK_DIR
        : env.AGENTES_CLAUDE_DIR) || path.join(casa, "claude"),
      "projects",
    );
    for (const dir of await readdir(raiz, { withFileTypes: true }).catch(
      /** @returns {[]} */ () => [],
    )) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      for (const id of ids) {
        const archivo = path.join(raiz, dir.name, id + ".jsonl");
        if (
          await stat(archivo).then(
            (s) => s.isFile(),
            () => false,
          )
        )
          return archivo;
      }
    }
    return null;
  }
  if (sesion.motor === "codex") {
    const raiz = path.join(
      env.CODEX_HOME || path.join(casa, ".codex"),
      "sessions",
    );
    return sesion.conversacionId && UUID.test(sesion.conversacionId)
      ? buscarCodex(raiz, sesion.conversacionId)
      : null;
  }
  if (sesion.motor === "agy") {
    for (const id of ids) {
      const archivo = path.join(
        casa,
        ".gemini/antigravity-cli/brain",
        id,
        ".system_generated/logs/transcript.jsonl",
      );
      if (
        await stat(archivo).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        return archivo;
    }
  }
  return null;
}

/**
 * Follows one transcript by byte offset: fs.watch wakes it up, a timer is the
 * safety net (watchers are unreliable on some filesystems). Only appended bytes
 * are read; a truncated file starts over.
 * @param {{
 *   localizar: () => Promise<string | null>,
 *   motor: string,
 *   intervalo: number,
 *   alCambiar: TranscriptListener
 * }} options
 */
function seguirArchivo({ localizar, motor, intervalo, alCambiar }) {
  const normalizador0 = () => crearNormalizador(motor);
  let normalizador = normalizador0();
  /** @type {string | null} */
  let archivo = null;
  let offset = 0;
  let resto = "";
  /** @type {import("node:fs").FSWatcher | null} */
  let vigia = null;
  let ocupado = false;
  let pendiente = false;
  let detenido = false;
  const cerrarVigia = () => {
    try {
      vigia?.close();
    } catch {
      /* already closed */
    }
    vigia = null;
  };
  async function leerNuevo() {
    if (ocupado) {
      pendiente = true;
      return;
    }
    ocupado = true;
    try {
      do {
        pendiente = false;
        if (!archivo) {
          archivo = await localizar();
          if (!archivo) continue;
          offset = 0;
          resto = "";
          try {
            vigia = watch(archivo, () => void leerNuevo());
            vigia.on("error", cerrarVigia);
          } catch {
            /* the timer still follows the file */
          }
        }
        const info = await stat(archivo).catch(
          /** @returns {null} */ () => null,
        );
        if (!info) {
          archivo = null;
          cerrarVigia();
          continue;
        }
        if (info.size < offset) {
          normalizador = normalizador0();
          offset = 0;
          resto = "";
        }
        if (info.size === offset) continue;
        if (offset === 0 && info.size > MAX_LECTURA) {
          offset = info.size - MAX_LECTURA;
          resto = null; // drop the partial line we landed in
        }
        const manija = await open(archivo, "r");
        try {
          const buffer = Buffer.alloc(info.size - offset);
          const { bytesRead } = await manija.read(
            buffer,
            0,
            buffer.length,
            offset,
          );
          offset += bytesRead;
          let texto =
            (resto ?? "") + buffer.subarray(0, bytesRead).toString("utf8");
          if (resto === null) texto = texto.slice(texto.indexOf("\n") + 1);
          const corte = texto.lastIndexOf("\n");
          resto = corte < 0 ? texto : texto.slice(corte + 1);
          if (corte >= 0) normalizador.alimentar(texto.slice(0, corte + 1));
        } finally {
          await manija.close();
        }
        const cambiados = normalizador.drenar();
        if (cambiados.length && !detenido) alCambiar(cambiados);
      } while (pendiente && !detenido);
    } catch {
      /* a provider may still be writing; the next tick retries */
    } finally {
      ocupado = false;
    }
  }
  const timer = setInterval(() => void leerNuevo(), intervalo);
  timer.unref();
  void leerNuevo();
  return {
    ultimos: (n = LOTE_INICIAL) => normalizador.todos().slice(-n),
    detener() {
      detenido = true;
      clearInterval(timer);
      cerrarVigia();
    },
  };
}

/**
 * Shares one follower per session among all its readers and stops it with the
 * last one, so an idle transcript costs nothing.
 * @param {{
 *   registro: { leer(): readonly TranscriptSession[] },
 *   env?: NodeJS.ProcessEnv,
 *   intervalo?: number
 * }} options
 */
export function crearItems({ registro, env = process.env, intervalo = 1000 }) {
  /** @type {Map<string, { lectores: Set<TranscriptListener>, seguidor?: ReturnType<typeof seguirArchivo> }>} */
  const seguidores = new Map();
  return {
    activos: () => seguidores.size,
    /**
     * `alCambiar(items)` receives created/updated items.
     * @param {string} id
     * @param {TranscriptListener} alCambiar
     */
    suscribir(id, alCambiar) {
      const sesion = registro.leer().find((s) => s.id === id);
      if (!sesion || !LECTORES[sesion.motor])
        return {
          ultimos: /** @returns {TranscriptItem[]} */ () => [],
          off() {},
        };
      let entrada = seguidores.get(id);
      if (!entrada) {
        entrada = { lectores: new Set() };
        entrada.seguidor = seguirArchivo({
          motor: sesion.motor,
          intervalo,
          localizar: () =>
            localizarTranscript(
              registro.leer().find((s) => s.id === id) ?? sesion,
              env,
            ),
          alCambiar: (lista) => {
            for (const lector of entrada.lectores) lector(lista);
          },
        });
        seguidores.set(id, entrada);
      }
      entrada.lectores.add(alCambiar);
      return {
        /** @param {number} [n] */
        ultimos: (n) => entrada.seguidor.ultimos(n),
        off() {
          entrada.lectores.delete(alCambiar);
          if (!entrada.lectores.size) {
            entrada.seguidor.detener();
            if (seguidores.get(id) === entrada) seguidores.delete(id);
          }
        },
      };
    },
  };
}
