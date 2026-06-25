import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"

import {
  AgentContextNode,
  AgentMessage,
  ContextNodeId,
  ContextNodeNotFound,
  ContextTreeStore,
  ContextTreeStoreError,
} from "@xandreed/sdk-core"
import {
  encodeMessageContent,
  parseJsonColumn,
  reassembleMessageRow,
} from "../database/messageCodec.js"

/**
 * Postgres ContextTreeStore — the opt-in backend. Structurally identical to the
 * SQLite store but in Postgres dialect: `::uuid` on id bindings, `::jsonb` on
 * JSON values, `::text` on uuid columns in SELECTs (so decoding gets strings).
 */

const wrapSql = <A, R>(effect: Effect.Effect<A, unknown, R>, message: string) =>
  effect.pipe(
    Effect.mapError((cause) => new ContextTreeStoreError({ cause, message })),
  )

interface MessageRow {
  readonly role: string
  readonly content: unknown
}

interface NodeRow {
  readonly id: string
  readonly parent_id: string | null
  readonly kind: string | null
  readonly root_conversation_id: string | null
  readonly edge_kind: string
  readonly folder: string
  readonly display_root: string
  readonly title: string | null
  readonly seed: unknown
  readonly status: string
  readonly return_summary: string | null
  readonly files_changed: unknown
  readonly usage: unknown
  readonly workspace_ref: string | null
  readonly seed_message_count: number | string | null
  readonly created_at: string
  readonly ended_at: string | null
}

const decodeMessage = (row: MessageRow) =>
  Schema.decodeUnknown(AgentMessage)(
    reassembleMessageRow(row.role, row.content),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ContextTreeStoreError({
          cause,
          message: "Context message row failed schema validation",
        }),
    ),
  )

const decodeNode = (row: NodeRow) => {
  const raw = {
    id: row.id,
    parentId: row.parent_id,
    ...(row.kind !== null && row.kind !== undefined ? { kind: row.kind } : {}),
    rootConversationId: row.root_conversation_id,
    edgeKind: row.edge_kind,
    folder: row.folder,
    displayRoot: row.display_root,
    ...(row.title !== null && row.title !== undefined ? { title: row.title } : {}),
    seed: parseJsonColumn(row.seed),
    status: row.status,
    filesChanged: parseJsonColumn(row.files_changed),
    ...(row.return_summary !== null ? { returnSummary: row.return_summary } : {}),
    ...(row.usage !== null && row.usage !== undefined
      ? { usage: parseJsonColumn(row.usage) }
      : {}),
    ...(row.workspace_ref !== null && row.workspace_ref !== undefined
      ? { workspaceRef: row.workspace_ref }
      : {}),
    ...(row.seed_message_count !== null && row.seed_message_count !== undefined
      ? { seedMessageCount: Number(row.seed_message_count) }
      : {}),
    createdAt: Number(row.created_at),
    ...(row.ended_at !== null && row.ended_at !== undefined
      ? { endedAt: Number(row.ended_at) }
      : {}),
  }
  return Schema.decodeUnknown(AgentContextNode)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ContextTreeStoreError({
          cause,
          message: "Context node row failed schema validation",
        }),
    ),
  )
}

const SELECT_NODE = (sql: SqlClient.SqlClient) => sql`
  SELECT id::text, parent_id::text, kind, root_conversation_id::text, edge_kind, folder,
         display_root, title, seed, status, return_summary, files_changed, usage, workspace_ref,
         seed_message_count, created_at, ended_at
`

