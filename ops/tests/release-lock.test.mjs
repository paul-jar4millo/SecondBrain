import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceLock } from "../release-lock.mjs";

/** @param {Record<string, any>} packages */
const lock = (packages) => ({ lockfileVersion: 3, packages });

const base = {
  "": { name: "monorepo", workspaces: ["service", "web"] },
  service: {
    name: "@x/service",
    version: "1.0.0",
    dependencies: { a: "1.0.0", b: "2.0.0" },
    optionalDependencies: { fsevents: "2.0.0" },
    devDependencies: { tool: "1.0.0" },
  },
  web: { name: "@x/web", dependencies: { b: "1.0.0", react: "19.0.0" } },
  "node_modules/@x/service": { resolved: "service", link: true },
  "node_modules/@x/web": { resolved: "web", link: true },
  "node_modules/a": { version: "1.0.0", dependencies: { c: "^1.0.0" } },
  "node_modules/b": { version: "1.0.0" },
  "service/node_modules/b": { version: "2.0.0" },
  "node_modules/c": {
    version: "1.2.0",
    peerDependencies: { d: "*" },
    peerDependenciesMeta: { d: { optional: true } },
  },
  "node_modules/a/node_modules/e": { version: "3.0.0" },
  "node_modules/react": { version: "19.0.0" },
  "node_modules/tool": { version: "1.0.0", dev: true },
};

test("keeps only what the workspace needs, re-rooted at the module", () => {
  const out = workspaceLock(lock(base), "service");
  assert.deepEqual(Object.keys(out.packages).sort(), [
    "",
    "node_modules/a",
    "node_modules/b",
    "node_modules/c",
  ]);
  // The workspace's own copy of b replaces the hoisted one the web needs.
  assert.equal(out.packages["node_modules/b"].version, "2.0.0");
  assert.equal(out.packages[""].name, "@x/service");
  assert.equal(out.packages[""].devDependencies, undefined);
  assert.equal(out.name, "@x/service");
});

test("follows nested copies and skips missing optional dependencies", () => {
  const packages = structuredClone(base);
  packages["node_modules/a"].dependencies.e = "3.0.0";
  const out = workspaceLock(lock(packages), "service");
  assert.ok(out.packages["node_modules/a/node_modules/e"]);
  assert.equal(out.packages["node_modules/react"], undefined);
});

test("fails when two versions would land in the same folder", () => {
  const packages = structuredClone(base);
  // a now needs the hoisted b 1.0.0 while the service pins its own 2.0.0.
  packages["node_modules/a"].dependencies.b = "1.0.0";
  assert.throws(
    () => workspaceLock(lock(packages), "service"),
    /quedarían en node_modules\/b/,
  );
});

test("fails on a required dependency missing from the lockfile", () => {
  const packages = structuredClone(base);
  delete packages["node_modules/a"];
  assert.throws(() => workspaceLock(lock(packages), "service"), /necesita a/);
});
