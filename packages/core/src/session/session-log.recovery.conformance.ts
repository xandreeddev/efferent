import { Effect, Exit, Fiber, Option, Scope } from "effect"
import type { Context } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { atTime, check, expect, fail, freshId, headerOf } from "../conformance.functions.js"
import type { ConversationId } from "../domain/message.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import type { SessionLog } from "../ports/session-log.port.js"
import type { JsonObject, SessionDraft, SessionLogError } from "./session-log.entity.js"

type Log = Context.Service.Shape<typeof SessionLog>

/**
 * A SessionLog backend as the recovery kit opens it. Each run of `open` is a
 * new handle on the same stored data (a new connection to the same file or
 * server), released with its scope; the kit opens several at once and opens
 * again after closing. An in-memory backend passes only when every `open`
 * returns a log over the same store (build it once and `Effect.succeed` it):
 * a fresh `SessionLogMemoryLive` per open starts empty.
 */
export interface SessionLogSubject {
  readonly open: Effect.Effect<Log, SessionLogError, Scope.Scope>
  /**
   * The backend stamps commits and heads with the caller's Effect `Clock`
   * (the memory and SQLite logs do), so the kit can stop the clock and check
   * the `notAfter` boundary to the millisecond.
   */
  readonly callerClock?: boolean
}

const draft = (kind: string, data: JsonObject, turn: Option.Option<number> = Option.none()): SessionDraft => ({ kind, turn, data })
const noState = { notAfter: Option.none<number>(), state: Option.none<JsonObject>() }
const everything = { after: 0, limit: Option.none<number>(), kinds: [] }
const range = (length: number) => Array.from({ length }, (_, n) => n)

/** A value that must come back equal whatever key order the store keeps. */
const rich: JsonObject = { zeta: 1, alpha: { b: [true, false, { y: "ü", x: 0.5 }], a: "text ✓" }, empty: {}, list: [] }

/** A session as one handle reads it, and as text without the read time: what every handle must agree on. */
const seen = (log: Log, id: ConversationId) => Effect.all([log.head(id), log.read(id, everything)], { concurrency: 1 }).pipe(Effect.map(([head, events]) => ({
  seq: head.seq,
  revision: head.revision,
  state: head.state,
  events,
  text: canonicalJson({
    header: { ...head.header, parent: Option.getOrNull(head.header.parent) },
    seq: head.seq,
    revision: head.revision,
    state: head.state,
    updatedAt: head.updatedAt,
    events: events.map((event) => ({ ...event, turn: Option.getOrNull(event.turn) })),
  }),
})))

/** An owner's listing as text, without the read time. */
const listed = (log: Log, owner: string) => log.list({ owner, limit: 10, before: Option.none(), parent: Option.none() }).pipe(
  Effect.map((heads) => canonicalJson(heads.map((head) => ({ id: head.header.id, seq: head.seq, revision: head.revision, updatedAt: head.updatedAt })))),
)

/**
 * Add one to the session's `count` by compare-and-swap through `log`: read
 * the head, let the other writers run, commit against that revision, and
 * read again after a conflict. Returns the revision it stored.
 */
const increment = (log: Log, id: ConversationId, by: string, n: number, tries = 0): Effect.Effect<number, unknown> => Effect.gen(function* () {
  const head = yield* log.head(id)
  yield* Effect.yieldNow
  const count = typeof head.state.count === "number" ? head.state.count : 0
  const outcome = yield* Effect.result(log.commit(id, {
    expect: head.revision, notAfter: Option.none(), events: [draft("increment", { by, n })], state: Option.some({ count: count + 1 }),
  }))
  if (outcome._tag === "Success") return outcome.success.revision
  return outcome.failure._tag === "RevisionConflict" && tries < 100 ? yield* increment(log, id, by, n, tries + 1) : yield* Effect.fail(outcome.failure)
})

