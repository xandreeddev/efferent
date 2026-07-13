import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Either, Layer, Schema } from "effect"
import { UiPageEvent, UiPageStore } from "@xandreed/ui-agent"
import type { ConversationId } from "@xandreed/engine"

const decodeEvent = Schema.decodeUnknownEither(Schema.parseJson(UiPageEvent))

export const SqliteUiPageStoreLive = (dbPath: string) => Layer.scoped(
  UiPageStore,
  Effect.gen(function* () {
    const db = yield* Effect.try({
      try: () => {
        mkdirSync(dirname(dbPath), { recursive: true })
        const database = new Database(dbPath, { create: true })
        chmodSync(dbPath, 0o600)
        database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
        database.exec(`CREATE TABLE IF NOT EXISTS ui_page_events (
          conversation_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          page_id TEXT NOT NULL,
          event TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (conversation_id, position)
        ); CREATE INDEX IF NOT EXISTS ui_page_events_by_page ON ui_page_events(conversation_id, page_id, position);`)
        return database
      },
      catch: (error) => String(error),
    })
    yield* Effect.addFinalizer(() => Effect.try({
      try: () => db.close(),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) => Effect.logWarning(`UI page database cleanup failed: ${String(error)}`)),
    ))
    return {
      append: (conversationId: ConversationId, event: typeof UiPageEvent.Type) => Effect.try({
        try: () => {
          const pageId = event.type === "page_opened" ? event.page.id : event.pageId
          db.query(`INSERT INTO ui_page_events(conversation_id, position, page_id, event, created_at)
            SELECT ?1, COALESCE(MAX(position) + 1, 0), ?2, ?3, ?4 FROM ui_page_events WHERE conversation_id = ?1`).run(
            conversationId,
            pageId,
            JSON.stringify(event),
            event.at,
          )
        },
        catch: (error) => String(error),
      }),
      list: (conversationId: ConversationId) => Effect.try({
        try: () => db.query("SELECT event FROM ui_page_events WHERE conversation_id = ? ORDER BY position").all(conversationId) as ReadonlyArray<{ readonly event: string }>,
        catch: (error) => String(error),
      }).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => Either.match(decodeEvent(row.event), {
          onLeft: (issue) => Effect.logWarning(`skipping invalid UI event: ${String(issue)}`).pipe(Effect.as([])),
          onRight: (event) => Effect.succeed([event]),
        }))),
        Effect.map((events) => events.flat()),
      ),
    }
  }),
)
