import { Clock, Effect, Layer, Option, Ref } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import { SessionLog } from "../ports/session-log.port.js"
import { LeaseExpired, RevisionConflict, SessionExists, SessionMissing } from "./session-log.entity.js"
import type { JsonObject, SessionCommitted, SessionHead, SessionLogEvent } from "./session-log.entity.js"

/** A head as stored (its `now` is added when read) and the session's events. */
interface Stored {
  readonly head: Omit<SessionHead, "now">
  readonly events: ReadonlyArray<SessionLogEvent>
}

type Store = ReadonlyMap<string, Stored>

/** Stored JSON is a copy: what a caller later mutates never reaches the log. */
const stored = (value: JsonObject): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject

/** Every session under `ids`, their children, and theirs. */
const withDescendants = (all: Store, ids: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set([...ids, ...[...all.entries()].flatMap(([id, session]) =>
    Option.match(session.head.header.parent, { onNone: () => [], onSome: (parent) => ids.has(parent.id) ? [id] : [] }))])
  return next.size === ids.size ? ids : withDescendants(all, next)
}

const olderThan = (cursor: { readonly updatedAt: number; readonly id: string }) => (head: Omit<SessionHead, "now">): boolean =>
  head.updatedAt < cursor.updatedAt || (head.updatedAt === cursor.updatedAt && head.header.id < cursor.id)

/**
 * The session log held in memory, for tests and single-process hosts. Its
 * clock is the Effect clock, so a TestClock drives leases.
 */
export const SessionLogMemoryLive: Layer.Layer<SessionLog> = Layer.effect(SessionLog, Effect.gen(function* () {
  const store = yield* Ref.make<Store>(new Map())
  const now = Clock.currentTimeMillis
  const missing = (id: ConversationId) => new SessionMissing({ session: id })

  return SessionLog.of({
    create: (header) => now.pipe(Effect.flatMap((at) => Ref.modify(store, (all): readonly [Effect.Effect<SessionHead, SessionExists | SessionMissing>, Store] => {
      if (all.has(header.id)) return [Effect.fail(new SessionExists({ session: header.id })), all]
      if (Option.isSome(header.parent) && !all.has(header.parent.value.id)) return [Effect.fail(missing(header.parent.value.id)), all]
      const head = { header: { ...header, meta: stored(header.meta) }, seq: 0, revision: 0, state: {}, updatedAt: at }
      return [Effect.succeed({ ...head, now: at }), new Map([...all, [header.id, { head, events: [] }]])]
    })), Effect.flatten),
    head: (id) => Effect.gen(function* () {
      const at = yield* now
      const session = (yield* Ref.get(store)).get(id)
      return session === undefined ? yield* Effect.fail(missing(id)) : { ...session.head, now: at }
    }),
    list: (query) => Effect.gen(function* () {
      const at = yield* now
      const heads = [...(yield* Ref.get(store)).values()].map((session) => session.head)
        .filter((head) => head.header.owner === query.owner)
        .filter((head) => Option.match(query.parent, {
          onNone: () => Option.isNone(head.header.parent),
          onSome: (parent) => Option.exists(head.header.parent, (lineage) => lineage.id === parent),
        }))
        .filter(Option.match(query.before, { onNone: () => () => true, onSome: olderThan }))
        .sort((left, right) => right.updatedAt - left.updatedAt || (right.header.id < left.header.id ? -1 : right.header.id > left.header.id ? 1 : 0))
      return heads.slice(0, Math.max(0, query.limit)).map((head) => ({ ...head, now: at }))
    }),
    read: (id, query) => Ref.get(store).pipe(Effect.flatMap((all) => {
      const session = all.get(id)
      if (session === undefined) return Effect.fail(missing(id))
      const events = session.events.filter((event) => event.seq > query.after && (query.kinds.length === 0 || query.kinds.includes(event.kind)))
      return Effect.succeed(Option.match(query.limit, { onNone: () => events, onSome: (limit) => events.slice(0, Math.max(0, limit)) }))
    })),
    commit: (id, commit) => now.pipe(Effect.flatMap((at) => Ref.modify(store, (all): readonly [Effect.Effect<SessionCommitted, RevisionConflict | LeaseExpired | SessionMissing>, Store] => {
      const session = all.get(id)
      if (session === undefined) return [Effect.fail(missing(id)), all]
      if (session.head.revision !== commit.expect) {
        return [Effect.fail(new RevisionConflict({ session: id, expected: commit.expect, actual: session.head.revision })), all]
      }
      if (Option.isSome(commit.notAfter) && at > commit.notAfter.value) {
        return [Effect.fail(new LeaseExpired({ session: id, notAfter: commit.notAfter.value, now: at })), all]
      }
      const events = commit.events.map((draft, index): SessionLogEvent => ({
        session: id, seq: session.head.seq + index + 1, turn: draft.turn, kind: draft.kind, at, data: stored(draft.data),
      }))
      const head = {
        ...session.head,
        seq: session.head.seq + events.length,
        revision: session.head.revision + 1,
        state: Option.match(commit.state, { onNone: () => session.head.state, onSome: stored }),
        updatedAt: at,
      }
      return [
        Effect.succeed({ revision: head.revision, seq: head.seq, events, at }),
        new Map([...all, [id, { head, events: [...session.events, ...events] }]]),
      ]
    })), Effect.flatten),
    remove: (id) => Ref.update(store, (all) => {
      const removed = withDescendants(all, new Set([id]))
      return new Map([...all].filter(([key]) => !removed.has(key)))
    }),
  })
}))
