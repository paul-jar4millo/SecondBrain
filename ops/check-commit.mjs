// @ts-check
import { readFileSync } from "node:fs";

const message = readFileSync(process.argv[2] || 0, "utf8");
const subject = message.replace(/^\uFEFF/, "").split(/\r?\n/)[0];
if (
  !/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9._/-]*\))?!?: \S.*$/.test(
    subject,
  )
) {
  console.error(
    "Conventional Commits requerido: tipo(alcance opcional): descripción. Ejemplo: docs: actualizar arquitectura",
  );
  process.exitCode = 1;
}
