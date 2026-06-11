import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Display name for context-tree nodes (Postgres dialect): the short name the
 * spawner gave the agent via run_agent's `name` parameter ("audit state
 * layer"), shown in the agents pane / rail / activity tree instead of the
 * folder basename — three agents in one folder are indistinguishable by
 * folder alone. Nullable: older rows fall back to the folder basename.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE context_nodes ADD COLUMN title TEXT`
})
