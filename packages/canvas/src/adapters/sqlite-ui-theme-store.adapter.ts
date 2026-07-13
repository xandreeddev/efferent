import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Either, Layer, Schema } from "effect"
import { ThemeDefinition, UiThemeStore } from "@xandreed/ui-agent"
import type { ThemeDefinitionType } from "@xandreed/ui-agent"

const decodeTheme = Schema.decodeUnknownEither(Schema.parseJson(ThemeDefinition))

export const SqliteUiThemeStoreLive = (dbPath: string) => Layer.scoped(
  UiThemeStore,
  Effect.gen(function* () {
    const db = yield* Effect.try({
      try: () => {
        mkdirSync(dirname(dbPath), { recursive: true })
        const database = new Database(dbPath, { create: true })
        chmodSync(dbPath, 0o600)
        database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
        database.exec(`CREATE TABLE IF NOT EXISTS ui_themes (
          id TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          status TEXT NOT NULL,
          definition TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ); CREATE INDEX IF NOT EXISTS ui_themes_by_fingerprint ON ui_themes(fingerprint);`)
        return database
      },
      catch: (error) => String(error),
    })
    yield* Effect.addFinalizer(() => Effect.try({
      try: () => db.close(),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) => Effect.logWarning(`UI theme database cleanup failed: ${String(error)}`)),
    ))
    return {
      list: Effect.try({
        try: () => (db.query("SELECT definition FROM ui_themes WHERE status != 'deprecated' ORDER BY id").all() as ReadonlyArray<{ readonly definition: string }>).flatMap((row) => Either.match(decodeTheme(row.definition), { onLeft: () => [], onRight: (theme) => [theme] })),
        catch: (error) => String(error),
      }),
      put: (theme: ThemeDefinitionType) => Effect.try({
        try: () => void db.query("INSERT OR REPLACE INTO ui_themes(id, version, fingerprint, status, definition, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(theme.id, theme.version, theme.fingerprint, theme.status, JSON.stringify(theme), theme.createdAt),
        catch: (error) => String(error),
      }),
    }
  }),
)
