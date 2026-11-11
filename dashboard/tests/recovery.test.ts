import { expect, it } from "vitest";
import { isStaleChunk, reloadForNewVersion } from "../src/core/recovery";

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

it("reloads once for a new version but not in a loop", () => {
  const storage = memory();
  let reloads = 0;
  const reload = () => reloads++;
  expect(reloadForNewVersion(storage, reload, 1_000)).toBe(true);
  expect(reloadForNewVersion(storage, reload, 20_000)).toBe(false);
  expect(reloadForNewVersion(storage, reload, 120_000)).toBe(true);
  expect(reloads).toBe(2);
});

it("recognises a missing chunk in each browser's wording", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: https://x/assets/a.js",
    "error loading dynamically imported module: https://x/assets/a.js",
    "Importing a module script failed.",
  ])
    expect(isStaleChunk(new TypeError(message))).toBe(true);
  expect(isStaleChunk(new Error("Cannot read properties of undefined"))).toBe(
    false,
  );
});
