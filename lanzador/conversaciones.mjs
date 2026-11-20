import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** @import { Dirent } from "node:fs" */
/** @import { SessionMessage, SessionRegistry, SessionState } from "./session-types.d.ts" */
/** @import { ClaudeStreamEvent, GeminiStreamEvent } from "./motor-types.d.ts" */

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
/** @param {NodeJS.ProcessEnv} env */
const dirInternas = (env) => path.join(env.HOME, "estado/lanzador/internas");

/**
 * Marks a provider conversation as an internal run, never shown as a chat.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [nativo]
 */
export async function marcarInterna(env, nativo) {
  if (!env?.HOME || !UUID.test(nativo)) return;
  await mkdir(dirInternas(env), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dirInternas(env), nativo + ".json"), "{}", {
    mode: 0o600,
  });
}
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [nativo]
 */
const esInterna = (env, nativo) =>
  UUID.test(nativo ?? "")
    ? stat(path.join(dirInternas(env), nativo + ".json")).then(
        () => true,
        () => false,
      )
    : Promise.resolve(false);

export const LIMITE_CONTEXTO = 400_000;

/**
 * Last request's context, never the accumulated token bill.
 * @param {string} motor
 * @param {string} texto
 */
export function leerContexto(motor, texto) {
  let usados = null;
  for (const linea of texto.split("\n")) {
    /** @type {TranscriptRecord} */
    let e;
    try {
      e = JSON.parse(linea);
    } catch {
      continue;
    }
    if (
      ["claude", "deepseek"].includes(motor) &&
      e.type === "assistant" &&
      !e.isSidechain &&
      e.message?.usage
    ) {
      const u = e.message.usage;
      usados =
        (u.input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0) +
        (u.output_tokens || 0);
    } else if (
      motor === "codex" &&
      e.type === "event_msg" &&
      e.payload?.type === "token_count"
    ) {
      const u = e.payload.info?.last_token_usage;
      if (u) usados = (u.input_tokens || 0) + (u.output_tokens || 0);
    } else if (
      motor === "agy" &&
      e.step_update?.step_type === "agent_response" &&
      e.step_update?.usage
    ) {
      const u = e.step_update.usage;
      usados =
        (u.input_tokens || 0) +
        (u.cache_read_tokens || 0) +
        (u.output_tokens || 0);
    }
  }
  return Number.isFinite(usados) && usados > 0
    ? { usados, limite: LIMITE_CONTEXTO }
    : null;
}

/**
 * @param {string} motor
 * @param {string} texto
 */
