import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { abrirRegistro } from "/opt/secondbrain/current/lanzador/sessions.mjs";
import { crearEjecutor } from "/opt/secondbrain/current/lanzador/executor.mjs";
const dir = await mkdtemp("/var/lib/sb-agente/scope-smoke-");
try {
  const fake = dir + "/fake.mjs";
  await writeFile(
    fake,
    "import fs from 'node:fs'; console.log(JSON.stringify({type:'result',result:fs.readFileSync('/proc/self/cgroup','utf8')}));",
  );
  const registro = await abrirRegistro(dir + "/sessions.json");
  const env = {
    PATH: "/opt/node/bin:/usr/bin:/bin",
    HOME: "/var/lib/sb-agente",
    SB_SESSION_SCOPES: "1",
    XDG_RUNTIME_DIR: "/run/user/" + process.getuid(),
  };
  const runner = crearEjecutor({
    registro,
    proyectos: { test: dir },
    env,
    comando: () => ({ bin: "/opt/node/bin/node", args: [fake] }),
    comandoInteractivo: () => ({ bin: "/opt/node/bin/node", args: [fake] }),
  });
  for (const harness of [false, true]) {
    const session = await runner.encargar({
      motor: "claude",
      origen: "sala",
      proyecto: "test",
      brief: "synthetic",
      harness,
    });
    await runner.esperar(session.id);
    const result = registro.leer().find((s) => s.id === session.id);
    const output = harness ? result.terminal : result.resultado;
    if (result.estado !== "terminada" || !output?.includes("sb-session-"))
      throw new Error(
        "Actual executor " +
          (harness ? "PTY" : "headless") +
          " failed: " +
          JSON.stringify({ state: result.estado, output }),
      );
    console.log("ACTUAL_SCOPE_OK", harness ? "PTY" : "headless");
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
