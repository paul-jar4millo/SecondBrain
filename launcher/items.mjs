import { watch } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Structured conversation for the dashboard: provider transcripts become a flat
 * list of items (user, assistant, tool, error, system) with tool calls paired to
 * their results. `readConversation` (conversations.mjs) keeps feeding
 * `sesion.mensajes`; this module is the live, richer view.
 */

const MAX_SUMMARY = 200;
const MAX_RESULT = 2000;
const MAX_TEXT = 100000;
const MAX_ITEMS = 1000;
export const INITIAL_BATCH = 300;
// A transcript this large is read from its tail: the oldest turns are not live.
const MAX_READ = 8 * 1024 * 1024;

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
/** @typedef {ReturnType<typeof createAccumulator>} Accumulator */
/** @typedef {Pick<import("./session-types.d.ts").LauncherSession, "id" | "motor" | "conversacionId">} TranscriptSession */
/** @typedef {(items: TranscriptItem[]) => void} TranscriptListener */

/**
 * @param {unknown} text
 * @param {number} max
 */
const short = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
};

const SUMMARY_KEYS = [
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
 * @param {unknown} entry
 */
export function summarizeEntry(entry) {
  if (entry === null || entry === undefined) return "";
  if (typeof entry === "string")
    return short(entry.replace(/\s+/g, " ").trim(), MAX_SUMMARY);
  if (Array.isArray(entry) && entry.every((x) => typeof x === "string"))
    return short(entry.join(" "), MAX_SUMMARY);
  if (typeof entry === "object") {
    const objeto = /** @type {Record<string, unknown>} */ (entry);
    for (const key of SUMMARY_KEYS) {
      const value = objeto[key];
      if (typeof value === "string" && value.trim())
        return short(value.replace(/\s+/g, " ").trim(), MAX_SUMMARY);
      if (Array.isArray(value) && value.length)
        return short(value.join(" "), MAX_SUMMARY);
    }
    try {
      return short(JSON.stringify(entry), MAX_SUMMARY);
    } catch {
      return "";
    }
  }
  return short(entry, MAX_SUMMARY);
}

/** @param {unknown} contenido */
function textOf(contenido) {
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
    const block = /** @type {TranscriptBlock} */ (contenido);
    return typeof block.text === "string"
      ? block.text
      : typeof block.content === "string"
        ? block.content
        : JSON.stringify(contenido);
  }
  return "";
}

/** State shared by the per-provider readers: ordered items plus changed ids. */
function createAccumulator() {
  /** @type {Map<string, TranscriptItem>} */
  const items = new Map();
  /** @type {Set<string>} */
  const cambiados = new Set();
  /** @type {Map<string, TranscriptToolItem>} */
  const tools = new Map();
  return {
    herramientas: tools,
    /** @param {TranscriptItem} item */
    poner(item) {
      items.set(item.id, item);
      cambiados.add(item.id);
      if (items.size > MAX_ITEMS) {
        // Over the limit the map is never empty, so the oldest key exists.
        const old = /** @type {string} */ (items.keys().next().value);
        items.delete(old);
        cambiados.delete(old);
      }
    },
    /** @param {string} id */
    existe: (id) => items.has(id),
    todos: () => [...items.values()].map((x) => structuredClone(x)),
    drenar() {
      const list = [...cambiados]
        .map((id) => items.get(id))
        .filter((x) => x !== undefined)
        .map((x) => structuredClone(x));
      cambiados.clear();
      return list;
    },
  };
}

/**
 * @param {string} id
 * @param {unknown} name
 * @param {unknown} entry
 * @param {string | null} ts
 * @returns {TranscriptToolItem}
 */
const herramienta = (id, name, entry, ts) => ({
  id,
  tipo: "herramienta",
  herramienta: {
    nombre: String(name || "herramienta").slice(0, 80),
    resumen: summarizeEntry(entry),
    estado: "pendiente",
  },
  ts,
});

/**
 * @param {Accumulator} acc
 * @param {string} key
 * @param {string} text
 * @param {boolean} error
 * @param {string | null} ts
 */
function closeTool(acc, key, text, error, ts) {
  const item = acc.herramientas.get(key);
  if (!item) return;
  item.herramienta.resultado = short(text, MAX_RESULT);
  item.herramienta.estado = error ? "error" : "ok";
  if (ts) item.ts ??= ts;
  acc.poner(item);
}

const CLAUDE_INTERNAL = /^<(?:command-|local-command|system-reminder|bash-)/;

