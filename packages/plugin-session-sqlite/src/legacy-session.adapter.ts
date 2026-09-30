import { Database } from "bun:sqlite"
import { Option, Result, Schema } from "effect"
import { canonicalJson, SessionEvent, SessionRecord } from "@xandreed/core"

const decodeRecord = Schema.decodeUnknownResult(Schema.fromJsonString(SessionRecord))
const decodeEvent = Schema.decodeUnknownResult(Schema.fromJsonString(SessionEvent))
const hasTable = (database: Database, name: string) => database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null

type Data = Readonly<Record<string, unknown>>
interface Incoming { readonly kind: string; readonly at: number; readonly data: Data }
interface Plan {
  readonly id: string
  readonly owner: string
  readonly origin: string
  readonly createdAt: number
  readonly meta: Data
  readonly kinds: ReadonlyArray<string>
  readonly events: ReadonlyArray<Incoming>
}

/** What importing one source did: refused (nothing written), or imported, with the rows it could not decode and skipped. */
export interface LegacyImport {
  readonly refused: Option.Option<string>
  readonly skipped: ReadonlyArray<string>
}

/**
 * The import bookkeeping: the sources already imported, and the sessions
 * removed since (a removed session is never imported again, whatever path
 * its source is found at).
 */
export const LEGACY_BOOKKEEPING = `
  CREATE TABLE IF NOT EXISTS session_log_imports (source TEXT PRIMARY KEY, imported_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS session_log_tombstones (session_id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL);
`

const HARNESS_KINDS = ["harness.event"]
const CONVERSATION_KINDS = ["conversation.message", "conversation.checkpoint", "conversation.title", "conversation.outcome"]

/** Where an event sits (a harness event's seq, a message's position), when it has a place. */
const placeOf = (event: { readonly kind: string; readonly data: Data }): Option.Option<string> => {
  const inner = event.data.event
  if (event.kind === "conversation.message" && typeof event.data.position === "number") return Option.some(`${event.kind}:${event.data.position}`)
  return event.kind === "harness.event" && typeof inner === "object" && inner !== null && "seq" in inner && typeof inner.seq === "number"
    ? Option.some(`${event.kind}:${inner.seq}`) : Option.none()
}

/**
 * Import frozen pre-log tables once, in the destination's IMMEDIATE
 * transaction. Sources stay read only. A session is matched by id whatever
 * path its source is found at: events it already holds are not imported
 * again, a removed session is not imported again, and an orphan message row
 * (written under a harness id with no conversation row) joins the session
 * stored under its id, with that session's owner. A conflicting identity or
 * position refuses the entire source before any row is changed; a row that
 * does not decode is skipped and reported.
 */
