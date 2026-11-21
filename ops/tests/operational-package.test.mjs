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
    "ops/launcher/install.sh",
    "launcher/skills/resumen-matutino.md",
    "launcher/skills/personal-context/SKILL.md",
    "launcher/skills/personal-context/notas-locales.txt",
    "launcher/skills/sin-skill/README.md",
    "dashboard/ops/deploy-release.sh",
    "ops/backup/backup.sh",
    "ops/backup/secondbrain-backup.timer",
    "ops/backup/backup.env",
    "ops/notify/aviso.env",
  ])
    await put(file);
  const target = path.join(dir, "release");
  await packageRelease(target, { sourceRoot: source });
  assert.deepEqual((await readdir(path.join(target, "ops/backup"))).sort(), [
    "backup.sh",
    "secondbrain-backup.timer",
  ]);
  assert.deepEqual(await readdir(path.join(target, "ops/notify")), []);
  // Product skills ship only their SKILL.md; folders without one are skipped.
  assert.deepEqual(
    (await readdir(path.join(target, "launcher/skills"))).sort(),
    ["personal-context", "resumen-matutino.md"],
  );
  assert.deepEqual(
    await readdir(path.join(target, "launcher/skills/personal-context")),
    ["SKILL.md"],
  );
  const image = path.join(dir, "image");
  await packageRelease(image, { sourceRoot: source, serviceImage: true });
  assert.deepEqual((await readdir(image)).sort(), [
    "dashboard",
    "mcp",
    "service",
  ]);
  const native = path.join(dir, "native");
  await packageRelease(native, { sourceRoot: source, nativeHost: true });
  assert.deepEqual((await readdir(native)).sort(), [
    "launcher",
    "mcp",
    "ops",
    "server",
  ]);
  const lanzadorLock = JSON.parse(
    await readFile(path.join(target, "launcher/package-lock.json"), "utf8"),
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
    "ops/launcher/install.sh",
    "launcher/skills/resumen-matutino.md",
  ])
    await put(file);
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
  assert.deepEqual(await readdir(path.join(target, "launcher/threads")), [
    "kind.ts",
  ]);
  const { value } = await import(
    pathToFileURL(path.join(target, "launcher/threads/kind.ts")).href
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
    "ops/launcher/install.sh",
    "launcher/skills/resumen-matutino.md",
  ])
    await put(file, "x");
  await put(
    "contracts/package.json",
    '{"private":true,"dependencies":{"zod":"4","left-pad":"1"}}',
  );
  await assert.rejects(
    packageRelease(path.join(dir, "release"), { sourceRoot: source }),
    /left-pad/,
  );
});

// The native host package has no service/ (it runs in the image): a launcher
// import of ../service/ passed CI and broke the v0.5.1 deploy.
test("every relative import in the native host package resolves inside it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-native-imports-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.resolve(import.meta.dirname, "../..");
  const target = path.join(dir, "release");
  await packageRelease(target, { nativeHost: true, sourceRoot: repo });
  const missing = [];
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
  for (const entry of await readdir(target, {
    recursive: true,
    withFileTypes: true,
  })) {
    const file = path.join(entry.parentPath, entry.name);
    if (
      !entry.isFile() ||
      !/\.(mjs|ts)$/.test(entry.name) ||
      entry.name.endsWith(".d.ts") ||
      file.split(path.sep).includes("node_modules")
    )
      continue;
    // Type-only imports (JSDoc and `import type`) are erased at runtime.
    const text = (await readFile(file, "utf8"))
      .split("\n")
      .filter(
        (line) =>
          !/@import|@typedef|@type\b|@param|@returns|^\s*\*|^\s*import\s+type\b|^\s*}\s*from\s+["'][^"']+\.d\.ts["']/.test(
            line,
          ),
      )
      .join("\n");
    for (const [, specifier] of text.matchAll(pattern)) {
      const resolved = path.resolve(path.dirname(file), specifier);
      try {
        await readFile(resolved);
      } catch {
        missing.push(path.relative(target, file) + " -> " + specifier);
      }
    }
  }
  assert.deepEqual(missing, []);
});
