import path from "node:path";

/** @import { AgyQuota, ClaudeStreamEvent, ClaudeUsageSnapshot, CodexUsageSnapshot, DeepSeekBalance, FetchBalance, GeminiStreamEvent, GeminiUsageGroup, EngineOptions, NormalizedAttachment, RawAttachment, RepoCapabilitiesInput, SessionCapabilitiesInput, StreamResult, ToolActivityEvent, UsageWindowId, UsageWindows } from "./engine-types.d.ts" */

// Provider catalog and pure helpers: CLI arguments, child environments and
// translation of each CLI's output into one shape. No processes start here.

/**
 * @param {string} motor
 * @param {string} text
 * @param {EngineOptions} [options]
 */
export function engineCommand(
  motor,
  text,
  { modelo, esfuerzo: effort, conversacionId: conversationId } = {},
) {
  // A brief starting with "-" would be parsed by the CLI as an option.
  const prompt = String(text).startsWith("-")
    ? "Instrucciones:\n" + text
    : text;
  if (motor === "claude" || motor === "deepseek")
    return {
      bin: "claude",
      args: [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-hook-events",
        "--permission-mode",
        "bypassPermissions",
        ...(conversationId ? ["--resume", conversationId] : []),
        ...claudeOptions(motor, { modelo, esfuerzo: effort }),
      ],
    };
  if (motor === "codex")
    return {
      bin: "codex",
      args: [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "-c",
        'mcp_servers.secondbrain.env_vars=["SB_BRAIN_TOKEN_FILE","SB_BRAIN_URL","SB_AGENT","SB_AGENTE","SB_SESSION_ID"]',
        ...(modelo ? ["-m", modelo] : []),
        ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
        prompt,
      ],
    };
  if (motor === "agy")
    return {
      bin: "agy",
      args: [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        ...(conversationId ? ["--conversation", conversationId] : []),
        ...(modelo ? ["--model", modelo] : []),
      ],
    };
  throw new Error("Motor desconocido");
}

/** Marina runs Claude Code against DeepSeek: it must never present itself as Claude or Ámbar. */
export const MARINA_IDENTITY =
  "Eres Marina, la agente de SecondBrain que corre sobre DeepSeek mediante la API compatible con Anthropic. " +
  "No eres Claude ni Ámbar: preséntate siempre como Marina (DeepSeek) y responde en español.";

// DeepSeek ignores Claude's effort levels; the thinking budget is what it honours.
export const DEEPSEEK_THINKING = {
  low: "4096",
  medium: "16000",
  high: "32000",
  max: "63999",
};

/**
 * Model, effort and identity flags shared by the headless and interactive Claude Code.
 * @param {string} engine
 * @param {EngineOptions} [options]
 */
export function claudeOptions(engine, { modelo, esfuerzo } = {}) {
  if (engine === "deepseek") return ["--append-system-prompt", MARINA_IDENTITY];
  return [
    ...(modelo ? ["--model", modelo] : []),
    ...(esfuerzo ? ["--effort", esfuerzo] : []),
  ];
}

/**
 * Effort for DeepSeek travels as an environment variable, never as a CLI flag.
 * @param {string} engine
 * @param {string | null} [effort]
 */
export const effortEnvironment = (engine, effort) => {
  const key = /** @type {keyof typeof DEEPSEEK_THINKING} */ (effort);
  return engine === "deepseek" && DEEPSEEK_THINKING[key]
    ? { MAX_THINKING_TOKENS: DEEPSEEK_THINKING[key] }
    : {};
};

export const AGENTS_BY_ID = {
  ambar: { proveedor: "claude", nombre: "Claude", acceso: "suscripcion" },
  menta: { proveedor: "chatgpt", nombre: "ChatGPT", acceso: "suscripcion" },
  lira: { proveedor: "gemini", nombre: "Gemini", acceso: "suscripcion" },
  marina: { proveedor: "deepseek", nombre: "DeepSeek", acceso: "api" },
};

export const DEEPSEEK_MODEL = "deepseek-flash[1m]";
export const DEEPSEEK_LIMIT = 1_000_000;
export const GEMINI_LIMIT = 1_000_000;

/**
 * Agents get the vault credential; older installs only have the shared token file.
 * @param {NodeJS.ProcessEnv} env
 */
export const fileTokenVault = (env) =>
  env.AGENTES_BRAIN_TOKEN_FILE ?? env.AGENTES_TOKEN_FILE;

