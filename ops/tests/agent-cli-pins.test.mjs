import { deepEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePins } from "../agents/pins.mjs";

const read = (name) =>
  JSON.parse(readFileSync(new URL("../agents/" + name, import.meta.url)));

test("CLI pins resolve exact versions from the standalone npm lock", () => {
  const manifest = read("versions.json");
  const pkg = read("package.json");
  const lock = read("package-lock.json");
  const pins = parsePins(manifest, pkg, lock);
  deepEqual(pins.versions, {
    claude: pkg.dependencies[manifest.claude.npmPackage],
    codex: pkg.dependencies[manifest.codex.npmPackage],
    agy: manifest.agy.version,
  });
  const drift = structuredClone(lock);
  drift.packages["node_modules/" + manifest.codex.npmPackage].version = "1.0.0";
  throws(
    () => parsePins(manifest, pkg, drift),
    /Codex package must be exactly locked/,
  );
});

test("the AGY manifest rejects unchecked downloads and malformed version strings", () => {
  const pkg = read("package.json");
  const lock = read("package-lock.json");
  const manifest = read("versions.json");
  for (const override of [
    { url: "http://example.test/agy", sha512: "0".repeat(128) },
    { url: manifest.agy.linuxX64.url, sha512: "0" },
  ]) {
    throws(
      () =>
        parsePins(
          {
            ...manifest,
            agy: { ...manifest.agy, linuxX64: override },
          },
          pkg,
          lock,
        ),
      /Invalid Antigravity/,
    );
  }
  throws(
    () =>
      parsePins(
        { ...manifest, agy: { ...manifest.agy, version: "../../other" } },
        pkg,
        lock,
      ),
    /Invalid Antigravity/,
  );
});
