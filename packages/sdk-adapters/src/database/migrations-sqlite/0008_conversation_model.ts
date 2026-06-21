import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Per-fleet pinned model (SQLite dialect): a conversation (= a fleet coordinator
 * in the control-plane model) pins its own `"<provider>:<modelId>"` so changing
 * the global default never retroactively touches a running fleet. Nullable: a
 * conversation with no pin falls back to the session/global model.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE conversations ADD COLUMN model TEXT`
})
