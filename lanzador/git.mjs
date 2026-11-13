// @ts-check
import { execFile } from "node:child_process";

// Only what git and gh need. Tokens, when present, travel in the environment of
// the child (never in its arguments) and are not logged by this module.
const HEREDADAS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "APPDATA",
  "LOCALAPPDATA",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
];

export function entornoGit(env = process.env, extra = {}) {
  return {
    ...Object.fromEntries(
      HEREDADAS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]),
    ),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
    ...extra,
  };
}

/** git and gh through execFile: no shell, a timeout and a minimal environment. */
export function crearGit({
  env = process.env,
  timeout = 60000,
  // Tests run a fake gh as `node fake.mjs`; production uses the real one.
  ghComando = ["gh"],
} = {}) {
  function correr(bin, cwd, args, opciones = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          cwd,
          env: entornoGit(env, opciones.env),
          timeout: opciones.timeout ?? timeout,
          maxBuffer: opciones.max ?? 16 * 1024 * 1024,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout, stderr });
          // Output over the limit is still useful to a caller that trims it.
          if (
            opciones.tolerarExceso &&
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          )
            return resolve({ stdout: stdout ?? "", stderr, excedido: true });
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        },
      );
    });
  }
  return {
    git: (cwd, args, opciones) => correr("git", cwd, args, opciones),
    gh: (cwd, args, opciones) =>
      correr(ghComando[0], cwd, [...ghComando.slice(1), ...args], opciones),
  };
}
