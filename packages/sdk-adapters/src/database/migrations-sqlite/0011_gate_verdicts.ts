import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * The mandatory swarm gate's audit trail (SQLite dialect): one row per gate
 * round, INCLUDING `unavailable` rounds with the verifier's error text — so a
 * flaky verifier can never again degrade to a silent, untraceable bypass.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE IF NOT EXISTS gate_verdicts (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      attempt         INTEGER NOT NULL,
      verdict         TEXT NOT NULL,
      reasons         TEXT NOT NULL,
      files_changed   TEXT NOT NULL,
      advisory        INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER NOT NULL,
      error           TEXT,
      created_at      INTEGER NOT NULL
    )
  `
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_gate_verdicts_conversation
      ON gate_verdicts (conversation_id, created_at)
  `
})
