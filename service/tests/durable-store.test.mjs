import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendJsonLine,
  createSerialQueue,
  writeJsonAtomically,
} from "../lib/durable-store.mjs";

test("durable store writes snapshots atomically and appends journal lines", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-durable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const snapshot = path.join(dir, "state.json");
  await writeJsonAtomically(snapshot, { a: 1 });
  await writeJsonAtomically(snapshot, { a: 2 });
  assert.deepEqual(JSON.parse(await readFile(snapshot, "utf8")), { a: 2 });
  assert.deepEqual(await readdir(dir), ["state.json"]);

  const journal = path.join(dir, "journal.jsonl");
  await appendJsonLine(journal, { op: "one" });
  await appendJsonLine(journal, { op: "two" });
  const lines = (await readFile(journal, "utf8")).trim().split("\n");
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).op),
    ["one", "two"],
  );
});

test("serial queue keeps order and survives a failing task", async () => {
  const serial = createSerialQueue();
  const order = [];
  const slow = serial(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("slow");
  });
  const failing = serial(() => {
    throw new Error("boom");
  });
  const fast = serial(() => order.push("fast"));
  await assert.rejects(failing, /boom/);
  await Promise.all([slow, fast]);
  await serial.drain();
  assert.deepEqual(order, ["slow", "fast"]);
});