export function leerConversacion(motor, texto) {
  /** @type {SessionMessage[]} */
  const mensajes = [];
  for (const line of texto.split("\n")) {
    /** @type {TranscriptRecord} */
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    let rol, contenido;
    if (["claude", "deepseek"].includes(motor) && !e.isSidechain) {
      if (["user", "assistant"].includes(e.type)) {
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
      motor === "codex" &&
      e.type === "response_item" &&
      e.payload?.type === "message" &&
      ["user", "assistant"].includes(e.payload.role)
    ) {
      rol = e.payload.role;
      contenido = e.payload.content
        ?.filter((c) => ["input_text", "output_text"].includes(c.type))
        .map((c) => c.text)
        .join("\n");
    } else if (motor === "agy") {
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
      mensajes.push({ rol, texto: contenido.trim().slice(0, 100000) });
  }
  return mensajes.slice(-100);
}

// Only provider-owned operational transcripts; never scan the vault or project files.
/**
 * @param {{ registro: Pick<SessionRegistry, "leer" | "actualizar" | "crear">, env: NodeJS.ProcessEnv, proyectos: Readonly<Record<string, string>>, intervalo?: number }} options
 */
export function observarConversaciones({
  registro,
  env,
  proyectos,
  intervalo = 2000,
}) {
  /** @type {Map<string, string>} */
  const vistos = new Map();
  let ocupado = false;
  let detenido = false;
  async function actualizar() {
    if (ocupado || detenido) return;
    ocupado = true;
    try {
      /** @type {TranscriptSource[]} */
      const fuentes = [];
      const codex = path.join(
        env.CODEX_HOME || path.join(env.HOME, ".codex"),
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
            fuentes.push({ motor: "codex", archivo: full });
        }
      }
      await scan(codex);
      for (const [motor, configDir] of /** @type {const} */ ([
        ["claude", env.AGENTES_CLAUDE_DIR || path.join(env.HOME, "claude")],
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
              fuentes.push({
                motor,
                id: file.slice(0, -6),
                archivo: path.join(folder, dir.name, file),
              });
        }
      }
      const agy = path.join(env.HOME, ".gemini/antigravity-cli/brain");
      for (const dir of await readdir(agy, { withFileTypes: true }).catch(
        /** @returns {Dirent[]} */ () => [],
      ))
        if (dir.isDirectory() && /^[a-f0-9-]{36}$/i.test(dir.name))
          fuentes.push({
            motor: "agy",
            id: dir.name,
            archivo: path.join(
              agy,
              dir.name,
              ".system_generated/logs/transcript.jsonl",
            ),
          });
      for (const fuente of fuentes) {
        try {
          if (await esInterna(env, fuente.id)) continue;
          const s = await stat(fuente.archivo);
          const link = await readFile(
            path.join(env.HOME, "estado/lanzador/links", fuente.id + ".json"),
            "utf8",
          )
            .then(/** @returns {TranscriptLink} */ (value) => JSON.parse(value))
            .catch(/** @returns {null} */ () => null);
          const revision = s.mtimeMs + ":" + (link?.estado || "");
          if (
            s.size > 16 * 1024 * 1024 ||
            vistos.get(fuente.archivo) === revision
          )
            continue;
          const texto = await readFile(fuente.archivo, "utf8");
          const mensajes = leerConversacion(fuente.motor, texto);
          if (!mensajes.length) continue;
          const contexto = leerContexto(fuente.motor, texto);
          if (fuente.motor === "codex") {
            /** @type {TranscriptRecord["payload"]} */
            let meta;
            for (const line of texto.split("\n")) {
              try {
                const e = /** @type {TranscriptRecord} */ (JSON.parse(line));
                if (e.type === "session_meta") {
                  meta = e.payload;
                  break;
                }
              } catch {}
            }
            const session = registro
              .leer()
              .find(
                (x) =>
                  x.motor === "codex" &&
                  (x.conversacionId === meta?.id ||
                    mensajes.some(
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
              !UUID.test(meta?.id || "") ||
              (await esInterna(env, meta.id))
            )
              continue;
            await registro.actualizar(session.id, {
              conversacionId: meta.id,
              mensajes,
              ...(contexto ? { contexto } : {}),
              resultado:
                mensajes.filter((m) => m.rol === "assistant").at(-1)?.texto ||
                "",
            });
            vistos.set(fuente.archivo, revision);
            continue;
          }
          let sesion = registro
            .leer()
            .find(
              (x) =>
                x.motor === fuente.motor &&
                (x.conversacionId === fuente.id || x.id === link?.id),
            );
          if (!sesion) {
            // Expired tombstones must not revive as old provider transcripts.
            if (s.mtimeMs < Date.now() - 90 * 86400000) continue;
            if (
              registro
                .leer()
                .some(
                  (x) =>
                    x.motor === fuente.motor &&
                    x.estado === "trabajando" &&
                    !x.conversacionId,
                )
            )
              continue;
            /** @type {string | undefined} */
            let cwd;
            if (["claude", "deepseek"].includes(fuente.motor)) {
              for (const l of texto.split("\n")) {
                try {
                  cwd = /** @type {TranscriptRecord} */ (JSON.parse(l)).cwd;
                  if (cwd) break;
                } catch {}
              }
            }
            const proyecto =
              Object.entries(proyectos).find(([, p]) => p === cwd)?.[0] ?? null;
            sesion = await registro.crear({
              motor: fuente.motor,
              origen: "remote",
              proyecto,
              encargo: mensajes.find((m) => m.rol === "user")?.texto,
            });
          }
          if (sesion.structured) continue;
          await registro.actualizar(sesion.id, {
            conversacionId: fuente.id,
            mensajes,
            ...(contexto ? { contexto } : {}),
            resultado:
              mensajes.filter((m) => m.rol === "assistant").at(-1)?.texto || "",
            ...(sesion.origen === "remote" ? { estado: "terminada" } : {}),
            ...(link?.id === sesion.id && sesion.interactiva
              ? { estado: link.estado }
              : {}),
          });
          vistos.set(fuente.archivo, revision);
        } catch {
          /* A provider may still be writing its transcript. Retry next tick. */
        }
      }
    } finally {
      ocupado = false;
    }
  }
  const timer = setInterval(() => void actualizar(), intervalo);
  timer.unref();
  void actualizar();
  return () => {
    detenido = true;
    clearInterval(timer);
  };
}
