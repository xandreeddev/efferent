import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE captures (
      id          uuid PRIMARY KEY,
      title       text NOT NULL,
      body        text NOT NULL,
      source      text,
      created_at  bigint NOT NULL
    )
  `
  yield* sql`CREATE INDEX captures_created_at_idx ON captures (created_at DESC)`
})