/**
 * Only what a CLI needs: secrets of one provider never reach another's process.
 * @param {string} proveedor
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function environmentOf(proveedor, env) {
  const runtime =
    env.SB_SESSION_SCOPES === "1" ? env.XDG_RUNTIME_DIR : undefined;
  if (
    env.SB_SESSION_SCOPES === "1" &&
    (!runtime ||
      !/^\/run\/user\/[1-9][0-9]*$/.test(runtime) ||
      (process.getuid && runtime !== `/run/user/${process.getuid()}`))
  )
    throw new Error("Directorio de ejecución de sesión inválido");
  const tokenVault = fileTokenVault(env);
  const actor = /** @type {(keyof typeof AGENTS_BY_ID)[]} */ (
    Object.keys(AGENTS_BY_ID)
  ).find((id) => AGENTS_BY_ID[id].proveedor === proveedor);
  const base = {
    PATH: env.PATH,
    HOME: env.HOME,
    LANG: env.LANG || "C.UTF-8",
    TMPDIR: env.TMPDIR,
    ...(runtime ? { XDG_RUNTIME_DIR: runtime } : {}),
    // Windows needs these to start any child; they are absent on the server.
    SystemRoot: env.SystemRoot,
    USERPROFILE: env.USERPROFILE,
    ...(tokenVault
      ? {
          SB_BRAIN_TOKEN_FILE: tokenVault,
          SB_AGENT: actor,
          SB_AGENTE: actor,
          SB_BRAIN_URL: env.AGENTES_BRAIN_URL || "http://127.0.0.1:8080/api/v1",
          SB_BRAIN_CLI: env.AGENTES_BRAIN_CLI,
        }
      : {}),
  };
  const extra = /** @type {Partial<Record<string, NodeJS.ProcessEnv>>} */ ({
    claude: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "350000",
      CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
      CLAUDE_CONFIG_DIR: env.AGENTES_CLAUDE_DIR,
      // The owner's claude.ai connectors (WhatsApp, Docs, M365...) could send
      // messages or edit documents outside the approval queue.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
    deepseek: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "350000",
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: env.DEEPSEEK_API_KEY,
      ANTHROPIC_MODEL: DEEPSEEK_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-flash",
      CLAUDE_CONFIG_DIR: env.AGENTES_DEEPSEEK_DIR,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
    chatgpt: { CODEX_HOME: env.CODEX_HOME },
    gemini: {},
  })[proveedor];
  return Object.fromEntries(
    Object.entries({ ...base, ...extra }).filter(([, v]) => v !== undefined),
  );
}

/** @param {number} fraction */
const percentage = (fraction) =>
  Math.min(100, Math.max(0, Math.round(fraction * 1000) / 10));
/** @param {number} [seconds] */
const fecha = (seconds) =>
  seconds ? new Date(seconds * 1000).toISOString() : null;

/**
 * Folds Claude Code's stream-json lines; also used for DeepSeek through its Anthropic API.
 * @returns {StreamResult}
 */
export function newClaudeState() {
  return {
    sessionId: null,
    texto: "",
    error: null,
    usados: null,
    limite: null,
    compactado: false,
    ventanas: {},
  };
}

/**
 * @param {StreamResult} r
 * @param {ClaudeStreamEvent} e
 */
export function readClaudeEvent(r, e) {
  if (e.session_id) r.sessionId = e.session_id;
  if (e.type === "assistant" && !e.parent_tool_use_id && e.message?.usage) {
    const u = e.message.usage;
    const total =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.output_tokens || 0);
    if (total) r.usados = total;
  }
  if (e.type === "system" && e.subtype === "compact_boundary")
    r.compactado = true;
  if (e.type === "rate_limit_event") {
    const i = e.rate_limit_info || {};
    const windows = i.unifiedWindows || { [String(i.rateLimitType)]: i };
    for (const [tipo, v] of Object.entries(windows)) {
      const id = /** @type {Partial<Record<string, UsageWindowId>>} */ ({
        five_hour: "5h",
        seven_day: "semanal",
      })[tipo];
      if (id)
        r.ventanas[id] = {
          usado:
            typeof v.utilization === "number"
              ? percentage(v.utilization)
              : null,
          reinicia: fecha(v.resetsAt),
          agotada: v.status === "rejected",
        };
    }
  }
  if (e.type === "result") {
    if (e.is_error) r.error = String(e.result || "Claude terminó con error.");
    else r.texto = String(e.result || "");
    const models = Object.values(e.modelUsage || {});
    const limit = Math.max(0, ...models.map((m) => m.contextWindow || 0));
    if (limit) r.limite = limit;
  }
  return r;
}

