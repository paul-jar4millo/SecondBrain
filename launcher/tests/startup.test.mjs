import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { arrancar } from "../index.mjs";

test("arranca solo en loopback con configuración y huellas desde archivos", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-start-"));
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  await writeFile(path.join(dir, "control"), hash("control"));
  await writeFile(
    path.join(dir, "proyectos.json"),
    JSON.stringify({ prueba: dir }),
  );
  const server = await arrancar({
    SB_LAUNCHER_DATA_DIR: dir,
    SB_CONTROL_HASH_FILE: path.join(dir, "control"),
    SB_PROJECTS_FILE: path.join(dir, "proyectos.json"),
    SB_LAUNCHER_PORT: "0",
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // After the server: Windows cannot delete the open threads database.
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(server.address().address, "127.0.0.1");
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/status`,
    { headers: { authorization: "Bearer control" } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const projects = await fetch(
    `http://127.0.0.1:${server.address().port}/projects`,
    { headers: { authorization: "Bearer control" } },
  );
  assert.deepEqual(await projects.json(), ["prueba"]);
  assert.equal(
    JSON.stringify(
      await (
        await fetch(`http://127.0.0.1:${server.address().port}/projects`, {
          headers: { authorization: "Bearer control" },
        })
      ).json(),
    ).includes(dir),
    false,
  );
});
