import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Staleness stamp for context-tree nodes (Postgres dialect) — see the SQLite
 * `0003_workspace_ref` twin. The workspace git ref (HEAD) recorded when a
 * node's run finishes; null on non-git workspaces.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE context_nodes ADD COLUMN workspace_ref TEXT`
})