/**
 * Codex labels windows by role, not length: a lone weekly window can arrive as
 * primary. Its app server uses camelCase; its rollout files, snake_case.
 * @param {CodexUsageSnapshot | null} [snapshot]
 */
export function codexWindows(snapshot) {
  /** @type {UsageWindows} */
  const ventanas = {};
  for (const v of [snapshot?.primary, snapshot?.secondary]) {
    if (!v) continue;
    const id = /** @type {Partial<Record<number, UsageWindowId>>} */ ({
      300: "5h",
      10080: "semanal",
    })[v.windowDurationMins ?? v.window_minutes ?? 0];
    const used = v.usedPercent ?? v.used_percent;
    if (id && typeof used === "number")
      ventanas[id] = {
        usado: used,
        reinicia: fecha(v.resetsAt ?? v.resets_at),
        agotada: used >= 100,
      };
  }
  return ventanas;
}

/**
 * @param {number} used
 * @param {string | null} restarts
 */
const ventana = (used, restarts) => ({
  usado: used,
  reinicia: restarts,
  agotada: used >= 100,
});

/**
 * `rate_limits` of Claude Code's status line input: percent used, epoch seconds.
 * @param {ClaudeUsageSnapshot | null} [limits]
 */
export function claudeWindows(limits) {
  /** @type {UsageWindows} */
  const windows = {};
  for (const [origin, id] of /** @type {const} */ ([
    ["five_hour", "5h"],
    ["seven_day", "semanal"],
  ])) {
    const v = limits?.[origin];
    if (typeof v?.used_percentage === "number")
      windows[id] = ventana(v.used_percentage, fecha(v.resets_at));
  }
  return windows;
}

/**
 * `quota` of Antigravity's status line input: fraction left, ISO date. Claude,
 * GPT and open models draw from the `3p-*` buckets, the rest from `gemini-*`.
 * @param {AgyQuota | null} [cuota]
 * @param {string | null} [model]
 */
export function agyWindows(cuota, model) {
  const family = /claude|gpt|oss/i.test(model || "") ? "3p" : "gemini";
  /** @type {UsageWindows} */
  const windows = {};
  for (const [suffix, id] of /** @type {const} */ ([
    ["5h", "5h"],
    ["weekly", "semanal"],
  ])) {
    const v = cuota?.[`${family}-${suffix}`];
    if (!v || v.disabled || typeof v.remaining_fraction !== "number") continue;
    const restarts = Date.parse(v.reset_time ?? "");
    windows[id] = ventana(
      Math.round((1 - v.remaining_fraction) * 1000) / 10,
      Number.isNaN(restarts) ? null : new Date(restarts).toISOString(),
    );
  }
  return windows;
}

/**
 * The result's usage adds up the whole conversation; only the last reply shows the context.
 * @param {StreamResult} r
 * @param {GeminiStreamEvent} e
 */
export function readGeminiEvent(r, e) {
  const id = e.conversation_id || e.result?.conversation_id;
  if (id) r.sessionId = id;
  const step = e.step_update;
  if (step?.state === "DONE") {
    if (step.step_type === "checkpoint") r.compactado = true;
    if (step.step_type === "agent_response" && step.usage) {
      const u = step.usage;
      r.usados =
        (u.input_tokens || 0) +
        (u.cache_read_tokens || 0) +
        (u.output_tokens || 0);
    }
  }
  if (e.event === "result") {
    r.terminado = true;
    if (e.result?.status === "SUCCESS")
      r.texto = String(e.result.response || "").trim();
    else r.error = String(e.result?.error || "Gemini terminó con error.");
  }
  return r;
}

/**
 * `agy /usage` also lists per-model limits: the tightest one is what Lira can spend.
 * @param {GeminiUsageGroup[]} [groups]
 */
export function geminiWindows(groups = []) {
  /** @type {UsageWindows} */
  const windows = {};
  for (const b of groups.flatMap((g) => g.buckets || [])) {
    const id = /** @type {Partial<Record<string, UsageWindowId>>} */ ({
      "5h": "5h",
      weekly: "semanal",
    })[b.window];
    if (!id || b.id?.startsWith("3p-")) continue;
    const used = percentage(1 - b.remaining_fraction);
    const previous = windows[id]?.usado;
    if (previous == null || !(previous >= used))
      windows[id] = {
        usado: used,
        reinicia: b.reset_time || null,
        agotada: b.remaining_fraction <= 0,
      };
  }
  return windows;
}

