import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"

import {
  ConversationId,
  AgentMessage,
  ConversationNotFound,
  ConversationStore,
  ConversationStoreError,
  Checkpoint,
} from "@xandreed/sdk-core"
import {
  encodeMessageContent,
  reassembleMessageRow,
} from "../database/messageCodec.js"

/**
 * SQLite ConversationStore — the zero-config default (bun:sqlite via
 * `@effect/sql-sqlite-bun`). Structurally identical to the Postgres store
 * but in SQLite dialect: no `::uuid`/`::text`/`::jsonb` casts (ids are TEXT,
 * content is a TEXT JSON string), and the browse preview uses `json_extract`
 * instead of the `->>` operator. Ids/timestamps are app-generated, so there
 * are no DB-side defaults to differ. Message (de)serialization is shared via
 * `../database/messageCodec`.
 */

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

const decodeMessage = (row: MessageRow) =>
  Schema.decodeUnknown(AgentMessage)(
    reassembleMessageRow(row.role, row.content),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ConversationStoreError({
          cause,
          message: "Message row failed schema validation",
        }),
    ),
  )

export const SqliteConversationStoreLive = Layer.effect(
  ConversationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const store = ConversationStore.of({
      create: (workspaceDir) =>
        Effect.gen(function* () {
          const id = crypto.randomUUID()
          const createdAt = Date.now()
          yield* wrapSql(
            sql`INSERT INTO conversations (id, created_at, workspace_dir) VALUES (${id}, ${createdAt}, ${workspaceDir ?? null})`,
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
            VALUES (${id}, ${Date.now()}, ${workspaceDir ?? null})
            ON CONFLICT (id) DO UPDATE SET workspace_dir = COALESCE(conversations.workspace_dir, EXCLUDED.workspace_dir)
          `,
          "Failed to ensure conversation",
        ).pipe(Effect.asVoid),

      append: (conversationId, msg) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ readonly id: string }>`SELECT id FROM conversations WHERE id = ${conversationId}`,
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
          const inserted = yield* wrapSql(
            sql<{ readonly position: number }>`
              INSERT INTO messages (id, conversation_id, position, role, content, created_at)
              VALUES (
                ${messageId},
                ${conversationId},
                COALESCE(
                  (SELECT MAX(position) + 1 FROM messages WHERE conversation_id = ${conversationId}),
                  0
                ),
                ${msg.role},
                ${contentJson},
                ${createdAt}
              )
              RETURNING position
            `,
            "Failed to append message",
          )
          return Number(inserted[0]?.position ?? 0)
        }),

      list: (conversationId) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<MessageRow>`
              SELECT role, content
              FROM messages
              WHERE conversation_id = ${conversationId}
              ORDER BY position ASC
            `,
            "Failed to list messages",
          )
          return yield* Effect.forEach(rows, decodeMessage)
        }),

      checkpoint: (conversationId, summary) =>
        wrapSql(
          // Fold at the current head: COALESCE(MAX(position), -1) is computed
          // and inserted in one statement — the fold point is exactly
          // "everything that exists right now", no read/write race.
          sql`
            INSERT INTO checkpoints (id, conversation_id, message_position, summary, created_at)
            SELECT ${crypto.randomUUID()}, ${conversationId},
                   COALESCE(MAX(position), -1), ${summary}, ${Date.now()}
            FROM messages WHERE conversation_id = ${conversationId}
          `,
          "Failed to create checkpoint",
        ).pipe(Effect.asVoid),

      getLatestCheckpoint: (conversationId) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ id: string; conversation_id: string; message_position: number; summary: string; created_at: number }>`
              SELECT id, conversation_id, message_position, summary, created_at
              FROM checkpoints
              WHERE conversation_id = ${conversationId}
              ORDER BY created_at DESC, message_position DESC
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
            sql<{ id: string; conversation_id: string; message_position: number; summary: string; created_at: number }>`
              SELECT id, conversation_id, message_position, summary, created_at
              FROM checkpoints
              WHERE conversation_id = ${conversationId}
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
      // fold point (or all rows if none). The handoff summary is prepended by
      // `runAgent` in core, not here.
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
              WHERE conversation_id = ${conversationId} AND position > ${checkpoint.messagePosition}
              ORDER BY position ASC
            `,
            "Failed to list active messages",
          )
          return yield* Effect.forEach(rows, decodeMessage)
        }),

      setTitle: (conversationId, title) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ readonly id: string }>`SELECT id FROM conversations WHERE id = ${conversationId}`,
            "Failed to look up conversation",
          )
          if (rows.length === 0) {
            return yield* Effect.fail(
              new ConversationNotFound({ id: conversationId }),
            )
          }
          yield* wrapSql(
            sql`UPDATE conversations SET title = ${title} WHERE id = ${conversationId}`,
            "Failed to set conversation title",
          )
        }),

      listByWorkspace: (workspaceDir) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ readonly id: string; readonly created_at: number; readonly title: string | null; readonly model: string | null; readonly first_prompt: string | null }>`
              SELECT
                c.id,
                c.created_at,
                c.title,
                c.model,
                (SELECT json_extract(content, '$.content')
                 FROM messages
                 WHERE conversation_id = c.id AND role = 'user'
                 ORDER BY position ASC LIMIT 1) as first_prompt
              FROM conversations c
              WHERE c.workspace_dir = ${workspaceDir}
              ORDER BY c.created_at DESC
            `,
            "Failed to list conversations by workspace",
          )
          const results: { id: ConversationId; createdAt: number; firstPrompt?: string; title?: string; model?: string }[] = []
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
              ...(r.title !== null ? { title: r.title } : {}),
              ...(r.model !== null ? { model: r.model } : {}),
            })
          }
          return results
        }),

      setModel: (conversationId, model) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ readonly id: string }>`SELECT id FROM conversations WHERE id = ${conversationId}`,
            "Failed to look up conversation",
          )
          if (rows.length === 0) {
            return yield* Effect.fail(new ConversationNotFound({ id: conversationId }))
          }
          yield* wrapSql(
            sql`UPDATE conversations SET model = ${model} WHERE id = ${conversationId}`,
            "Failed to set conversation model",
          )
        }),

      markPending: (conversationId, prompt) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ readonly id: string }>`SELECT id FROM conversations WHERE id = ${conversationId}`,
            "Failed to look up conversation",
          )
          if (rows.length === 0) {
            return yield* Effect.fail(new ConversationNotFound({ id: conversationId }))
          }
          yield* wrapSql(
            sql`UPDATE conversations SET pending_prompt = ${prompt} WHERE id = ${conversationId}`,
            "Failed to mark pending turn",
          )
        }),

      clearPending: (conversationId) =>
        wrapSql(
          sql`UPDATE conversations SET pending_prompt = NULL WHERE id = ${conversationId}`,
          "Failed to clear pending turn",
        ).pipe(Effect.asVoid),

      listPending: (workspaceDir) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{ readonly id: string; readonly pending_prompt: string | null }>`
              SELECT id, pending_prompt FROM conversations
              WHERE workspace_dir = ${workspaceDir} AND pending_prompt IS NOT NULL
              ORDER BY created_at DESC
            `,
            "Failed to list pending turns",
          )
          const results: { id: ConversationId; prompt: string }[] = []
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
            results.push({ id, prompt: r.pending_prompt ?? "" })
          }
          return results
        }),

      recordGateVerdict: (record) =>
        wrapSql(
          sql`
            INSERT INTO gate_verdicts (
              id, conversation_id, attempt, verdict, reasons, files_changed,
              advisory, duration_ms, error, created_at
            )
            VALUES (
              ${crypto.randomUUID()}, ${record.conversationId}, ${record.attempt},
              ${record.verdict}, ${JSON.stringify(record.reasons)},
              ${JSON.stringify(record.filesChanged)}, ${record.advisory ? 1 : 0},
              ${record.durationMs}, ${record.error ?? null}, ${Date.now()}
            )
          `,
          "Failed to record gate verdict",
        ).pipe(Effect.asVoid),

      listGateVerdicts: (id) =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<{
              readonly attempt: number
              readonly verdict: string
              readonly reasons: string
              readonly files_changed: string
              readonly advisory: number
              readonly duration_ms: number
              readonly error: string | null
              readonly created_at: number
            }>`
              SELECT attempt, verdict, reasons, files_changed, advisory, duration_ms, error, created_at
              FROM gate_verdicts WHERE conversation_id = ${id} ORDER BY created_at ASC
            `,
            "Failed to list gate verdicts",
          )
          return rows.map((r) => ({
            conversationId: id,
            attempt: Number(r.attempt),
            verdict: r.verdict as "sound" | "needs_work" | "blocked" | "unavailable",
            reasons: JSON.parse(r.reasons) as string[],
            filesChanged: JSON.parse(r.files_changed) as string[],
            advisory: r.advisory === 1,
            durationMs: Number(r.duration_ms),
            ...(r.error !== null ? { error: r.error } : {}),
            createdAt: Number(r.created_at),
          }))
        }),
    })

    return store
  }),
)
