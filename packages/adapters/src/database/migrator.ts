import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import * as Migrator from "@effect/sql/Migrator"
import { PgClient, PgMigrator } from "@effect/sql-pg"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Config, Effect, Layer, Option } from "effect"

import { PostgresConversationStoreLive } from "../conversationStore/postgres.js"
import { SqliteConversationStoreLive } from "../conversationStore/sqlite.js"

import pg0001 from "./migrations/0001_init.js"
import pg0002 from "./migrations/0002_conversations.js"
import pg0003 from "./migrations/0003_unified_messages.js"
import pg0004 from "./migrations/0004_conversation_workspace.js"
import pg0005 from "./migrations/0005_checkpoints.js"
import sqlite0001 from "./migrations-sqlite/0001_init.js"

/**
 * Database layer + ConversationStore, selected at runtime:
 *   - `EFFERENT_DB_URL` set → Postgres (the opt-in, heavier-duty backend);
 *   - else → SQLite at `~/.efferent/efferent.db` (the zero-config default,
 *     so `npm i -g efferent` works with no Docker).
 *
 * Migrations are loaded via `Migrator.fromRecord` (a static map) rather than
 * `fromFileSystem`, so the published single-file bundle carries them inline —
 * no `.ts` files read off disk at runtime.
 */

const pgLoader = Migrator.fromRecord({
  "0001_init": pg0001,
  "0002_conversations": pg0002,
  "0003_unified_messages": pg0003,
  "0004_conversation_workspace": pg0004,
  "0005_checkpoints": pg0005,
})

const sqliteLoader = Migrator.fromRecord({
  "0001_init": sqlite0001,
})

/** Postgres client + migrator (only built when EFFERENT_DB_URL is set). */
const PgDatabaseLive = PgMigrator.layer({ loader: pgLoader }).pipe(
  Layer.provideMerge(
    PgClient.layerConfig({ url: Config.redacted("EFFERENT_DB_URL") }),
  ),
)

/** SQLite client + migrator at ~/.efferent/efferent.db (creating the dir). */
const SqliteDatabaseLive = Layer.unwrapEffect(
  Effect.sync(() => {
    const filename = join(homedir(), ".efferent", "efferent.db")
    mkdirSync(dirname(filename), { recursive: true })
    return SqliteMigrator.layer({ loader: sqliteLoader }).pipe(
      Layer.provideMerge(SqliteClient.layer({ filename })),
    )
  }),
)

/** Back-compat alias: the Postgres database layer. */
export const DatabaseLive = PgDatabaseLive

/**
 * The composed ConversationStore for the active backend. The driver provides
 * this once; all four modes consume `ConversationStore` unchanged.
 */
export const ConversationStoreLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const dbUrl = yield* Config.option(Config.redacted("EFFERENT_DB_URL"))
    return Option.isSome(dbUrl)
      ? PostgresConversationStoreLive.pipe(Layer.provide(PgDatabaseLive))
      : SqliteConversationStoreLive.pipe(Layer.provide(SqliteDatabaseLive))
  }),
)
