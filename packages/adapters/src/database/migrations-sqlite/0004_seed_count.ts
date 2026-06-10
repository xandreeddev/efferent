import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Seed-boundary stamp for context-tree nodes (SQLite dialect): how many
 * `context_messages` were materialized at spawn (positions `0..n-1` = the
 * seed; the run's appended tail follows). Lets the TUI mark the seed/run
 * boundary when previewing a node's session. Nullable: rows created before
 * this column simply render without a boundary marker.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE context_nodes ADD COLUMN seed_message_count INTEGER`
})
