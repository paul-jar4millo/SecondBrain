import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("commit messages accept Conventional Commits and reject missing type or description", () => {
  for (const message of [
    "feat: crear proyecto",
    "fix(vault)!: cambiar contrato",
    "chore: initial version\n\nVersión inicial.",
  ]) {
    const result = spawnSync(process.execPath, ["ops/check-commit.mjs"], {
      input: message,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const message of [
    "actualizar docs",
    "feat:",
    "Fix: reparar",
    "feat(): algo",
    "fix:   ",
  ]) {
    const result = spawnSync(process.execPath, ["ops/check-commit.mjs"], {
      input: message,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, message);
    assert.match(result.stderr, /Conventional Commits/);
  }
});
