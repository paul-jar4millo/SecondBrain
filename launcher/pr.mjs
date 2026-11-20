import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { LauncherError } from "./errors.mjs";
import { markInternal } from "./conversations.mjs";
import {
  engineCommand,
  environmentOf,
  readClaudeEvent,
  readGeminiEvent,
  economyModel,
  newClaudeState,
} from "./engines.mjs";

/** @import { LauncherSession } from "./session-types.d.ts" */

const AGENT = {
  claude: "ambar",
  codex: "menta",
  agy: "lira",
  deepseek: "marina",
};
const TYPES = "build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test";
const CONVENTIONAL = new RegExp(`^(${TYPES})(\\([\\w./-]+\\))?!?: \\S.*$`);
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20000;
const REDACTION_TIME = 120000;

/** @param {unknown} title */
export const isConventional = (title) =>
  typeof title === "string" &&
  title.length <= MAX_TITLE &&
  CONVENTIONAL.test(title);

/** @param {unknown} text */
export function slug(text, max = 40) {
  const clean = String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return clean || "cambios";
}

/** @param {Pick<LauncherSession, "motor" | "encargo" | "id">} session */
export const branchName = (session) =>
  `sb/${AGENT[session.motor] ?? "agente"}-${slug(firstLine(session.encargo))}-${session.id.slice(0, 6)}`;

/** @param {string} task */
function typeOf(task) {
  if (/\b(corrige|corregir|arregla|arreglar|fix|bug|error|falla)\b/i.test(task))
    return "fix";
  if (/\b(docs?|documenta|documentaci[oó]n|readme)\b/i.test(task))
    return "docs";
  if (/\b(pruebas?|tests?)\b/i.test(task)) return "test";
  if (/\brefactor/i.test(task)) return "refactor";
  return "feat";
}

/** @param {unknown} text */
const firstLine = (text) =>
  String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";

/** @param {string} ts */
const hour = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toISOString().slice(0, 16).replace("T", " ");
};

/**
 * Deterministic title and description from what the launcher already knows:
 * the brief, the agent's last reply, the changed files and the turn log.
 * @param {{ sesion: Pick<LauncherSession, "encargo" | "resultado" | "checkpoints">, archivos?: { estado: string, ruta: string, binario?: boolean, añadidas?: number, eliminadas?: number }[], ultimaRespuesta?: string }} input
 */
export function proposalPr({
  sesion: session,
  archivos = [],
  ultimaRespuesta: lastResponse = "",
}) {
  const task = firstLine(session.encargo);
  let titulo;
  if (isConventional(task.slice(0, 72))) titulo = task.slice(0, 72);
  else {
    const subject = task
      .replace(/^[A-ZÁÉÍÓÚÑ]/, (c) => c.toLowerCase())
      .replace(/[.:;]+$/, "");
    const type = typeOf(task);
    titulo = `${type}: ${subject || "cambios de la sesión"}`
      .slice(0, 72)
      .trim();
  }
  const sections = [];
  const summary = String(lastResponse || session.resultado || "").trim();
  if (summary) sections.push(`## Resumen\n\n${summary.slice(0, 1500)}`);
  if (archivos.length) {
    const lines = archivos
      .slice(0, 50)
      .map(
        (a) =>
          `- \`${a.estado}\` ${a.ruta}${a.binario ? " (binario)" : ` (+${a.añadidas} −${a.eliminadas})`}`,
      );
    if (archivos.length > 50) lines.push(`- … y ${archivos.length - 50} más`);
    sections.push(`## Archivos (${archivos.length})\n\n${lines.join("\n")}`);
  }
  const turns = (session.checkpoints ?? []).filter(
    (c) => c.tipo !== "reversion",
  );
  if (turns.length)
    sections.push(
      `## Cambios por turno\n\n${turns
        .slice(-20)
        .map((c, i) => `${i + 1}. ${c.mensaje || "Turno"} (${hour(c.ts)})`)
        .join("\n")}`,
    );
  return {
    titulo,
    descripcion: sections.join("\n\n").slice(0, MAX_DESCRIPTION),
  };
}

/** @param {string} text */
function extractJson(text) {
  const inicio = text.indexOf("{");
  const fin = text.lastIndexOf("}");
  if (inicio < 0 || fin <= inicio) return null;
  try {
    return JSON.parse(text.slice(inicio, fin + 1));
  } catch {
    return null;
  }
}

