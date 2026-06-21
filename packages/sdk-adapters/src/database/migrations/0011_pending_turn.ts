import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * In-flight turn marker (Postgres dialect): `send` sets `pending_prompt` to the
 * user prompt when a turn starts and clears it on completion. A restarted
 * daemon reads non-null markers to auto-resume a turn interrupted by a crash
 * (the daemon-split restorability path). Nullable: a session with no turn in
 * flight has NULL.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE conversations ADD COLUMN pending_prompt TEXT`
})
