import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Seed-boundary stamp for context-tree nodes (Postgres dialect) — see the
 * SQLite `0004_seed_count` twin. How many `context_messages` were materialized
 * at spawn (positions `0..n-1` = the seed); null on pre-migration rows.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE context_nodes ADD COLUMN seed_message_count integer`
})
