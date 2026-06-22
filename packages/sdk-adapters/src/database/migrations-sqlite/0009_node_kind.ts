import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Explicit node tier (SQLite dialect): make the SESSION → FLEET → AGENT model
 * queryable instead of implied by `parent_id`. A top-level node under a session
 * (`parent_id IS NULL`) is a `fleet` (a task / coordinator); a deeper worker is
 * an `agent`. Nullable + backfilled from `parent_id` so existing rows keep their
 * derived tier — `nodeKind` in core treats an absent value the same way.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE context_nodes ADD COLUMN kind TEXT`
  yield* sql`UPDATE context_nodes SET kind = CASE WHEN parent_id IS NULL THEN 'fleet' ELSE 'agent' END`
})
