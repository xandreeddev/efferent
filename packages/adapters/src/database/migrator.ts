import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { PgClient, PgMigrator } from "@effect/sql-pg"
import { Config, Layer } from "effect"

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
)

const PgLive = PgClient.layerConfig({
  url: Config.redacted("AGENT_DB_URL"),
})

const MigratorLive = PgMigrator.layer({
  loader: PgMigrator.fromFileSystem(migrationsDir),
})

/**
 * Composed database layer: provides PgClient + SqlClient and runs migrations
 * on acquire. The CLI/web driver provides this once; the `*StoreLive` adapters
 * (CaptureStore, ConversationStore) consume the SqlClient it surfaces.
 */
export const DatabaseLive = MigratorLive.pipe(Layer.provideMerge(PgLive))
