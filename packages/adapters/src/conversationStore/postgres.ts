import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"

import {
  ConversationId,
  AgentMessage,
  ConversationNotFound,
  ConversationStore,
  ConversationStoreError,
  Checkpoint,
} from "@agent/core"

const wrapSql = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
  message: string,
) =>
  effect.pipe(
    Effect.mapError((cause) => new ConversationStoreError({ cause, message })),
  )

interface MessageRow {
  readonly role: string
  readonly content: unknown
}

const decodeMessage = (row: MessageRow) => {
  // `role` is denormalised into its own column for query convenience, but
  // the actual message payload lives in `content` (jsonb). Reassemble before
  // decoding through the schema union.
  const raw =
    row.content !== null && typeof row.content === "object"
      ? { role: row.role, ...(row.content as Record<string, unknown>) }
      : row.content
  return Schema.decodeUnknown(AgentMessage)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ConversationStoreError({
          cause,
          message: "Message row failed schema validation",
        }),
    ),
  )
}

const encodeMessageContent = (msg: AgentMessage): string => {
  // Store role in its own column; everything else goes in jsonb.
  const { role: _role, ...rest } = msg as Record<string, unknown>
  return JSON.stringify(rest)
}

export const PostgresConversationStoreLive = Layer.effect(
  ConversationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const store = ConversationStore.of({
      create: (workspaceDir) =>
        Effect.gen(function* () {
          const id = crypto.randomUUID()
          const createdAt = Date.now()
          yield* wrapSql(
            sql`INSERT INTO conversations (id, created_at, workspace_dir) VALUES (${id}::uuid, ${createdAt}, ${workspaceDir ?? null})`,
            "Failed to create conversation",
          )
          return yield* Schema.decodeUnknown(ConversationId)(id).pipe(
            Effect.mapError(
              (cause) =>
                new ConversationStoreError({
                  cause,
                  message: "Generated id failed ConversationId schema",
                }),
            ),
          )
        }),

      ensure: (id, workspaceDir) =>
        wrapSql(
          sql`
            INSERT INTO conversations (id, created_at, workspace_dir)
            VALUES (${id}::uuid, ${Date.now()}, ${workspaceDir ?? null})
            ON CONFLICT (id) DO UPDATE SET workspace_dir = COALESCE(conversations.workspace_dir, EXCLUDED.workspace_dir)
          `,
          "Failed to ensure conversation",
        ).pipe(Effect.asVoid),

      append: (conversationId, msg) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ readonly id: string }>`SELECT id::text FROM conversations WHERE id = ${conversationId}::uuid`,
            "Failed to look up conversation",
          )
          if (rows.length === 0) {
            return yield* Effect.fail(
              new ConversationNotFound({ id: conversationId }),
            )
          }
          const messageId = crypto.randomUUID()
          const createdAt = Date.now()
          const contentJson = encodeMessageContent(msg)
          yield* wrapSql(
            sql`
              INSERT INTO messages (id, conversation_id, position, role, content, created_at)
              VALUES (
                ${messageId}::uuid,
                ${conversationId}::uuid,
                COALESCE(
                  (SELECT MAX(position) + 1 FROM messages WHERE conversation_id = ${conversationId}::uuid),
                  0
                ),
                ${msg.role},
                ${contentJson}::jsonb,
                ${createdAt}
              )
            `,
            "Failed to append message",
          )
        }),

      list: (conversationId) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<MessageRow>`
              SELECT role, content
              FROM messages
              WHERE conversation_id = ${conversationId}::uuid
              ORDER BY position ASC
            `,
            "Failed to list messages",
          )
          return yield* Effect.forEach(rows, decodeMessage)
        }),

      checkpoint: (conversationId, summary) =>
        wrapSql(
          // Fold at the current head: COALESCE(MAX(position), -1) is computed
          // and inserted in one statement, so the fold point is exactly
          // "everything that exists right now" — no separate read/write race.
          sql`
            INSERT INTO checkpoints (id, conversation_id, message_position, summary, created_at)
            SELECT ${crypto.randomUUID()}::uuid, ${conversationId}::uuid,
                   COALESCE(MAX(position), -1), ${summary}, ${Date.now()}
            FROM messages WHERE conversation_id = ${conversationId}::uuid
          `,
          "Failed to create checkpoint",
        ).pipe(Effect.asVoid),

      getLatestCheckpoint: (conversationId) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ id: string; conversation_id: string; message_position: number; summary: string; created_at: string }>`
              SELECT id::text, conversation_id::text, message_position, summary, created_at
              FROM checkpoints
              WHERE conversation_id = ${conversationId}::uuid
              ORDER BY created_at DESC
              LIMIT 1
            `,
            "Failed to get latest checkpoint",
          )
          if (rows.length === 0) return undefined
          const r = rows[0]!
          return {
            id: r.id,
            conversationId: conversationId,
            messagePosition: r.message_position,
            summary: r.summary,
            createdAt: Number(r.created_at),
          } satisfies Checkpoint
        }),

      listCheckpoints: (conversationId) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ id: string; conversation_id: string; message_position: number; summary: string; created_at: string }>`
              SELECT id::text, conversation_id::text, message_position, summary, created_at
              FROM checkpoints
              WHERE conversation_id = ${conversationId}::uuid
              ORDER BY message_position ASC
            `,
            "Failed to list checkpoints",
          )
          const results = []
          for (const r of rows) {
            results.push({
              id: r.id,
              conversationId: conversationId,
              messagePosition: r.message_position,
              summary: r.summary,
              createdAt: Number(r.created_at),
            } satisfies Checkpoint)
          }
          return results
        }),

      // Real rows the agent loads: everything after the latest checkpoint's
      // fold point (or all rows if none). The handoff summary itself is NOT
      // prepended here — `runAgent` does that in core (no domain logic in the
      // adapter). `list` remains the full, browsable record.
      listActive: (conversationId) =>
        Effect.gen(function* () {
          const checkpoint = yield* store.getLatestCheckpoint(conversationId)
          if (!checkpoint) {
            return yield* store.list(conversationId)
          }
          const rows = yield* wrapSql(
            sql<MessageRow>`
              SELECT role, content
              FROM messages
              WHERE conversation_id = ${conversationId}::uuid AND position > ${checkpoint.messagePosition}
              ORDER BY position ASC
            `,
            "Failed to list active messages",
          )
          return yield* Effect.forEach(rows, decodeMessage)
        }),

      listByWorkspace: (workspaceDir) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ readonly id: string; readonly created_at: string; readonly first_prompt: string | null }>`
              SELECT 
                c.id::text, 
                c.created_at,
                (SELECT content->>'content' 
                 FROM messages 
                 WHERE conversation_id = c.id AND role = 'user' 
                 ORDER BY position ASC LIMIT 1) as first_prompt
              FROM conversations c
              WHERE c.workspace_dir = ${workspaceDir}
              ORDER BY c.created_at DESC
            `,
            "Failed to list conversations by workspace",
          )
          const results: { id: ConversationId; createdAt: number; firstPrompt?: string }[] = []
          for (const r of rows) {
            const id = yield* Schema.decodeUnknown(ConversationId)(r.id).pipe(
              Effect.mapError(
                (cause) =>
                  new ConversationStoreError({
                    cause,
                    message: "Failed to decode conversation UUID",
                  }),
              ),
            )
            results.push({
              id,
              createdAt: Number(r.created_at),
              ...(r.first_prompt !== null ? { firstPrompt: r.first_prompt } : {}),
            })
          }
          return results
        }),
    })

    return store
  }),
)
