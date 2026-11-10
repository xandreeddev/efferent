import { Array as Arr, Clock, Effect, Layer, Option, Ref } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import { SessionLog } from "../ports/session-log.port.js"
import { randomUuid } from "../internal/random-id.entity.functions.js"
import { LeaseExpired, RevisionConflict, SessionExists, SessionIncarnation, SessionLogError, SessionMissing } from "./session-log.entity.js"
import type { JsonObject, SessionCommitted, SessionHead, SessionHeader, SessionLogEvent, SessionRef } from "./session-log.entity.js"
import { storedJson } from "./session-log.entity.functions.js"
import { sessionAttributes } from "./sessions.entity.functions.js"

/** A head as stored (its `now` is added when read) and the session's events. */
interface Stored {
  readonly head: Omit<SessionHead, "now">
  readonly events: ReadonlyArray<SessionLogEvent>
}

type Store = ReadonlyMap<string, Stored>
const matches = (reference: SessionRef, stored: Stored): boolean => reference.owner === stored.head.header.owner && reference.incarnation === stored.head.incarnation

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

/** Every session under `ids`, their children (whose parent reference names one of them whole: id, owner and incarnation), and theirs. */
const withDescendants = (all: Store, ids: ReadonlySet<string>): ReadonlySet<string> => {
  const next = new Set([...ids, ...[...all.entries()].flatMap(([id, session]) =>
    Option.match(session.head.header.parent, {
      onNone: () => [],
      onSome: (parent) => ids.has(parent.id) && Option.exists(Option.fromNullishOr(all.get(parent.id)), (stored) => matches(parent, stored)) ? [id] : [],
    }))])
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
    create: Effect.fn("session_log.create")(function* ({ header, state: initial }) {
      return yield* Effect.all([encoded(header.meta), now, randomUuid, encoded(initial)], { concurrency: 1 }).pipe(Effect.flatMap(([meta, at, minted, initial]) => Ref.modify(store, (all): readonly [Effect.Effect<SessionHead, SessionExists | SessionMissing>, Store] => {
        if (all.has(header.id)) return [Effect.fail(new SessionExists({ session: header.id })), all]
        // A child's parent is a live session of the child's own owner, named whole.
        if (Option.isSome(header.parent) && (header.parent.value.owner !== header.owner || all.get(header.parent.value.id) === undefined || !matches(header.parent.value, all.get(header.parent.value.id)!))) return [Effect.fail(missing(header.parent.value.id)), all]
        const head = {
          header: { ...header, meta, parent: Option.map(header.parent, (parent) => ({ ...parent })) },
          incarnation: SessionIncarnation.make(minted), seq: 0, revision: 0, state: initial, updatedAt: at,
        }
        return [Effect.succeed(copyHead(head, at)), new Map([...all, [header.id, { head, events: [] }]])]
      })), Effect.flatten)
    }, (effect, input) => onSession(effect, input.header.id)),
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
          onSome: (parent) => Option.exists(head.header.parent, (lineage) => lineage.id === parent.id && lineage.owner === parent.owner && lineage.incarnation === parent.incarnation),
        }))
        .filter(Option.match(query.before, { onNone: () => () => true, onSome: olderThan }))
        .sort((left, right) => right.updatedAt - left.updatedAt || (right.header.id < left.header.id ? -1 : right.header.id > left.header.id ? 1 : 0))
      return heads.slice(0, Math.max(0, query.limit)).map((head) => copyHead(head, at))
    }),
    read: Effect.fn("session_log.read")(function* (reference, query) {
      const id = reference.id
      return yield* Ref.get(store).pipe(Effect.flatMap((all) => {
        const session = all.get(id)
        if (session === undefined || !matches(reference, session)) return Effect.fail(missing(id))
        const events = session.events.filter((event) => event.seq > query.after && (query.through === undefined || event.seq <= query.through) && (query.kinds.length === 0 || query.kinds.includes(event.kind)))
        // From the end, the newest `limit` matches, still ascending.
        const kept = Option.match(query.limit, {
          onNone: () => events,
          onSome: (limit) => query.from === "end" ? events.slice(Math.max(0, events.length - Math.max(0, limit))) : events.slice(0, Math.max(0, limit)),
        })
        return Effect.succeed(kept.map(copyEvent))
      }))
    }, (effect, reference) => onSession(effect, reference.id)),
    commit: Effect.fn("session_log.commit")(function* (reference, commit) {
      const id = reference.id
      return yield* Effect.all([
        Effect.forEach(commit.events, (draft) => encoded(draft.data), { concurrency: 1 }),
        Option.match(commit.state, { onNone: () => Effect.succeedNone, onSome: (state) => Effect.map(encoded(state), Option.some) }),
        now,
      ], { concurrency: 1 }).pipe(Effect.flatMap(([data, state, at]) => Ref.modify(store, (all): readonly [Effect.Effect<SessionCommitted, RevisionConflict | LeaseExpired | SessionMissing>, Store] => {
        const session = all.get(id)
        // A session removed and created again under its id is another incarnation: missing to a writer of the one before.
        if (session === undefined || !matches(reference, session)) return [Effect.fail(missing(id)), all]
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
    }, (effect, reference) => onSession(effect, reference.id)),
    remove: Effect.fn("session_log.remove")(function* (reference) {
      return yield* Ref.modify(store, (all): readonly [Effect.Effect<void, SessionMissing>, Store] => {
        const current = all.get(reference.id)
        if (current === undefined || !matches(reference, current)) return [Effect.fail(missing(reference.id)), all]
        const removed = withDescendants(all, new Set([reference.id]))
        return [Effect.void, new Map([...all].filter(([key]) => !removed.has(key)))]
      }).pipe(Effect.flatten)
    }, (effect, reference) => onSession(effect, reference.id)),
  })
}))
