import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

export function readLimits(env = {}) {
  const integer = (key, fallback, max) => {
    const value = env[key] ?? String(fallback);
    if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max)
      throw new Error("Límite inválido: " + key);
    return Number(value);
  };
  return {
    maxActivos: integer("SB_MAX_ACTIVOS", 6, 16),
    retencionDias: integer("SB_RETENCION_DIAS", 90, 365),
  };
}

export function sessionCommand(spec, id, env = {}) {
  if (env.SB_SESSION_SCOPES !== "1") return spec;
  if (!/^[a-z0-9-]{1,80}$/i.test(id))
    throw new Error("Identificador de sesión inválido");
  return {
    bin: "/usr/bin/systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--unit=sb-session-" + id,
      "--property=MemoryMax=1G",
      "--property=MemorySwapMax=128M",
      "--property=CPUQuota=100%",
      "--property=TasksMax=128",
      "--",
      spec.bin,
      ...spec.args,
    ],
  };
}

export async function stopSessionScope(id, env = {}) {
  if (env.SB_SESSION_SCOPES !== "1") return;
  if (!/^[a-z0-9-]{1,80}$/i.test(id))
    throw new Error("Identificador de sesión inválido");
  const unit = `sb-session-${id}.scope`;
  const options = {
    env: { PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR },
    timeout: 10000,
  };
  const absent = async () =>
    (
      await run(
        "/usr/bin/systemctl",
        ["--user", "show", "--property=LoadState", "--value", unit],
        options,
      )
    ).stdout.trim() === "not-found";
  if (await absent()) return;
  try {
    await run(
      "/usr/bin/systemctl",
      ["--user", "kill", "--signal=SIGKILL", "--kill-whom=all", unit],
      options,
    );
    await run("/usr/bin/systemctl", ["--user", "stop", unit], options);
  } catch (error) {
    if (!(await absent())) throw error;
  }
}
