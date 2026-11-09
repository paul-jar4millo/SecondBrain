import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { operationalStatus } from "../operational-status.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-maintenance-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = {
    stateFile: path.join(dir, "backup.json"),
    revisionFile: path.join(dir, "REVISION"),
    launcherPinFile: path.join(dir, "launcher"),
    runtimeLauncherFile: path.join(dir, "runtime"),
    now: Date.parse("2026-11-15T18:00:00Z"),
  };
  await writeFile(options.revisionFile, "a".repeat(40));
  await writeFile(
    options.launcherPinFile,
    "/opt/secondbrain/releases/" + "b".repeat(40),
  );
  return options;
}
test("a missing backup is degraded and a pinned old launcher stays visible", async (t) => {
  const status = await operationalStatus(await fixture(t));
  assert.equal(status.status, "degraded");
  assert.equal(status.backup.status, "never");
  assert.equal(status.deployment.pending, true);
  assert.equal(status.deployment.launcherRevision, "b".repeat(40));
});
test("a successful backup becomes stale after 26 hours and a later error wins", async (t) => {
  const options = await fixture(t);
  await writeFile(
    options.stateFile,
    JSON.stringify({
      lastSuccess: "2026-11-14T15:00:00Z",
      lastSnapshot: "1234abcd",
    }),
  );
  assert.equal((await operationalStatus(options)).backup.status, "stale");
  await writeFile(
    options.stateFile,
    JSON.stringify({
      lastSuccess: "2026-11-15T17:00:00Z",
      lastErrorAt: "2026-11-15T17:30:00Z",
      error: "private operational detail",
    }),
  );
  const status = await operationalStatus(options);
  assert.equal(status.backup.status, "failed");
  assert.ok(!JSON.stringify(status).includes("private operational detail"));
});
test("fresh verified backup and aligned releases are healthy without exposing paths", async (t) => {
  const options = await fixture(t);
  await writeFile(
    options.launcherPinFile,
    "/opt/secondbrain/releases/" + "a".repeat(40),
  );
  await writeFile(
    options.stateFile,
    JSON.stringify({
      lastSuccess: "2026-11-15T17:00:00Z",
      lastRestore: "2026-11-15T16:00:00Z",
      lastSnapshot: "1234abcd",
      repository: "private path",
    }),
  );
  const status = await operationalStatus(options);
  assert.equal(status.status, "ok");
  assert.equal(status.deployment.pending, false);
  assert.ok(!JSON.stringify(status).includes("private path"));
});
