import { Array as Arr, Clock, Effect, Layer, Option, Ref } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import { SessionLog } from "../ports/session-log.port.js"
import { LeaseExpired, RevisionConflict, SessionExists, SessionLogError, SessionMissing } from "./session-log.entity.js"
import type { JsonObject, SessionCommitted, SessionHead, SessionHeader, SessionLogEvent } from "./session-log.entity.js"
import { storedJson } from "./session-log.entity.functions.js"
import { sessionAttributes } from "./sessions.entity.functions.js"

/** A head as stored (its `now` is added when read) and the session's events. */
interface Stored {
  readonly head: Omit<SessionHead, "now">
  readonly events: ReadonlyArray<SessionLogEvent>
}

type Store = ReadonlyMap<string, Stored>

/** What a caller hands the log, as a store on disk would keep it; a value JSON cannot hold fails with `store.encode`. */
const encoded = (value: JsonObject): Effect.Effect<JsonObject, SessionLogError> =>
  storedJson(value).pipe(Effect.mapError((error) => new SessionLogError({ code: "store.encode", message: `the data is not JSON: ${error.message}` })))

/** Stored JSON is copied out: what a caller later mutates never reaches the log. */
const copyHeader = (header: SessionHeader): SessionHeader => ({
  ...header, meta: structuredClone(header.meta), parent: Option.map(header.parent, (parent) => ({ ...parent })),
})
const copyHead = (head: Omit<SessionHead, "now">, now: number): SessionHead => ({
  ...head, header: copyHeader(head.header), state: structuredClone(head.state), now,
})
const copyEvent = (event: SessionLogEvent): SessionLogEvent => ({
  ...event, turn: Option.map(event.turn, (turn) => turn), data: structuredClone(event.data),
})

/** Every session under `ids`, their children, and theirs. */
const withDescendants = (all: Store, ids: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set([...ids, ...[...all.entries()].flatMap(([id, session]) =>
    Option.match(session.head.header.parent, { onNone: () => [], onSome: (parent) => ids.has(parent.id) ? [id] : [] }))])
  return next.size === ids.size ? ids : withDescendants(all, next)
}

const olderThan = (cursor: { readonly updatedAt: number; readonly id: string }) => (head: Omit<SessionHead, "now">): boolean =>
  head.updatedAt < cursor.updatedAt || (head.updatedAt === cursor.updatedAt && head.header.id < cursor.id)

/** The session an operation reads or writes, on the operation's span. */
const onSession = <A, E, R>(effect: Effect.Effect<A, E, R>, id: ConversationId): Effect.Effect<A, E, R> =>
  Effect.annotateCurrentSpan(sessionAttributes(id)).pipe(Effect.andThen(effect))

/**
 * The session log held in memory, for tests and single-process hosts. Its
 * clock is the Effect clock, so a TestClock drives leases. Each operation
 * runs under its span, `session_log.<op>`, which carries
 * `efferent.session.id` when the operation names a session.
 */
