import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * The `ConversationMessage` union was replaced with `AgentMessage` —
 * structurally identical to v6 `ModelMessage` (assistant content is
 * now an array of typed parts; tool messages carry `toolCallId` etc.).
 * Existing rows are in the old shape and will fail schema validation
 * on load, so we truncate. Dev DB; disposable.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`TRUNCATE messages, conversations CASCADE`
})
