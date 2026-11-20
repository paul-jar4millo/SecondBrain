import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
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
  for (const file of [
    "dashboard/dist/index.html",
    "ops/compat/index.mjs",
    "ops/launcher/install.sh",
    "launcher/skills/equipo-cuatro-fases.md",
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
    ["equipo-cuatro-fases.md", "personal-context", "resumen-matutino.md"],
  );
  assert.deepEqual(
    await readdir(path.join(target, "lanzador/skills/personal-context")),
    ["SKILL.md"],
  );
  assert.ok(
    (await readdir(path.join(target, "ops/deploy"))).includes(
      "deploy-release.sh",
    ),
  );
});
