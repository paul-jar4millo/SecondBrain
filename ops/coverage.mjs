// Runs every test suite with coverage and prints one summary per module.
// Node modules use the built-in node:test coverage (V8); the dashboard uses
// @vitest/coverage-v8. LCOV reports land in coverage/<module>/lcov.info.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cwd, command, args, shell = false) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

/** Line coverage from an LCOV file: sum of LH over sum of LF. */
const linePercent = (file) => {
  let found = 0;
  let hit = 0;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.startsWith("LF:")) found += Number(line.slice(3));
    if (line.startsWith("LH:")) hit += Number(line.slice(3));
  }
  return found ? ((hit / found) * 100).toFixed(1) : "0.0";
};

for (const module of ["service", "mcp", "lanzador"]) {
  const dir = path.join(root, module);
  const out = path.join(root, "coverage", module);
  mkdirSync(out, { recursive: true });
  const tests = readdirSync(path.join(dir, "tests"))
    .filter((file) => file.endsWith(".test.mjs"))
    .map((file) => path.join("tests", file));
  console.log(`\n== ${module}`);
  run(dir, process.execPath, [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-exclude=tests/**",
    "--test-reporter=dot",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${path.join(out, "lcov.info")}`,
    ...tests,
  ]);
  console.log(`${module}: ${linePercent(path.join(out, "lcov.info"))}% lines`);
}
console.log("\n== dashboard");
run(
  path.join(root, "dashboard"),
  "npx",
  ["vitest", "run", "--coverage"],
  process.platform === "win32",
);
