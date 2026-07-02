import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * The mandatory swarm gate's audit trail (Postgres dialect): one row per gate
 * round, INCLUDING `unavailable` rounds with the verifier's error text — so a
 * flaky verifier can never again degrade to a silent, untraceable bypass.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE IF NOT EXISTS gate_verdicts (
      id              uuid PRIMARY KEY,
      conversation_id uuid NOT NULL,
      attempt         integer NOT NULL,
      verdict         text NOT NULL,
      reasons         jsonb NOT NULL,
      files_changed   jsonb NOT NULL,
      advisory        boolean NOT NULL DEFAULT false,
      duration_ms     integer NOT NULL,
      error           text,
      created_at      bigint NOT NULL
    )
  `
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_gate_verdicts_conversation
      ON gate_verdicts (conversation_id, created_at)
  `
})
