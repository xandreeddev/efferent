import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Either, Layer, Option, Schema } from "effect"
import {
  AgentMessage,
  Checkpoint,
  ConversationId,
  ConversationStore,
  ConversationSummary,
  StoreError,
} from "@xandreed/engine"

/**
 * The new line's conversation store: zero-config SQLite (bun:sqlite). Its own
 * database file — never the frozen line's `efferent.db` (different schema,
 * different lifecycle). Positions are assigned atomically in one INSERT
 * (`COALESCE(MAX(position)+1, 0)`), the durable identity contract.
 *
 * Durability posture: `PRAGMA user_version` records how many MIGRATIONS have
 * run — schema growth is an append to that array, never an edit; reads DECODE
 * rows (an undecodable row is skipped with a warning — one bad row must not
 * brick a conversation); fork is one transaction; the file is owner-only
 * (conversations absorb whatever tool output the model saw).
 */

/** Ordered, append-only. Step 1 is idempotent (`IF NOT EXISTS`) because
 *  pre-versioning databases already carry the v1 schema at user_version 0. */
const MIGRATIONS: ReadonlyArray<string> = [
  `
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
  `,
  `
  CREATE INDEX IF NOT EXISTS checkpoints_by_conversation
    ON checkpoints (conversation_id, message_position);
  CREATE INDEX IF NOT EXISTS conversations_by_workspace
    ON conversations (workspace_dir);
  `,
]

const migrate = (db: Database): void => {
  const version = (db.query("PRAGMA user_version").get() as { user_version: number })
    .user_version
  MIGRATIONS.slice(version).forEach((step) => db.transaction(() => db.exec(step))())
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
}

/** Parse + validate in one step — reads never cast a blob into the entity. */
const decodeMessage = Schema.decodeUnknownEither(Schema.parseJson(AgentMessage))

const tryDb = <A>(run: () => A): Effect.Effect<A, StoreError> =>
  Effect.try({
    try: run,
    catch: (e) => new StoreError({ message: String(e) }),
  })

/** Schema drift or disk corruption in ONE row degrades to a logged skip —
 *  the rest of the conversation stays loadable. */
const salvageRows = (
  rows: ReadonlyArray<{ content: string }>,
  where: string,
): Effect.Effect<ReadonlyArray<AgentMessage>> =>
  Effect.forEach(rows, (row) =>
    Either.match(decodeMessage(row.content), {
      onLeft: (issue) =>
        Effect.logWarning(`${where}: skipping undecodable message row: ${String(issue)}`).pipe(
          Effect.as(Option.none<AgentMessage>()),
        ),
      onRight: (message) => Effect.succeed(Option.some(message)),
    }),
  ).pipe(Effect.map((decoded) => decoded.filter(Option.isSome).map((some) => some.value)))

export const SqliteConversationStoreLive = (dbPath: string) =>
  Layer.scoped(
    ConversationStore,
    Effect.gen(function* () {
      const db = yield* tryDb(() => {
        mkdirSync(dirname(dbPath), { recursive: true })
        const database = new Database(dbPath, { create: true })
        // Owner-only BEFORE the WAL sidecars exist (they inherit this mode):
        // tool output can carry anything the coder read, including secrets.
        chmodSync(dbPath, 0o600)
        database.exec("PRAGMA journal_mode = WAL;")
        // A second process on the same workspace db waits out the lock
        // instead of dying on an instant SQLITE_BUSY.
        database.exec("PRAGMA busy_timeout = 5000;")
        migrate(database)
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
          tryDb(
            () =>
              db
                .query(
                  `SELECT content FROM messages WHERE conversation_id = ? ORDER BY position ASC`,
                )
                .all(id) as ReadonlyArray<{ content: string }>,
          ).pipe(Effect.flatMap((rows) => salvageRows(rows, `list ${id}`))),

        listActive: (id: ConversationId) =>
          tryDb(() => {
            const fold = latestCheckpointRow(id)
            const after = Option.match(fold, {
              onNone: () => -1,
              onSome: (c) => c.message_position,
            })
            return db
              .query(
                `SELECT content FROM messages
                 WHERE conversation_id = ? AND position > ? ORDER BY position ASC`,
              )
              .all(id, after) as ReadonlyArray<{ content: string }>
          }).pipe(Effect.flatMap((rows) => salvageRows(rows, `listActive ${id}`))),

        checkpoint: (id: ConversationId, summary: string) =>
          tryDb(() => {
            db.query(
              `INSERT INTO checkpoints (conversation_id, message_position, summary, created_at)
               SELECT ?1, COALESCE(MAX(position), -1), ?2, ?3
               FROM messages WHERE conversation_id = ?1`,
            ).run(id, summary, Date.now())
          }),

        checkpointAt: (id: ConversationId, summary: string, messagePosition: number) =>
          tryDb(() => {
            db.query(
              `INSERT INTO checkpoints (conversation_id, message_position, summary, created_at)
               VALUES (?1, ?2, ?3, ?4)`,
            ).run(id, messagePosition, summary, Date.now())
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

        fork: (id: ConversationId, upToPosition?: number) =>
          tryDb(() =>
            Option.fromNullable(
              db
                .query(`SELECT workspace_dir, title FROM conversations WHERE id = ?`)
                .get(id) as { workspace_dir: string | null; title: string | null } | null,
            ),
          ).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new StoreError({ message: `conversation ${id} not found` })),
                onSome: (source) =>
                  tryDb(() => {
                    const forkId = ConversationId.make(crypto.randomUUID())
                    const cap = upToPosition ?? Number.MAX_SAFE_INTEGER
                    // One transaction: a crash mid-fork must not leave a
                    // conversation row with half a trail and no checkpoint.
                    db.transaction(() => {
                      db.query(
                        `INSERT INTO conversations (id, workspace_dir, title, created_at) VALUES (?, ?, ?, ?)`,
                      ).run(
                        forkId,
                        source.workspace_dir,
                        source.title === null ? null : `fork: ${source.title}`,
                        Date.now(),
                      )
                      db.query(
                        `INSERT INTO messages (conversation_id, position, content, created_at)
                         SELECT ?2, position, content, created_at FROM messages
                         WHERE conversation_id = ?1 AND position <= ?3`,
                      ).run(id, forkId, cap)
                      // The latest checkpoint WITHIN range rides along, so a
                      // forked long session loads its active window exactly
                      // like the source.
                      db.query(
                        `INSERT INTO checkpoints (conversation_id, message_position, summary, created_at)
                         SELECT ?2, message_position, summary, created_at FROM checkpoints
                         WHERE conversation_id = ?1 AND message_position <= ?3
                         ORDER BY message_position DESC LIMIT 1`,
                      ).run(id, forkId, cap)
                    })()
                    return forkId
                  }),
              }),
            ),
          ),

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
                Option.flatMap((content) => Either.getRight(decodeMessage(content))),
                Option.flatMap((parsed) =>
                  parsed.role === "user"
                    ? Option.some(parsed.content.slice(0, 120))
                    : Option.none<string>(),
                ),
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
