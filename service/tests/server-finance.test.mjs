import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";

import path from "node:path";
import { randomUUID } from "node:crypto";

import { fixture, item, mutate } from "./helpers/vault-fixture.mjs";

test("derives a balanced ledger from the same Markdown records, with no double-counted card payments", () =>
  fixture(async ({ vault }) => {
    const a = await mutate(
      vault,
      item("account", { accountType: "asset", currency: "MXN" }),
    );
    const c = await mutate(
      vault,
      item("account", { accountType: "credit", currency: "MXN" }),
    );
    await mutate(
      vault,
      item("transaction", {
        transactionType: "opening",
        amountMinor: 100000,
        accountId: a.id,
        date: "2026-11-06",
        status: "confirmed",
      }),
    );
    const expense = await mutate(
      vault,
      item("transaction", {
        transactionType: "expense",
        amountMinor: 12000,
        accountId: c.id,
        category: "Personal",
        date: "2026-11-06",
        status: "confirmed",
      }),
    );
    await mutate(
      vault,
      item("transaction", {
        transactionType: "payment",
        amountMinor: 12000,
        accountId: a.id,
        otherAccountId: c.id,
        date: "2026-11-06",
        status: "confirmed",
      }),
    );
    const ledger = await vault.ledger();
    const sum = (id) =>
      ledger
        .filter((x) => x.account === id)
        .reduce((n, x) => n + x.debit - x.credit, 0);
    assert.equal(sum(a.id), 88000);
    assert.equal(sum(c.id), 0);
    assert.equal(sum("expense:Personal"), 12000);
    assert.equal(
      ledger.reduce((n, x) => n + x.debit - x.credit, 0),
      0,
    );
    await assert.rejects(
      mutate(vault, { ...expense, title: "overwrite" }),
      /confirmados/,
    );
  }));

test("excludes malformed externally edited financial records from totals, while showing the source and errors", () =>
  fixture(async ({ root, vault }) => {
    const account = await mutate(
      vault,
      item("account", { accountType: "asset" }),
    );
    const transaction = await mutate(
      vault,
      item("transaction", {
        transactionType: "expense",
        amountMinor: 1000,
        accountId: account.id,
        date: "2026-11-06",
        status: "confirmed",
      }),
    );
    await writeFile(
      path.join(root, transaction.vaultPath),
      (await readFile(path.join(root, transaction.vaultPath), "utf8")).replace(
        "amountMinor: 1000",
        "amountMinor: wrong",
      ),
    );
    const snapshot = await vault.snapshot();
    assert.ok(
      snapshot.items.find((i) => i.id === transaction.id).validationErrors
        .length,
    );
    assert.equal((await vault.ledger()).length, 0);
    assert.ok(snapshot.issues.length);
  }));

test("monthly recurrence preserves the day anchor through February and cannot duplicate its next occurrence", () =>
  fixture(async ({ vault }) => {
    const task = await mutate(
      vault,
      item("task", {
        date: "2027-01-31",
        recurrence: "monthly",
        status: "pending",
      }),
    );
    const op = randomUUID();
    await mutate(vault, { ...task, status: "done" }, op);
    await mutate(vault, { ...task, status: "done" }, op);
    let next = (await vault.snapshot()).items.filter(
      (i) => i.kind === "task" && i.date === "2027-02-28",
    );
    assert.equal(next.length, 1);
    await mutate(vault, { ...next[0], status: "done" });
    assert.equal(
      (await vault.snapshot()).items.filter(
        (i) => i.kind === "task" && i.date === "2027-03-31",
      ).length,
      1,
    );
  }));
