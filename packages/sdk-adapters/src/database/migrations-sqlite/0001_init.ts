import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * SQLite schema (the zero-config default store). A single init migration with
 * the final shape — a fresh on-disk db has no legacy rows to evolve, so the
 * Postgres history (5 migrations incl. a dev-data truncate) collapses here.
 *
 * Dialect vs Postgres: uuid → TEXT (ids are app-generated UUID strings),
 * jsonb → TEXT (content is a JSON string; read back with JSON.parse or
 * `json_extract`), bigint → INTEGER. The orphaned `captures` table is dropped.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE conversations (
      id            TEXT PRIMARY KEY,
      created_at    INTEGER NOT NULL,
      workspace_dir TEXT
    )
  `
  yield* sql`
    CREATE TABLE messages (
      id               TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      position         INTEGER NOT NULL,
      role             TEXT NOT NULL,
      content          TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      UNIQUE (conversation_id, position)
    )
  `
  yield* sql`CREATE INDEX messages_conversation_position_idx ON messages (conversation_id, position)`
  yield* sql`
    CREATE TABLE checkpoints (
      id               TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_position INTEGER NOT NULL,
      summary          TEXT NOT NULL,
      created_at       INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX checkpoints_conversation_idx ON checkpoints (conversation_id, created_at DESC)`
})
