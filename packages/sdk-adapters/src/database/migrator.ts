import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import * as Migrator from "@effect/sql/Migrator"
import { PgClient, PgMigrator } from "@effect/sql-pg"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Cause, Config, Duration, Effect, Layer, Option, Redacted } from "effect"
import { connFromUrl, type DatabaseConn } from "@xandreed/sdk-core"

import { PostgresConversationStoreLive } from "../conversationStore/postgres.js"
import { SqliteConversationStoreLive } from "../conversationStore/sqlite.js"
import { PostgresContextTreeStoreLive } from "../contextTreeStore/postgres.js"
import { SqliteContextTreeStoreLive } from "../contextTreeStore/sqlite.js"

import pg0001 from "./migrations/0001_init.js"
import pg0002 from "./migrations/0002_conversations.js"
import pg0003 from "./migrations/0003_unified_messages.js"
import pg0004 from "./migrations/0004_conversation_workspace.js"
import pg0005 from "./migrations/0005_checkpoints.js"
import pg0006 from "./migrations/0006_context_tree.js"
import pg0007 from "./migrations/0007_workspace_ref.js"
import pg0008 from "./migrations/0008_seed_count.js"
import pg0009 from "./migrations/0009_conversation_title.js"
import pg0010 from "./migrations/0010_node_title.js"
import sqlite0001 from "./migrations-sqlite/0001_init.js"
import sqlite0002 from "./migrations-sqlite/0002_context_tree.js"
import sqlite0003 from "./migrations-sqlite/0003_workspace_ref.js"
import sqlite0004 from "./migrations-sqlite/0004_seed_count.js"
import sqlite0005 from "./migrations-sqlite/0005_conversation_title.js"
import sqlite0006 from "./migrations-sqlite/0006_node_title.js"

/**
 * Database layer + ConversationStore, selected at runtime from a single
 * `EFFERENT_DB_URL` value (env, or seeded from config.json's `dbUrl` at boot —
 * see packages/code/src/main.ts `seedDbUrlFromConfig`; env always wins):
 *   - `postgres://…` / `postgresql://…` → Postgres (the opt-in backend);
 *   - any other non-empty value (a path, optionally `sqlite:`-prefixed) →
 *     SQLite at that path;
 *   - unset → SQLite at `~/.efferent/efferent.db` (the zero-config default,
 *     so `npm i -g efferent` works with no Docker).
 *
 * Migrations are loaded via `Migrator.fromRecord` (a static map) rather than
 * `fromFileSystem`, so the published single-file bundle carries them inline —
 * no `.ts` files read off disk at runtime.
 */

const defaultSqlitePath = () => join(homedir(), ".efferent", "efferent.db")

type DbTarget =
  | { readonly kind: "postgres" }
  | { readonly kind: "sqlite"; readonly filename: string }

/** Interpret the EFFERENT_DB_URL value into a concrete backend target. */
export const parseDbTarget = (raw: string | undefined): DbTarget => {
  const v = raw?.trim()
  if (v === undefined || v.length === 0) {
    return { kind: "sqlite", filename: defaultSqlitePath() }
  }
  if (/^postgres(ql)?:\/\//i.test(v)) return { kind: "postgres" }
  const path = v.replace(/^sqlite:(\/\/)?/i, "")
  return { kind: "sqlite", filename: path.length > 0 ? path : defaultSqlitePath() }
}

/** Best-effort message out of a probe failure: prefer the driver's own cause
 *  (e.g. "password authentication failed", "ENOTFOUND host") over the wrapper. */
const probeErrorMessage = (e: unknown): string => {
  if (typeof e === "string") return e
  if (typeof e === "object" && e !== null) {
    const anyE = e as { message?: unknown; cause?: { message?: unknown } }
    const cause = anyE.cause?.message
    if (typeof cause === "string" && cause.trim().length > 0) return cause
    if (typeof anyE.message === "string" && anyE.message.trim().length > 0) return anyE.message
  }
  return "could not connect"
}

/**
 * Probe a Postgres connection string: open a short-lived single connection and
 * run `SELECT 1`. Returns a plain result (never fails) so callers — e.g. the
 * onboarding DB step — can give immediate feedback before persisting `dbUrl`,
 * which otherwise only fails at the NEXT boot when the store builds. Bounded by
 * a 15s connect timeout + an 18s overall deadline (serverless Postgres like Neon
 * can take several seconds to wake a suspended compute) so a bad host can't hang.
 *
 * `matchCause` (not `match`) so a **defect** — an SSL/socket error the driver
 * throws rather than returning as a `SqlError`, or a finalizer hiccup — becomes a
 * clean `ok:false` too, instead of crashing the caller. The probe never fails.
 */
export const probePostgres = (
  url: string,
): Effect.Effect<{ readonly ok: true } | { readonly ok: false; readonly error: string }> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`select 1`
  }).pipe(
    Effect.scoped,
    Effect.provide(
      PgClient.layer({
        url: Redacted.make(url),
        connectTimeout: Duration.seconds(15),
        maxConnections: 1,
      }),
    ),
    Effect.timeoutFail({ duration: Duration.seconds(18), onTimeout: () => "connection timed out" }),
    Effect.matchCause({
      onSuccess: () => ({ ok: true as const }),
      onFailure: (cause) => ({ ok: false as const, error: probeErrorMessage(Cause.squash(cause)) }),
    }),
  )

