import { afterEach, expect, it, vi } from "vitest";
import { backupAlert, fetchBackupAlert } from "../src/core/maintenance";

const health = (backup: unknown) => ({
  status: "ready",
  maintenance: { status: "degraded", backup },
});

afterEach(() => vi.unstubAllGlobals());

it("reports failed, stale and unreadable backups with the last good one", () => {
  const lastSuccess = "2026-11-19T01:34:08.941Z";
  expect(backupAlert(health({ status: "failed", lastSuccess }))).toEqual({
    status: "failed",
    lastSuccess,
  });
  expect(backupAlert(health({ status: "stale", lastSuccess }))).toEqual({
    status: "stale",
    lastSuccess,
  });
  expect(backupAlert(health({ status: "invalid", lastSuccess: null }))).toEqual(
    { status: "invalid", lastSuccess: null },
  );
});

it("stays quiet when the backup is fine, never configured or unknown", () => {
  expect(backupAlert(health({ status: "ok", lastSuccess: null }))).toBeNull();
  expect(backupAlert(health({ status: "never" }))).toBeNull();
  expect(backupAlert(health({ status: "<b>x</b>" }))).toBeNull();
  expect(backupAlert({ status: "ready" })).toBeNull();
  expect(backupAlert(null)).toBeNull();
  expect(backupAlert("texto")).toBeNull();
});

it("drops a last-success value that is not a date", () => {
  expect(
    backupAlert(health({ status: "failed", lastSuccess: "ayer" })),
  ).toEqual({ status: "failed", lastSuccess: null });
});

it("reads the alert from a 503 health response and never throws", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(health({ status: "failed", lastSuccess: null }), {
        status: 503,
      }),
    ),
  );
  expect(await fetchBackupAlert()).toEqual({
    status: "failed",
    lastSuccess: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  expect(await fetchBackupAlert()).toBeNull();
});
