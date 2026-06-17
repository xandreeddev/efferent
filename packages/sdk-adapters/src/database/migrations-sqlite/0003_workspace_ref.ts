import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Staleness stamp for context-tree nodes (SQLite dialect): the workspace git
 * ref (HEAD) recorded when a node's run finishes. On resume/branch, a moved
 * HEAD means the node's context describes an older world — the spawner injects
 * a staleness brief and the `:tree` view shows a `stale` badge. Nullable:
 * non-git workspaces simply never stamp.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE context_nodes ADD COLUMN workspace_ref TEXT`
})
