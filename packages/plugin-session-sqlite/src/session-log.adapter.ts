import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import { chmodSync, existsSync, realpathSync } from "node:fs"
import { dirname } from "node:path"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import type { Scope } from "effect"
import {
  ConversationId,
  definePlugin,
  LeaseExpired,
  RevisionConflict,
  SessionExists,
  SessionLog,
  SessionLogError,
  SessionMissing,
} from "@xandreed/core"
import type { JsonObject, SessionCommitted, SessionHead, SessionHeader, SessionLogEvent } from "@xandreed/core"
import { importLegacySessions, LEGACY_BOOKKEEPING } from "./legacy-session.adapter.js"

interface HeadRow {
  readonly id: string
  readonly owner: string
  readonly origin: string
  readonly created_at: number
  readonly meta: string
  readonly parent_id: string | null
  readonly parent_through: number | null
  readonly turn_at_fork: number | null
  readonly seq: number
  readonly revision: number
  readonly state: string
  readonly updated_at: number
}

interface EventRow {
  readonly seq: number
  readonly turn: number | null
  readonly kind: string
  readonly at: number
  readonly data: string
}

const failure = (code: string) => (error: unknown) => new SessionLogError({ code, message: String(error) })
const json = (text: string): JsonObject => JSON.parse(text) as JsonObject

const headOf = (row: HeadRow, now: number): SessionHead => ({
  header: {
    id: ConversationId.make(row.id),
    owner: row.owner,
    origin: row.origin,
    createdAt: row.created_at,
    meta: json(row.meta),
    parent: row.parent_id === null ? Option.none() : Option.some({
      id: ConversationId.make(row.parent_id), through: row.parent_through ?? 0, turnAtFork: row.turn_at_fork ?? 0,
    }),
  },
  seq: row.seq,
  revision: row.revision,
  state: json(row.state),
  updatedAt: row.updated_at,
  now,
})

const eventOf = (session: ConversationId) => (row: EventRow): SessionLogEvent => ({
  session, seq: row.seq, turn: Option.fromNullishOr(row.turn), kind: row.kind, at: row.at, data: json(row.data),
})

/** One conversation as the positional listing shows it: its first message and its latest title and outcome, as stored. */
export interface ConversationOverview {
  readonly id: ConversationId
  readonly createdAt: number
  readonly first: Option.Option<JsonObject>
  readonly title: Option.Option<JsonObject>
  readonly outcome: Option.Option<JsonObject>
}

/**
 * What this package's compatibility projections use of a SQLite log beyond
 * the SessionLog contract: set-based reads, retention in one transaction,
 * and importing a host's own older file.
 */
export interface SqliteLogInternals {
  /** The owner's conversation sessions (origin `conversation`), newest first, in one query. */
  readonly conversations: (owner: string) => Effect.Effect<ReadonlyArray<ConversationOverview>, SessionLogError>
  /** Remove the conversation sessions created before `before` in one transaction, then reclaim the space; returns how many. */
  readonly prune: (before: number) => Effect.Effect<number, SessionLogError>
  /** Import older files through read-only connections (absent ones are skipped); orphan rows without a session default to `owner`. */
  readonly importLegacy: (paths: ReadonlyArray<string>, owner: Option.Option<string>) => Effect.Effect<void, SessionLogError>
}

const internals = new WeakMap<SessionLog["Service"], SqliteLogInternals>()

/** The SQLite internals of a log `SessionLogSqliteLive` built; none for any other SessionLog. */
export const sqliteLogInternals = (log: SessionLog["Service"]): Option.Option<SqliteLogInternals> => Option.fromNullishOr(internals.get(log))

interface OverviewRow {
  readonly id: string
  readonly created_at: number
  readonly first: string | null
  readonly title: string | null
  readonly outcome: string | null
}

/** A commit's outcome inside its transaction. */
type Outcome =
  | { readonly _tag: "Done"; readonly committed: SessionCommitted }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Conflict"; readonly actual: number }
  | { readonly _tag: "Expired" }

