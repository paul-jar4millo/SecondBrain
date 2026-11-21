import assert from "node:assert/strict";
import test from "node:test";
import { readOnlyCommand } from "../lib/providers/shared.mjs";

test("read-only stages may read and run tests, nothing else", () => {
  for (const command of [
    "git diff",
    "git log --oneline -5",
    "node --test slug.test.mjs",
    "rg slugify",
    "cat slug.mjs",
    "npm test",
    "npx vitest run",
    "ls -la",
  ])
    assert.equal(readOnlyCommand(command), true, command);
  for (const command of [
    "rm -rf x",
    "git commit -m x",
    "git branch -D main",
    "git diff --output=patch",
    "cat a > b",
    "npm test && rm x",
    "echo hi",
    "find . -delete",
    "node -e 1",
    "git diff | tee out",
    "sed -i s/a/b/ f",
    "cat $(echo x)",
    "lsof",
    "",
    undefined,
  ])
    assert.equal(readOnlyCommand(command), false, String(command));
});
