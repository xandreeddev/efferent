import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE conversations (
      id          uuid PRIMARY KEY,
      created_at  bigint NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE messages (
      id               uuid PRIMARY KEY,
      conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      position         integer NOT NULL,
      role             text NOT NULL,
      content          jsonb NOT NULL,
      created_at       bigint NOT NULL,
      UNIQUE (conversation_id, position)
    )
  `
  yield* sql`CREATE INDEX messages_conversation_position_idx ON messages (conversation_id, position)`
})
