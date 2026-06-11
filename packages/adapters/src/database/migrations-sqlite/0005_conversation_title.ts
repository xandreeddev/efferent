import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Generated session title (SQLite dialect): set by the TUI after a
 * conversation's first exchange (cheap utility-model call) and shown in the
 * sessions pane / startup picker instead of the raw first-prompt preview.
 * Nullable: untitled rows keep falling back to the preview.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE conversations ADD COLUMN title TEXT`
})
