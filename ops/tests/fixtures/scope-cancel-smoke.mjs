import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { openSessionRegistry } from "/opt/secondbrain/current/lanzador/sessions.mjs";
import { createExecutor } from "/opt/secondbrain/current/lanzador/executor.mjs";
import { setTimeout as delay } from "node:timers/promises";
const dir = await mkdtemp("/var/lib/sb-agente/scope-cancel-");
let descendant;
try {
  const pidFile = dir + "/owned-descendant.pid";
  const fake = dir + "/fake.mjs";
  await writeFile(
    fake,
    `import{spawn}from'node:child_process';import fs from'node:fs';if(fs.existsSync(${JSON.stringify(pidFile)})){console.log('RESUMED');process.exit(0);}const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));console.log('READY');setInterval(()=>{},1000);`,
  );
  const registro = await openSessionRegistry(dir + "/sessions.json");
  const env = {
    PATH: "/opt/node/bin:/usr/bin:/bin",
    HOME: "/var/lib/sb-agente",
    SB_SESSION_SCOPES: "1",
    XDG_RUNTIME_DIR: "/run/user/" + process.getuid(),
    AGENTES_CLAUDE_DIR: dir + "/claude",
  };
  const runner = createExecutor({
    registro,
    proyectos: { test: dir },
    env,
    comandoInteractivo: () => ({ bin: "/opt/node/bin/node", args: [fake] }),
  });
  const session = await runner.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "test",
    brief: "synthetic",
    harness: true,
  });
  for (let i = 0; i < 150; i++) {
    try {
      descendant = Number(await readFile(pidFile, "utf8"));
      break;
    } catch {
      await delay(30);
    }
  }
  if (!Number.isInteger(descendant) || descendant < 2)
    throw new Error("Fixture did not start its owned descendant");
  await runner.cancelar(session.id);
  await runner.esperar(session.id);
  let alive = true;
  try {
    process.kill(descendant, 0);
  } catch {
    alive = false;
  }
  // A dead child can briefly remain as an init-owned zombie: it has no resources.
  if (alive) {
    try {
      const stat = await readFile("/proc/" + descendant + "/stat", "utf8");
      alive = !/\) Z /.test(stat);
    } catch {
      alive = false;
    }
  }
  if (alive)
    throw new Error(
      "Detached signal-resistant descendant survived cancellation",
    );
  await runner.continuar(session.id, "synthetic resume");
  await runner.esperar(session.id);
  const result = registro.leer().find((s) => s.id === session.id);
  if (result.estado !== "terminada" || !result.terminal.includes("RESUMED"))
    throw new Error("Same session scope could not be reused");
  console.log("CANCEL_DESCENDANT_AND_RESUME_OK");
} finally {
  if (descendant) {
    try {
      process.kill(descendant, "SIGKILL");
    } catch {}
  }
  await rm(dir, { recursive: true, force: true });
}
