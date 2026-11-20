import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { ErrorLanzador } from "./errores.mjs";
import { marcarInterna } from "./conversaciones.mjs";
import {
  comandoMotor,
  entornoDe,
  leerClaude,
  leerGemini,
  modeloEconomico,
  nuevoClaude,
} from "./motores.mjs";

/** @import { LauncherSession } from "./session-types.d.ts" */

const AGENTE = {
  claude: "ambar",
  codex: "menta",
  agy: "lira",
  deepseek: "marina",
};
const TIPOS = "build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test";
const CONVENCIONAL = new RegExp(`^(${TIPOS})(\\([\\w./-]+\\))?!?: \\S.*$`);
const MAX_TITULO = 200;
const MAX_DESCRIPCION = 20000;
const TIEMPO_REDACCION = 120000;

/** @param {unknown} titulo */
export const esConvencional = (titulo) =>
  typeof titulo === "string" &&
  titulo.length <= MAX_TITULO &&
  CONVENCIONAL.test(titulo);

/** @param {unknown} texto */
export function slug(texto, max = 40) {
  const limpio = String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return limpio || "cambios";
}

/** @param {Pick<LauncherSession, "motor" | "encargo" | "id">} sesion */
export const nombreRama = (sesion) =>
  `sb/${AGENTE[sesion.motor] ?? "agente"}-${slug(primeraLinea(sesion.encargo))}-${sesion.id.slice(0, 6)}`;

/** @param {string} encargo */
function tipoDe(encargo) {
  if (
    /\b(corrige|corregir|arregla|arreglar|fix|bug|error|falla)\b/i.test(encargo)
  )
    return "fix";
  if (/\b(docs?|documenta|documentaci[oó]n|readme)\b/i.test(encargo))
    return "docs";
  if (/\b(pruebas?|tests?)\b/i.test(encargo)) return "test";
  if (/\brefactor/i.test(encargo)) return "refactor";
  return "feat";
}

