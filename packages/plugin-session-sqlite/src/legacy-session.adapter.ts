import { Database } from "bun:sqlite"
import { Option, Schema } from "effect"
import { canonicalJson, SessionEvent, SessionRecord } from "@xandreed/core"

const recordOf = Schema.decodeUnknownSync(Schema.fromJsonString(SessionRecord))
const eventOf = Schema.decodeUnknownSync(Schema.fromJsonString(SessionEvent))
const hasTable = (database: Database, name: string) => database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null
const canonical = (data: Readonly<Record<string, unknown>>) => canonicalJson(data)

/**
 * Import frozen pre-log tables once in the destination's IMMEDIATE transaction.
 * Sources stay read only; markers survive pruning. A conflicting identity or
 * position refuses the entire source before any row is changed.
 */
export const importLegacySessions = (database: Database, source: Database, sourceId: string, owner: Option.Option<string> = Option.none()): Option.Option<string> => {
  database.exec("CREATE TABLE IF NOT EXISTS session_log_imports (source TEXT PRIMARY KEY, imported_at INTEGER NOT NULL)")
  return database.transaction((): Option.Option<string> => {
    if (database.query("SELECT source FROM session_log_imports WHERE source = ?").get(sourceId) !== null) return Option.none()
    const harness = hasTable(source, "harness_sessions") ? source.query<{ body: string }, []>("SELECT body FROM harness_sessions ORDER BY rowid").all().map((row) => recordOf(row.body)).map((record) => ({
      id: record.id, owner: record.workspace, origin: "harness", createdAt: record.createdAt,
      meta: { workspace: record.workspace, profile: record.profile, projection: "harness", ...Option.match(Option.fromNullishOr(record.parent), { onNone: () => ({}), onSome: (parent) => ({ legacyParent: parent }) }) },
      events: source.query<{ body: string }, [string]>("SELECT body FROM harness_events WHERE session_id = ? ORDER BY seq").all(record.id).map((row) => eventOf(row.body)).map((event) => ({ kind: "harness.event", at: event.at, data: { event } as Readonly<Record<string, unknown>> })),
    })) : []
    const conversationRows = hasTable(source, "conversations") ? source.query<{ id: string; workspace_dir: string | null; title: string | null; created_at: number }, []>("SELECT id, workspace_dir, title, created_at FROM conversations ORDER BY rowid").all() : []
    // Historical domain hosts wrote messages under the harness id without
    // creating a second conversation row. Preserve those rows too; an unknown
    // orphan is isolated under the compatibility owner's namespace.
    const orphanRows = hasTable(source, "messages") ? source.query<{ id: string; created_at: number }, []>(`SELECT conversation_id AS id, MIN(created_at) AS created_at FROM messages ${hasTable(source, "conversations") ? "WHERE conversation_id NOT IN (SELECT id FROM conversations)" : ""} GROUP BY conversation_id`).all().map((row) => {
      const target = database.query<{ owner: string; created_at: number }, [string]>("SELECT owner, created_at FROM session_heads WHERE id = ?").get(row.id)
      const planned = harness.find((header) => header.id === row.id)
      return { id: row.id, workspace_dir: planned?.owner ?? Option.getOrElse(owner, () => "conversation-store"), title: null, created_at: target?.created_at ?? planned?.createdAt ?? row.created_at }
    }) : []
    const conversations = [...conversationRows, ...orphanRows].map((row) => ({
      id: row.id, owner: row.workspace_dir ?? "conversation-store", origin: "conversation", createdAt: row.created_at,
      meta: { workspace: row.workspace_dir ?? "conversation-store", projection: "conversation" },
      events: [
        ...source.query<{ position: number; content: string; created_at: number }, [string]>("SELECT position, content, created_at FROM messages WHERE conversation_id = ? ORDER BY position").all(row.id).map((message) => ({ kind: "conversation.message", at: message.created_at, data: { position: message.position, content: message.content } as Readonly<Record<string, unknown>> })),
        ...source.query<{ message_position: number; summary: string; created_at: number }, [string]>("SELECT message_position, summary, created_at FROM checkpoints WHERE conversation_id = ? ORDER BY rowid").all(row.id).map((checkpoint) => ({ kind: "conversation.checkpoint", at: checkpoint.created_at, data: { messagePosition: checkpoint.message_position, summary: checkpoint.summary, createdAt: checkpoint.created_at } })),
        ...(row.title === null ? [] : [{ kind: "conversation.title", at: row.created_at, data: { title: row.title } }]),
        ...(hasTable(source, "run_outcomes") ? source.query<{ at: number; outcome: string; reason: string }, [string]>("SELECT at, outcome, reason FROM run_outcomes WHERE conversation_id = ? ORDER BY at, rowid").all(row.id).map((outcome) => ({ kind: "conversation.outcome", at: outcome.at, data: { outcome: outcome.outcome, reason: outcome.reason, at: outcome.at } })) : []),
      ],
    }))
    const plans = [...harness, ...conversations].map((plan) => ({ ...plan,
      previous: database.query<{ kind: string; data: string }, [string]>("SELECT kind, data FROM session_log_events WHERE session_id = ? ORDER BY seq").all(plan.id),
    }))
    const identityConflict = plans.find((plan) => {
      const head = database.query<{ owner: string; origin: string; created_at: number; meta: string }, [string]>("SELECT owner, origin, created_at, meta FROM session_heads WHERE id = ?").get(plan.id)
      return plans.some((other) => other.id === plan.id && other.owner !== plan.owner) || (head !== null && (head.owner !== plan.owner || (head.origin === plan.origin && head.created_at !== plan.createdAt)))
    })
    if (identityConflict !== undefined) return Option.some(`session ${identityConflict.id} has a conflicting legacy identity`)
    const positionConflict = plans.find((plan) => plan.events.some((incoming) => {
      const data = incoming.data as Readonly<Record<string, unknown>>
      const key = incoming.kind === "harness.event" ? "event" : incoming.kind === "conversation.message" ? "position" : ""
      if (key === "") return false
      return plan.previous.some((previous) => {
        if (previous.kind !== incoming.kind) return false
        const earlier = JSON.parse(previous.data) as Readonly<Record<string, unknown>>
        const samePosition = key === "position" ? earlier.position === data.position : typeof earlier.event === "object" && earlier.event !== null && "seq" in earlier.event && typeof data.event === "object" && data.event !== null && "seq" in data.event && earlier.event.seq === data.event.seq
        return samePosition && canonical(earlier) !== canonical(data)
      })
    }))
    if (positionConflict !== undefined) return Option.some(`session ${positionConflict.id} has a conflicting legacy position`)
    const header = database.query("INSERT OR IGNORE INTO session_heads (id, owner, origin, created_at, meta, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    plans.forEach((plan) => {
      header.run(plan.id, plan.owner, plan.origin, plan.createdAt, JSON.stringify(plan.meta), plan.createdAt)
      plan.events.filter((event) => !plan.previous.some((previous) => previous.kind === event.kind && canonical(JSON.parse(previous.data) as Readonly<Record<string, unknown>>) === canonical(event.data))).forEach((event) => {
        const current = database.query<{ seq: number }, [string]>("SELECT seq FROM session_heads WHERE id = ?").get(plan.id)
        const seq = (current?.seq ?? 0) + 1
        database.query("INSERT INTO session_log_events (session_id, seq, turn, kind, at, data) VALUES (?, ?, NULL, ?, ?, ?)").run(plan.id, seq, event.kind, event.at, JSON.stringify(event.data))
        database.query("UPDATE session_heads SET seq = ?, revision = revision + 1, updated_at = MAX(updated_at, ?) WHERE id = ?").run(seq, event.at, plan.id)
      })
    })
    database.query("INSERT INTO session_log_imports VALUES (?, ?)").run(sourceId, Date.now())
    return Option.none()
  }).immediate()
}
