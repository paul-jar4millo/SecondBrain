import { describe, it, expect, vi } from "vitest";
vi.stubGlobal("localStorage", { getItem: () => null });
import {
  newItem,
  parseAmount,
  balance,
  expenses,
  nextOccurrence,
  shiftDay,
  eventInZone,
} from "../src/core/model";
import { parseCSV, csvItems } from "../src/lib/csv";
describe("financial calculations", () => {
  it("parses exact minor units and refuses unsafe/ambiguous input", () => {
    expect(parseAmount("120.05")).toBe(12005);
    expect(parseAmount("0.01")).toBe(1);
    for (const input of ["-1", "1.001", "NaN", "1e5", "12,50", "0"])
      expect(() => parseAmount(input)).toThrow();
  });
  it("does not count a card payment twice or MSI quotas as new expenses", () => {
    const asset = newItem("account", { accountType: "asset" });
    const card = newItem("account", { accountType: "credit" });
    const items = [
      asset,
      card,
      newItem("transaction", {
        transactionType: "opening",
        accountId: asset.id,
        amountMinor: 100000,
        status: "confirmed",
        date: "2026-11-06",
      }),
      newItem("transaction", {
        transactionType: "expense",
        accountId: card.id,
        amountMinor: 12000,
        installments: 12,
        status: "confirmed",
        date: "2026-11-06",
      }),
      newItem("transaction", {
        transactionType: "payment",
        accountId: asset.id,
        otherAccountId: card.id,
        amountMinor: 12000,
        status: "confirmed",
        date: "2026-11-06",
      }),
    ];
    expect(balance(items, asset.id)).toBe(88000);
    expect(balance(items, card.id)).toBe(0);
    expect(expenses(items, "2026-11")).toBe(12000);
  });
  it("handles credit balances, pending items and refunds", () => {
    const card = newItem("account", { accountType: "credit" });
    const items = [
      card,
      newItem("transaction", {
        transactionType: "opening_debt",
        accountId: card.id,
        amountMinor: 5000,
        date: "2026-11-06",
      }),
      newItem("transaction", {
        transactionType: "refund",
        accountId: card.id,
        amountMinor: 7000,
        date: "2026-11-06",
      }),
      newItem("transaction", {
        transactionType: "expense",
        accountId: card.id,
        amountMinor: 1000,
        status: "pending",
        date: "2026-11-06",
      }),
    ];
    expect(balance(items, card.id)).toBe(2000);
    expect(expenses(items, "2026-11")).toBe(-7000);
  });
});
describe("dates", () => {
  it("keeps monthly anchor through a short month", () => {
    expect(nextOccurrence("2027-01-31", "monthly", 31)).toBe("2027-02-28");
    expect(nextOccurrence("2027-02-28", "monthly", 31)).toBe("2027-03-31");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("displays timed events in the viewer zone while preserving all-day dates", () => {
    const event = newItem("event", {
      date: "2026-11-07",
      time: "01:00",
      startsAt: "2026-11-07T01:00:00Z",
      endsAt: "2026-11-07T02:00:00Z",
      timezone: "UTC",
    });
    expect(eventInZone(event).date).toBe("2026-11-06");
    expect(eventInZone(event).time).toBe("19:00");
    const allDay = newItem("event", {
      date: "2026-11-07",
      endDate: "2026-11-08",
    });
    expect(eventInZone(allDay)).toEqual(allDay);
  });
});
describe("CSV import", () => {
  it("reads escaped delimiters, quotes and multiline values", () => {
    expect(
      parseCSV(
        'date,title,amount\r\n2026-11-06,"Un café, y \"\"otro\"\"",12.50',
      ),
    ).toEqual([
      ["date", "title", "amount"],
      ["2026-11-06", 'Un café, y "otro"', "12.50"],
    ]);
    expect(
      parseCSV('date;title;amount\n2026-11-06;"línea 1\nlínea 2";1,20')[1][1],
    ).toBe("línea 1\nlínea 2");
    expect(() => parseCSV('a,b\n"oops,1')).toThrow();
  });
  it("maps explicit date/decimal formats and deterministic source identities", async () => {
    const account = newItem("account", { title: "Débito" });
    const rows = parseCSV("fecha;concepto;importe\n06/11/2026;Café;1.234,56");
    const map = {
      date: 0,
      title: 1,
      amount: 2,
      account: -1,
      type: -1,
      category: -1,
      otherAccount: -1,
      defaultAccount: account.id,
      defaultType: "expense",
      dateFormat: "DMY",
      decimal: ",",
    };
    const a = await csvItems(rows, map, [account]);
    const b = await csvItems(rows, map, [account]);
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].amountMinor).toBe(123456);
    expect(a[0].date).toBe("2026-11-06");
  });
  it("refuses negative amounts and invalid dates instead of guessing", async () => {
    const account = newItem("account");
    const map = {
      date: 0,
      title: 1,
      amount: 2,
      account: -1,
      type: -1,
      category: -1,
      otherAccount: -1,
      defaultAccount: account.id,
      defaultType: "expense",
      dateFormat: "ISO",
      decimal: ".",
    };
    await expect(
      csvItems(
        [
          ["d", "t", "a"],
          ["2026-02-30", "Café", "12"],
        ],
        map,
        [account],
      ),
    ).rejects.toThrow();
    await expect(
      csvItems(
        [
          ["d", "t", "a"],
          ["2026-11-06", "Café", "-12"],
        ],
        map,
        [account],
      ),
    ).rejects.toThrow();
  });
});

describe("portable Markdown", () => {
  it("preserves imported frontmatter without duplicating or changing unknown fields", async () => {
    const { noteMarkdown } = await import("../src/lib/export");
    const raw =
      "---\ntitle: Original\ncustom_field: preserve-me\nverified: 2026-10-01\n---\n\nTexto original.";
    expect(
      noteMarkdown(newItem("note", { title: "Original", body: raw })),
    ).toBe(raw);
    const fresh = noteMarkdown(
      newItem("note", { title: "Nueva", body: "Una idea" }),
    );
    expect(fresh).toContain('title: "Nueva"');
    expect(fresh).toContain("Una idea");
  });
});

it("does not crash on malformed external dates or display invalid money as a real balance", async () => {
  const { dateLabel, money } = await import("../src/core/model");
  expect(dateLabel("{{date}}")).toBe("Fecha por revisar");
  expect(dateLabel("2026-02-30")).toBe("Fecha por revisar");
  expect(money(Number.NaN)).toBe("Importe por revisar");
});