/**
 * The authoritative session journal in one SQLite file: `session_heads`
 * and `session_log_events`. Legacy tables remain preserved, read only after
 * their import. Removal cascades to events and children and leaves a
 * tombstone, so no import brings a removed session back. A commit is one
 * IMMEDIATE transaction that checks the revision and the clock before it
 * writes; the clock is the process's.
 */
export const makeSessionLogSqlite = (path: string, options: { readonly legacyPaths?: ReadonlyArray<string>; readonly legacyOwner?: string } = {}): Effect.Effect<SessionLog["Service"], SessionLogError, Scope.Scope> => Effect.gen(function* () {
  yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: failure("store.open") })
  const db = yield* Effect.acquireRelease(
    Effect.try({ try: () => new Database(path, { create: true, strict: true }), catch: failure("store.open") }),
    (database) => Effect.sync(() => database.close()),
  )
  const operation = <A>(work: () => A) => Effect.try({ try: work, catch: failure("store.io") })
  yield* operation(() => chmodSync(path, 0o600))
  yield* operation(() => db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS session_heads (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL, meta TEXT NOT NULL,
      parent_id TEXT REFERENCES session_heads(id) ON DELETE CASCADE, parent_through INTEGER, turn_at_fork INTEGER,
      seq INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS session_heads_owner ON session_heads(owner, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS session_heads_parent ON session_heads(parent_id);
    CREATE TABLE IF NOT EXISTS session_log_events (
      session_id TEXT NOT NULL REFERENCES session_heads(id) ON DELETE CASCADE, seq INTEGER NOT NULL, turn INTEGER,
      kind TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, seq));
    CREATE INDEX IF NOT EXISTS session_log_events_kind ON session_log_events(session_id, kind, seq);
    ${LEGACY_BOOKKEEPING}
  `))
  const imported = (source: Database, sourceId: string, owner: Option.Option<string>) => operation(() => importLegacySessions(db, source, sourceId, owner)).pipe(
    Effect.tap((result) => Effect.forEach(result.skipped, (row) => Effect.logWarning(`legacy import of ${sourceId}: skipped an undecodable row: ${row}`), { discard: true })),
    Effect.flatMap((result) => Option.match(result.refused, {
      onNone: () => Effect.void,
      onSome: (message) => Effect.fail(new SessionLogError({ code: "store.legacy-conflict", message })),
    })),
  )
  const importLegacy = (paths: ReadonlyArray<string>, owner: Option.Option<string>) => Effect.gen(function* () {
    const destination = yield* operation(() => realpathSync(path))
    const sources = yield* operation(() => [...new Set(paths.filter(existsSync).map((source) => realpathSync(source)))].filter((source) => source !== destination))
    yield* Effect.forEach(sources, (source) => Effect.acquireUseRelease(
      operation(() => {
        const legacy = new Database(source, { readonly: true, strict: true })
        legacy.exec("PRAGMA busy_timeout = 5000")
        return legacy
      }),
      (legacy) => imported(legacy, source, owner),
      (legacy) => Effect.sync(() => legacy.close()),
    ), { discard: true })
  })
  const owner = Option.fromNullishOr(options.legacyOwner)
  yield* imported(db, "local", owner)
  yield* importLegacy(options.legacyPaths ?? [], owner)
  const headRow = (id: string) => db.query<HeadRow, [string]>("SELECT * FROM session_heads WHERE id = ?").get(id)
  /** Remove sessions with their children, leaving a tombstone for each (inside the caller's transaction). */
  const removeTrees = (ids: ReadonlyArray<string>, now: number) => ids.forEach((id) => {
    db.query(`WITH RECURSIVE tree(id) AS (SELECT id FROM session_heads WHERE id = ? UNION SELECT child.id FROM session_heads child JOIN tree ON child.parent_id = tree.id)
      INSERT OR IGNORE INTO session_log_tombstones (session_id, removed_at) SELECT id, ? FROM tree`).run(id, now)
    db.query("DELETE FROM session_heads WHERE id = ?").run(id)
  })

  const log = SessionLog.of({
    create: (header: SessionHeader) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const outcome = yield* operation(() => db.transaction((): "created" | "exists" | "orphan" => {
        if (headRow(header.id) !== null) return "exists"
        if (Option.isSome(header.parent) && headRow(header.parent.value.id) === null) return "orphan"
        const parent = Option.getOrNull(header.parent)
        db.query("INSERT INTO session_heads (id, owner, origin, created_at, meta, parent_id, parent_through, turn_at_fork, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(header.id, header.owner, header.origin, header.createdAt, JSON.stringify(header.meta), parent?.id ?? null, parent?.through ?? null, parent?.turnAtFork ?? null, now)
        return "created"
      }).immediate())
      if (outcome === "exists") return yield* Effect.fail(new SessionExists({ session: header.id }))
      if (outcome === "orphan") return yield* Effect.fail(new SessionMissing({ session: Option.match(header.parent, { onNone: () => header.id, onSome: (parent) => parent.id }) }))
      const row = yield* operation(() => headRow(header.id))
      return row === null ? yield* Effect.fail(new SessionLogError({ code: "store.io", message: "the new session was not stored" })) : headOf(row, now)
    }),
    head: (id) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const row = yield* operation(() => headRow(id))
      return row === null ? yield* Effect.fail(new SessionMissing({ session: id })) : headOf(row, now)
    }),
    list: (query) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => operation(() => {
      const before = Option.getOrNull(query.before)
      const parent = Option.getOrNull(query.parent)
      return db.query<HeadRow, [string, string | null, string | null, number | null, number | null, number | null, string | null, number]>(`
        SELECT * FROM session_heads
        WHERE owner = ? AND ((? IS NULL AND parent_id IS NULL) OR parent_id = ?)
          AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
        ORDER BY updated_at DESC, id DESC LIMIT ?`)
        .all(query.owner, parent, parent, before?.updatedAt ?? null, before?.updatedAt ?? null, before?.updatedAt ?? null, before?.id ?? null, Math.max(0, query.limit))
        .map((row) => headOf(row, now))
    }))),
    read: (id, query) => Effect.gen(function* () {
      if ((yield* operation(() => headRow(id))) === null) return yield* Effect.fail(new SessionMissing({ session: id }))
      const kinds = query.kinds.length === 0 ? "" : ` AND kind IN (${query.kinds.map(() => "?").join(", ")})`
      const limit = Option.match(query.limit, { onNone: () => -1, onSome: (value) => Math.max(0, value) })
      return yield* operation(() => db.query<EventRow, Array<string | number>>(`SELECT seq, turn, kind, at, data FROM session_log_events WHERE session_id = ? AND seq > ?${kinds} ORDER BY seq LIMIT ?`)
        .all(id, query.after, ...query.kinds, limit)
        .map(eventOf(id)))
    }),
    commit: (id, commit) => Clock.currentTimeMillis.pipe(Effect.flatMap((at) => operation(() => db.transaction((): Outcome => {
      const head = db.query<{ readonly seq: number; readonly revision: number }, [string]>("SELECT seq, revision FROM session_heads WHERE id = ?").get(id)
      if (head === null) return { _tag: "Missing" }
      if (head.revision !== commit.expect) return { _tag: "Conflict", actual: head.revision }
      if (Option.isSome(commit.notAfter) && at > commit.notAfter.value) return { _tag: "Expired" }
      const events = commit.events.map((draft, index): SessionLogEvent => ({
        session: id, seq: head.seq + index + 1, turn: draft.turn, kind: draft.kind, at, data: json(JSON.stringify(draft.data)),
      }))
      const insert = db.query("INSERT INTO session_log_events (session_id, seq, turn, kind, at, data) VALUES (?, ?, ?, ?, ?, ?)")
      events.forEach((event) => insert.run(id, event.seq, Option.getOrNull(event.turn), event.kind, at, JSON.stringify(event.data)))
      db.query("UPDATE session_heads SET revision = revision + 1, seq = ?, state = COALESCE(?, state), updated_at = ? WHERE id = ?")
        .run(head.seq + events.length, Option.match(commit.state, { onNone: () => null, onSome: (state) => JSON.stringify(state) }), at, id)
      return { _tag: "Done", committed: { revision: head.revision + 1, seq: head.seq + events.length, events, at } }
    }).immediate()).pipe(Effect.flatMap((outcome): Effect.Effect<SessionCommitted, RevisionConflict | LeaseExpired | SessionMissing> => {
      if (outcome._tag === "Done") return Effect.succeed(outcome.committed)
      if (outcome._tag === "Missing") return Effect.fail(new SessionMissing({ session: id }))
      if (outcome._tag === "Conflict") return Effect.fail(new RevisionConflict({ session: id, expected: commit.expect, actual: outcome.actual }))
      return Effect.fail(new LeaseExpired({ session: id, notAfter: Option.getOrElse(commit.notAfter, () => at), now: at }))
    })))),
    remove: (id) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => operation(() => db.transaction(() => removeTrees([id], now)).immediate()))),
  })
  internals.set(log, {
    conversations: (owner) => operation(() => db.query<OverviewRow, [string]>(`
      SELECT head.id AS id, head.created_at AS created_at,
        (SELECT event.data FROM session_log_events event WHERE event.session_id = head.id AND event.kind = 'conversation.message' ORDER BY event.seq LIMIT 1) AS first,
        (SELECT event.data FROM session_log_events event WHERE event.session_id = head.id AND event.kind = 'conversation.title' ORDER BY event.seq DESC LIMIT 1) AS title,
        (SELECT event.data FROM session_log_events event WHERE event.session_id = head.id AND event.kind = 'conversation.outcome' ORDER BY event.seq DESC LIMIT 1) AS outcome
      FROM session_heads head WHERE head.owner = ? AND head.origin = 'conversation' ORDER BY head.created_at DESC, head.id DESC`)
      .all(owner)
      .map((row): ConversationOverview => ({
        id: ConversationId.make(row.id), createdAt: row.created_at,
        first: Option.map(Option.fromNullishOr(row.first), json), title: Option.map(Option.fromNullishOr(row.title), json), outcome: Option.map(Option.fromNullishOr(row.outcome), json),
      }))),
    prune: (before) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => operation(() => {
      const removed = db.transaction(() => {
        const ids = db.query<{ readonly id: string }, [number]>("SELECT id FROM session_heads WHERE origin = 'conversation' AND created_at < ?").all(before).map((row) => row.id)
        removeTrees(ids, now)
        return ids.length
      }).immediate()
      // Reclaim the deleted pages from the WAL: deletion alone shrinks nothing on disk.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
      return removed
    }))),
    importLegacy,
  })
  return log
})

/** The session log over one SQLite file (see `makeSessionLogSqlite`). */
export const SessionLogSqliteLive = (path: string, options: { readonly legacyPaths?: ReadonlyArray<string>; readonly legacyOwner?: string } = {}): Layer.Layer<SessionLog, SessionLogError> =>
  Layer.effect(SessionLog, makeSessionLogSqlite(path, options))

const LogConfig = Schema.Struct({ path: Schema.String })

/** The session log in a SQLite file, as a plugin: provides SessionLog. */
export const sessionLogSqlitePlugin = definePlugin({
  id: "@xandreed/plugin-session-sqlite/log", version: "0.8.0-next.0", scope: "runtime",
  config: LogConfig, defaults: { path: ".efferent/runtime/sessions.db" }, provides: [SessionLog],
  layer: ({ path }) => SessionLogSqliteLive(path),
})