/**
 * Deterministic scene cues from actual provider events; never ask a model to navigate.
 * @param {ToolActivityEvent} e
 */
export function eventActivity(e) {
  const item = e.params?.item || e.item;
  const tool = e.message?.content?.find((c) => c.type === "tool_use");
  const name = String(
    tool?.name || item?.type || e.step_update?.step_type || "",
  ).toLowerCase();
  if (/search|fetch|read|grep|glob/.test(name))
    return { zona: "library", etiqueta: "Consultando información" };
  if (/command|filechange|bash|edit|write|code/.test(name))
    return { zona: "workshop", etiqueta: "Trabajando con archivos" };
  return null;
}

/**
 * @param {string | null} key
 * @param {FetchBalance} [fetchFn]
 */
export async function deepSeekBalance(key, fetchFn = fetch) {
  if (!key) throw new Error("Saldo DeepSeek no disponible");
  const response = await fetchFn("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Saldo DeepSeek no disponible");
  const data = /** @type {DeepSeekBalance} */ (await response.json());
  const usd = data.balance_infos?.find(
    (b) => b.currency === "USD",
  )?.total_balance;
  if (
    !data.is_available ||
    typeof usd !== "string" ||
    !/^\d+(?:\.\d+)?$/.test(usd)
  )
    throw new Error("Saldo DeepSeek no disponible");
  const saldo = Number(usd);
  if (!Number.isFinite(saldo)) throw new Error("Saldo DeepSeek no disponible");
  return saldo;
}

/**
 * What each engine really supports in this launcher, read off the code above:
 * `reanudar` is a headless follow-up (`continuar`), `reanudarHarness` the same on
 * a live-terminal session. Nobody rewinds the provider's own conversation yet.
 * REQUISITOS names what the session must also have; `capacidadesDe` applies it.
 */
export const CAPABILITIES = {
  claude: {
    reanudar: true,
    reanudarHarness: true,
    terminalInteractiva: true,
    interrumpir: true,
    teclaInterrumpir: "Esc",
    revertirArchivos: true,
    revertirConversacion: false,
    herramientasEstructuradas: true,
    reportaUso: true,
    reportaContexto: true,
    remoteControl: true,
    redactarPr: true,
    crearPr: true,
    steering: false,
    colaMensajes: true,
    adjuntos: ["text", "image"],
    elicitacion: true,
  },
  codex: {
    reanudar: false,
    reanudarHarness: true,
    terminalInteractiva: true,
    interrumpir: true,
    teclaInterrumpir: "Ctrl+C",
    revertirArchivos: true,
    revertirConversacion: false,
    herramientasEstructuradas: true,
    reportaUso: true,
    reportaContexto: true,
    remoteControl: false,
    redactarPr: true,
    crearPr: true,
    steering: true,
    colaMensajes: true,
    adjuntos: ["text", "localImage", "image"],
    elicitacion: true,
  },
  agy: {
    reanudar: true,
    reanudarHarness: true,
    terminalInteractiva: true,
    interrumpir: true,
    teclaInterrumpir: "Esc",
    revertirArchivos: true,
    revertirConversacion: false,
    // Only messages are known; its tool steps show up generically.
    herramientasEstructuradas: "parcial",
    reportaUso: true,
    reportaContexto: true,
    remoteControl: true,
    redactarPr: true,
    crearPr: true,
    steering: true,
    colaMensajes: true,
    adjuntos: ["text", "image", "embeddedContext"],
    elicitacion: true,
  },
  deepseek: {
    reanudar: false,
    reanudarHarness: true,
    terminalInteractiva: true,
    interrumpir: true,
    teclaInterrumpir: "Esc",
    revertirArchivos: true,
    revertirConversacion: false,
    herramientasEstructuradas: true,
    // Marina pays per token: there are no plan windows to report.
    reportaUso: false,
    reportaContexto: true,
    remoteControl: false,
    redactarPr: true,
    crearPr: true,
    steering: false,
    colaMensajes: true,
    adjuntos: ["text"],
    elicitacion: true,
  },
};

