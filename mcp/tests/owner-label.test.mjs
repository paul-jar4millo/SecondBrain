import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerLabel } from "../index.mjs";

test("ownerLabel uses SB_OWNER_NAME and stays neutral without it", () => {
  assert.equal(ownerLabel({}), "tu usuario");
  assert.equal(ownerLabel({ SB_OWNER_NAME: "   " }), "tu usuario");
  assert.equal(ownerLabel({ SB_OWNER_NAME: " Ana " }), "Ana");
  assert.equal(ownerLabel({ SB_OWNER_NAME: "x".repeat(80) }).length, 60);
});
