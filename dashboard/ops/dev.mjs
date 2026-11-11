import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const children = [];
let stopping = false;
function child(command, args, env = {}) {
  const processChild = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  children.push(processChild);
  processChild.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  processChild.on("exit", (code) => {
    if (!stopping) stop(code || 0);
  });
  return processChild;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const processChild of children) processChild.kill("SIGTERM");
  setTimeout(() => process.exit(code), 800).unref();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
if (process.env.VAULT_ROOT)
  child(process.execPath, ["../service/index.mjs"], {
    API_PORT: process.env.API_PORT || "5080",
    HOST: "127.0.0.1",
    NODE_ENV: "development",
  });
let ready = !process.env.VAULT_ROOT;
if (ready)
  console.log(
    "Vault remoto: desarrollo local con datos sintéticos en http://127.0.0.1:5173/?demo=1. Usa MCP para las notas reales.",
  );
for (let i = 0; !ready && i < 60; i++) {
  try {
    if (
      (
        await fetch(
          `http://127.0.0.1:${process.env.API_PORT || 5080}/api/v1/health`,
        )
      ).ok
    ) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
if (!ready) {
  console.error("No se pudo abrir el vault. Revisa VAULT_ROOT y los permisos.");
  stop(1);
} else
  child(process.execPath, [
    path.join(
      path.dirname(require.resolve("vite/package.json")),
      "bin/vite.js",
    ),
    "--host",
    arg("--host", "127.0.0.1"),
    "--port",
    arg("--port", process.env.PORT || "5173"),
    "--strictPort",
  ]);
