import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * The persistent, branching agent-context tree (SQLite dialect — the
 * zero-config default store). Mirrors the Postgres `0006_context_tree`
 * migration: uuid → TEXT, jsonb → TEXT (JSON string), bigint → INTEGER. A
 * separate `0002` migration because the SQLite `0001_init` is already applied
 * on existing databases.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE context_nodes (
      id                   TEXT PRIMARY KEY,
      parent_id            TEXT REFERENCES context_nodes(id) ON DELETE CASCADE,
      root_conversation_id TEXT,
      edge_kind            TEXT NOT NULL,
      folder               TEXT NOT NULL,
      display_root         TEXT NOT NULL,
      seed                 TEXT NOT NULL,
      status               TEXT NOT NULL,
      return_summary       TEXT,
      files_changed        TEXT NOT NULL DEFAULT '[]',
      usage                TEXT,
      created_at           INTEGER NOT NULL,
      ended_at             INTEGER
    )
  `
  yield* sql`CREATE INDEX context_nodes_root_idx ON context_nodes (root_conversation_id, created_at)`
  yield* sql`
    CREATE TABLE context_messages (
      id          TEXT PRIMARY KEY,
      node_id     TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE (node_id, position)
    )
  `
  yield* sql`CREATE INDEX context_messages_node_position_idx ON context_messages (node_id, position)`
})