/**
 * What a SessionLog backend must keep across handles, restarts and
 * interruptions, as checks: commits survive closing and opening again
 * (twice); two open handles see each other's commits and race by
 * compare-and-swap with exactly one winner per revision and no lost or
 * doubled event; an interrupted commit is stored whole or not at all, and has
 * settled by the time the interrupt returns (a backend whose write can land
 * after its caller stops waiting, such as a request already sent to a
 * server, makes that write uninterruptible); a handle whose scope never
 * closed (leaked, or held by a process that hangs) blocks nobody; and, with
 * `callerClock`, a commit at exactly its `notAfter` is stored at that time
 * while one a millisecond later is refused. Every check uses fresh ids and
 * owners, so the kit is safe on a shared database; each must finish within
 * 30 seconds, so a handle that waits on another fails instead of hanging.
 */
export const sessionLogRecoveryConformance = (subject: SessionLogSubject): ReadonlyArray<ConformanceCheck> => {
  const recovery = (name: string, id: string, body: (owner: string) => Effect.Effect<void, unknown, Scope.Scope>): ConformanceCheck =>
    check(name, id, (owner) => Effect.timeoutOrElse(Effect.scoped(body(owner)), {
      duration: "30 seconds",
      orElse: () => fail(id, "the check did not finish in 30 seconds: a handle waits on another"),
    }))
  const reading = (id: ConversationId) => Effect.scoped(subject.open.pipe(Effect.flatMap((log) => seen(log, id))))

  return [
    recovery("what a handle committed is all there after it closes and the store is opened again", "reopen", (owner) => Effect.gen(function* () {
      const [id, other] = [yield* freshId, yield* freshId]
      const before = yield* Effect.scoped(Effect.gen(function* () {
        const log = yield* subject.open
        yield* log.create(headerOf(id, owner))
        yield* log.create(headerOf(other, owner))
        yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [draft("a", { n: 1 }, Option.some(1)), draft("b", rich, Option.some(1))], state: Option.some({ open: { turn: 1 } }) })
        yield* log.commit(id, { expect: 1, ...noState, events: [draft("c", { n: 3 })] })
        yield* log.commit(other, { expect: 0, notAfter: Option.none(), events: [], state: Option.some({ title: "other" }) })
        return { session: yield* seen(log, id), listing: yield* listed(log, owner) }
      }))
      yield* expect("reopen", before.session.seq === 3 && before.session.revision === 2, `the writing handle read seq ${before.session.seq}, revision ${before.session.revision}`)
      const after = yield* subject.open.pipe(Effect.flatMap((log) => Effect.all({ session: seen(log, id), listing: listed(log, owner) }, { concurrency: 1 })))
      yield* expect("reopen", after.session.text === before.session.text, `after reopening the session reads ${after.session.text}, not ${before.session.text}`)
      yield* expect("reopen", after.listing === before.listing, `after reopening the listing is ${after.listing}, not ${before.listing}`)
    })),
    recovery("opening an existing store again is idempotent: twice more, nothing is lost and commits go on", "reopen-twice", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      const written = yield* Effect.scoped(Effect.gen(function* () {
        const log = yield* subject.open
        yield* log.create(headerOf(id, owner))
        yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [draft("a", { n: 1 })], state: Option.some({ n: 1 }) })
        return yield* seen(log, id)
      }))
      const first = yield* reading(id)
      const second = yield* reading(id)
      yield* expect("reopen-twice", first.text === written.text && second.text === written.text, "opening the store again changed what it holds")
      const log = yield* subject.open
      const next = yield* log.commit(id, { expect: 1, ...noState, events: [draft("b", { n: 2 })] })
      yield* expect("reopen-twice", next.revision === 2 && next.seq === 2 && next.events[0]?.seq === 2, `the next commit stored revision ${next.revision}, seq ${next.seq}`)
    })),
    recovery("two open handles see each other's commits at once, and a stale revision through either is refused", "cross-handle", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      const [a, b] = [yield* subject.open, yield* subject.open]
      yield* a.create(headerOf(id, owner))
      yield* expect("cross-handle", (yield* b.head(id)).revision === 0, "the other handle reads a revision for a new session")
      yield* a.commit(id, { expect: 0, ...noState, events: [draft("a", { by: "a" })] })
      const fromB = yield* seen(b, id)
      yield* expect("cross-handle", fromB.revision === 1 && fromB.events.map((event) => event.kind).join() === "a", `the other handle reads revision ${fromB.revision}`)
      yield* b.commit(id, { expect: 1, notAfter: Option.none(), events: [draft("b", { by: "b" })], state: Option.some({ by: "b" }) })
      const fromA = yield* seen(a, id)
      yield* expect("cross-handle", fromA.revision === 2 && fromA.events.map((event) => event.kind).join() === "a,b" && fromA.state.by === "b", `the first handle reads revision ${fromA.revision}`)
      yield* expect("cross-handle", fromA.text === (yield* seen(b, id)).text, "the two handles read the session differently")
      const stale = yield* Effect.flip(a.commit(id, { expect: 1, ...noState, events: [draft("stale", {})] }))
      yield* expect("cross-handle", stale._tag === "RevisionConflict" && stale.actual === 2, `a stale commit gave ${stale._tag}`)
      const listing = yield* b.list({ owner, limit: 10, before: Option.none(), parent: Option.none() })
      yield* expect("cross-handle", listing.length === 1 && listing[0]?.revision === 2, "the other handle does not list the session as it is")
    })),
    recovery("of compare-and-swap commits racing through two handles, exactly one wins each revision, and none is lost or stored twice", "cross-handle-race", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      const handles = [yield* subject.open, yield* subject.open]
      yield* handles[0]!.create(headerOf(id, owner))
      const attempts = yield* Effect.forEach(range(8), (n) => Effect.result(handles[n % 2]!.commit(id, {
        expect: 0, notAfter: Option.none(), events: [draft("attempt", { n })], state: Option.some({ winner: n }),
      })), { concurrency: "unbounded" })
      const won = attempts.filter((attempt) => attempt._tag === "Success")
      const refused = attempts.filter((attempt) => attempt._tag === "Failure" && attempt.failure._tag === "RevisionConflict")
      yield* expect("cross-handle-race", won.length === 1 && refused.length === 7, `of eight commits against one revision, ${won.length} won and ${refused.length} were refused`)
      const rounds = 12
      const stored = yield* Effect.forEach(handles, (log, side) => Effect.forEach(range(rounds), (n) => increment(log, id, `handle-${side}`, n), { concurrency: 1 }), { concurrency: "unbounded" })
      const revisions = stored.flat().toSorted((left, right) => left - right)
      yield* expect("cross-handle-race", revisions.join() === range(rounds * 2).map((n) => n + 2).join(), `the increments stored revisions ${revisions.join()}`)
      const final = yield* reading(id)
      const increments = final.events.filter((event) => event.kind === "increment")
      yield* expect("cross-handle-race", final.revision === rounds * 2 + 1 && final.seq === rounds * 2 + 1 && final.state.count === rounds * 2,
        `after ${rounds * 2} increments: revision ${final.revision}, seq ${final.seq}, count ${JSON.stringify(final.state.count)}`)
      yield* expect("cross-handle-race", handles.every((_, side) =>
        increments.filter((event) => event.data.by === `handle-${side}`).map((event) => event.data.n).join() === range(rounds).join()),
      "an increment was lost, stored twice or out of order")
    })),
    recovery("an interrupted commit leaves all of its events or none, and the session takes the next commit", "interrupted-commit", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      const parts = 40
      const before = yield* Effect.scoped(Effect.gen(function* () {
        const log = yield* subject.open
        yield* log.create(headerOf(id, owner))
        // Interrupted at once, after one yield and after a few: wherever the backend is when it lands.
        yield* Effect.forEach([0, 1, 4], (yields, batch) => Effect.gen(function* () {
          const head = yield* log.head(id)
          const fiber = yield* Effect.forkChild(log.commit(id, {
            expect: head.revision, notAfter: Option.none(), events: range(parts).map((n) => draft("part", { batch, n })), state: Option.some({ batch }),
          }))
          yield* Effect.forEach(range(yields), () => Effect.yieldNow, { concurrency: 1, discard: true })
          yield* Fiber.interrupt(fiber)
          const after = yield* seen(log, id)
          const written = after.events.filter((event) => event.data.batch === batch).length
          const whole = written === parts && after.revision === head.revision + 1 && canonicalJson(after.state) === canonicalJson({ batch })
          const nothing = written === 0 && after.revision === head.revision && after.seq === head.seq
          yield* expect("interrupted-commit", whole || nothing, `an interrupted commit left ${written} of its ${parts} events at revision ${after.revision}`)
          yield* expect("interrupted-commit", after.events.every((event, index) => event.seq === index + 1) && after.seq === after.events.length, "the sequence has a gap")
        }), { concurrency: 1, discard: true })
        return yield* seen(log, id)
      }))
      const log = yield* subject.open
      const reopened = yield* seen(log, id)
      yield* expect("interrupted-commit", reopened.text === before.text, "after reopening the session differs from what the interrupted handle read")
      const next = yield* log.commit(id, { expect: reopened.revision, ...noState, events: [draft("next", {})] })
      yield* expect("interrupted-commit", next.revision === reopened.revision + 1 && next.seq === reopened.seq + 1, "the commit after the interrupted ones was not stored next")
    })),
    recovery("a handle whose scope never closed blocks nothing: a new handle reads all it committed and commits after it", "unclosed-handle", (owner) => Effect.gen(function* () {
      const id = yield* freshId
      // Left open, as by a process that stopped; closed only once the check is over.
      const abandoned = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(abandoned, Exit.void))
      const left = yield* subject.open.pipe(Scope.provide(abandoned))
      yield* left.create(headerOf(id, owner))
      yield* left.commit(id, { expect: 0, notAfter: Option.none(), events: [draft("a", { n: 1 }), draft("b", { n: 2 })], state: Option.some({ by: "abandoned" }) })
      const wrote = yield* seen(left, id)
      const continued = yield* Effect.scoped(Effect.gen(function* () {
        const log = yield* subject.open
        yield* expect("unclosed-handle", (yield* seen(log, id)).text === wrote.text, "a new handle does not read what the unclosed one committed")
        yield* log.commit(id, { expect: 1, ...noState, events: [draft("c", { n: 3 })] })
        return yield* seen(log, id)
      }))
      const again = yield* reading(id)
      yield* expect("unclosed-handle", continued.seq === 3 && continued.revision === 2 && again.text === continued.text, `after the unclosed handle: seq ${again.seq}, revision ${again.revision}`)
    })),
    ...(subject.callerClock === true ? [
      recovery("with the caller's clock, a commit at exactly its notAfter is stored at that time, and one a millisecond later is refused", "expiry-boundary", (owner) => Effect.gen(function* () {
        const id = yield* freshId
        const log = yield* subject.open
        const created = yield* log.create(headerOf(id, owner))
        const deadline = created.now + 60_000
        const onTime = yield* atTime(deadline)(log.commit(id, { expect: 0, notAfter: Option.some(deadline), events: [draft("on-time", {})], state: Option.none() }))
        yield* expect("expiry-boundary", onTime.at === deadline && onTime.events.every((event) => event.at === deadline), `a commit at its notAfter was stored at ${onTime.at}, not ${deadline}`)
        const late = yield* Effect.flip(atTime(deadline + 1)(log.commit(id, { expect: 1, notAfter: Option.some(deadline), events: [draft("late", {})], state: Option.some({ late: true }) })))
        yield* expect("expiry-boundary", late._tag === "LeaseExpired" && late.notAfter === deadline && late.now === deadline + 1, `a commit a millisecond late gave ${JSON.stringify(late)}`)
        const head = yield* atTime(deadline + 1)(log.head(id))
        yield* expect("expiry-boundary", head.revision === 1 && head.seq === 1 && head.updatedAt === deadline && canonicalJson(head.state) === "{}", "the late commit wrote something")
        yield* expect("expiry-boundary", head.now === deadline + 1, `the head was read at ${head.now}, not at the caller's ${deadline + 1}`)
      })),
    ] : []),
  ]
}