export const REQUIREMENTS = {
  revertirArchivos: "La carpeta de la sesión debe ser un repositorio git.",
  crearPr:
    "La carpeta debe ser un repositorio registrado con remoto origin en GitHub.",
  interrumpir: "Solo con la terminal del harness en marcha.",
  redactarPr: "Necesita un repositorio con remoto en GitHub.",
};

/**
 * Capabilities of one session: the engine's, narrowed by the repository it runs in.
 * @param {SessionCapabilitiesInput} sesion
 * @param {RepoCapabilitiesInput} [repo]
 */
export function capabilitiesOf(sesion, repo = {}) {
  const base =
    CAPABILITIES[/** @type {keyof typeof CAPABILITIES} */ (sesion.motor)];
  if (!base) return null;
  const isRepo = !!repo.esRepo;
  const hasRemote = !!repo.tieneRemoto;
  const githubRemote = !!repo.remotoGithub;
  return {
    ...base,
    esRepo: isRepo,
    tieneRemoto: hasRemote,
    remotoGithub: githubRemote,
    continuar: sesion.structured
      ? !!sesion.conversacionId
      : sesion.harness
        ? base.reanudarHarness
        : base.reanudar,
    ...(sesion.structured
      ? { terminalInteractiva: false, herramientasEstructuradas: true }
      : {}),
    revertirArchivos: base.revertirArchivos && isRepo,
    crearPr: base.crearPr && isRepo && githubRemote,
    redactarPr: base.redactarPr && isRepo && githubRemote,
    interrumpir: base.interrumpir && (!!sesion.harness || !!sesion.structured),
  };
}

/**
 * Validate and normalize structured attachments against engine capability and workspace boundary.
 * @param {string} motor
 * @param {unknown} [attachments]
 * @param {string} [cwd]
 * @returns {NormalizedAttachment[]}
 */
export function validateEngineAttachments(motor, attachments = [], cwd = "") {
  const caps = CAPABILITIES[/** @type {keyof typeof CAPABILITIES} */ (motor)];
  if (!caps) throw new Error("Motor desconocido");
  const allowed = new Set(caps.adjuntos || ["text"]);
  if (!Array.isArray(attachments)) {
    throw new Error("Lista de adjuntos inválida.");
  }
  const resolvedRoot = cwd ? path.resolve(cwd) : "";
  return attachments.map(
    /** @param {RawAttachment} att */ (att) => {
      if (!att || typeof att !== "object" || typeof att.type !== "string") {
        throw new Error("Adjunto estructurado inválido.");
      }
      if (!allowed.has(att.type)) {
        throw new Error(
          `El motor ${motor} no soporta adjuntos de tipo «${att.type}».`,
        );
      }
      /** @type {NormalizedAttachment} */
      const normalized = { type: att.type };
      if (att.type === "text") {
        normalized.text = String(att.text ?? "");
        return normalized;
      }
      if (att.path !== undefined) {
        const candidate = resolvedRoot
          ? path.resolve(resolvedRoot, String(att.path))
          : String(att.path);
        if (resolvedRoot) {
          const rel = path.relative(resolvedRoot, candidate);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(
              "Referencia de adjunto fuera del espacio de trabajo permitido.",
            );
          }
        }
        normalized.path = candidate;
      }
      if (att.url !== undefined) normalized.url = String(att.url);
      if (att.uri !== undefined) normalized.uri = String(att.uri);
      if (att.text !== undefined) normalized.text = String(att.text);
      if (att.mimeType !== undefined)
        normalized.mimeType = String(att.mimeType);
      if (att.sha256 !== undefined) normalized.sha256 = String(att.sha256);
      if (att.ref !== undefined) normalized.ref = String(att.ref);
      return normalized;
    },
  );
}

/**
 * Cheapest model of an engine's catalog; null leaves the program's default.
 * @param {string} motor
 * @param {{ id: string }[]} [catalogo]
 */
export function economyModel(motor, catalogo = []) {
  const ids = catalogo.map((m) => m.id);
  if (motor === "claude") return ids.find((id) => /haiku/i.test(id)) ?? null;
  if (motor === "deepseek") return DEEPSEEK_MODEL;
  if (motor === "codex")
    return (
      ids.find((id) => /mini|spark/i.test(id)) ??
      ids.find((id) => /-luna(?:$|\b)/i.test(id)) ??
      null
    );
  if (motor === "agy") return ids.find((id) => /flash|lite/i.test(id)) ?? null;
  return null;
}