export const PostgresContextTreeStoreLive = Layer.effect(
  ContextTreeStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const decodeNodeId = (raw: string) =>
      Schema.decodeUnknown(ContextNodeId)(raw).pipe(
        Effect.mapError(
          (cause) =>
            new ContextTreeStoreError({
              cause,
              message: "Generated id failed ContextNodeId schema",
            }),
        ),
      )

    const requireNode = (id: ContextNodeId) =>
      Effect.gen(function* () {
        const rows = yield* wrapSql(
          sql<{ readonly id: string }>`SELECT id::text FROM context_nodes WHERE id = ${id}::uuid`,
          "Failed to look up context node",
        )
        if (rows.length === 0) {
          return yield* Effect.fail(new ContextNodeNotFound({ id }))
        }
      })

    const insertMessageAt = (
      nodeId: string,
      msg: AgentMessage,
      position: number,
    ) =>
      wrapSql(
        sql`
          INSERT INTO context_messages (id, node_id, position, role, content, created_at)
          VALUES (${crypto.randomUUID()}::uuid, ${nodeId}::uuid, ${position}, ${msg.role}, ${encodeMessageContent(msg)}::jsonb, ${Date.now()})
        `,
        "Failed to insert context message",
      )

    const store = ContextTreeStore.of({
      spawn: (input) =>
        Effect.gen(function* () {
          const id = crypto.randomUUID()
          const createdAt = Date.now()
          // SESSION → FLEET → AGENT: a parentless node is a top-level fleet
          // (task/coordinator), a child is a worker agent.
          const kind = input.parentId === null ? "fleet" : "agent"
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* wrapSql(
                  sql`
                    INSERT INTO context_nodes (
                      id, parent_id, kind, root_conversation_id, edge_kind, folder, display_root, title,
                      seed, status, return_summary, files_changed, usage, workspace_ref,
                      seed_message_count, created_at, ended_at
                    )
                    VALUES (
                      ${id}::uuid, ${input.parentId ?? null}::uuid, ${kind}, ${input.rootConversationId ?? null}::uuid,
                      ${input.edgeKind}, ${input.folder}, ${input.displayRoot}, ${input.title ?? null},
                      ${JSON.stringify(input.seed)}::jsonb, 'running', ${null}, '[]'::jsonb, ${null}::jsonb, ${null},
                      ${input.seedMessages.length}, ${createdAt}, ${null}
                    )
                  `,
                  "Failed to spawn context node",
                )
                for (let i = 0; i < input.seedMessages.length; i++) {
                  yield* insertMessageAt(id, input.seedMessages[i]!, i)
                }
                return yield* decodeNodeId(id)
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", (e) =>
                Effect.fail(new ContextTreeStoreError({ cause: e, message: "spawn transaction failed" })),
              ),
            )
        }),

      append: (id, msg) =>
        Effect.gen(function* () {
          yield* requireNode(id)
          yield* wrapSql(
            sql`
              INSERT INTO context_messages (id, node_id, position, role, content, created_at)
              VALUES (
                ${crypto.randomUUID()}::uuid, ${id}::uuid,
                COALESCE((SELECT MAX(position) + 1 FROM context_messages WHERE node_id = ${id}::uuid), 0),
                ${msg.role}, ${encodeMessageContent(msg)}::jsonb, ${Date.now()}
              )
            `,
            "Failed to append context message",
          )
        }),

      listMessages: (id) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<MessageRow>`
              SELECT role, content FROM context_messages
              WHERE node_id = ${id}::uuid ORDER BY position ASC
            `,
            "Failed to list context messages",
          )
          return yield* Effect.forEach(rows, decodeMessage)
        }),

      recordReturn: (id, result) =>
        Effect.gen(function* () {
          yield* requireNode(id)
          yield* wrapSql(
            sql`
              UPDATE context_nodes SET
                status = ${result.status},
                return_summary = ${result.summary},
                files_changed = ${JSON.stringify(result.filesChanged)}::jsonb,
                usage = ${result.usage !== undefined ? JSON.stringify(result.usage) : null}::jsonb,
                workspace_ref = ${result.workspaceRef ?? null},
                ended_at = ${Date.now()}
              WHERE id = ${id}::uuid
            `,
            "Failed to record context return",
          )
        }),

      get: (id) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<NodeRow>`${SELECT_NODE(sql)} FROM context_nodes WHERE id = ${id}::uuid`,
            "Failed to get context node",
          )
          if (rows.length === 0) {
            return yield* Effect.fail(new ContextNodeNotFound({ id }))
          }
          return yield* decodeNode(rows[0]!)
        }),

      listTree: (rootConversationId) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            rootConversationId === null
              ? sql<NodeRow>`${SELECT_NODE(sql)} FROM context_nodes WHERE root_conversation_id IS NULL ORDER BY created_at ASC`
              : sql<NodeRow>`${SELECT_NODE(sql)} FROM context_nodes WHERE root_conversation_id = ${rootConversationId}::uuid ORDER BY created_at ASC`,
            "Failed to list context tree",
          )
          return yield* Effect.forEach(rows, decodeNode)
        }),

      drop: (id) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* wrapSql(
                sql`
                  WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM context_nodes WHERE id = ${id}::uuid
                    UNION ALL
                    SELECT cn.id FROM context_nodes cn JOIN descendants d ON cn.parent_id = d.id
                  )
                  DELETE FROM context_messages WHERE node_id IN (SELECT id FROM descendants)
                `,
                "Failed to drop context messages",
              )
              yield* wrapSql(
                sql`
                  WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM context_nodes WHERE id = ${id}::uuid
                    UNION ALL
                    SELECT cn.id FROM context_nodes cn JOIN descendants d ON cn.parent_id = d.id
                  )
                  DELETE FROM context_nodes WHERE id IN (SELECT id FROM descendants)
                `,
                "Failed to drop context nodes",
              )
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (e) =>
              Effect.fail(new ContextTreeStoreError({ cause: e, message: "drop transaction failed" })),
            ),
          ),
    })

    return store
  }),
)