/** @param {unknown} texto */
const primeraLinea = (texto) =>
  String(texto ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";

/** @param {string} ts */
const hora = (ts) => {
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
export function propuestaPr({ sesion, archivos = [], ultimaRespuesta = "" }) {
  const encargo = primeraLinea(sesion.encargo);
  let titulo;
  if (esConvencional(encargo.slice(0, 72))) titulo = encargo.slice(0, 72);
  else {
    const sujeto = encargo
      .replace(/^[A-ZÁÉÍÓÚÑ]/, (c) => c.toLowerCase())
      .replace(/[.:;]+$/, "");
    const tipo = tipoDe(encargo);
    titulo = `${tipo}: ${sujeto || "cambios de la sesión"}`.slice(0, 72).trim();
  }
  const secciones = [];
  const resumen = String(ultimaRespuesta || sesion.resultado || "").trim();
  if (resumen) secciones.push(`## Resumen\n\n${resumen.slice(0, 1500)}`);
  if (archivos.length) {
    const lineas = archivos
      .slice(0, 50)
      .map(
        (a) =>
          `- \`${a.estado}\` ${a.ruta}${a.binario ? " (binario)" : ` (+${a.añadidas} −${a.eliminadas})`}`,
      );
    if (archivos.length > 50) lineas.push(`- … y ${archivos.length - 50} más`);
    secciones.push(`## Archivos (${archivos.length})\n\n${lineas.join("\n")}`);
  }
  const turnos = (sesion.checkpoints ?? []).filter(
    (c) => c.tipo !== "reversion",
  );
  if (turnos.length)
    secciones.push(
      `## Cambios por turno\n\n${turnos
        .slice(-20)
        .map((c, i) => `${i + 1}. ${c.mensaje || "Turno"} (${hora(c.ts)})`)
        .join("\n")}`,
    );
  return {
    titulo,
    descripcion: secciones.join("\n\n").slice(0, MAX_DESCRIPCION),
  };
}

/** @param {string} texto */
function extraerJson(texto) {
  const inicio = texto.indexOf("{");
  const fin = texto.lastIndexOf("}");
  if (inicio < 0 || fin <= inicio) return null;
  try {
    return JSON.parse(texto.slice(inicio, fin + 1));
  } catch {
    return null;
  }
}

/**
 * Pull-request flow and optional drafting by the session's own engine.
 * `ejecutor` is the git/gh runner of git.mjs; `info(cwd)` tells repo facts.
 * @param {{ git: ReturnType<typeof import("./git.mjs").crearGit>, info: ReturnType<typeof import("./checkpoints.mjs").crearCheckpoints>["info"], env?: NodeJS.ProcessEnv, lanzar?: typeof spawn, comando?: typeof comandoMotor }} options
 */
export function crearPr({
  git: ejecutor,
  info,
  env = process.env,
  lanzar = spawn,
  comando = comandoMotor,
}) {
  const { git, gh } = ejecutor;
  const enCurso = new Set();

  /** @param {string} cwd */
  async function ramaPorDefecto(cwd) {
    const ref = await git(cwd, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]).then(
      (r) => r.stdout.trim().replace(/^origin\//, ""),
      () => "",
    );
    if (ref) return ref;
    for (const rama of ["main", "master"]) {
      for (const completa of [
        `refs/remotes/origin/${rama}`,
        `refs/heads/${rama}`,
      ])
        if (
          await git(cwd, ["rev-parse", "--verify", "-q", completa]).then(
            () => true,
            () => false,
          )
        )
          return rama;
    }
    throw new ErrorLanzador("No se pudo determinar la rama por defecto.");
  }

  /** @param {{ sesion: LauncherSession, cwd: string, titulo: string, descripcion: string, borrador?: boolean }} input */
  async function crear({ sesion, cwd, titulo, descripcion, borrador = false }) {
    if (!esConvencional(titulo))
      throw new ErrorLanzador(
        "El título debe seguir Conventional Commits, por ejemplo «feat: añade X».",
        400,
      );
    if (typeof descripcion !== "string" || descripcion.length > MAX_DESCRIPCION)
      throw new ErrorLanzador("La descripción es demasiado larga.", 400);
    if (enCurso.has(sesion.id))
      throw new ErrorLanzador("Ya hay un PR en curso para esta sesión.");
    enCurso.add(sesion.id);
    try {
      const repo = await info(cwd);
      if (!repo.esRepo || !repo.remotoGithub)
        throw new ErrorLanzador(
          "La sesión no está en un repositorio con remoto en GitHub.",
        );
      const defecto = await ramaPorDefecto(cwd);
      const actual = (
        await git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() => {
          throw new ErrorLanzador(
            "El repositorio está en HEAD desacoplado; cambia a una rama.",
          );
        })
      ).stdout.trim();
      const sucio = (await git(cwd, ["status", "--porcelain"])).stdout.trim();
      const adelantados = await git(cwd, [
        "rev-list",
        "--count",
        `origin/${defecto}..HEAD`,
      ]).then(
        (r) => Number(r.stdout.trim()) || 0,
        () => 0,
      );
      const ramaNueva = actual === defecto;
      if (!sucio && (ramaNueva || !adelantados))
        throw new ErrorLanzador("No hay cambios para enviar en un PR.");
      const rama = ramaNueva ? nombreRama(sesion) : actual;
      if (ramaNueva) {
        try {
          await git(cwd, ["checkout", "-b", rama]);
        } catch {
          throw new ErrorLanzador("No se pudo crear la rama del PR.");
        }
      }
      const identidad = (
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
        const nada = await git(cwd, ["diff", "--cached", "--quiet"]).then(
          () => true,
          () => false,
        );
        if (!nada)
          await git(cwd, ["commit", "-m", titulo], {
            env: identidad,
            timeout: 120000,
          });
      } catch {
        throw new ErrorLanzador(
          "No se pudo crear el commit; revisa los hooks del repositorio.",
        );
      }
      const commit = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      try {
        await git(cwd, ["push", "-u", "origin", rama], { timeout: 120000 });
      } catch {
        throw new ErrorLanzador(
          "No se pudo enviar la rama al remoto. El commit quedó en local.",
          502,
        );
      }
      const abierto = await gh(cwd, [
        "pr",
        "view",
        rama,
        "--json",
        "url,state",
      ]).then(
        (r) => {
          const datos = JSON.parse(r.stdout);
          return datos.state === "OPEN" ? datos.url : null;
        },
        /** @returns {null} */ () => null,
      );
      if (abierto) return { rama, commit, url: abierto, existente: true };
      let salida;
      try {
        salida = (
          await gh(
            cwd,
            [
              "pr",
              "create",
              "--head",
              rama,
              "--base",
              defecto,
              "--title",
              titulo,
              "--body",
              descripcion,
              ...(borrador ? ["--draft"] : []),
            ],
            { timeout: 120000 },
          )
        ).stdout;
      } catch {
        throw new ErrorLanzador(
          "La rama se envió, pero gh no pudo abrir el PR.",
          502,
        );
      }
      const url = /https?:\/\/\S+/.exec(salida)?.[0];
      if (!url)
        throw new ErrorLanzador("gh no devolvió la dirección del PR.", 502);
      return { rama, commit, url, existente: false };
    } finally {
      enCurso.delete(sesion.id);
    }
  }

  /**
   * One short headless run of the session's engine, only when the user asks.
   * @param {{ sesion: LauncherSession, cwd: string, propuesta: ReturnType<typeof propuestaPr>, parche?: string, catalogo?: Partial<Record<string, Parameters<typeof modeloEconomico>[1]>> }} input
   */
  async function redactar({
    sesion,
    cwd,
    propuesta,
    parche = "",
    catalogo = {},
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
      propuesta.titulo,
      propuesta.descripcion.slice(0, 4000),
      "",
      "Parche (recortado):",
      parche.slice(0, 6000),
    ].join("\n");
    const spec = comando(sesion.motor, prompt, {
      modelo:
        modeloEconomico(sesion.motor, catalogo[sesion.motor]) ?? undefined,
    });
    // An internal run is not a conversation: with the session's own id the
    // hooks would link its transcript to that session and the observer would
    // replace its messages. Its provider id is marked so it is never imported.
    const interno = randomUUID();
    const marcadas = new Set();
    /** @param {unknown} nativo */
    const marcar = (nativo) => {
      if (typeof nativo !== "string" || marcadas.has(nativo)) return;
      marcadas.add(nativo);
      return marcarInterna(env, nativo).catch(() => {});
    };
    if (sesion.motor === "claude" || sesion.motor === "deepseek") {
      spec.args = [...spec.args, "--session-id", interno];
      await marcar(interno);
    }
    /** @type {Partial<Record<string, string>>} */
    const proveedores = { codex: "chatgpt", agy: "gemini" };
    const proveedor = proveedores[sesion.motor] || sesion.motor;
    const hijo = lanzar(spec.bin, spec.args, {
      cwd,
      env: { ...entornoDe(proveedor, env), SB_SESSION_ID: interno },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const acumulado = nuevoClaude();
    const lineas = createInterface({ input: hijo.stdout });
    lineas.on("line", (linea) => {
      let evento;
      try {
        evento = JSON.parse(linea);
      } catch {
        return;
      }
      marcar(
        evento.session_id ||
          evento.thread_id ||
          evento.conversationId ||
          evento.conversation_id,
      );
      if (sesion.motor === "claude" || sesion.motor === "deepseek")
        leerClaude(acumulado, evento);
      else if (sesion.motor === "agy") leerGemini(acumulado, evento);
      else if (
        evento.type === "item.completed" &&
        evento.item?.type === "agent_message"
      )
        acumulado.texto = String(evento.item.text || "");
    });
    hijo.stderr?.resume();
    let reloj;
    const codigo = await new Promise((resolve) => {
      reloj = setTimeout(() => {
        hijo.kill("SIGKILL");
        resolve(-1);
      }, TIEMPO_REDACCION);
      hijo.once("error", () => resolve(-1));
      hijo.once("close", resolve);
    });
    clearTimeout(reloj);
    const datos =
      codigo === 0 && !acumulado.error ? extraerJson(acumulado.texto) : null;
    const titulo = String(datos?.titulo ?? "").trim();
    if (!esConvencional(titulo) || typeof datos?.descripcion !== "string")
      throw new ErrorLanzador(
        "El agente no pudo redactar el PR; se conserva la propuesta.",
        502,
      );
    return {
      titulo,
      descripcion: datos.descripcion.slice(0, MAX_DESCRIPCION),
    };
  }

  return { crear, redactar };
}
