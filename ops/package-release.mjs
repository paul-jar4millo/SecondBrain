import {
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceLock } from "./release-lock.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Repository folder to runtime folder. */
export const RELEASE_MODULES = /** @type {const} */ ([
  ["service", "service"],
  ["mcp", "mcp"],
  ["launcher", "launcher"],
]);

/**
 * Runtime sources: .mjs and native TypeScript (ADR 0011), never declarations.
 * @param {string} name
 */
const isSource = (name) =>
  name.endsWith(".mjs") || (name.endsWith(".ts") && !name.endsWith(".d.ts"));

/**
 * Shared schemas (ADR 0011). contracts/ sits next to launcher/ and service/,
 * so their relative imports resolve. Zod has no dependencies and is copied as
 * plain files into contracts/node_modules: the deploy helper on the host only
 * installs service, mcp and launcher and rejects symlinks in the archive.
 * @param {string} root
 * @param {string} target
 */
async function packageContracts(root, target) {
  const manifest = path.join(root, "contracts/package.json");
  const exists = await stat(manifest)
    .then((s) => s.isFile())
    .catch((e) => {
      if (e.code === "ENOENT") return false;
      throw e;
    });
  if (!exists) return;
  const pkg = JSON.parse(await readFile(manifest, "utf8"));
  if (!pkg.private)
    throw new Error("Los módulos de SecondBrain deben ser privados.");
  const extra = Object.keys(pkg.dependencies ?? {}).filter((d) => d !== "zod");
  if (extra.length)
    throw new Error(
      `contracts solo puede depender de zod: ${extra.join(", ")}`,
    );
  await mkdir(path.join(target, "contracts"), { recursive: true });
  await cp(manifest, path.join(target, "contracts/package.json"));
  await cp(
    path.join(root, "contracts/src"),
    path.join(target, "contracts/src"),
    {
      recursive: true,
      filter: (file) => !file.endsWith(".d.ts") && !file.includes("tests"),
    },
  );
  await cp(
    path.join(root, "node_modules/zod"),
    path.join(target, "contracts/node_modules/zod"),
    { recursive: true, dereference: true },
  );
}

/**
 * Explicit inputs: never copy an entire checkout or runtime data directory.
 * @param {string} destination
 * @param {{ sourceRoot?: string, serviceImage?: boolean, nativeHost?: boolean }} [options]
 */

export async function packageRelease(
  destination,
  { sourceRoot = root, serviceImage = false, nativeHost = false } = {},
) {
  const root = path.resolve(sourceRoot);
  const target = path.resolve(destination);
  if (serviceImage && nativeHost)
    throw new Error("Packaging modes are mutually exclusive.");
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length)
    throw new Error("El destino del paquete debe estar vacío.");
  if (!nativeHost) {
    const source = await stat(path.join(root, "dashboard/dist/index.html"));
    if (!source.isFile())
      throw new Error("Build dashboard/dist before packaging.");
    await cp(
      path.join(root, "dashboard/dist"),
      path.join(target, "dashboard/dist"),
      { recursive: true },
    );
  }
  // One lockfile in the repository (npm workspaces); each released module
  // gets its own slice, so the hosts keep installing modules one by one.
  const rootLock = JSON.parse(
    await readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  const modules = RELEASE_MODULES.filter(
    ([module]) =>
      !(serviceImage && module === "launcher") &&
      !(nativeHost && module === "service"),
  );
  for (const [module, output] of modules) {
    await mkdir(path.join(target, output));
    await writeFile(
      path.join(target, output, "package-lock.json"),
      JSON.stringify(workspaceLock(rootLock, module), null, 2) + "\n",
    );
    for (const entry of await readdir(path.join(root, module), {
      withFileTypes: true,
    })) {
      if (
        entry.isFile() &&
        (isSource(entry.name) || entry.name === "package.json")
      )
        await cp(
          path.join(root, module, entry.name),
          path.join(target, output, entry.name),
        );
    }
    // Internal folders of a package, recursively: only .mjs and .ts sources.
    for (const folder of ["lib", "http", "threads"]) {
      const lib = path.join(root, module, folder);
      const libEntries = await readdir(lib, {
        withFileTypes: true,
        recursive: true,
      }).catch(
        /** @returns {import("node:fs").Dirent[]} */
        (error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const entry of libEntries)
        if (entry.isFile() && isSource(entry.name)) {
          const relative = path.relative(
            lib,
            path.join(entry.parentPath, entry.name),
          );
          await mkdir(
            path.dirname(path.join(target, output, folder, relative)),
            {
              recursive: true,
            },
          );
          await cp(
            path.join(lib, relative),
            path.join(target, output, folder, relative),
          );
        }
    }
  }
  await packageContracts(root, target);
  for (const [, output] of modules)
    if (
      !JSON.parse(
        await readFile(path.join(target, output, "package.json"), "utf8"),
      ).private
    )
      throw new Error("SecondBrain modules must be private.");
  if (serviceImage) return target;
  await mkdir(path.join(target, "launcher/skills"));
  for (const skill of ["resumen-matutino"])
    await cp(
      path.join(root, `launcher/skills/${skill}.md`),
      path.join(target, `launcher/skills/${skill}.md`),
    );
  // Product skills: only each skill folder's SKILL.md, so the catalog
  // hashes the same bytes in the release and nothing else from the folder ships.
  for (const entry of await readdir(path.join(root, "launcher/skills"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, "launcher/skills", entry.name, "SKILL.md");
    const isFile = await stat(file)
      .then((s) => s.isFile())
      .catch((e) => {
        if (e.code === "ENOENT") return false;
        throw e;
      });
    if (!isFile) continue;
    await mkdir(path.join(target, "launcher/skills", entry.name));
    await cp(
      file,
      path.join(target, "launcher/skills", entry.name, "SKILL.md"),
    );
  }
  await cp(path.join(root, "ops/launcher"), path.join(target, "ops/launcher"), {
    recursive: true,
  });
  for (const directory of [
    "deploy",
    "backup",
    "notify",
    "homelab",
    "lxc/templates",
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
              ["pc-wake", "pc-status", "agent-context.md"].includes(
                entry.name,
              )))
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
  for (const folder of ["agents", "migration"]) {
    const input = path.join(root, "ops", folder);
    await cp(input, path.join(target, "ops", folder), {
      recursive: true,
      filter: (file) =>
        !/(?:^|[\\/])(?:node_modules|tests)(?:[\\/]|$)/.test(file) &&
        !/\.(?:env|log)$/.test(file),
    }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  // Stable entry points for existing units and MCP clients.
  await mkdir(path.join(target, "server"));
  for (const [entry, module, method] of [
    ["index", "service/index", "startService"],
    ["launcher", "launcher/index", "arrancar"],
    ["mcp", "mcp/index", "startMcp"],
  ]) {
    if (nativeHost && entry === "index") continue;
    await writeFile(
      path.join(target, "server", entry + ".mjs"),
      "import { " +
        method +
        ' } from "../' +
        module +
        '.mjs";\nawait ' +
        method +
        "();\n",
    );
  }
  return target;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [destination, ...flags] = process.argv.slice(2);
  if (
    flags.some((flag) => !["--service-image", "--native-host"].includes(flag))
  )
    throw new Error("Unknown packaging option.");
  console.log(
    await packageRelease(destination || path.join(root, "artifacts/app"), {
      serviceImage: flags.includes("--service-image"),
      nativeHost: flags.includes("--native-host"),
    }),
  );
}
