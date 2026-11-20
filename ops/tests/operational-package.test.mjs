import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { packageRelease } from "../package-release.mjs";

test("empaqueta recursos de operación sin configuración privada local", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-ops-package-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  const put = async (file, content = "synthetic") => {
    const target = path.join(source, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  for (const module of ["service", "mcp", "launcher"])
    await put(`${module}/package.json`, '{"private":true}');
  // One root lockfile (npm workspaces); the release gets one slice per module.
  await put(
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { workspaces: ["service", "mcp", "launcher"] },
        service: { name: "@x/service", dependencies: { shared: "1.0.0" } },
        mcp: { name: "@x/mcp" },
        launcher: { name: "@x/launcher", dependencies: { pty: "2.0.0" } },
        "node_modules/shared": { version: "1.0.0" },
        "node_modules/pty": { version: "2.0.0" },
      },
    }),
  );
  for (const file of [
    "dashboard/dist/index.html",
    "ops/compat/index.mjs",
    "ops/launcher/install.sh",
    "launcher/skills/resumen-matutino.md",
    "launcher/skills/personal-context/SKILL.md",
    "launcher/skills/personal-context/notas-locales.txt",
    "launcher/skills/sin-skill/README.md",
    "dashboard/ops/deploy-release.sh",
    "ops/backup/backup.sh",
    "ops/backup/secondbrain-backup.timer",
    "ops/backup/backup.env",
    "ops/aviso/aviso.env",
  ])
    await put(file);
  await put(
    "launcher/version-registry.mjs",
    "export const SESSION_REGISTRY_VERSION = 2;\n",
  );
  const target = path.join(dir, "release");
  await packageRelease(target, { sourceRoot: source });
  assert.deepEqual((await readdir(path.join(target, "ops/backup"))).sort(), [
    "backup.sh",
    "secondbrain-backup.timer",
  ]);
  assert.deepEqual(await readdir(path.join(target, "ops/aviso")), []);
  // Product skills ship only their SKILL.md; folders without one are skipped.
  assert.deepEqual(
    (await readdir(path.join(target, "lanzador/skills"))).sort(),
    ["personal-context", "resumen-matutino.md"],
  );
  assert.deepEqual(
    await readdir(path.join(target, "lanzador/skills/personal-context")),
    ["SKILL.md"],
  );
  const lanzadorLock = JSON.parse(
    await readFile(path.join(target, "lanzador/package-lock.json"), "utf8"),
  );
  assert.equal(lanzadorLock.name, "@x/launcher");
  assert.deepEqual(Object.keys(lanzadorLock.packages), [
    "",
    "node_modules/pty",
  ]);
  assert.ok(
    (await readdir(path.join(target, "ops/deploy"))).includes(
      "deploy-release.sh",
    ),
  );
});

test("ships contracts with vendored Zod so lanzador .ts files resolve it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-ops-contracts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  const put = async (file, content = "synthetic") => {
    const target = path.join(source, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  for (const module of ["service", "mcp", "launcher"])
    await put(`${module}/package.json`, '{"private":true}');
  await put(
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { workspaces: ["contracts", "service", "mcp", "launcher"] },
        service: { name: "@x/service" },
        mcp: { name: "@x/mcp" },
        launcher: { name: "@x/launcher" },
      },
    }),
  );
  for (const file of [
    "dashboard/dist/index.html",
    "ops/compat/index.mjs",
    "ops/launcher/install.sh",
    "launcher/skills/resumen-matutino.md",
  ])
    await put(file);
  await put(
    "launcher/version-registry.mjs",
    "export const SESSION_REGISTRY_VERSION = 2;\n",
  );
  await put(
    "contracts/package.json",
    '{"private":true,"type":"module","dependencies":{"zod":"4.0.0"}}',
  );
  await put(
    "contracts/src/index.ts",
    'import { z } from "zod";\nexport const kind: string = z.parse("repo");\n',
  );
  await put("contracts/tests/index.test.ts", "throw new Error('no')");
  await put(
    "node_modules/zod/package.json",
    '{"name":"zod","type":"module","exports":"./index.js"}',
  );
  await put(
    "node_modules/zod/index.js",
    "export const z = { parse: (v) => v };\n",
  );
  await put(
    "launcher/threads/kind.ts",
    'import { kind } from "../../contracts/src/index.ts";\nexport const value: string = kind;\n',
  );
  await put("launcher/threads/types.d.ts", "export {};\n");
  const target = path.join(dir, "release");
  await packageRelease(target, { sourceRoot: source });
  assert.deepEqual(await readdir(path.join(target, "contracts/src")), [
    "index.ts",
  ]);
  assert.deepEqual(await readdir(path.join(target, "lanzador/threads")), [
    "kind.ts",
  ]);
  const { value } = await import(
    pathToFileURL(path.join(target, "lanzador/threads/kind.ts")).href
  );
  assert.equal(value, "repo");
});

test("contracts may only depend on zod", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-ops-contracts-deps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  const put = async (file, content) => {
    const target = path.join(source, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  for (const module of ["service", "mcp", "launcher"])
    await put(`${module}/package.json`, '{"private":true}');
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
  for (const file of [
    "dashboard/dist/index.html",
    "ops/compat/index.mjs",
    "ops/launcher/install.sh",
    "launcher/skills/resumen-matutino.md",
  ])
    await put(file, "x");
  await put(
    "launcher/version-registry.mjs",
    "export const SESSION_REGISTRY_VERSION = 2;\n",
  );
  await put(
    "contracts/package.json",
    '{"private":true,"dependencies":{"zod":"4","left-pad":"1"}}',
  );
  await assert.rejects(
    packageRelease(path.join(dir, "release"), { sourceRoot: source }),
    /left-pad/,
  );
});
