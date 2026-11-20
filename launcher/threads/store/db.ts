// The only module that opens threads.sqlite (ADR 0009). One writer: the
// launcher process. Every other module goes through the store API.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

/** Runs fn inside BEGIN IMMEDIATE … COMMIT; rolls back on any error. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Consistent online copy for the nightly backup. */
export function backupTo(db: Db, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  db.prepare("VACUUM INTO ?").run(file);
}

export const json = (value: unknown): string => JSON.stringify(value);
export const parseJson = <T>(text: unknown): T => JSON.parse(String(text)) as T;
