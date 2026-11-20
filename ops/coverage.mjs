// Runs every test suite with coverage and prints one summary per module.
// Node modules use the built-in node:test coverage (V8); the dashboard uses
// @vitest/coverage-v8. LCOV reports land in coverage/<module>/lcov.info.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * @param {string} cwd
 * @param {string} command
 * @param {string[]} args
 * @param {boolean} [shell]
 */
const run = (cwd, command, args, shell = false) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

/**
 * Line coverage from an LCOV file: sum of LH over sum of LF.
 * @param {string} file
 */
const linePercent = (file) => {
  let found = 0;
  let hit = 0;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.startsWith("LF:")) found += Number(line.slice(3));
    if (line.startsWith("LH:")) hit += Number(line.slice(3));
  }
  return found ? ((hit / found) * 100).toFixed(1) : "0.0";
};

// Minimum line coverage per module. Raise a floor when coverage improves; never
// lower it. Baseline measured on 2026-11-19 (v0.1.2).
const floors = { service: 85, mcp: 38, lanzador: 65, dashboard: 40 };
/** @type {string[]} */
const failures = [];
/** @param {keyof typeof floors} module */
const check = (module) => {
  const percent = linePercent(path.join(root, "coverage", module, "lcov.info"));
  console.log(`${module}: ${percent}% lines (floor ${floors[module]}%)`);
  if (Number(percent) < floors[module])
    failures.push(`${module} ${percent}% < ${floors[module]}%`);
};

for (const module of /** @type {const} */ (["service", "mcp", "lanzador"])) {
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
  check(module);
}
console.log("\n== dashboard");
// On Windows npx is a .cmd shim and needs a shell; pass one command string so
// Node does not concatenate unescaped arguments (DEP0190).
if (process.platform === "win32")
  run(path.join(root, "dashboard"), "npx vitest run --coverage", [], true);
else run(path.join(root, "dashboard"), "npx", ["vitest", "run", "--coverage"]);
check("dashboard");

if (failures.length) {
  console.error(`\nCoverage below the floor: ${failures.join(", ")}`);
  process.exit(1);
}