/**
 * @param {TranscriptEvent} e
 * @param {Accumulator} acc
 * @param {number} line
 */
function readClaudeEvent(e, acc, line) {
  if (e.isSidechain || e.isMeta) return;
  const ts = e.timestamp ?? null;
  if (e.type === "system" && e.subtype === "api_error") {
    acc.poner({
      id: `${e.uuid ?? "l" + line}:error`,
      tipo: "error",
      texto: short(
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
  const blocks =
    typeof contenido === "string"
      ? [{ type: "text", text: contenido }]
      : Array.isArray(contenido)
        ? contenido
        : [];
  blocks.forEach((block, i) => {
    const id = `${e.uuid ?? "l" + line}:${i}`;
    if (block.type === "text" && typeof block.text === "string") {
      const texto = block.text.trim();
      if (!texto) return;
      if (e.type === "user") {
        if (/^\[Request interrupted by user/.test(texto))
          acc.poner({ id, tipo: "sistema", texto: "Turno interrumpido", ts });
        else if (!CLAUDE_INTERNAL.test(texto))
          acc.poner({
            id,
            tipo: "usuario",
            texto: short(texto, MAX_TEXT),
            ts,
          });
      } else
        acc.poner({
          id,
          tipo: e.isApiErrorMessage ? "error" : "asistente",
          texto: short(texto, MAX_TEXT),
          ts,
        });
    } else if (block.type === "tool_use" && block.id) {
      const item = herramienta(`h:${block.id}`, block.name, block.input, ts);
      acc.herramientas.set(block.id, item);
      acc.poner(item);
    } else if (block.type === "tool_result" && block.tool_use_id) {
      closeTool(
        acc,
        block.tool_use_id,
        textOf(block.content),
        block.is_error === true,
        ts,
      );
    }
  });
}

const CODEX_INTERNAL =
  /^<(?:environment_context|user_instructions|ide-context)/;
const LAUNCHER_PREFIX = /^Contexto SecondBrain: sesión [a-f0-9-]+\.\s*/i;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function argumentos(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Codex wraps shell output as {"output": "...", "metadata": {"exit_code": n}}.
 * @param {unknown} salida
 */
function codexResult(salida) {
  let value = salida;
  if (typeof value === "string" && value.trimStart().startsWith("{"))
    try {
      value = JSON.parse(value);
    } catch {
      /* plain text that merely starts with a brace */
    }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const objeto =
      /** @type {{ metadata?: { exit_code?: unknown }, output?: unknown, content?: unknown, success?: boolean }} */ (
        value
      );
    const code = objeto.metadata?.exit_code;
    return {
      texto: textOf(objeto.output ?? objeto.content ?? value),
      error:
        (typeof code === "number" && code !== 0) || objeto.success === false,
    };
  }
  return { texto: textOf(value), error: false };
}

/**
 * @param {TranscriptEvent} e
 * @param {Accumulator} acc
 * @param {number} line
 */
function readCodex(e, acc, line) {
  if (e.type === "event_msg" && e.payload?.type === "error") {
    acc.poner({
      id: `l${line}`,
      tipo: "error",
      texto: short(e.payload.message || "Codex devolvió un error.", 2000),
      ts: e.timestamp ?? null,
    });
    return;
  }
  if (e.type !== "response_item") return;
  const p = e.payload ?? {};
  const ts = e.timestamp ?? null;
  if (p.type === "message" && ["user", "assistant"].includes(p.role ?? "")) {
    let texto = (p.content ?? [])
      .filter((c) => ["input_text", "output_text"].includes(c.type ?? ""))
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (p.role === "user") {
      if (CODEX_INTERNAL.test(texto)) return;
      texto = texto.replace(LAUNCHER_PREFIX, "").trim();
    }
    if (!texto) return;
    acc.poner({
      id: p.id ?? `l${line}`,
      tipo: p.role === "user" ? "usuario" : "asistente",
      texto: short(texto, MAX_TEXT),
      ts,
    });
  } else if (
    ["function_call", "custom_tool_call", "local_shell_call"].includes(
      p.type ?? "",
    )
  ) {
    const key = p.call_id ?? p.id ?? `l${line}`;
    const item = herramienta(
      `h:${key}`,
      p.name ?? (p.type === "local_shell_call" ? "shell" : "herramienta"),
      argumentos(p.arguments ?? p.input ?? p.action),
      ts,
    );
    acc.herramientas.set(key, item);
    acc.poner(item);
  } else if (
    ["function_call_output", "custom_tool_call_output"].includes(
      p.type ?? "",
    ) &&
    p.call_id
  ) {
    const { texto, error } = codexResult(p.output);
    closeTool(acc, p.call_id, texto, error, ts);
  }
}

// Antigravity's transcript is only known for these entries; anything that looks
// like a tool step degrades to a generic tool item, the rest is ignored.
const TOOL_STEP = /TOOL|COMMAND|FILE|SEARCH|GREP|LIST_DIR|VIEW|MCP|BROWSER/i;

/**
 * @param {TranscriptEvent} e
 * @param {Accumulator} acc
 * @param {number} line
 */
function readAgy(e, acc, line) {
  const id = String(e.id ?? e.step_id ?? `l${line}`);
  const ts = e.timestamp ?? e.created_at ?? null;
  if (e.type === "USER_INPUT") {
    const text = (
      /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(
        e.content || "",
      )?.[1] ??
      e.content ??
      ""
    ).trim();
    if (text)
      acc.poner({ id, tipo: "usuario", texto: short(text, MAX_TEXT), ts });
  } else if (e.type === "PLANNER_RESPONSE") {
    const texto = String(e.content ?? "").trim();
    if (texto)
      acc.poner({ id, tipo: "asistente", texto: short(texto, MAX_TEXT), ts });
  } else if (typeof e.type === "string" && TOOL_STEP.test(e.type)) {
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
const READERS = {
  claude: readClaudeEvent,
  deepseek: readClaudeEvent,
  codex: readCodex,
  agy: readAgy,
};

/**
 * Incremental reader: `alimentar` takes whole lines (never a partial one) and
 * `drenar` returns only the items that were created or updated since.
 * @param {string} engine
 */
export function createNormalizer(engine) {
  const read = READERS[engine];
  if (!read) throw new Error("Motor desconocido");
  const acc = createAccumulator();
  let line = 0;
  return {
    /** @param {string} text */
    alimentar(text) {
      for (const raw of text.split("\n")) {
        line++;
        if (!raw.trim()) continue;
        /** @type {TranscriptEvent} */
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        if (event && typeof event === "object") read(event, acc, line);
      }
    },
    drenar: acc.drenar,
    todos: acc.todos,
  };
}

/**
 * Whole-transcript convenience used by tests and one-off reads.
 * @param {string} engine
 * @param {string} text
 */
export function normalizeItems(engine, text) {
  const normalizer = createNormalizer(engine);
  normalizer.alimentar(text);
  return normalizer.todos();
}

// --- Locating and following the provider's file ---------------------------

const UUID = /^[a-f0-9-]{36}$/i;

/**
 * @param {string} root
 * @param {string} id
 */
async function findCodex(root, id) {
  /** @type {string[]} */
  const found = [];
  /**
   * @param {string} dir
   * @param {number} depth
   */
  async function walk(dir, depth) {
    if (depth > 4 || found.length) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(
      /** @returns {[]} */ () => [],
    )) {
      if (entry.isSymbolicLink()) continue;
      const complete = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(complete, depth + 1);
      else if (
        entry.isFile() &&
        /^rollout-.*\.jsonl$/.test(entry.name) &&
        entry.name.includes(id)
      )
        found.push(complete);
    }
  }
  await walk(root, 0);
  return found[0] ?? null;
}

/**
 * Path of the provider transcript of a session, or null while it does not exist.
 * @param {TranscriptSession} sesion
 * @param {NodeJS.ProcessEnv} env
 */
export async function locateTranscript(sesion, env) {
  const ids = /** @type {string[]} */ (
    [sesion.conversacionId, sesion.id].filter(
      (id, i, all) =>
        typeof id === "string" && UUID.test(id) && all.indexOf(id) === i,
    )
  );
  const home = env.HOME ?? "";
  if (sesion.motor === "claude" || sesion.motor === "deepseek") {
    const root = path.join(
      (sesion.motor === "deepseek"
        ? env.AGENTES_DEEPSEEK_DIR
        : env.AGENTES_CLAUDE_DIR) || path.join(home, "claude"),
      "projects",
    );
    for (const dir of await readdir(root, { withFileTypes: true }).catch(
      /** @returns {[]} */ () => [],
    )) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      for (const id of ids) {
        const file = path.join(root, dir.name, id + ".jsonl");
        if (
          await stat(file).then(
            (s) => s.isFile(),
            () => false,
          )
        )
          return file;
      }
    }
    return null;
  }
  if (sesion.motor === "codex") {
    const raiz = path.join(
      env.CODEX_HOME || path.join(home, ".codex"),
      "sessions",
    );
    return sesion.conversacionId && UUID.test(sesion.conversacionId)
      ? findCodex(raiz, sesion.conversacionId)
      : null;
  }
  if (sesion.motor === "agy") {
    for (const id of ids) {
      const archivo = path.join(
        home,
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
function followFile({
  localizar: locate,
  motor: engine,
  intervalo: interval,
  alCambiar: onChange,
}) {
  const normalizador0 = () => createNormalizer(engine);
  let normalizer = normalizador0();
  /** @type {string | null} */
  let archivo = null;
  let offset = 0;
  /** @type {string | null} null after a seek, until the next full line. */
  let rest = "";
  /** @type {import("node:fs").FSWatcher | null} */
  let watcher = null;
  let busy = false;
  let pending = false;
  let stopped = false;
  const closeWatcher = () => {
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
    watcher = null;
  };
  async function readNew() {
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    try {
      do {
        pending = false;
        if (!archivo) {
          archivo = await locate();
          if (!archivo) continue;
          offset = 0;
          rest = "";
          try {
            watcher = watch(archivo, () => void readNew());
            watcher.on("error", closeWatcher);
          } catch {
            /* the timer still follows the file */
          }
        }
        const info = await stat(archivo).catch(
          /** @returns {null} */ () => null,
        );
        if (!info) {
          archivo = null;
          closeWatcher();
          continue;
        }
        if (info.size < offset) {
          normalizer = normalizador0();
          offset = 0;
          rest = "";
        }
        if (info.size === offset) continue;
        if (offset === 0 && info.size > MAX_READ) {
          offset = info.size - MAX_READ;
          rest = null; // drop the partial line we landed in
        }
        const handle = await open(archivo, "r");
        try {
          const buffer = Buffer.alloc(info.size - offset);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            offset,
          );
          offset += bytesRead;
          let text =
            (rest ?? "") + buffer.subarray(0, bytesRead).toString("utf8");
          if (rest === null) text = text.slice(text.indexOf("\n") + 1);
          const cutoff = text.lastIndexOf("\n");
          rest = cutoff < 0 ? text : text.slice(cutoff + 1);
          if (cutoff >= 0) normalizer.alimentar(text.slice(0, cutoff + 1));
        } finally {
          await handle.close();
        }
        const changed = normalizer.drenar();
        if (changed.length && !stopped) onChange(changed);
      } while (pending && !stopped);
    } catch {
      /* a provider may still be writing; the next tick retries */
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => void readNew(), interval);
  timer.unref();
  void readNew();
  return {
    ultimos: (n = INITIAL_BATCH) => normalizer.todos().slice(-n),
    detener() {
      stopped = true;
      clearInterval(timer);
      closeWatcher();
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
export function createItems({
  registro: registry,
  env = process.env,
  intervalo: interval = 1000,
}) {
  /** @type {Map<string, { lectores: Set<TranscriptListener>, seguidor: ReturnType<typeof followFile> }>} */
  const followers = new Map();
  return {
    activos: () => followers.size,
    /**
     * `alCambiar(items)` receives created/updated items.
     * @param {string} id
     * @param {TranscriptListener} onChange
     */
    suscribir(id, onChange) {
      const session = registry.leer().find((s) => s.id === id);
      if (!session || !READERS[session.motor])
        return {
          ultimos: /** @returns {TranscriptItem[]} */ () => [],
          off() {},
        };
      let existing = followers.get(id);
      if (!existing) {
        /** @type {Set<TranscriptListener>} */
        const readers = new Set();
        const follower = followFile({
          motor: session.motor,
          intervalo: interval,
          localizar: () =>
            locateTranscript(
              registry.leer().find((s) => s.id === id) ?? session,
              env,
            ),
          alCambiar: (list) => {
            for (const reader of readers) reader(list);
          },
        });
        existing = { lectores: readers, seguidor: follower };
        followers.set(id, existing);
      }
      const entry = existing;
      entry.lectores.add(onChange);
      return {
        /** @param {number} [n] */
        ultimos: (n) => entry.seguidor.ultimos(n),
        off() {
          entry.lectores.delete(onChange);
          if (!entry.lectores.size) {
            entry.seguidor.detener();
            if (followers.get(id) === entry) followers.delete(id);
          }
        },
      };
    },
  };
}
