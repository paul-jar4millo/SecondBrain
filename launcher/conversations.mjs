import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** @import { Dirent } from "node:fs" */
/** @import { SessionMessage, SessionRegistry, SessionState } from "./session-types.d.ts" */
/** @import { ClaudeStreamEvent, GeminiStreamEvent } from "./engine-types.d.ts" */

/** @typedef {{ type: string, text?: string }} TranscriptBlock */
/**
 * @typedef {object} TranscriptRecord
 * @property {string} [type]
 * @property {boolean} [isSidechain]
 * @property {string} [cwd]
 * @property {string} [content]
 * @property {ClaudeStreamEvent["message"] & { content?: string | TranscriptBlock[] }} [message]
 * @property {GeminiStreamEvent["step_update"]} [step_update]
 * @property {{ id?: string, type?: string, role?: string, content?: TranscriptBlock[], info?: { last_token_usage?: { input_tokens?: number, output_tokens?: number } } }} [payload]
 */
/** @typedef {{ motor: "codex", archivo: string, id?: never } | { motor: "claude" | "deepseek" | "agy", archivo: string, id: string }} TranscriptSource */
/** @typedef {{ id: string, estado: SessionState }} TranscriptLink */

const UUID = /^[a-f0-9-]{36}$/i;
/** @param {string} home */
const dirInternal = (home) => path.join(home, "estado/lanzador/internas");

/**
 * Marks a provider conversation as an internal run, never shown as a chat.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [native]
 */
export async function markInternal(env, native) {
  if (!env?.HOME || !native || !UUID.test(native)) return;
  await mkdir(dirInternal(env.HOME), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dirInternal(env.HOME), native + ".json"), "{}", {
    mode: 0o600,
  });
}
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [native]
 */
const isInternal = (env, native) =>
  env.HOME !== undefined && UUID.test(native ?? "")
    ? stat(path.join(dirInternal(env.HOME), native + ".json")).then(
        () => true,
        () => false,
      )
    : Promise.resolve(false);

export const CONTEXT_LIMIT = 400_000;

/**
 * Last request's context, never the accumulated token bill.
 * @param {string} engine
 * @param {string} text
 */
export function readContextUsage(engine, text) {
  let used = null;
  for (const line of text.split("\n")) {
    /** @type {TranscriptRecord} */
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      ["claude", "deepseek"].includes(engine) &&
      e.type === "assistant" &&
      !e.isSidechain &&
      e.message?.usage
    ) {
      const u = e.message.usage;
      used =
        (u.input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0) +
        (u.output_tokens || 0);
    } else if (
      engine === "codex" &&
      e.type === "event_msg" &&
      e.payload?.type === "token_count"
    ) {
      const u = e.payload.info?.last_token_usage;
      if (u) used = (u.input_tokens || 0) + (u.output_tokens || 0);
    } else if (
      engine === "agy" &&
      e.step_update?.step_type === "agent_response" &&
      e.step_update?.usage
    ) {
      const u = e.step_update.usage;
      used =
        (u.input_tokens || 0) +
        (u.cache_read_tokens || 0) +
        (u.output_tokens || 0);
    }
  }
  return used !== null && Number.isFinite(used) && used > 0
    ? { usados: used, limite: CONTEXT_LIMIT }
    : null;
}

/**
 * @param {string} engine
 * @param {string} texto
 */
export function readConversation(engine, texto) {
  /** @type {SessionMessage[]} */
  const messages = [];
  for (const line of texto.split("\n")) {
    /** @type {TranscriptRecord} */
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    let rol, contenido;
    if (["claude", "deepseek"].includes(engine) && !e.isSidechain) {
      if (["user", "assistant"].includes(e.type ?? "")) {
        rol = e.type;
        const c = e.message?.content;
        contenido =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c
                  .filter((x) => x.type === "text")
                  .map((x) => x.text)
                  .join("\n")
              : "";
      }
    } else if (
      engine === "codex" &&
      e.type === "response_item" &&
      e.payload?.type === "message" &&
      ["user", "assistant"].includes(e.payload.role ?? "")
    ) {
      rol = e.payload.role;
      contenido = e.payload.content
        ?.filter((c) => ["input_text", "output_text"].includes(c.type))
        .map((c) => c.text)
        .join("\n");
    } else if (engine === "agy") {
      if (e.type === "USER_INPUT") {
        rol = "user";
        contenido =
          /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(
            e.content || "",
          )?.[1] ?? e.content;
      } else if (e.type === "PLANNER_RESPONSE") {
        rol = "assistant";
        contenido = e.content;
      }
    }
    if (rol && typeof contenido === "string" && contenido.trim())
      messages.push({ rol, texto: contenido.trim().slice(0, 100000) });
  }
  return messages.slice(-100);
}

// Only provider-owned operational transcripts; never scan the vault or project files.
/**
 * @param {{ registro: Pick<SessionRegistry, "leer" | "actualizar" | "crear">, env: NodeJS.ProcessEnv, proyectos: Readonly<Record<string, string>>, intervalo?: number }} options
 */
