import { transaction, type Db } from "./db.ts";

/**
 * Schema versions, applied in order and tracked with PRAGMA user_version.
 * Never edit a released migration: append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: event log, projections and the inbox view.
  `
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    parent_id TEXT,
    last_seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX threads_status ON threads(status);
  CREATE INDEX threads_parent ON threads(parent_id);

  CREATE TABLE events (
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    global_seq INTEGER NOT NULL UNIQUE,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (thread_id, seq)
  ) WITHOUT ROWID;

  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    seq INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX items_thread ON items(thread_id, seq);

  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    stage_index INTEGER NOT NULL,
    agent TEXT NOT NULL,
    outcome TEXT,
    error TEXT,
    started_seq INTEGER NOT NULL,
    completed_seq INTEGER,
    started_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX turns_thread ON turns(thread_id, started_seq);

  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX requests_open ON requests(status, created_at);

  CREATE TABLE stages (
    thread_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (thread_id, idx)
  ) WITHOUT ROWID;

  CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    from_stage INTEGER NOT NULL,
    to_stage INTEGER NOT NULL,
    at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE usage_snapshots (
    id INTEGER PRIMARY KEY,
    engine TEXT NOT NULL,
    at TEXT NOT NULL,
    source TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX usage_engine ON usage_snapshots(engine, at);

  CREATE VIEW inbox_view AS
    SELECT r.thread_id AS thread_id,
           json_extract(t.data, '$.title') AS thread_title,
           'request' AS reason,
           r.id AS request_id,
           json_extract(r.data, '$.title') AS summary,
           r.created_at AS since
      FROM requests r JOIN threads t ON t.id = r.thread_id
     WHERE r.status = 'open' AND t.status <> 'archived'
    UNION ALL
    SELECT t.id, json_extract(t.data, '$.title'), t.status, NULL,
           json_extract(t.data, '$.title'), t.updated_at
      FROM threads t
     WHERE t.status IN ('needs-decision', 'ready-for-review', 'failed');
  `,
  // 2: operational side tables (not projections; never rebuilt from the log).
  `
  CREATE TABLE thread_meta (
    thread_id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE checkpoints (
    turn_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    before_tree TEXT,
    after_tree TEXT
  );
  CREATE INDEX checkpoints_thread ON checkpoints(thread_id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Applies pending migrations; running it again is a no-op. */
export function migrate(db: Db): number {
  const current = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  if (current > SCHEMA_VERSION)
    throw new Error(
      `threads.sqlite is at schema ${current}, newer than this launcher (${SCHEMA_VERSION}).`,
    );
  for (let version = current; version < SCHEMA_VERSION; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version] as string);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return SCHEMA_VERSION;
}
