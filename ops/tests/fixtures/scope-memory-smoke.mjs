import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { abrirRegistro } from "/opt/secondbrain/current/lanzador/sessions.mjs";
import { crearEjecutor } from "/opt/secondbrain/current/lanzador/executor.mjs";
const dir = await mkdtemp("/var/lib/sb-agente/scope-memory-");
try {
  const burn = dir + "/burn.mjs",
    other = dir + "/other.mjs",
    probe = dir + "/limit.json";
  await writeFile(
    burn,
    `import fs from'node:fs';const group=fs.readFileSync('/proc/self/cgroup','utf8').trim().split('::')[1];fs.writeFileSync(${JSON.stringify(probe)},JSON.stringify({group,max:fs.readFileSync('/sys/fs/cgroup'+group+'/memory.max','utf8').trim()}));const parts=[];for(let i=0;i<80;i++)parts.push(Buffer.alloc(32*1024*1024,1));console.log(JSON.stringify({type:'result',result:'UNBOUNDED'}));`,
  );
  await writeFile(
    other,
    "setTimeout(()=>console.log(JSON.stringify({type:'result',result:'SURVIVED'})),2200);",
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
    comando: (_motor, brief) => ({
      bin: "/opt/node/bin/node",
      args: [brief === "burn" ? burn : other],
    }),
  });
  const a = await runner.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "test",
    brief: "other",
  });
  const b = await runner.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "test",
    brief: "burn",
  });
  await Promise.all([runner.esperar(a.id), runner.esperar(b.id)]);
  const limit = JSON.parse(await readFile(probe, "utf8"));
  const sessions = registro.leer();
  if (limit.max !== "1073741824" || !limit.group.includes("sb-session-"))
    throw new Error("No effective per-session cgroup limit");
  if (
    sessions.find((s) => s.id === a.id).resultado !== "SURVIVED" ||
    sessions.find((s) => s.id === b.id).estado !== "error"
  )
    throw new Error("Memory pressure escaped its own session");
  const health = await (
    await fetch("http://127.0.0.1:8080/api/v1/health")
  ).json();
  if (health.status !== "ready") throw new Error("API lost availability");
  console.log(
    "OOM_CONTAINMENT_OK",
    JSON.stringify({ bytes: limit.max, other: "SURVIVED", api: health.status }),
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
