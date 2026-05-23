import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"

import {
  ConversationId,
  ConversationMessage,
  ConversationNotFound,
  ConversationStore,
  ConversationStoreError,
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
  return Schema.decodeUnknown(ConversationMessage)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ConversationStoreError({
          cause,
          message: "Message row failed schema validation",
        }),
    ),
  )
}

const encodeMessageContent = (msg: ConversationMessage): string => {
  // Store role in its own column; everything else goes in jsonb.
  const { role: _role, ...rest } = msg as Record<string, unknown>
  return JSON.stringify(rest)
}

export const PostgresConversationStoreLive = Layer.effect(
  ConversationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return ConversationStore.of({
      create: () =>
        Effect.gen(function* () {
          const id = crypto.randomUUID()
          const createdAt = Date.now()
          yield* wrapSql(
            sql`INSERT INTO conversations (id, created_at) VALUES (${id}::uuid, ${createdAt})`,
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

      append: (conversationId, msg) =>
        Effect.gen(function* () {
          // Verify the conversation exists so we return a typed NotFound
          // rather than a foreign-key violation buried in the cause.
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
    })
  }),
)
