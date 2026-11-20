import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Explicit inputs: never copy an entire checkout or runtime data directory.
export async function packageRelease(destination, { sourceRoot = root } = {}) {
  const root = path.resolve(sourceRoot);
  const target = path.resolve(destination);
  const source = await stat(path.join(root, "dashboard/dist/index.html"));
  if (!source.isFile()) throw new Error("Falta compilar dashboard/dist.");
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length)
    throw new Error("El destino del paquete debe estar vacío.");
  await cp(
    path.join(root, "dashboard/dist"),
    path.join(target, "dashboard/dist"),
    { recursive: true },
  );
  for (const module of ["service", "mcp", "lanzador"]) {
    await mkdir(path.join(target, module));
    for (const entry of await readdir(path.join(root, module), {
      withFileTypes: true,
    })) {
      if (
        entry.isFile() &&
        (entry.name.endsWith(".mjs") ||
          (module === "lanzador" && entry.name === "terminal.py") ||
          ["package.json", "package-lock.json"].includes(entry.name))
      )
        await cp(
          path.join(root, module, entry.name),
          path.join(target, module, entry.name),
        );
    }
    // Internal modules of a package (lib/, recursively): only .mjs sources.
    const lib = path.join(root, module, "lib");
    const libEntries = await readdir(lib, {
      withFileTypes: true,
      recursive: true,
    }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of libEntries)
      if (entry.isFile() && entry.name.endsWith(".mjs")) {
        const relative = path.relative(
          lib,
          path.join(entry.parentPath, entry.name),
        );
        await mkdir(path.dirname(path.join(target, module, "lib", relative)), {
          recursive: true,
        });
        await cp(
          path.join(lib, relative),
          path.join(target, module, "lib", relative),
        );
      }
  }
  await mkdir(path.join(target, "lanzador/skills"));
  for (const skill of ["equipo-cuatro-fases", "resumen-matutino"])
    await cp(
      path.join(root, `lanzador/skills/${skill}.md`),
      path.join(target, `lanzador/skills/${skill}.md`),
    );
  // Product skills: only each skill folder's SKILL.md, so the catalog
  // hashes the same bytes in the release and nothing else from the folder ships.
  for (const entry of await readdir(path.join(root, "lanzador/skills"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, "lanzador/skills", entry.name, "SKILL.md");
    const isFile = await stat(file)
      .then((s) => s.isFile())
      .catch((e) => {
        if (e.code === "ENOENT") return false;
        throw e;
      });
    if (!isFile) continue;
    await mkdir(path.join(target, "lanzador/skills", entry.name));
    await cp(
      file,
      path.join(target, "lanzador/skills", entry.name, "SKILL.md"),
    );
  }
  await cp(path.join(root, "ops/lanzador"), path.join(target, "ops/lanzador"), {
    recursive: true,
  });
  for (const directory of [
    "deploy",
    "backup",
    "aviso",
    "homelab",
    "lxc/plantillas",
  ]) {
    const source = path.join(root, "ops", directory);
    if (
      await stat(source)
        .then((s) => s.isDirectory())
        .catch((e) => {
          if (e.code === "ENOENT") return false;
          throw e;
        })
    ) {
      const output = path.join(target, "ops", directory);
      await mkdir(output, { recursive: true });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (
          entry.isFile() &&
          (/\.(?:mjs|py|sh|service|timer|conf)$/.test(entry.name) ||
            (directory === "homelab" &&
              ["prender-pc", "estado-pc", "CLAUDE.md"].includes(entry.name)))
        )
          await cp(
            path.join(source, entry.name),
            path.join(output, entry.name),
          );
      }
    }
  }
  for (const [source, destination] of [
    ["dashboard/ops/deploy-release.sh", "ops/deploy/deploy-release.sh"],
    [
      "ops/secondbrain-vault-push.service",
      "ops/deploy/secondbrain-vault-push.service",
    ],
    [
      "ops/secondbrain-vault-push.timer",
      "ops/deploy/secondbrain-vault-push.timer",
    ],
  ]) {
    if (
      await stat(path.join(root, source))
        .then((s) => s.isFile())
        .catch((e) => {
          if (e.code === "ENOENT") return false;
          throw e;
        })
    ) {
      await mkdir(path.dirname(path.join(target, destination)), {
        recursive: true,
      });
      await cp(path.join(root, source), path.join(target, destination));
    }
  }
  await cp(path.join(root, "ops/compat"), path.join(target, "server"), {
    recursive: true,
  });
  // Verify the manifests are private before distributing any software package.
  for (const module of ["service", "mcp", "lanzador"]) {
    if (
      !JSON.parse(
        await readFile(path.join(target, module, "package.json"), "utf8"),
      ).private
    )
      throw new Error("Los módulos de SecondBrain deben ser privados.");
  }
  return target;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    await packageRelease(process.argv[2] || path.join(root, "artifacts/app")),
  );
}