export const SessionLogMemoryLive: Layer.Layer<SessionLog> = Layer.effect(SessionLog, Effect.gen(function* () {
  const store = yield* Ref.make<Store>(new Map())
  const now = Clock.currentTimeMillis
  const missing = (id: ConversationId) => new SessionMissing({ session: id })

  return SessionLog.of({
    create: Effect.fn("session_log.create")(function* (header) {
      return yield* Effect.all([encoded(header.meta), now], { concurrency: 1 }).pipe(Effect.flatMap(([meta, at]) => Ref.modify(store, (all): readonly [Effect.Effect<SessionHead, SessionExists | SessionMissing>, Store] => {
        if (all.has(header.id)) return [Effect.fail(new SessionExists({ session: header.id })), all]
        if (Option.isSome(header.parent) && !all.has(header.parent.value.id)) return [Effect.fail(missing(header.parent.value.id)), all]
        const head = { header: { ...header, meta, parent: Option.map(header.parent, (parent) => ({ ...parent })) }, seq: 0, revision: 0, state: {}, updatedAt: at }
        return [Effect.succeed(copyHead(head, at)), new Map([...all, [header.id, { head, events: [] }]])]
      })), Effect.flatten)
    }, (effect, header) => onSession(effect, header.id)),
    head: Effect.fn("session_log.head")(function* (id) {
      const at = yield* now
      const session = (yield* Ref.get(store)).get(id)
      return session === undefined ? yield* Effect.fail(missing(id)) : copyHead(session.head, at)
    }, onSession),
    list: Effect.fn("session_log.list")(function* (query) {
      const at = yield* now
      const heads = [...(yield* Ref.get(store)).values()].map((session) => session.head)
        .filter((head) => head.header.owner === query.owner)
        .filter((head) => Option.match(query.parent, {
          onNone: () => Option.isNone(head.header.parent),
          onSome: (parent) => Option.exists(head.header.parent, (lineage) => lineage.id === parent),
        }))
        .filter(Option.match(query.before, { onNone: () => () => true, onSome: olderThan }))
        .sort((left, right) => right.updatedAt - left.updatedAt || (right.header.id < left.header.id ? -1 : right.header.id > left.header.id ? 1 : 0))
      return heads.slice(0, Math.max(0, query.limit)).map((head) => copyHead(head, at))
    }),
    read: Effect.fn("session_log.read")(function* (id, query) {
      return yield* Ref.get(store).pipe(Effect.flatMap((all) => {
        const session = all.get(id)
        if (session === undefined) return Effect.fail(missing(id))
        const events = session.events.filter((event) => event.seq > query.after && (query.through === undefined || event.seq <= query.through) && (query.kinds.length === 0 || query.kinds.includes(event.kind)))
        return Effect.succeed(Option.match(query.limit, { onNone: () => events, onSome: (limit) => events.slice(0, Math.max(0, limit)) }).map(copyEvent))
      }))
    }, onSession),
    commit: Effect.fn("session_log.commit")(function* (id, commit) {
      return yield* Effect.all([
        Effect.forEach(commit.events, (draft) => encoded(draft.data), { concurrency: 1 }),
        Option.match(commit.state, { onNone: () => Effect.succeedNone, onSome: (state) => Effect.map(encoded(state), Option.some) }),
        now,
      ], { concurrency: 1 }).pipe(Effect.flatMap(([data, state, at]) => Ref.modify(store, (all): readonly [Effect.Effect<SessionCommitted, RevisionConflict | LeaseExpired | SessionMissing>, Store] => {
        const session = all.get(id)
        if (session === undefined) return [Effect.fail(missing(id)), all]
        if (session.head.revision !== commit.expect) {
          return [Effect.fail(new RevisionConflict({ session: id, expected: commit.expect, actual: session.head.revision })), all]
        }
        if (Option.isSome(commit.notAfter) && at > commit.notAfter.value) {
          return [Effect.fail(new LeaseExpired({ session: id, notAfter: commit.notAfter.value, now: at })), all]
        }
        const events = Arr.zip(commit.events, data).map(([draft, stored], index): SessionLogEvent => ({
          session: id, seq: session.head.seq + index + 1, turn: Option.map(draft.turn, (turn) => turn), kind: draft.kind, at, data: stored,
        }))
        const head = {
          ...session.head,
          seq: session.head.seq + events.length,
          revision: session.head.revision + 1,
          state: Option.getOrElse(state, () => session.head.state),
          updatedAt: at,
        }
        return [
          Effect.succeed({ revision: head.revision, seq: head.seq, events: events.map(copyEvent), at }),
          new Map([...all, [id, { head, events: [...session.events, ...events] }]]),
        ]
      })), Effect.flatten)
    }, onSession),
    remove: Effect.fn("session_log.remove")(function* (id) {
      yield* Ref.update(store, (all) => {
        const removed = withDescendants(all, new Set([id]))
        return new Map([...all].filter(([key]) => !removed.has(key)))
      })
    }, onSession),
  })
}))
