import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { packageRelease } from "../../ops/package-release.mjs";

// Catches accidentally packaging operational data, credentials or a vault.
test("el paquete incluye los módulos ejecutables y excluye datos personales", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "sb-package-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), text);
  };
  for (const module of ["service", "mcp", "launcher"]) {
    await put(`${module}/package.json`, '{"private":true}');
    await put(`${module}/package-lock.json`, "{}");
    await put(`${module}/index.mjs`, "export const synthetic = true;");
    await put(`${module}/.env`, "secret");
    await put(`${module}/.data/personal.md`, "private");
    await put(`${module}/node_modules/private.txt`, "private");
  }
  // The root lockfile is the source; a stale module lockfile is not shipped.
  await put(
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { workspaces: ["service", "mcp", "launcher"] },
        service: { name: "@x/service" },
        mcp: { name: "@x/mcp" },
        launcher: { name: "@x/launcher" },
      },
    }),
  );
  await put("service/lib/shared.mjs", "export const shared = true;");
  await put("service/lib/notes.md", "private");
  await put("service/http/context.mjs", "export const context = true;");
  await put("service/http/routes/vault.mjs", "export const routes = true;");
  await put("service/http/route-types.d.ts", "export {};");
  await put("launcher/threads/runtime.mjs", "export const runtime = true;");
  await put(
    "launcher/version-registry.mjs",
    "export const SESSION_REGISTRY_VERSION = 2;\n",
  );
  await put("dashboard/dist/index.html", "<main>synthetic</main>");
  await put("assets/reference-bank/references.json", "{}");
  await put("assets/reference-bank/auth.json", "secret");
  await put("vault/Home.md", "private");
  await put("ops/compat/index.mjs", "// launcher");
  await put("launcher/skills/no-publicar.env", "secret");
  await put("launcher/skills/resumen-matutino.md", "# Resumen");
  await put("ops/launcher/install.sh", "#!/bin/sh");
  const target = path.join(temp, "release");
  // The release keeps the launcher in lanzador/: host units and entry points use that path.
  await packageRelease(target, { sourceRoot: source });
  assert.equal(
    await readFile(path.join(target, "dashboard/dist/index.html"), "utf8"),
    "<main>synthetic</main>",
  );
  assert.deepEqual((await readdir(target)).sort(), [
    "dashboard",
    "lanzador",
    "mcp",
    "ops",
    "server",
    "service",
  ]);
  assert.deepEqual(await readdir(path.join(target, "service/lib")), [
    "shared.mjs",
  ]);
  assert.deepEqual(
    (await readdir(path.join(target, "service/http"), { recursive: true }))
      .map((file) => file.split(path.sep).join("/"))
      .sort(),
    ["context.mjs", "routes", "routes/vault.mjs"],
  );
  assert.deepEqual((await readdir(path.join(target, "mcp"))).sort(), [
    "index.mjs",
    "package-lock.json",
    "package.json",
  ]);
  assert.deepEqual((await readdir(path.join(target, "lanzador"))).sort(), [
    "index.mjs",
    "package-lock.json",
    "package.json",
    "registro-version.mjs",
    "skills",
    "threads",
    "version-registry.mjs",
  ]);
  assert.deepEqual(await readdir(path.join(target, "lanzador/skills")), [
    "resumen-matutino.md",
  ]);
  // The helper already installed on hosts reads the old marker name.
  assert.match(
    await readFile(path.join(target, "lanzador/registro-version.mjs"), "utf8"),
    // The exact pattern of the v0.1.2 helper.
    /^(?:[ \t]*(?:\/\/[^\n]*)?\r?\n)*\s*export const REGISTRO_VERSION = 2;\s*$/,
  );
  const lanzadorLock = JSON.parse(
    await readFile(path.join(target, "lanzador/package-lock.json"), "utf8"),
  );
  assert.equal(lanzadorLock.name, "@x/launcher");
  assert.equal(lanzadorLock.lockfileVersion, 3);
  await assert.rejects(packageRelease(target, { sourceRoot: source }), /vacío/);
});
