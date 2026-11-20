import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { arrancar } from "../index.mjs";

test("arranca solo en loopback con configuración y huellas desde archivos", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-start-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  await writeFile(path.join(dir, "control"), hash("control"));
  await writeFile(path.join(dir, "hook"), hash("hook"));
  await writeFile(
    path.join(dir, "proyectos.json"),
    JSON.stringify({ prueba: dir }),
  );
  const servidor = await arrancar({
    SB_LANZADOR_DATA_DIR: dir,
    SB_CONTROL_HASH_FILE: path.join(dir, "control"),
    SB_HOOK_HASH_FILE: path.join(dir, "hook"),
    SB_PROYECTOS_FILE: path.join(dir, "proyectos.json"),
    SB_LANZADOR_PORT: "0",
  });
  t.after(() => new Promise((resolve) => servidor.close(resolve)));
  assert.equal(servidor.address().address, "127.0.0.1");
  const response = await fetch(
    `http://127.0.0.1:${servidor.address().port}/estado`,
    { headers: { authorization: "Bearer control" } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  const proyectos = await fetch(
    `http://127.0.0.1:${servidor.address().port}/proyectos`,
    { headers: { authorization: "Bearer control" } },
  );
  assert.deepEqual(await proyectos.json(), ["prueba"]);
  assert.equal(
    JSON.stringify(
      await (
        await fetch(`http://127.0.0.1:${servidor.address().port}/proyectos`, {
          headers: { authorization: "Bearer control" },
        })
      ).json(),
    ).includes(dir),
    false,
  );
});
