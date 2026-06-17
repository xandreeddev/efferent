import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE checkpoints (
      id               uuid PRIMARY KEY,
      conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_position integer NOT NULL,
      summary          text NOT NULL,
      created_at       bigint NOT NULL
    )
  `
  yield* sql`
    CREATE INDEX checkpoints_conversation_idx ON checkpoints (conversation_id, created_at DESC)
  `
})