export function watchConversations({
  registro: registry,
  env,
  proyectos,
  intervalo: interval = 2000,
}) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  let busy = false;
  let stopped = false;
  async function update() {
    const home = env.HOME;
    if (busy || stopped || home === undefined) return;
    busy = true;
    try {
      /** @type {TranscriptSource[]} */
      const sources = [];
      const codex = path.join(
        env.CODEX_HOME || path.join(home, ".codex"),
        "sessions",
      );
      /** @param {string} dir */
      async function scan(dir, depth = 0) {
        if (depth > 4) return;
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(
          /** @returns {Dirent[]} */ () => [],
        )) {
          if (entry.isSymbolicLink()) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await scan(full, depth + 1);
          else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))
            sources.push({ motor: "codex", archivo: full });
        }
      }
      await scan(codex);
      for (const [engine, configDir] of /** @type {const} */ ([
        ["claude", env.AGENTES_CLAUDE_DIR || path.join(home, "claude")],
        ["deepseek", env.AGENTES_DEEPSEEK_DIR],
      ])) {
        if (!configDir) continue;
        const folder = path.join(configDir, "projects");
        for (const dir of await readdir(folder, { withFileTypes: true }).catch(
          /** @returns {Dirent[]} */ () => [],
        )) {
          if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
          for (const file of await readdir(path.join(folder, dir.name)).catch(
            /** @returns {string[]} */ () => [],
          ))
            if (/^[a-f0-9-]{36}\.jsonl$/i.test(file))
              sources.push({
                motor: engine,
                id: file.slice(0, -6),
                archivo: path.join(folder, dir.name, file),
              });
        }
      }
      const agy = path.join(home, ".gemini/antigravity-cli/brain");
      for (const dir of await readdir(agy, { withFileTypes: true }).catch(
        /** @returns {Dirent[]} */ () => [],
      ))
        if (dir.isDirectory() && /^[a-f0-9-]{36}$/i.test(dir.name))
          sources.push({
            motor: "agy",
            id: dir.name,
            archivo: path.join(
              agy,
              dir.name,
              ".system_generated/logs/transcript.jsonl",
            ),
          });
      for (const source of sources) {
        try {
          if (await isInternal(env, source.id)) continue;
          const s = await stat(source.archivo);
          const link = await readFile(
            path.join(home, "estado/lanzador/links", source.id + ".json"),
            "utf8",
          )
            .then(/** @returns {TranscriptLink} */ (value) => JSON.parse(value))
            .catch(/** @returns {null} */ () => null);
          const revision = s.mtimeMs + ":" + (link?.estado || "");
          if (
            s.size > 16 * 1024 * 1024 ||
            seen.get(source.archivo) === revision
          )
            continue;
          const text = await readFile(source.archivo, "utf8");
          const messages = readConversation(source.motor, text);
          if (!messages.length) continue;
          const context = readContextUsage(source.motor, text);
          if (source.motor === "codex") {
            /** @type {TranscriptRecord["payload"]} */
            let meta;
            for (const line of text.split("\n")) {
              try {
                const e = /** @type {TranscriptRecord} */ (JSON.parse(line));
                if (e.type === "session_meta") {
                  meta = e.payload;
                  break;
                }
              } catch {}
            }
            const session = registry
              .leer()
              .find(
                (x) =>
                  x.motor === "codex" &&
                  (x.conversacionId === meta?.id ||
                    messages.some(
                      (m) =>
                        m.rol === "user" &&
                        m.texto.includes(
                          `Contexto SecondBrain: sesión ${x.id}.`,
                        ),
                    )),
              );
            if (
              !session ||
              session.structured ||
              !meta?.id ||
              !UUID.test(meta.id) ||
              (await isInternal(env, meta.id))
            )
              continue;
            await registry.actualizar(session.id, {
              conversacionId: meta.id,
              mensajes: messages,
              ...(context ? { contexto: context } : {}),
              resultado:
                messages.filter((m) => m.rol === "assistant").at(-1)?.texto ||
                "",
            });
            seen.set(source.archivo, revision);
            continue;
          }
          let sesion = registry
            .leer()
            .find(
              (x) =>
                x.motor === source.motor &&
                (x.conversacionId === source.id || x.id === link?.id),
            );
          if (!sesion) {
            // Expired tombstones must not revive as old provider transcripts.
            if (s.mtimeMs < Date.now() - 90 * 86400000) continue;
            if (
              registry
                .leer()
                .some(
                  (x) =>
                    x.motor === source.motor &&
                    x.estado === "trabajando" &&
                    !x.conversacionId,
                )
            )
              continue;
            /** @type {string | undefined} */
            let cwd;
            if (["claude", "deepseek"].includes(source.motor)) {
              for (const l of text.split("\n")) {
                try {
                  cwd = /** @type {TranscriptRecord} */ (JSON.parse(l)).cwd;
                  if (cwd) break;
                } catch {}
              }
            }
            const project =
              Object.entries(proyectos).find(([, p]) => p === cwd)?.[0] ?? null;
            sesion = await registry.crear({
              motor: source.motor,
              origen: "remote",
              proyecto: project,
              encargo: messages.find((m) => m.rol === "user")?.texto,
            });
          }
          if (sesion.structured) continue;
          await registry.actualizar(sesion.id, {
            conversacionId: source.id,
            mensajes: messages,
            ...(context ? { contexto: context } : {}),
            resultado:
              messages.filter((m) => m.rol === "assistant").at(-1)?.texto || "",
            ...(sesion.origen === "remote" ? { estado: "terminada" } : {}),
            ...(link?.id === sesion.id && sesion.interactiva
              ? { estado: link.estado }
              : {}),
          });
          seen.set(source.archivo, revision);
        } catch {
          /* A provider may still be writing its transcript. Retry next tick. */
        }
      }
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => void update(), interval);
  timer.unref();
  void update();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
