import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Layer, Option } from "effect"
import {
  Checkpoint,
  ConversationId,
  ConversationStore,
  ConversationSummary,
  StoreError,
} from "@xandreed/engine"
import type { AgentMessage } from "@xandreed/engine"

/**
 * The new line's conversation store: zero-config SQLite (bun:sqlite). Its own
 * database file — never the frozen line's `efferent.db` (different schema,
 * different lifecycle). Positions are assigned atomically in one INSERT
 * (`COALESCE(MAX(position)+1, 0)`), the durable identity contract.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  workspace_dir TEXT,
  title TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  conversation_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, position)
);
CREATE TABLE IF NOT EXISTS checkpoints (
  conversation_id TEXT NOT NULL,
  message_position INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

const tryDb = <A>(run: () => A): Effect.Effect<A, StoreError> =>
  Effect.try({
    try: run,
    catch: (e) => new StoreError({ message: String(e) }),
  })

export const SqliteConversationStoreLive = (dbPath: string) =>
  Layer.scoped(
    ConversationStore,
    Effect.gen(function* () {
      const db = yield* tryDb(() => {
        mkdirSync(dirname(dbPath), { recursive: true })
        const database = new Database(dbPath, { create: true })
        database.exec("PRAGMA journal_mode = WAL;")
        database.exec(SCHEMA)
        return database
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

      const latestCheckpointRow = (
        id: ConversationId,
      ): Option.Option<{ message_position: number; summary: string; created_at: number }> =>
        Option.fromNullable(
          db
            .query(
              `SELECT message_position, summary, created_at FROM checkpoints
               WHERE conversation_id = ? ORDER BY message_position DESC LIMIT 1`,
            )
            .get(id) as
            | { message_position: number; summary: string; created_at: number }
            | null,
        )

      return {
        create: (workspaceDir?: string) =>
          tryDb(() => {
            const id = ConversationId.make(crypto.randomUUID())
            db.query(
              `INSERT INTO conversations (id, workspace_dir, title, created_at) VALUES (?, ?, NULL, ?)`,
            ).run(id, workspaceDir ?? null, Date.now())
            return id
          }),

        append: (id: ConversationId, message: AgentMessage) =>
          tryDb(
            () =>
              (
                db
                  .query(
                    `INSERT INTO messages (conversation_id, position, content, created_at)
                     SELECT ?1, COALESCE(MAX(position) + 1, 0), ?2, ?3
                     FROM messages WHERE conversation_id = ?1
                     RETURNING position`,
                  )
                  .get(id, JSON.stringify(message), Date.now()) as { position: number }
              ).position,
          ),

        list: (id: ConversationId) =>
          tryDb(() =>
            (
              db
                .query(
                  `SELECT content FROM messages WHERE conversation_id = ? ORDER BY position ASC`,
                )
                .all(id) as ReadonlyArray<{ content: string }>
            ).map((row) => JSON.parse(row.content) as AgentMessage),
          ),

        listActive: (id: ConversationId) =>
          tryDb(() => {
            const fold = latestCheckpointRow(id)
            const after = Option.match(fold, {
              onNone: () => -1,
              onSome: (c) => c.message_position,
            })
            return (
              db
                .query(
                  `SELECT content FROM messages
                   WHERE conversation_id = ? AND position > ? ORDER BY position ASC`,
                )
                .all(id, after) as ReadonlyArray<{ content: string }>
            ).map((row) => JSON.parse(row.content) as AgentMessage)
          }),

        checkpoint: (id: ConversationId, summary: string) =>
          tryDb(() => {
            db.query(
              `INSERT INTO checkpoints (conversation_id, message_position, summary, created_at)
               SELECT ?1, COALESCE(MAX(position), -1), ?2, ?3
               FROM messages WHERE conversation_id = ?1`,
            ).run(id, summary, Date.now())
          }),

        latestCheckpoint: (id: ConversationId) =>
          tryDb(() =>
            Option.map(
              latestCheckpointRow(id),
              (row) =>
                new Checkpoint({
                  conversationId: id,
                  messagePosition: row.message_position,
                  summary: row.summary,
                  createdAt: row.created_at,
                }),
            ),
          ),

        setTitle: (id: ConversationId, title: string) =>
          tryDb(() => {
            db.query(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, id)
          }),

        listByWorkspace: (workspaceDir: string) =>
          tryDb(() =>
            (
              db
                .query(
                  `SELECT c.id, c.created_at, c.title,
                          (SELECT m.content FROM messages m
                           WHERE m.conversation_id = c.id ORDER BY m.position ASC LIMIT 1)
                            AS first_content
                   FROM conversations c WHERE c.workspace_dir = ?
                   ORDER BY c.created_at DESC`,
                )
                .all(workspaceDir) as ReadonlyArray<{
                id: string
                created_at: number
                title: string | null
                first_content: string | null
              }>
            ).map((row) => {
              const first = Option.fromNullable(row.first_content).pipe(
                Option.flatMap((content) => {
                  const parsed = JSON.parse(content) as AgentMessage
                  return parsed.role === "user"
                    ? Option.some(parsed.content.slice(0, 120))
                    : Option.none<string>()
                }),
              )
              return new ConversationSummary({
                id: ConversationId.make(row.id),
                createdAt: row.created_at,
                firstPrompt: first,
                title: Option.fromNullable(row.title),
              })
            }),
          ),
      }
    }),
  )
