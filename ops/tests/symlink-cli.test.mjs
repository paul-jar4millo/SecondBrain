import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test(
  "operational CLIs execute when invoked through the current symlink",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sb-cli-link-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await symlink(path.resolve("."), path.join(dir, "current"), "dir");
    for (const script of ["ops/homelab/pc.mjs", "ops/deploy/configure.mjs"]) {
      const result = spawnSync(
        process.execPath,
        [path.join(dir, "current", script)],
        {
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 2, result.stderr);
      assert.ok(result.stderr.length > 0);
    }
    // These exit 1 on bad arguments; a silent exit 0 means the entrypoint
    // never ran because the symlinked path did not match import.meta.url.
    for (const script of [
      "ops/migration/migrate-host-layout.mjs",
      "ops/deploy/render-container.mjs",
    ]) {
      const result = spawnSync(
        process.execPath,
        [path.join(dir, "current", script), "--unknown"],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0, script);
      assert.ok(result.stderr.length > 0, script);
    }
  },
);