const pgLoader = Migrator.fromRecord({
  "0001_init": pg0001,
  "0002_conversations": pg0002,
  "0003_unified_messages": pg0003,
  "0004_conversation_workspace": pg0004,
  "0005_checkpoints": pg0005,
  "0006_context_tree": pg0006,
  "0007_workspace_ref": pg0007,
  "0008_seed_count": pg0008,
  "0009_conversation_title": pg0009,
  "0010_node_title": pg0010,
})

const sqliteLoader = Migrator.fromRecord({
  "0001_init": sqlite0001,
  "0002_context_tree": sqlite0002,
  "0003_workspace_ref": sqlite0003,
  "0004_seed_count": sqlite0004,
  "0005_conversation_title": sqlite0005,
  "0006_node_title": sqlite0006,
})

/** Postgres client + migrator (only built when EFFERENT_DB_URL is set). */
const PgDatabaseLive = PgMigrator.layer({ loader: pgLoader }).pipe(
  Layer.provideMerge(
    PgClient.layerConfig({ url: Config.redacted("EFFERENT_DB_URL") }),
  ),
)

/** SQLite client + migrator at `filename` (creating its parent dir). */
const sqliteDatabaseLive = (filename: string) =>
  Layer.unwrapEffect(
    Effect.sync(() => {
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
 * this once; all four modes consume `ConversationStore` unchanged. The plain
 * (non-redacted) value is read only to branch + extract a SQLite path; the
 * Postgres branch re-reads it as a redacted secret in `PgDatabaseLive`.
 */
export const ConversationStoreLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const raw = Option.getOrUndefined(
      yield* Config.option(Config.string("EFFERENT_DB_URL")),
    )
    const target = parseDbTarget(raw)
    return target.kind === "postgres"
      ? PostgresConversationStoreLive.pipe(Layer.provide(PgDatabaseLive))
      : SqliteConversationStoreLive.pipe(
          Layer.provide(sqliteDatabaseLive(target.filename)),
        )
  }),
)

/**
 * Both SQL stores (`ConversationStore` + `ContextTreeStore`) over a SINGLE
 * database stack — one client, one migrator run. Providing each store its own
 * self-contained DB layer would open two connections and race the migrator on
 * the same file, so the composition root provides this combined layer instead
 * of `ConversationStoreLive` alone.
 */
export const StoresLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const raw = Option.getOrUndefined(
      yield* Config.option(Config.string("EFFERENT_DB_URL")),
    )
    const target = parseDbTarget(raw)
    return target.kind === "postgres"
      ? Layer.merge(
          PostgresConversationStoreLive,
          PostgresContextTreeStoreLive,
        ).pipe(Layer.provide(PgDatabaseLive))
      : Layer.merge(
          SqliteConversationStoreLive,
          SqliteContextTreeStoreLive,
        ).pipe(Layer.provide(sqliteDatabaseLive(target.filename)))
  }),
)

/** Postgres client + migrator for an explicit `url` (vs the env-config variant
 *  used at boot) — the on-demand path for runtime switching / transient reads. */
const pgDatabaseLayer = (url: string) =>
  PgMigrator.layer({ loader: pgLoader }).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
  )

/**
 * Both SQL stores over a SINGLE db stack for an EXPLICIT connection (not the
 * env). Building it runs the migrator → only *pending* migrations apply, so it's
 * safe against an already-populated database. Used by the switchable store
 * (`switchTo` / transient session reads). SQLite paths flow through
 * `parseDbTarget` so `""`/`sqlite:`-prefixes resolve like the boot path.
 */
const sqliteFilenameOf = (url: string): string => {
  const t = parseDbTarget(url)
  return t.kind === "sqlite" ? t.filename : defaultSqlitePath()
}

export const storesLayerFor = (conn: DatabaseConn) =>
  conn.kind === "postgres"
    ? Layer.merge(PostgresConversationStoreLive, PostgresContextTreeStoreLive).pipe(
        Layer.provide(pgDatabaseLayer(conn.url)),
      )
    : Layer.merge(SqliteConversationStoreLive, SqliteContextTreeStoreLive).pipe(
        Layer.provide(sqliteDatabaseLive(sqliteFilenameOf(conn.url))),
      )

/** The zero-config local SQLite connection (`~/.efferent/efferent.db`). */
export const localConn = (): DatabaseConn => ({ kind: "sqlite", url: defaultSqlitePath() })

/** The active connection at boot: `EFFERENT_DB_URL` (env, or config-seeded into
 *  it by `seedDbUrlFromConfig`) if set, else zero-config local SQLite. */
export const bootConn = (): DatabaseConn => {
  const raw = process.env.EFFERENT_DB_URL?.trim()
  return raw !== undefined && raw.length > 0 ? connFromUrl(raw) : localConn()
}
