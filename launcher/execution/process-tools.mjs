// Helpers around a session's child process: environment, signals, diagnostics
// and the files a member's workspace starts with.
import path from "node:path";
import os from "node:os";
import { cp, readdir, rm, rmdir } from "node:fs/promises";
import { redactDiagnostic } from "../diagnostics.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
/** @import { ToolProfile } from "../tool-catalog-types.d.ts" */
/** @import { LauncherSession } from "../session-types.d.ts" */
/** @import { ChildProcess } from "node:child_process" */
/** @import { ExecutorConfig } from "./options.mjs" */

export const runFile = promisify(execFile);

/** Credential provider of each engine, when it differs from the engine id. */
/** @type {Partial<Record<string, string>>} */
export const PROVIDER_BY_ENGINE = { codex: "chatgpt", agy: "gemini" };

/**
 * @param {ExecutorConfig} config
 */
export function createProcessTools(config) {
  const { env, proyectos, registrar, registro, seguimiento } = config;
  function sessionTokenDir() {
    const base =
      env.SB_LANZADOR_DATA_DIR || path.join(os.tmpdir(), "sb-lanzador");
    return path.join(base, "session-tokens");
  }
  /**
   * @param {NodeJS.ProcessEnv} baseEnv
   * @param {ToolProfile} profile
   * @param {string | null} tokenFile
   * @param {boolean} billingGranted
   * @param {string} motor
   */
  function sanitizeChildEnv(
    baseEnv,
    profile,
    tokenFile,
    billingGranted,
    motor,
  ) {
    const next = { ...baseEnv };
    // Never leak supervisor / wide room tokens into agent environments.
    delete next.AGENTES_TOKEN_FILE;
    delete next.AGENTES_SECRETO;
    if (tokenFile) {
      next.SB_BRAIN_TOKEN_FILE = tokenFile;
      delete next.AGENTES_BRAIN_TOKEN_FILE;
    } else if (!profile?.allowedMcps?.includes("secondbrain")) {
      delete next.SB_BRAIN_TOKEN_FILE;
      delete next.AGENTES_BRAIN_TOKEN_FILE;
    }
    if (!profile?.allowExternalWriteSecrets) {
      for (const key of [
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "RESEND_API_KEY",
        "SMTP_PASS",
        "STRIPE_API_KEY",
      ]) {
        delete next[key];
      }
    }
    if (!(motor === "deepseek" && billingGranted)) {
      delete next.DEEPSEEK_API_KEY;
      delete next.ANTHROPIC_AUTH_TOKEN;
    }
    return next;
  }
  /** @param {string} sessionId */
  function acpGeminiDirFor(sessionId) {
    const base =
      env.SB_LANZADOR_DATA_DIR || path.join(os.tmpdir(), "sb-lanzador");
    return path.join(base, "acp-runtime", sessionId, "gemini");
  }
  /**
   * @param {string} src
   * @param {string} dst
   */
  async function copiarEntradasProyecto(src, dst) {
    const srcResolved = path.resolve(src);
    const dstResolved = path.resolve(dst);
    const entries = await readdir(srcResolved, { withFileTypes: true }).catch(
      /** @returns {import("node:fs").Dirent[]} */
      () => [],
    );
    const skip = new Set([
      ".git",
      ".secondbrain",
      "node_modules",
      "member-workspaces",
    ]);
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const from = path.join(srcResolved, entry.name);
      const to = path.join(dstResolved, entry.name);
      if (dstResolved === from || dstResolved.startsWith(from + path.sep)) {
        continue;
      }
      await cp(from, to, {
        recursive: true,
        filter: (p) => !skip.has(path.basename(p)),
      }).catch(() => {});
    }
  }
  /** @param {LauncherSession | undefined} sesion */
  async function limpiarWorkspaceMiembro(sesion) {
    const ws = sesion?.workspacePath;
    if (
      !sesion ||
      !ws ||
      !["git-worktree", "directory"].includes(sesion.workspaceKind ?? "")
    ) {
      return;
    }
    const resolvedWs = path.resolve(ws);
    if (
      path.basename(path.dirname(path.dirname(resolvedWs))) !==
      "member-workspaces"
    ) {
      return;
    }
    if (sesion.workspaceKind === "git-worktree") {
      let repoRoot = null;
      try {
        const common = await runFile(
          "git",
          ["-C", resolvedWs, "rev-parse", "--git-common-dir"],
          { timeout: 10000 },
        );
        if (common.stdout?.trim()) {
          repoRoot = path.dirname(
            path.resolve(resolvedWs, common.stdout.trim()),
          );
        }
      } catch {
        repoRoot = sesion.proyecto ? proyectos[sesion.proyecto] || null : null;
      }
      if (repoRoot) {
        await runFile(
          "git",
          ["-C", repoRoot, "worktree", "remove", "--force", resolvedWs],
          { timeout: 15000 },
        ).catch(() => {});
        await runFile("git", ["-C", repoRoot, "worktree", "prune"], {
          timeout: 10000,
        }).catch(() => {});
      }
    }
    await rm(resolvedWs, { recursive: true, force: true }).catch(() => {});
    await rmdir(path.dirname(resolvedWs)).catch(() => {});
  }
  registro.setOnPrune?.((sesion) => limpiarWorkspaceMiembro(sesion));
  /**
   * @param {ChildProcess} hijo
   * @param {NodeJS.Signals} signal
   */
  function senalar(hijo, signal) {
    if (process.platform !== "win32" && hijo.pid) {
      try {
        process.kill(-hijo.pid, signal);
        return;
      } catch {}
    }
    try {
      hijo.kill(signal);
    } catch (error) {
      try {
        registrar(
          JSON.stringify({
            evento: "lanzador.signal",
            senal: signal,
            codigo: error?.code || "UNKNOWN",
          }),
        );
      } catch {}
    }
  }
  /**
   * A checkpoint of the working tree precedes every turn; it never blocks one.
   * @param {string} id
   * @param {string} texto
   */
  const marcar = (id, texto) =>
    seguimiento ? seguimiento.marcar(id, texto) : Promise.resolve(null);
  /**
   * Keep enough overlap to redact a credential or assignment crossing the tail.
   * @param {string} brief
   */
  const margenDiagnostico = (brief) =>
    2000 +
    Math.max(
      brief.length,
      ...Object.values(env).map((v) => (typeof v === "string" ? v.length : 0)),
    );
  /**
   * @param {LauncherSession} sesion
   * @param {string} brief
   * @param {Record<string, unknown>} datos
   */
  function diagnosticar(sesion, brief, datos) {
    try {
      registrar(
        JSON.stringify({
          evento: "lanzador.motor",
          sesion: sesion.id,
          motor: sesion.motor,
          ...Object.fromEntries(
            Object.entries(datos).map(([key, value]) => {
              const limpio =
                typeof value === "string"
                  ? redactDiagnostic(value, { env, textos: [brief] })
                  : value;
              return [
                key,
                key === "diagnostico"
                  ? /** @type {string} */ (limpio).slice(-2000)
                  : limpio,
              ];
            }),
          ),
        }),
      );
    } catch {
      /* Diagnostics never reject a background job. */
    }
  }
  return {
    sessionTokenDir,
    sanitizeChildEnv,
    acpGeminiDirFor,
    copiarEntradasProyecto,
    limpiarWorkspaceMiembro,
    senalar,
    marcar,
    margenDiagnostico,
    diagnosticar,
  };
}