export const importLegacySessions = (database: Database, source: Database, sourceId: string, owner: Option.Option<string> = Option.none()): LegacyImport => database.transaction((): LegacyImport => {
  database.exec(LEGACY_BOOKKEEPING)
  if (database.query("SELECT source FROM session_log_imports WHERE source = ?").get(sourceId) !== null) return { refused: Option.none(), skipped: [] }
  const removed = (id: string) => database.query("SELECT session_id FROM session_log_tombstones WHERE session_id = ?").get(id) !== null
  const stored = (id: string) => Option.fromNullishOr(database.query<{ owner: string; origin: string; created_at: number }, [string]>("SELECT owner, origin, created_at FROM session_heads WHERE id = ?").get(id))
  const records = hasTable(source, "harness_sessions")
    ? source.query<{ id: string; body: string }, []>("SELECT id, body FROM harness_sessions ORDER BY rowid").all().map((row) => ({ row, decoded: decodeRecord(row.body) }))
    : []
  const harness = records.flatMap(({ decoded }) => Result.match(decoded, { onFailure: () => [], onSuccess: (record) => [record] })).map((record) => {
    const rows = source.query<{ seq: number; body: string }, [string]>("SELECT seq, body FROM harness_events WHERE session_id = ? ORDER BY seq").all(record.id).map((row) => ({ row, decoded: decodeEvent(row.body) }))
    const plan: Plan = {
      id: record.id, owner: record.workspace, origin: "harness", createdAt: record.createdAt, kinds: HARNESS_KINDS,
      meta: { workspace: record.workspace, profile: record.profile, projection: "harness", ...Option.match(Option.fromNullishOr(record.parent), { onNone: () => ({}), onSome: (parent) => ({ legacyParent: parent }) }) },
      events: rows.flatMap(({ decoded }) => Result.match(decoded, { onFailure: () => [], onSuccess: (event): ReadonlyArray<Incoming> => [{ kind: "harness.event", at: event.at, data: { event } }] })),
    }
    return { plan, skipped: rows.flatMap(({ row, decoded }) => Result.match(decoded, { onFailure: (issue) => [`harness event ${record.id}#${row.seq}: ${String(issue)}`], onSuccess: () => [] })) }
  })
  const messages = hasTable(source, "messages")
  const conversations = hasTable(source, "conversations")
  const conversationRows = conversations ? source.query<{ id: string; workspace_dir: string | null; title: string | null; created_at: number }, []>("SELECT id, workspace_dir, title, created_at FROM conversations ORDER BY rowid").all() : []
  // Historical domain hosts wrote messages under the harness id without
  // creating a conversation row. Such an orphan joins the session stored (or
  // imported here) under its id, keeping that session's owner; an unknown
  // one is created under the compatibility owner.
  const orphanRows = messages ? source.query<{ id: string; created_at: number }, []>(`SELECT conversation_id AS id, MIN(created_at) AS created_at FROM messages ${conversations ? "WHERE conversation_id NOT IN (SELECT id FROM conversations)" : ""} GROUP BY conversation_id`).all().map((row) => {
    const target = stored(row.id)
    const planned = Option.fromNullishOr(harness.find((entry) => entry.plan.id === row.id)?.plan)
    return {
      id: row.id, title: null,
      workspace_dir: Option.getOrElse(Option.orElse(Option.map(target, (head) => head.owner), () => Option.map(planned, (plan) => plan.owner)), () => Option.getOrElse(owner, () => "conversation-store")),
      created_at: Option.getOrElse(Option.orElse(Option.map(target, (head) => head.created_at), () => Option.map(planned, (plan) => plan.createdAt)), () => row.created_at),
    }
  }) : []
  const checkpoints = hasTable(source, "checkpoints")
  const outcomes = hasTable(source, "run_outcomes")
  const conversationPlans = [...conversationRows, ...orphanRows].map((row): Plan => ({
    id: row.id, owner: row.workspace_dir ?? "conversation-store", origin: "conversation", createdAt: row.created_at, kinds: CONVERSATION_KINDS,
    meta: { workspace: row.workspace_dir ?? "conversation-store", projection: "conversation" },
    events: [
      ...(messages ? source.query<{ position: number; content: string; created_at: number }, [string]>("SELECT position, content, created_at FROM messages WHERE conversation_id = ? ORDER BY position").all(row.id).map((message) => ({ kind: "conversation.message", at: message.created_at, data: { position: message.position, content: message.content } })) : []),
      ...(checkpoints ? source.query<{ message_position: number; summary: string; created_at: number }, [string]>("SELECT message_position, summary, created_at FROM checkpoints WHERE conversation_id = ? ORDER BY rowid").all(row.id).map((checkpoint) => ({ kind: "conversation.checkpoint", at: checkpoint.created_at, data: { messagePosition: checkpoint.message_position, summary: checkpoint.summary, createdAt: checkpoint.created_at } })) : []),
      ...(row.title === null ? [] : [{ kind: "conversation.title", at: row.created_at, data: { title: row.title } }]),
      ...(outcomes ? source.query<{ at: number; outcome: string; reason: string }, [string]>("SELECT at, outcome, reason FROM run_outcomes WHERE conversation_id = ? ORDER BY at, rowid").all(row.id).map((outcome) => ({ kind: "conversation.outcome", at: outcome.at, data: { outcome: outcome.outcome, reason: outcome.reason, at: outcome.at } })) : []),
    ],
  }))
  const skipped = [
    ...records.flatMap(({ row, decoded }) => Result.match(decoded, { onFailure: (issue) => [`harness session ${row.id}: ${String(issue)}`], onSuccess: () => [] })),
    ...harness.flatMap((entry) => entry.skipped),
  ]
  const plans = [...harness.map((entry) => entry.plan), ...conversationPlans].filter((plan) => !removed(plan.id))
  const identityConflict = plans.find((plan) => plans.some((other) => other.id === plan.id && other.owner !== plan.owner)
    || Option.exists(stored(plan.id), (head) => head.owner !== plan.owner || (head.origin === plan.origin && head.created_at !== plan.createdAt)))
  if (identityConflict !== undefined) return { refused: Option.some(`session ${identityConflict.id} has a conflicting legacy identity`), skipped }
  // What each session already holds, by place and by content: one pass over its events and one over the incoming.
  const indexed = plans.map((plan) => {
    const previous = database.query<{ kind: string; data: string }, Array<string>>(`SELECT kind, data FROM session_log_events WHERE session_id = ? AND kind IN (${plan.kinds.map(() => "?").join(", ")}) ORDER BY seq`)
      .all(plan.id, ...plan.kinds)
      .map((row) => ({ kind: row.kind, data: JSON.parse(row.data) as Data }))
      .map((event) => ({ place: placeOf(event), content: `${event.kind}\n${canonicalJson(event.data)}` }))
    const places = new Map(previous.flatMap((event) => Option.toArray(Option.map(event.place, (place) => [place, event.content] as const))))
    const present = new Set(previous.map((event) => event.content))
    const incoming = plan.events.map((event) => ({ event, place: placeOf(event), content: `${event.kind}\n${canonicalJson(event.data)}` }))
    return {
      plan,
      conflict: incoming.some((entry) => Option.exists(entry.place, (place) => Option.exists(Option.fromNullishOr(places.get(place)), (content) => content !== entry.content))),
      fresh: incoming.filter((entry) => !present.has(entry.content)).map((entry) => entry.event),
    }
  })
  const positionConflict = indexed.find((entry) => entry.conflict)
  if (positionConflict !== undefined) return { refused: Option.some(`session ${positionConflict.plan.id} has a conflicting legacy position`), skipped }
  const header = database.query("INSERT OR IGNORE INTO session_heads (id, owner, origin, created_at, meta, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
  const insert = database.query("INSERT INTO session_log_events (session_id, seq, turn, kind, at, data) VALUES (?, ?, NULL, ?, ?, ?)")
  indexed.forEach(({ plan, fresh }) => {
    header.run(plan.id, plan.owner, plan.origin, plan.createdAt, JSON.stringify(plan.meta), plan.createdAt)
    if (fresh.length === 0) return
    const base = database.query<{ seq: number }, [string]>("SELECT seq FROM session_heads WHERE id = ?").get(plan.id)?.seq ?? 0
    fresh.forEach((event, index) => insert.run(plan.id, base + index + 1, event.kind, event.at, JSON.stringify(event.data)))
    database.query("UPDATE session_heads SET seq = ?, revision = revision + 1, updated_at = MAX(updated_at, ?) WHERE id = ?")
      .run(base + fresh.length, fresh.reduce((latest, event) => Math.max(latest, event.at), 0), plan.id)
  })
  database.query("INSERT INTO session_log_imports VALUES (?, ?)").run(sourceId, Date.now())
  return { refused: Option.none(), skipped }
}).immediate()
