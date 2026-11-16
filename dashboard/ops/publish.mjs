import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageRelease } from "../../ops/package-release.mjs";
const root = fileURLToPath(new URL("../..", import.meta.url));
const result = spawnSync("npm", ["run", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.status !== 0) process.exit(result.status || 1);
const target = await packageRelease(
  path.join(root, "artifacts/app-" + Date.now()),
);
console.log(
  `Aplicación empaquetada en ${target}. Instala dependencias en service/ y mcp/; inicia node service/index.mjs.`,
);