/**
 * Pull-request flow and optional drafting by the session's own engine.
 * `ejecutor` is the git/gh runner of git.mjs; `info(cwd)` tells repo facts.
 * @param {{ git: ReturnType<typeof import("./git.mjs").createGit>, info: ReturnType<typeof import("./checkpoints.mjs").createCheckpoints>["info"], env?: NodeJS.ProcessEnv, lanzar?: typeof spawn, comando?: typeof engineCommand }} options
 */
export function createPrClient({
  git: executor,
  info,
  env = process.env,
  lanzar: launch = spawn,
  comando: command = engineCommand,
}) {
  const { git, gh } = executor;
  const inProgress = new Set();

  /** @param {string} cwd */
  async function defaultBranch(cwd) {
    const ref = await git(cwd, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]).then(
      (r) => r.stdout.trim().replace(/^origin\//, ""),
      () => "",
    );
    if (ref) return ref;
    for (const branch of ["main", "master"]) {
      for (const complete of [
        `refs/remotes/origin/${branch}`,
        `refs/heads/${branch}`,
      ])
        if (
          await git(cwd, ["rev-parse", "--verify", "-q", complete]).then(
            () => true,
            () => false,
          )
        )
          return branch;
    }
    throw new LauncherError("No se pudo determinar la rama por defecto.");
  }

  /** @param {{ sesion: LauncherSession, cwd: string, titulo: string, descripcion: string, borrador?: boolean }} input */
  async function crear({
    sesion: session,
    cwd,
    titulo,
    descripcion: description,
    borrador = false,
  }) {
    if (!isConventional(titulo))
      throw new LauncherError(
        "El título debe seguir Conventional Commits, por ejemplo «feat: añade X».",
        400,
      );
    if (typeof description !== "string" || description.length > MAX_DESCRIPTION)
      throw new LauncherError("La descripción es demasiado larga.", 400);
    if (inProgress.has(session.id))
      throw new LauncherError("Ya hay un PR en curso para esta sesión.");
    inProgress.add(session.id);
    try {
      const repo = await info(cwd);
      if (!repo.esRepo || !repo.remotoGithub)
        throw new LauncherError(
          "La sesión no está en un repositorio con remoto en GitHub.",
        );
      const defecto = await defaultBranch(cwd);
      const actual = (
        await git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() => {
          throw new LauncherError(
            "El repositorio está en HEAD desacoplado; cambia a una rama.",
          );
        })
      ).stdout.trim();
      const dirty = (await git(cwd, ["status", "--porcelain"])).stdout.trim();
      const ahead = await git(cwd, [
        "rev-list",
        "--count",
        `origin/${defecto}..HEAD`,
      ]).then(
        (r) => Number(r.stdout.trim()) || 0,
        () => 0,
      );
      const newBranch = actual === defecto;
      if (!dirty && (newBranch || !ahead))
        throw new LauncherError("No hay cambios para enviar en un PR.");
      const branch = newBranch ? branchName(session) : actual;
      if (newBranch) {
        try {
          await git(cwd, ["checkout", "-b", branch]);
        } catch {
          throw new LauncherError("No se pudo crear la rama del PR.");
        }
      }
      const identity = (
        await git(cwd, ["config", "user.email"]).catch(() => ({ stdout: "" }))
      ).stdout.trim()
        ? {}
        : {
            GIT_AUTHOR_NAME: "SecondBrain",
            GIT_AUTHOR_EMAIL: "agente@secondbrain.invalid",
            GIT_COMMITTER_NAME: "SecondBrain",
            GIT_COMMITTER_EMAIL: "agente@secondbrain.invalid",
          };
      try {
        await git(cwd, ["add", "-A"]);
        const nothing = await git(cwd, ["diff", "--cached", "--quiet"]).then(
          () => true,
          () => false,
        );
        if (!nothing)
          await git(cwd, ["commit", "-m", titulo], {
            env: identity,
            timeout: 120000,
          });
      } catch {
        throw new LauncherError(
          "No se pudo crear el commit; revisa los hooks del repositorio.",
        );
      }
      const commit = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      try {
        await git(cwd, ["push", "-u", "origin", branch], { timeout: 120000 });
      } catch {
        throw new LauncherError(
          "No se pudo enviar la rama al remoto. El commit quedó en local.",
          502,
        );
      }
      const open = await gh(cwd, [
        "pr",
        "view",
        branch,
        "--json",
        "url,state",
      ]).then(
        (r) => {
          const data = JSON.parse(r.stdout);
          return data.state === "OPEN" ? data.url : null;
        },
        /** @returns {null} */ () => null,
      );
      if (open) return { rama: branch, commit, url: open, existente: true };
      let output;
      try {
        output = (
          await gh(
            cwd,
            [
              "pr",
              "create",
              "--head",
              branch,
              "--base",
              defecto,
              "--title",
              titulo,
              "--body",
              description,
              ...(borrador ? ["--draft"] : []),
            ],
            { timeout: 120000 },
          )
        ).stdout;
      } catch {
        throw new LauncherError(
          "La rama se envió, pero gh no pudo abrir el PR.",
          502,
        );
      }
      const url = /https?:\/\/\S+/.exec(output)?.[0];
      if (!url)
        throw new LauncherError("gh no devolvió la dirección del PR.", 502);
      return { rama: branch, commit, url, existente: false };
    } finally {
      inProgress.delete(session.id);
    }
  }

  /**
   * One short headless run of the session's engine, only when the user asks.
   * @param {{ sesion: LauncherSession, cwd: string, propuesta: ReturnType<typeof proposalPr>, parche?: string, catalogo?: Partial<Record<string, Parameters<typeof economyModel>[1]>> }} input
   */
  async function redact({
    sesion,
    cwd,
    propuesta: proposal,
    parche: patch = "",
    catalogo: catalog = {},
  }) {
    const prompt = [
      "Redacta el título y la descripción de un pull request, en español.",
      'Responde ÚNICAMENTE con un objeto JSON: {"titulo": "...", "descripcion": "..."}.',
      "El título sigue Conventional Commits (tipo(ámbito): resumen), máximo 72 caracteres.",
      "La descripción usa Markdown breve. No uses herramientas ni modifiques archivos.",
      "",
      `Encargo: ${String(sesion.encargo ?? "").slice(0, 1500)}`,
      "",
      "Propuesta actual:",
      proposal.titulo,
      proposal.descripcion.slice(0, 4000),
      "",
      "Parche (recortado):",
      patch.slice(0, 6000),
    ].join("\n");
    const spec = command(sesion.motor, prompt, {
      modelo: economyModel(sesion.motor, catalog[sesion.motor]) ?? undefined,
    });
    // An internal run is not a conversation: with the session's own id the
    // hooks would link its transcript to that session and the observer would
    // replace its messages. Its provider id is marked so it is never imported.
    const interno = randomUUID();
    const marcadas = new Set();
    /** @param {unknown} native */
    const mark = (native) => {
      if (typeof native !== "string" || marcadas.has(native)) return;
      marcadas.add(native);
      return markInternal(env, native).catch(() => {});
    };
    if (sesion.motor === "claude" || sesion.motor === "deepseek") {
      spec.args = [...spec.args, "--session-id", interno];
      await mark(interno);
    }
    /** @type {Partial<Record<string, string>>} */
    const providers = { codex: "chatgpt", agy: "gemini" };
    const proveedor = providers[sesion.motor] || sesion.motor;
    const child = launch(spec.bin, spec.args, {
      cwd,
      env: { ...environmentOf(proveedor, env), SB_SESSION_ID: interno },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const accumulated = newClaudeState();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      mark(
        event.session_id ||
          event.thread_id ||
          event.conversationId ||
          event.conversation_id,
      );
      if (sesion.motor === "claude" || sesion.motor === "deepseek")
        readClaudeEvent(accumulated, event);
      else if (sesion.motor === "agy") readGeminiEvent(accumulated, event);
      else if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
      )
        accumulated.texto = String(event.item.text || "");
    });
    child.stderr?.resume();
    let clock;
    const code = await new Promise((resolve) => {
      clock = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(-1);
      }, REDACTION_TIME);
      child.once("error", () => resolve(-1));
      child.once("close", resolve);
    });
    clearTimeout(clock);
    const data =
      code === 0 && !accumulated.error ? extractJson(accumulated.texto) : null;
    const title = String(data?.titulo ?? "").trim();
    if (!isConventional(title) || typeof data?.descripcion !== "string")
      throw new LauncherError(
        "El agente no pudo redactar el PR; se conserva la propuesta.",
        502,
      );
    return {
      titulo: title,
      descripcion: data.descripcion.slice(0, MAX_DESCRIPTION),
    };
  }

  return { crear, redactar: redact };
}
