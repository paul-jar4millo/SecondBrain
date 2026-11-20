import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACTS_VERSION, z } from "../src/index.ts";

test("exports the contracts version and Zod 4", () => {
  assert.equal(CONTRACTS_VERSION, 1);
  assert.equal(z.string().parse("ok"), "ok");
});
