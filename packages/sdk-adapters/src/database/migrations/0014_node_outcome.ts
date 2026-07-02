import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Honest outcome vocabulary (Postgres dialect): `context_nodes.status` widens to
 * running | ok | partial | error | killed (text — no constraint change needed),
 * and the new nullable `stop_reason` column persists the typed StopReason JSON
 * (WHY the run ended: budget / step-cap / stall / interrupt / provider / error).
 * Old rows keep their statuses and a NULL stop_reason — both decode fine.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE context_nodes ADD COLUMN stop_reason text`
})
