import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSessionRegistry } from "../sessions.mjs";
import { createExecutor } from "../executor.mjs";

test("ejecuta un CLI simulado, recoge su resultado y conserva el directorio del proyecto", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-exec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake.mjs");
  await writeFile(
    fake,
    'console.log(JSON.stringify({type:"result",result:process.cwd()}));',
  );
  const registro = await openSessionRegistry(
    path.join(dir, "estado", "sesiones.json"),
  );
  const ejecutor = createExecutor({
    registro,
    proyectos: { prueba: dir },
    comando: () => ({ bin: process.execPath, args: [fake] }),
  });
  const s = await ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "prueba",
  });
  await ejecutor.esperar(s.id);
  const resultado = registro.leer().find((x) => x.id === s.id);
  assert.equal(resultado.estado, "terminada");
  assert.equal(resultado.resultado, dir);
  assert.equal(ejecutor.activos(), 0);
});

test("cancela el proceso y rechaza proyectos no registrados", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-exec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake.mjs");
  await writeFile(fake, "setInterval(() => {}, 1000);");
  const registro = await openSessionRegistry(path.join(dir, "estado.json"));
  const ejecutor = createExecutor({
    registro,
    proyectos: { prueba: dir },
    comando: () => ({ bin: process.execPath, args: [fake] }),
  });
  await assert.rejects(
    ejecutor.encargar({
      motor: "claude",
      origen: "sala",
      proyecto: "../vault",
      brief: "x",
    }),
  );
  const s = await ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "x",
  });
  await ejecutor.cancelar(s.id);
  await ejecutor.esperar(s.id);
  assert.equal(registro.leer().find((x) => x.id === s.id).estado, "cancelada");
});

test("un CLI inexistente termina la sesión con error y libera el cupo", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-exec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registro = await openSessionRegistry(path.join(dir, "estado.json"));
  const ejecutor = createExecutor({
    registro,
    proyectos: { prueba: dir },
    comando: () => ({ bin: path.join(dir, "inexistente"), args: [] }),
  });
  const s = await ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "x",
  });
  await ejecutor.esperar(s.id);
  assert.equal(registro.leer().find((x) => x.id === s.id).estado, "error");
  assert.equal(ejecutor.activos(), 0);
});

test("un fallo al preparar el comando no deja la sesión trabajando", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-exec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registro = await openSessionRegistry(path.join(dir, "estado.json"));
  const ejecutor = createExecutor({
    registro,
    proyectos: { prueba: dir },
    comando: () => {
      throw new Error("fallo");
    },
  });
  const s = await ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "x",
  });
  await ejecutor.esperar(s.id);
  assert.equal(registro.leer().find((x) => x.id === s.id).estado, "error");
});

test("el CLI recibe la ruta del token de hooks y el identificador de su sesión", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-exec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, "fake.mjs");
  await writeFile(
    fake,
    'console.log(JSON.stringify({type:"result",result:JSON.stringify({id:process.env.SB_SESSION_ID,token:process.env.SB_HOOK_TOKEN_FILE})}));',
  );
  const registro = await openSessionRegistry(path.join(dir, "estado.json"));
  const ejecutor = createExecutor({
    registro,
    proyectos: { prueba: dir },
    env: { PATH: process.env.PATH, SB_HOOK_TOKEN_FILE: "/hook-token" },
    comando: () => ({ bin: process.execPath, args: [fake] }),
  });
  const s = await ejecutor.encargar({
    motor: "claude",
    origen: "sala",
    proyecto: "prueba",
    brief: "x",
  });
  await ejecutor.esperar(s.id);
  const result = JSON.parse(
    registro.leer().find((x) => x.id === s.id).resultado,
  );
  assert.deepEqual(result, { id: s.id, token: "/hook-token" });
});
