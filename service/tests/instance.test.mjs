import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireInstance } from "../../contracts/src/node/instance.mjs";
test("allows one process, releases only its own lock and recovers a dead owner", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sb-instance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await acquireInstance(root);
  await assert.rejects(acquireInstance(root), /instancia/i);
  await release();
  await writeFile(
    path.join(root, "instance.lock"),
    JSON.stringify({ pid: 2147483647, nonce: "old" }),
  );
  const again = await acquireInstance(root);
  await again();
});
