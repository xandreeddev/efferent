import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * The persistent, branching agent-context tree (Postgres dialect). A dedicated
 * pair of tables — intentionally parallel to `conversations`/`messages`, but a
 * separate store: each node is one scoped sub-agent run with a `parent_id` edge
 * and its own `context_messages`. `root_conversation_id` is a loose reference
 * (no FK) so the two stores stay decoupled.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE context_nodes (
      id                   uuid PRIMARY KEY,
      parent_id            uuid REFERENCES context_nodes(id) ON DELETE CASCADE,
      root_conversation_id uuid,
      edge_kind            text NOT NULL,
      folder               text NOT NULL,
      display_root         text NOT NULL,
      seed                 jsonb NOT NULL,
      status               text NOT NULL,
      return_summary       text,
      files_changed        jsonb NOT NULL DEFAULT '[]'::jsonb,
      usage                jsonb,
      created_at           bigint NOT NULL,
      ended_at             bigint
    )
  `
  yield* sql`
    CREATE INDEX context_nodes_root_idx ON context_nodes (root_conversation_id, created_at)
  `
  yield* sql`
    CREATE TABLE context_messages (
      id          uuid PRIMARY KEY,
      node_id     uuid NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
      position    integer NOT NULL,
      role        text NOT NULL,
      content     jsonb NOT NULL,
      created_at  bigint NOT NULL,
      UNIQUE (node_id, position)
    )
  `
  yield* sql`
    CREATE INDEX context_messages_node_position_idx ON context_messages (node_id, position)
  `
})
