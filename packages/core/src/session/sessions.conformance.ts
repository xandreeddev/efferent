import { Deferred, Effect, Exit, Fiber, Match, Option, Ref, Schema, Scope } from "effect"
import type { Context } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, failureCode, freshId, kindsOf, pixelPng, settles } from "../conformance.functions.js"
import { mediaFromBase64 } from "../domain/media.entity.functions.js"
import { RunId } from "../domain/run.entity.js"
import type { TurnEnding } from "../domain/turn-vocabulary.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import type { TurnActivity } from "../ports/activity.port.js"
import type { Sessions, TurnWriter } from "../ports/sessions.port.js"
import { TurnAdmission } from "../ports/turn-admission.port.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { TurnEndedData } from "./session-event.entity.js"
import { frameworkDraft } from "./session-event.entity.functions.js"
import type { JsonObject, SessionLogEvent } from "./session-log.entity.js"
import { InboxItemId, TurnRefused } from "./sessions.entity.js"
import type { AdmittedTurn, BeginTurn, InboxItem, SessionAddress, TurnError } from "./sessions.entity.js"

type Service = Context.Service.Shape<typeof Sessions>
type Admission = Context.Service.Shape<typeof TurnAdmission>

/** One `Sessions` instance as the kit builds it. */
export interface SessionsInstance {
  readonly sessions: Service
  /** Its `TurnActivity` (the turns it has in flight), when it provides one: then checked against what it opens. */
  readonly activity: Option.Option<Context.Service.Shape<typeof TurnActivity>>
}

/** A process as the kit names one, for process ownership: its host, its pid and when it started. */
export interface SessionsProcess {
  readonly host: string
  readonly pid: number
  readonly startedAt: number
}

/**
 * A Sessions backend as the kit builds it. Every instance runs over the same
 * store, as one per server would; the kit opens several at once, and uses
 * fresh owners and session ids in every check, so the store may be shared.
 */
export interface SessionsSubject {
  /**
   * Another instance over the same store each time it runs, released with
   * its scope, whose turns `admission` admits and which holds its turns by
   * a lease of `ttlMs` of storage time from their begin, renewed by each of
   * their writes and by nothing else (no keep-alive).
   */
  readonly leased: (options: { readonly ttlMs: number; readonly admission: Admission }) => Effect.Effect<SessionsInstance, unknown, Scope.Scope>
  /**
   * The same, holding its turns for as long as the process that began them
   * runs: the instance runs in `self`, and of the pids of its host only
   * `running` run (the liveness check it asks). Leave it out for a backend
   * without process ownership: the dead-holder and tenure checks are then
   * not run.
   */
  readonly processOwned?: (options: {
    readonly self: SessionsProcess
    readonly running: ReadonlyArray<number>
    readonly admission: Admission
  }) => Effect.Effect<SessionsInstance, unknown, Scope.Scope>
  /** Move the clock the store and the instances read forward by `millis`: `TestClock.adjust`, or a sleep on a live clock. */
  readonly advance: (millis: number) => Effect.Effect<void>
}

/** Admits every turn. */
const admitAll: Admission = TurnAdmission.of({ admit: (_turn, open) => open })

/** A lease no check outlives. */
const LONG = 600_000
/** The lease the expiry checks run out: the shortest a lease may be. */
const SHORT = 1_000

const say = (text: string, key = text, command: JsonObject = {}): BeginTurn =>
  ({ _tag: "User", userMessage: new UserMessage({ text }), runId: RunId.make(`run-${key}`), key, command })
const resume = (turn: number, key = `resume:${turn}`): BeginTurn =>
  ({ _tag: "User", userMessage: new UserMessage({ text: "Continue." }), runId: RunId.make(`run-${key}`), key, command: {}, resumes: turn })
const completed: TurnEnding = { reason: "completed", failure: Option.none() }
const item = (id: string): InboxItem => ({ id: InboxItemId.make(id), source: { kind: "conformance", id }, content: `the result of ${id}` })

const turnOf = (event: SessionLogEvent): number => Option.getOrElse(event.turn, () => 0)
const decodeEnded = Schema.decodeUnknownOption(TurnEndedData)
/** A `turn.ended` as `reason:code` (`none` when it stores no failure), as it decodes. */
const endingOf = (event: SessionLogEvent): string => Option.match(decodeEnded(event.data), {
  onNone: () => "undecodable",
  onSome: (ended) => `${ended.reason}:${Option.match(ended.failure, { onNone: () => "none", onSome: (failure) => failure.code })}`,
})
/** Each `turn.ended` as `turn:reason:code`. */
const endings = (events: ReadonlyArray<SessionLogEvent>) =>
  events.filter((event) => event.kind === "turn.ended").map((event) => `${turnOf(event)}:${endingOf(event)}`).join()

const created = (sessions: Service, owner: string) =>
  sessions.create({ owner }).pipe(Effect.map((view): SessionAddress => ({ id: view.header.id, owner })))
const openTurn = (sessions: Service, address: SessionAddress) =>
  sessions.get(address).pipe(Effect.map((view) => Option.map(view.open, (open) => open.turn)))
/** What a begin failed with, as `Tag` (and the reason a resume was refused), or the turn it opened (and closed again). */
const refusal = (sessions: Service, address: SessionAddress, input: BeginTurn) => Effect.scoped(sessions.begin(address, input)).pipe(Effect.match({
  onFailure: (error) => error._tag === "NotResumable" ? `NotResumable:${error.reason}` : error._tag,
  onSuccess: (writer) => `opened turn ${writer.admitted.turn}`,
}))
/**
 * A writer's refusal as the kit compares it: `TurnClosed:<reason>`,
 * `ReservedKind`, any other failure as `<tag>(<code>)` (a `HarnessError` of
 * the code a tag stands for is not that tag).
 */
const refusalOf = (error: TurnError): string => Match.value(error).pipe(
  Match.tag("TurnClosed", (closed) => `TurnClosed:${closed.reason}`),
  Match.tag("ReservedKind", () => "ReservedKind"),
  Match.orElse((other) => `${other._tag}(${failureCode(other)})`),
)
/** What a write after the turn was closed failed with (`refusalOf`): a flush, so a write that is queued is tried. */
const writeRefused = (writer: TurnWriter) => writer.append([{ kind: "conformance.late", data: {} }]).pipe(
  Effect.andThen(writer.flush),
  Effect.match({ onFailure: refusalOf, onSuccess: () => "stored" }),
)
/** A scope of the check's own, closed when the check ends if it is still open. */
const scopeOfCheck = Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))

/**
 * The Sessions contract, as checks any backend must pass: sessions created,
 * read only by their owner, listed in pages and forked; one open turn per
 * session (`SessionBusy`, on any instance, and exactly one winner of a
 * race); a key's retry is the same turn (`TurnDuplicate`, whatever the
 * `meta`) and anything else under it a `KeyConflict`; a run id an earlier
 * turn of the session, or of the history a fork inherits, was begun with
 * refused as `RunIdReused`, opening nothing; `meta` stored,
 * admitted and shown to the host's admission; the resume rules and every
 * `NotResumable` reason; an image its bytes do not support refused with
 * `AttachmentRejected` and an inbox turn with nothing to take with
 * `NothingPending`, opening nothing; the writer storing in order and its
 * end storing how the turn ended (completed, failed with a code, a scope
 * closed unended or interrupted), a write after its own end refused as
 * `TurnClosed` (`ended`); writing outside a turn and the reserved kinds,
 * refused as `ReservedKind` there and to a turn's writer unless the
 * framework's turn wrote them (`frameworkDraft`); cancel and removal closing
 * the writer, a write after a cancel, a reap or a stopped holder refused as
 * `TurnClosed` with its reason (a writer must raise these tags, not a
 * `HarnessError` of their codes), and
 * a turn nobody holds any more reaped alike by a cancel or a delivery,
 * whichever comes first; the inbox (delivered once
 * per id, taken by one inbox turn, waiting for the open turn, given back
 * when its turn is interrupted from outside, done when its turn is
 * cancelled); a turn whose lease ran out shown closed, left alone by a
 * drain with nothing to take and reaped by the next begin; a write renewing
 * the lease from that write; with `processOwned`, a turn whose process
 * stopped reaped, one whose process runs held, and a leased turn held by
 * a process-owned instance within its lease (a turn is judged as it was
 * taken, not by the reader's ownership); and, for an instance
 * with a `TurnActivity`, its activity agreeing with what is open, per
 * session and turn, a begin counting from the moment it is asked for (an
 * instance without one passes that check unchecked).
 *
 * Checks that move the clock (`advance`) run leases of a second: give the
 * kit a clock it can move at once (`TestClock`) or expect them to take
 * seconds. Run each check under the clock `advance` moves.
 */
export const sessionsConformance = (subject: SessionsSubject): ReadonlyArray<ConformanceCheck> => {
  const scoped = (name: string, id: string, body: (owner: string) => Effect.Effect<void, unknown, Scope.Scope>): ConformanceCheck =>
    check(name, id, (owner) => Effect.scoped(body(owner)))
  const leased = (ttlMs = LONG, admission: Admission = admitAll) => subject.leased({ ttlMs, admission })

  return [
    scoped("a session is created empty, read back by its owner only, and its id is created once", "create", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const view = yield* sessions.create({ owner, origin: "conformance", meta: { purpose: "kit", nested: { list: [1, "two", null] } } })
      const address: SessionAddress = { id: view.header.id, owner }
      yield* expect("create", view.header.owner === owner && view.header.origin === "conformance" && Option.isNone(view.header.parent)
        && canonicalJson(view.header.meta) === canonicalJson({ purpose: "kit", nested: { list: [1, "two", null] } }), `the header was created as ${canonicalJson({ ...view.header, parent: null })}`)
      yield* expect("create", view.turns === 0 && Option.isNone(view.open) && view.pending === 0, `a new session shows ${view.turns} turns, ${view.pending} waiting, ${Option.isSome(view.open) ? "one open" : "none open"}`)
      const read = yield* sessions.get(address)
      yield* expect("create", read.header.id === view.header.id && read.turns === 0, "get does not read the session as it was created")
      const again = yield* Effect.flip(sessions.create({ owner, id: view.header.id }))
      yield* expect("create", again._tag === "SessionExists", `creating an existing id gave ${again._tag}`)
      const stranger: SessionAddress = { ...address, owner: `${owner}-stranger` }
      const refused = [
        yield* Effect.flip(sessions.get(stranger)),
        yield* Effect.flip(sessions.read(stranger)),
        yield* Effect.flip(sessions.cancel(stranger, 1)),
        yield* Effect.flip(sessions.get({ id: yield* freshId, owner })),
      ].map((error) => error._tag)
      yield* expect("create", refused.every((tag) => tag === "SessionMissing"), `another owner's address and an unknown id gave ${refused.join()}`)
      yield* expect("create", (yield* sessions.read(address)).length === 0, "a new session holds events")
    })),

    scoped("an owner's sessions are listed newest first in pages, and a session's children only under it", "list", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const first = yield* created(sessions, owner)
      yield* subject.advance(10)
      const second = yield* created(sessions, owner)
      yield* subject.advance(10)
      const third = yield* created(sessions, owner)
      const child = yield* sessions.fork(first, { origin: "conformance", inherit: false })
      const page = yield* sessions.list({ owner, limit: 2 })
      yield* expect("list", page.sessions.map((view) => view.header.id).join() === [third.id, second.id].join() && Option.isSome(page.next),
        `the first page of two lists ${page.sessions.length} sessions${Option.isSome(page.next) ? "" : " and no next page"}`)
      const rest = yield* sessions.list({ owner, limit: 2, ...Option.match(page.next, { onNone: () => ({}), onSome: (before) => ({ before }) }) })
      yield* expect("list", rest.sessions.map((view) => view.header.id).join() === first.id && Option.isNone(rest.next),
        `the page after it lists ${rest.sessions.length} sessions${Option.isSome(rest.next) ? " and another page" : ""}`)
      const children = yield* sessions.list({ owner, parent: first.id })
      yield* expect("list", children.sessions.map((view) => view.header.id).join() === child.header.id, `the parent's children are ${children.sessions.length}`)
      const others = yield* sessions.list({ owner: `${owner}-stranger` })
      yield* expect("list", others.sessions.length === 0, "another owner lists these sessions")
    })),

    scoped("a fork's history is its parent's up to the last closed turn and its turns count on from there; a spawn starts empty", "fork", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const parent = yield* created(sessions, owner)
      yield* Effect.scoped(sessions.begin(parent, say("one")).pipe(Effect.tap((writer) =>
        writer.append([{ kind: "conformance.answer", data: { n: 1 } }]).pipe(Effect.andThen(writer.end(completed))))))
      const left = yield* scopeOfCheck
      const open = yield* sessions.begin(parent, say("two")).pipe(Scope.provide(left))
      yield* open.append([{ kind: "conformance.answer", data: { n: 2 } }])
      yield* open.flush
      const fork = yield* sessions.fork(parent, { origin: "conformance", inherit: true, meta: { task: "t1" } })
      const closing = (yield* sessions.read(parent, { kinds: ["turn.ended"] })).at(-1)
      const lineage = fork.header.parent
      yield* expect("fork", Option.exists(lineage, (at) => at.id === parent.id && at.turnAtFork === 1 && at.through === (closing?.seq ?? -1))
        && fork.turns === 1 && fork.header.owner === owner && fork.header.origin === "conformance" && canonicalJson(fork.header.meta) === canonicalJson({ task: "t1" }),
      `the fork's lineage is ${canonicalJson(Option.getOrNull(lineage))} with ${fork.turns} turns`)
      const child: SessionAddress = { id: fork.header.id, owner }
      const writer = yield* sessions.begin(child, say("in the fork"))
      yield* expect("fork", writer.admitted.turn === 2, `the fork's first turn is ${writer.admitted.turn}, not 2`)
      const history = kindsOf(yield* writer.history([]))
      yield* expect("fork", history === "turn.started@1,conformance.answer@1,turn.ended@1", `the fork's history is ${history}`)
      yield* writer.append([{ kind: "conformance.answer", data: { n: 3 } }])
      const snapshot = kindsOf(yield* writer.snapshot(["conformance.answer"]))
      yield* expect("fork", snapshot === "conformance.answer@1,conformance.answer@2", `the fork's snapshot is ${snapshot}`)
      const spawn = yield* sessions.fork(parent, { origin: "conformance", inherit: false })
      const fresh = yield* sessions.begin({ id: spawn.header.id, owner }, say("from nothing"))
      yield* expect("fork", spawn.turns === 0 && fresh.admitted.turn === 1 && (yield* fresh.history([])).length === 0, `a spawn starts at ${spawn.turns} turns`)
      const orphan = yield* Effect.flip(sessions.fork({ id: yield* freshId, owner }, { origin: "conformance", inherit: true }))
      yield* expect("fork", orphan._tag === "SessionMissing", `forking a missing session gave ${orphan._tag}`)
    })),

    scoped("one turn is open per session: a second begin is SessionBusy on any instance, which also sees the turn open", "busy", (owner) => Effect.gen(function* () {
      const [one, two] = [yield* leased(), yield* leased()]
      const address = yield* created(one.sessions, owner)
      const writer = yield* one.sessions.begin(address, say("first", "k1", { canvas: "c1" }))
      const admitted: AdmittedTurn = writer.admitted
      yield* expect("busy", admitted.turn === 1 && admitted.key === "k1" && admitted.runId === "run-k1" && admitted.origin === "user"
        && admitted.userMessage.text === "first" && canonicalJson(admitted.command) === canonicalJson({ canvas: "c1" }) && admitted.claimed.length === 0
        && admitted.session.id === address.id && writer.started.kind === "turn.started" && Option.contains(writer.started.turn, 1),
      `the turn was admitted as ${canonicalJson({ ...admitted, userMessage: admitted.userMessage.text })}`)
      const views = [yield* one.sessions.get(address), yield* two.sessions.get(address)]
      yield* expect("busy", views.every((view) => Option.exists(view.open, (open) => open.turn === 1 && open.key === "k1" && open.origin === "user") && view.turns === 1),
        "an instance does not show the open turn")
      const busy = [yield* Effect.flip(Effect.scoped(one.sessions.begin(address, say("second", "k2")))), yield* Effect.flip(Effect.scoped(two.sessions.begin(address, say("second", "k2"))))]
      yield* expect("busy", busy.every((error) => error._tag === "SessionBusy" && error.turn === 1), `a second begin gave ${busy.map((error) => error._tag).join()}`)
      yield* writer.end(completed)
      const next = yield* two.sessions.begin(address, say("second", "k2"))
      yield* expect("busy", next.admitted.turn === 2 && Option.contains(yield* openTurn(one.sessions, address), 2), `the begin after the end opened turn ${next.admitted.turn}`)
      const started = kindsOf(yield* one.sessions.read(address, { kinds: ["turn.started"] }))
      yield* expect("busy", started === "turn.started@1,turn.started@2", `the session stored ${started}`)
    })),

    scoped("of begins racing on one session from several instances, exactly one opens a turn", "race", (owner) => Effect.gen(function* () {
      const instances = [yield* leased(), yield* leased(), yield* leased()]
      const address = yield* created(instances[0]!.sessions, owner)
      const attempts = yield* Effect.forEach(instances, (instance, n) => Effect.result(instance.sessions.begin(address, say(`racer ${n}`))), { concurrency: "unbounded" })
      const won = attempts.filter((attempt) => attempt._tag === "Success").length
      const busy = attempts.filter((attempt) => attempt._tag === "Failure" && attempt.failure._tag === "SessionBusy").length
      yield* expect("race", won === 1 && busy === 2, `of three racing begins ${won} opened a turn and ${busy} were busy`)
      const started = (yield* instances[1]!.sessions.read(address, { kinds: ["turn.started"] })).length
      yield* expect("race", started === 1, `the race stored ${started} turns`)
    })),

    scoped("a key's retry is the same turn (TurnDuplicate, whatever its meta) and anything else under the key a KeyConflict", "duplicate", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const asked = (text: string, canvas: string, meta?: JsonObject): BeginTurn => meta === undefined ? say(text, "k1", { canvas }) : { ...say(text, "k1", { canvas }), meta }
      const writer = yield* sessions.begin(address, asked("find alpha", "c1", { request: "r1" }))
      const retries = [
        yield* Effect.flip(Effect.scoped(sessions.begin(address, asked("find alpha", "c1", { request: "r2" })))),
        yield* Effect.flip(Effect.scoped(sessions.begin(address, asked("find alpha", "c1")))),
      ]
      yield* expect("duplicate", retries.every((error) => error._tag === "TurnDuplicate" && error.turn === 1 && error.open),
        `a retry while the turn is open gave ${retries.map((error) => error._tag === "TurnDuplicate" ? `TurnDuplicate(${error.turn}, open ${error.open})` : error._tag).join()}`)
      const conflicts = [
        yield* Effect.flip(Effect.scoped(sessions.begin(address, asked("find beta", "c1")))),
        yield* Effect.flip(Effect.scoped(sessions.begin(address, asked("find alpha", "c2")))),
      ]
      yield* expect("duplicate", conflicts.every((error) => error._tag === "KeyConflict" && error.key === "k1" && error.turn === 1),
        `another message or command under the key gave ${conflicts.map((error) => error._tag).join()}`)
      yield* expect("duplicate", Option.contains(yield* sessions.lookup(address, "k1"), 1) && Option.isNone(yield* sessions.lookup(address, "k-unused")), "lookup does not find the key's turn")
      yield* writer.end(completed)
      const after = yield* Effect.flip(Effect.scoped(sessions.begin(address, asked("find alpha", "c1"))))
      yield* expect("duplicate", after._tag === "TurnDuplicate" && !after.open, `a retry after the turn ended gave ${after._tag}${after._tag === "TurnDuplicate" ? `, open ${after.open}` : ""}`)
      const started = kindsOf(yield* sessions.read(address, { kinds: ["turn.started"] }))
      yield* expect("duplicate", started === "turn.started@1", `the retries stored ${started}`)
    })),

    scoped("a run id names one turn: a begin under one an earlier turn of the session, or of the history a fork inherits, was begun with is RunIdReused and opens nothing", "run-id", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const under = (runId: string, key: string): BeginTurn => ({ _tag: "User", userMessage: new UserMessage({ text: key }), runId: RunId.make(runId), key, command: {} })
      const reused = (at: SessionAddress, input: BeginTurn) => Effect.scoped(sessions.begin(at, input)).pipe(Effect.match({
        onFailure: (error) => error._tag === "RunIdReused" ? `RunIdReused:${error.runId}:${error.turn}` : error._tag,
        onSuccess: (writer) => `opened turn ${writer.admitted.turn}`,
      }))
      yield* Effect.scoped(sessions.begin(address, under("run-once", "k1")).pipe(Effect.tap((writer) => writer.end(completed))))
      const again = [yield* reused(address, under("run-once", "k1")), yield* reused(address, under("run-once", "k2")), yield* reused(address, { _tag: "Inbox", runId: RunId.make("run-once") })]
      yield* expect("run-id", again.join() === "TurnDuplicate,RunIdReused:run-once:1,RunIdReused:run-once:1",
        `the same key, a new key and an inbox turn under a used run id gave ${again.join()}`)
      const view = yield* sessions.get(address)
      yield* expect("run-id", view.turns === 1 && kindsOf(yield* sessions.read(address)) === "turn.started@1,turn.ended@1", `the refused begins moved the session to ${view.turns} turns`)
      const fork = yield* sessions.fork(address, { origin: "conformance", inherit: true })
      const child: SessionAddress = { id: fork.header.id, owner }
      const inherited = [yield* reused(child, under("run-once", "k1")), yield* reused(child, under("run-fresh", "k1"))]
      yield* expect("run-id", inherited.join() === "RunIdReused:run-once:1,opened turn 2", `in a fork, its parent's run id and a new one gave ${inherited.join()}`)
    })),

    scoped("a turn's meta is stored, admitted and shown to the host's admission, {} when none is given, and the inbox's from drain", "meta", (owner) => Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const recording = TurnAdmission.of({ admit: (turn, open) => Ref.update(seen, (all) => [...all, canonicalJson(turn.meta)]).pipe(Effect.andThen(open)) })
      const { sessions } = yield* leased(LONG, recording)
      const address = yield* created(sessions, owner)
      const shown = yield* Effect.scoped(sessions.begin(address, { ...say("one", "k1"), meta: { tenant: "acme", nested: { n: 1 } } }).pipe(Effect.tap((writer) => writer.end(completed)),
        Effect.map((writer) => [canonicalJson(writer.admitted.meta), canonicalJson(writer.started.data.meta ?? null)])))
      yield* expect("meta", shown.every((json) => json === canonicalJson({ tenant: "acme", nested: { n: 1 } })), `the turn's meta was admitted and stored as ${shown.join(" and ")}`)
      const plain = yield* Effect.scoped(sessions.begin(address, say("two", "k2")).pipe(Effect.tap((writer) => writer.end(completed)),
        Effect.map((writer) => [canonicalJson(writer.admitted.meta), canonicalJson(writer.started.data.meta ?? {})])))
      yield* expect("meta", plain.every((json) => json === "{}"), `a turn without meta was admitted and stored with ${plain.join(" and ")}`)
      yield* sessions.deliver(address, item("i1"))
      const drained = yield* Ref.make<ReadonlyArray<string>>([])
      yield* sessions.drain(address, (writer) => Ref.set(drained, [canonicalJson(writer.admitted.meta), canonicalJson(writer.started.data.meta ?? null)]), { maxTurns: 1, meta: { source: "drain" } })
      yield* expect("meta", (yield* Ref.get(drained)).join() === [canonicalJson({ source: "drain" }), canonicalJson({ source: "drain" })].join(), `the inbox turn's meta was ${(yield* Ref.get(drained)).join(" and ")}`)
      const admitted = (yield* Ref.get(seen)).join(" ")
      yield* expect("meta", admitted === [canonicalJson({ tenant: "acme", nested: { n: 1 } }), "{}", canonicalJson({ source: "drain" })].join(" "), `the host's admission saw ${admitted}`)
    })),

    scoped("only the last user's turn, cancelled or interrupted, is resumed; every other is NotResumable with why, and nothing opens", "resume", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      yield* Effect.scoped(sessions.begin(address, say("one")).pipe(Effect.tap((writer) => writer.end(completed))))
      const early = [yield* refusal(sessions, address, resume(1)), yield* refusal(sessions, address, resume(7)), yield* refusal(sessions, address, resume(1.5, "resume:half"))]
      yield* expect("resume", early.join() === "NotResumable:finished,NotResumable:missing,NotResumable:missing", `resuming a completed, an unknown and a fractional turn gave ${early.join()}`)
      yield* sessions.begin(address, say("two"))
      yield* sessions.cancel(address, 2)
      const resumed = yield* Effect.scoped(sessions.begin(address, resume(2)).pipe(Effect.tap((writer) => writer.end(completed)),
        Effect.map((writer) => [writer.admitted.turn, writer.admitted.resumes ?? null, writer.started.data.resumes ?? null].join())))
      yield* expect("resume", resumed === "3,2,2", `resuming the cancelled turn 2 admitted turn, resumes and stored resumes ${resumed}`)
      const after = [yield* refusal(sessions, address, resume(2)), yield* refusal(sessions, address, resume(2, "resume:2:again"))]
      yield* expect("resume", after.join() === "TurnDuplicate,NotResumable:superseded", `retrying the resume, and resuming again under a new key, gave ${after.join()}`)
      yield* sessions.deliver(address, item("i1"))
      yield* sessions.drain(address, () => Effect.interrupt, { maxTurns: 1 })
      const inbox = yield* refusal(sessions, address, resume(4))
      yield* expect("resume", inbox === "NotResumable:inbox", `resuming an interrupted inbox turn gave ${inbox}`)
      const before = yield* sessions.get(address)
      const busyFirst = yield* Effect.scoped(Effect.gen(function* () {
        yield* sessions.begin(address, say("open"))
        return yield* refusal(sessions, address, resume(4))
      }))
      yield* expect("resume", busyFirst === "SessionBusy", `a resume while a turn is open gave ${busyFirst}`)
      yield* expect("resume", before.turns === 4, `the refused resumes moved the session to ${before.turns} turns`)
    })),

    scoped("a message whose image its bytes do not support is refused with AttachmentRejected and opens nothing; a good one is stored", "attachments", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const image = yield* mediaFromBase64(pixelPng, { name: "pixel.png" })
      const asked = (attachments: ReadonlyArray<typeof image>, key: string): BeginTurn =>
        ({ _tag: "User", userMessage: new UserMessage({ text: "what is this?", attachments }), runId: RunId.make(`run-${key}`), key, command: {} })
      const rejected = yield* refusal(sessions, address, asked([{ ...image, data: "aGVsbG8gd29ybGQ=" }], "k1"))
      yield* expect("attachments", rejected === "AttachmentRejected", `an image that is text gave ${rejected}`)
      const view = yield* sessions.get(address)
      yield* expect("attachments", view.turns === 0 && Option.isNone(view.open) && (yield* sessions.read(address)).length === 0, "a refused image opened or stored something")
      const writer = yield* sessions.begin(address, asked([image], "k2"))
      const kept = writer.admitted.userMessage.attachments?.map((media) => media.fingerprint).join() ?? ""
      yield* expect("attachments", writer.admitted.turn === 1 && kept === image.fingerprint && JSON.stringify(writer.started.data.userMessage ?? null).includes(image.fingerprint),
        `a good image was admitted as ${kept || "nothing"}`)
    })),

    scoped("an inbox turn with nothing waiting is NothingPending and opens nothing; a drain then runs none", "nothing-pending", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const refused = yield* refusal(sessions, address, { _tag: "Inbox", runId: RunId.make("run-inbox") })
      yield* expect("nothing-pending", refused === "NothingPending", `an inbox turn with nothing waiting gave ${refused}`)
      const ran = yield* Ref.make(0)
      const drained = yield* sessions.drain(address, () => Ref.update(ran, (count) => count + 1))
      yield* expect("nothing-pending", drained.turns === 0 && (yield* Ref.get(ran)) === 0, `a drain with nothing waiting ran ${yield* Ref.get(ran)} turns`)
      const view = yield* sessions.get(address)
      yield* expect("nothing-pending", view.turns === 0 && (yield* sessions.read(address)).length === 0, "nothing waiting still opened or stored something")
    })),

    scoped("a writer stores in order, stamped with its turn; its end stores how the turn ended, an unended scope failed and an interrupted one interrupted", "writer", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const late = yield* Effect.scoped(Effect.gen(function* () {
        const writer = yield* sessions.begin(address, say("one"))
        yield* writer.append([{ kind: "conformance.a", data: { n: 1 } }, { kind: "conformance.b", data: { n: 2 } }])
        const written = yield* writer.write(Effect.succeed("in order"))
        yield* expect("writer", written === "in order", "write did not return its operation's value")
        yield* writer.append([{ kind: "conformance.c", data: { n: 3 } }])
        const snapshot = kindsOf(yield* writer.snapshot(["conformance.a", "conformance.b", "conformance.c"]))
        yield* expect("writer", snapshot === "conformance.a@1,conformance.b@1,conformance.c@1", `the turn's snapshot is ${snapshot}`)
        const ended = yield* writer.end(completed)
        yield* expect("writer", ended.pending === 0, `the end reports ${ended.pending} items waiting`)
        return yield* writeRefused(writer)
      }))
      yield* expect("writer", late === "TurnClosed:ended", `a write after the end gave ${late}`)
      yield* Effect.scoped(sessions.begin(address, say("two")).pipe(Effect.tap((writer) =>
        writer.end({ reason: "failed", failure: Option.some({ code: "conformance.failed", message: "the host failed" }) }))))
      yield* Effect.scoped(sessions.begin(address, say("three")))
      const begun = yield* Deferred.make<void>()
      const held = yield* Effect.forkChild(Effect.scoped(sessions.begin(address, say("four")).pipe(Effect.andThen(Deferred.succeed(begun, undefined)), Effect.andThen(Effect.never))))
      yield* Deferred.await(begun)
      yield* Fiber.interrupt(held)
      const all = yield* sessions.read(address)
      const stored = endings(all)
      yield* expect("writer", stored === "1:completed:none,2:failed:conformance.failed,3:failed:turn.unended,4:interrupted:turn.interrupted", `the turns ended ${stored}`)
      const first = kindsOf(all.filter((event) => turnOf(event) === 1))
      yield* expect("writer", first === "turn.started@1,conformance.a@1,conformance.b@1,conformance.c@1,turn.ended@1", `turn 1 stored ${first}`)
      const view = yield* sessions.get(address)
      yield* expect("writer", view.turns === 4 && Option.isNone(view.open), `after four ended turns the session shows ${view.turns} turns${Option.isSome(view.open) ? " and one open" : ""}`)
    })),

    scoped("transact records outside a turn, and the framework's kinds are refused: as ReservedKind there, and to a turn's writer unless the framework's turn wrote them", "transact", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const decided = yield* sessions.transact(address, (view) => Effect.succeed({ drafts: [{ kind: "conformance.note", data: { turns: view.turns } }], result: "noted" }))
      yield* expect("transact", decided.result === "noted" && kindsOf(decided.events) === "conformance.note", `transact returned ${String(decided.result)} with ${kindsOf(decided.events)}`)
      const reserved = yield* Effect.flip(sessions.transact(address, () => Effect.succeed({ drafts: [{ kind: "turn.ended", data: {} }], result: undefined })))
      yield* expect("transact", reserved._tag === "ReservedKind", `recording turn.ended gave ${reserved._tag}`)
      const all = kindsOf(yield* sessions.read(address))
      yield* expect("transact", all === "conformance.note", `the session holds ${all}`)
      const writer = yield* sessions.begin(address, say("in a turn"))
      const refused = [
        yield* Effect.flip(writer.append([{ kind: "conformance.note", data: {} }, { kind: "turn.ended", data: { reason: "completed", failure: null } }])),
        yield* Effect.flip(writer.transact(() => Effect.succeed({ drafts: [{ kind: "memory.message", data: {} }], result: undefined }))),
      ].map(refusalOf)
      yield* expect("transact", refused.every((refusal) => refusal === "ReservedKind"), `a turn's writer recording turn.ended and memory.message gave ${refused.join()}`)
      yield* expect("transact", Option.contains(yield* openTurn(sessions, address), 1), "a turn.ended a host appended closed the turn")
      yield* writer.append([frameworkDraft("step.started", { step: 0 }), { kind: "conformance.answer", data: {} }])
      yield* writer.end(completed)
      const turn = kindsOf(yield* sessions.read(address, { after: 1 }))
      yield* expect("transact", turn === "turn.started@1,step.started@1,conformance.answer@1,turn.ended@1", `the turn stored ${turn}`)
    })),

    scoped("a cancel ends exactly the open turn as cancelled and closes its writer, on its own instance at once and on another at its next write", "cancel", (owner) => Effect.gen(function* () {
      const [holder, other] = [yield* leased(), yield* leased()]
      const address = yield* created(holder.sessions, owner)
      const local = yield* holder.sessions.begin(address, say("stop me"))
      const cancelled = yield* holder.sessions.cancel(address, 1)
      yield* expect("cancel", cancelled.cancelled && cancelled.pending === 0, `cancelling the open turn answered ${canonicalJson(cancelled)}`)
      const closed = yield* local.closed
      yield* expect("cancel", closed.reason === "cancelled" && closed.turn === 1, `the holder's writer was closed as ${closed.reason}`)
      const localRefusal = yield* writeRefused(local)
      yield* expect("cancel", localRefusal === "TurnClosed:cancelled", `a write to the cancelled writer gave ${localRefusal}`)
      const remote = yield* holder.sessions.begin(address, say("elsewhere"))
      yield* expect("cancel", (yield* other.sessions.cancel(address, 2)).cancelled, "another instance could not cancel the open turn")
      const remoteRefusal = yield* writeRefused(remote)
      yield* expect("cancel", remoteRefusal === "TurnClosed:cancelled", `a write to a writer cancelled from another instance gave ${remoteRefusal}`)
      const closedRemotely = yield* remote.closed
      yield* expect("cancel", closedRemotely.reason === "cancelled", `a writer cancelled from another instance was closed as ${closedRemotely.reason}`)
      const third = yield* holder.sessions.begin(address, say("three"))
      const wrong = [yield* other.sessions.cancel(address, 2), yield* other.sessions.cancel(address, 1)]
      yield* expect("cancel", wrong.every((answer) => !answer.cancelled) && Option.contains(yield* openTurn(other.sessions, address), third.admitted.turn),
        "a cancel naming a turn that is not open closed something")
      const stored = endings(yield* holder.sessions.read(address, { kinds: ["turn.ended"] }))
      yield* expect("cancel", stored === "1:cancelled:none,2:cancelled:none", `the cancels stored ${stored}`)
    })),

    scoped("a turn nobody holds any more is reaped by a cancel as by a delivery: whichever comes first, it ends interrupted, its items as a reap leaves them, and nothing is cancelled", "cancel-unheld", (owner) => Effect.gen(function* () {
      const [holder, other] = [yield* leased(SHORT), yield* leased(SHORT)]
      // An inbox turn whose holder stopped writing: it took the item, and its lease ran out.
      const stopped = Effect.gen(function* () {
        const address = yield* created(holder.sessions, owner)
        yield* holder.sessions.deliver(address, item("i1"))
        yield* holder.sessions.begin(address, { _tag: "Inbox", runId: RunId.make(`run-${address.id}`) })
        yield* subject.advance(SHORT * 2)
        return address
      })
      const outcome = (address: SessionAddress) => Effect.gen(function* () {
        const view = yield* other.sessions.get(address)
        return `${endings(yield* other.sessions.read(address, { kinds: ["turn.ended"] }))} open ${Option.isSome(view.open)} pending ${view.pending}`
      })
      const cancelFirst = yield* stopped
      const cancelled = yield* other.sessions.cancel(cancelFirst, 1)
      const reapFirst = yield* stopped
      yield* other.sessions.deliver(reapFirst, item("i1"))
      const afterReap = yield* other.sessions.cancel(reapFirst, 1)
      yield* expect("cancel-unheld", !cancelled.cancelled && !afterReap.cancelled && cancelled.pending === afterReap.pending,
        `a cancel before the reap answered ${canonicalJson(cancelled)}, after it ${canonicalJson(afterReap)}`)
      const [first, second] = [yield* outcome(cancelFirst), yield* outcome(reapFirst)]
      yield* expect("cancel-unheld", first === second && first.startsWith("1:interrupted:turn.lease open false"),
        `a cancel before the reap left ${first}, after it ${second}`)
    })),

    scoped("removing a session closes its open turn and removes its children", "remove", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const child = yield* sessions.fork(address, { origin: "conformance", inherit: false })
      const writer = yield* sessions.begin(address, say("open"))
      yield* sessions.remove(address)
      const closed = yield* writer.closed
      yield* expect("remove", closed.reason === "removed", `the open turn's writer was closed as ${closed.reason}`)
      const gone = [yield* Effect.flip(sessions.get(address)), yield* Effect.flip(sessions.get({ id: child.header.id, owner })), yield* Effect.flip(sessions.remove(address))]
      yield* expect("remove", gone.every((error) => error._tag === "SessionMissing"), `after the removal the session, its child and a second removal gave ${gone.map((error) => error._tag).join()}`)
    })),

    scoped("the inbox: an item is delivered once per id, taken by one inbox turn, waits for the open turn, comes back when its turn is interrupted from outside, and is done when its turn is cancelled", "inbox", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const delivered = [yield* sessions.deliver(address, item("i1")), yield* sessions.deliver(address, item("i1"))]
      yield* expect("inbox", delivered.map((answer) => `${answer.delivered}:${answer.pending}`).join() === "true:1,false:1", `delivering one item twice answered ${canonicalJson(delivered)}`)
      const taken = yield* Ref.make(Option.none<AdmittedTurn>())
      const drained = yield* sessions.drain(address, (writer) => Ref.set(taken, Option.some(writer.admitted)))
      const turn = yield* Ref.get(taken)
      yield* expect("inbox", drained.turns === 1 && Option.exists(turn, (admitted) => admitted.origin === "inbox" && admitted.claimed.map((claimed) => claimed.id).join() === "i1"
        && admitted.claimed[0]?.content === item("i1").content && admitted.userMessage.text.includes(item("i1").content)),
      `the drain ran ${drained.turns} turns, taking ${canonicalJson(Option.getOrNull(Option.map(turn, (admitted) => admitted.claimed)))}`)
      yield* expect("inbox", (yield* sessions.get(address)).pending === 0 && endings(yield* sessions.read(address)) === "1:completed:none", "the inbox turn did not end completed with its item taken")
      yield* expect("inbox", !(yield* sessions.deliver(address, item("i1"))).delivered, "an item delivered again after it was taken is stored again")
      const writer = yield* sessions.begin(address, say("long answer"))
      yield* expect("inbox", (yield* sessions.deliver(address, item("i2"))).pending === 1, "an item delivered during a turn does not wait")
      yield* expect("inbox", (yield* sessions.drain(address, () => Effect.void)).turns === 0, "a drain ran an inbox turn while a turn was open")
      yield* expect("inbox", (yield* writer.end(completed)).pending === 1, "the turn's end does not report the item that waits")
      yield* expect("inbox", (yield* sessions.drain(address, () => Effect.void)).turns === 1, "the drain after the turn did not take the item")
      yield* sessions.deliver(address, item("i3"))
      const entered = yield* Deferred.make<void>()
      const held = yield* Effect.forkChild(sessions.drain(address, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(held)
      const back = yield* sessions.get(address)
      yield* expect("inbox", back.pending === 1 && Option.isNone(back.open), `after its inbox turn was interrupted from outside ${back.pending} items wait${Option.isSome(back.open) ? " and a turn is open" : ""}`)
      yield* expect("inbox", (yield* sessions.drain(address, () => Effect.void)).turns === 1 && (yield* sessions.get(address)).pending === 0, "the item given back was not taken by the next drain")
      const queued = (yield* sessions.read(address, { kinds: ["inbox.queued"] })).length
      yield* expect("inbox", queued === 3, `three items were stored as ${queued}`)
      yield* sessions.deliver(address, item("i4"))
      const claiming = yield* Deferred.make<number>()
      const claim = yield* Effect.forkChild(sessions.drain(address, (writer) => Deferred.succeed(claiming, writer.admitted.turn).pipe(Effect.andThen(Effect.never))))
      const claimTurn = yield* Deferred.await(claiming)
      const stopped = yield* sessions.cancel(address, claimTurn)
      yield* Fiber.interrupt(claim)
      const done = yield* sessions.get(address)
      yield* expect("inbox", stopped.cancelled && stopped.pending === 0 && done.pending === 0 && Option.isNone(done.open),
        `after its inbox turn was cancelled ${done.pending} items wait${Option.isSome(done.open) ? " and a turn is open" : ""} (a cancelled turn's items are done)`)
      const last = endings(yield* sessions.read(address, { kinds: ["turn.ended"] })).split(",").at(-1)
      yield* expect("inbox", last === `${claimTurn}:cancelled:none`, `the cancelled inbox turn was closed as ${last ?? "nothing"}`)
      yield* expect("inbox", (yield* sessions.drain(address, () => Effect.void)).turns === 0, "a drain took again an item whose turn was cancelled")
    })),

    scoped("a turn whose lease ran out is shown closed, left alone by a drain with nothing waiting, reaped as interrupted by the next begin, and its writer refused", "lease", (owner) => Effect.gen(function* () {
      const [first, second] = [yield* leased(SHORT), yield* leased(SHORT)]
      const address = yield* created(first.sessions, owner)
      const writer = yield* first.sessions.begin(address, say("slow"))
      yield* subject.advance(SHORT / 2)
      yield* expect("lease", Option.contains(yield* openTurn(second.sessions, address), 1), "a turn within its lease is shown closed")
      const early = yield* refusal(second.sessions, address, say("too early"))
      yield* expect("lease", early === "SessionBusy", `a begin within the lease gave ${early}`)
      yield* subject.advance(SHORT)
      yield* expect("lease", Option.isNone(yield* openTurn(second.sessions, address)), "a turn past its lease is still shown open")
      const idle = yield* second.sessions.drain(address, () => Effect.void)
      const unreaped = endings(yield* second.sessions.read(address, { kinds: ["turn.ended"] }))
      yield* expect("lease", idle.turns === 0 && unreaped === "", `a drain with nothing waiting ran ${idle.turns} turns and stored ${unreaped || "no ending"} (only a turn that opens reaps)`)
      const next = yield* second.sessions.begin(address, say("next"))
      yield* expect("lease", next.admitted.turn === 2, `the begin after the lease opened turn ${next.admitted.turn}`)
      const reaped = endings(yield* second.sessions.read(address, { kinds: ["turn.ended"] }))
      yield* expect("lease", reaped === "1:interrupted:turn.lease", `the expired turn was closed as ${reaped || "nothing"}`)
      const late = yield* writeRefused(writer)
      yield* expect("lease", late === "TurnClosed:interrupted", `a write by the old holder gave ${late}`)
      const closed = yield* writer.closed
      yield* expect("lease", closed.reason === "interrupted", `the old holder's writer was closed as ${closed.reason}`)
    })),

    scoped("a write renews the lease: a turn written to within its lease is held for a lease from that write, then reaped", "lease-renewal", (owner) => Effect.gen(function* () {
      const [holder, other] = [yield* leased(SHORT), yield* leased(SHORT)]
      const address = yield* created(holder.sessions, owner)
      const writer = yield* holder.sessions.begin(address, say("long turn"))
      const step = SHORT * 0.6
      yield* subject.advance(step)
      yield* writer.append([{ kind: "conformance.progress", data: { n: 1 } }])
      yield* writer.flush
      yield* subject.advance(step)
      yield* expect("lease-renewal", Option.contains(yield* openTurn(other.sessions, address), 1),
        `a turn written to ${step} ms ago, ${step * 2} ms after its begin, is shown closed: its write did not renew its lease of ${SHORT} ms`)
      const held = yield* refusal(other.sessions, address, say("too early"))
      yield* expect("lease-renewal", held === "SessionBusy", `a begin within the renewed lease gave ${held}`)
      yield* subject.advance(SHORT)
      const next = yield* other.sessions.begin(address, say("next"))
      const reaped = endings(yield* other.sessions.read(address, { kinds: ["turn.ended"] }))
      yield* expect("lease-renewal", next.admitted.turn === 2 && reaped === "1:interrupted:turn.lease",
        `once the renewed lease ran out the begin opened turn ${next.admitted.turn} and the turn was closed as ${reaped || "nothing"}`)
      const stored = kindsOf(yield* other.sessions.read(address, { kinds: ["conformance.progress"] }))
      yield* expect("lease-renewal", stored === "conformance.progress@1", `the renewing write was stored as ${stored || "nothing"}`)
    })),

    ...Option.match(Option.fromNullishOr(subject.processOwned), {
      onNone: () => [],
      onSome: (processOwned) => [
        scoped("under process ownership a turn whose process stopped is reaped by the next begin, and one whose process runs stays held", "process", (owner) => Effect.gen(function* () {
          const named = (pid: number, startedAt: number, running: ReadonlyArray<number>) =>
            processOwned({ self: { host: "conformance-host", pid, startedAt }, running, admission: admitAll })
          const crashed = yield* named(101, 1, [202])
          const restarted = yield* named(202, 2, [202])
          const address = yield* created(crashed.sessions, owner)
          const writer = yield* crashed.sessions.begin(address, say("before the crash"))
          yield* expect("process", Option.isNone(yield* openTurn(restarted.sessions, address)), "a turn whose process stopped is shown open")
          const next = yield* restarted.sessions.begin(address, say("after the restart"))
          yield* expect("process", next.admitted.turn === 2, `the begin after the crash opened turn ${next.admitted.turn}`)
          const late = yield* writeRefused(writer)
          yield* expect("process", late === "TurnClosed:interrupted", `a write by the stopped process's writer gave ${late}`)
          // The pid came back: a process that started later under it is not the one holding the turn.
          const reborn = yield* named(202, 3, [202])
          const third = yield* reborn.sessions.begin(address, say("pid reused"))
          yield* expect("process", third.admitted.turn === 3, `a process reusing the holder's pid opened turn ${third.admitted.turn}`)
          const reaped = endings(yield* reborn.sessions.read(address, { kinds: ["turn.ended"] }))
          yield* expect("process", reaped === "1:interrupted:turn.lease,2:interrupted:turn.lease", `the stopped holders' turns were closed as ${reaped}`)
          const alive = yield* named(303, 3, [303, 404])
          const observer = yield* named(404, 4, [303, 404])
          const other = yield* created(alive.sessions, owner)
          yield* alive.sessions.begin(other, say("still running"))
          yield* expect("process", Option.contains(yield* openTurn(observer.sessions, other), 1), "a turn whose process runs is shown closed")
          const busy = yield* refusal(observer.sessions, other, say("second"))
          yield* expect("process", busy === "SessionBusy", `a begin while the holder's process runs gave ${busy}`)
        })),
        scoped("a turn is held as it was taken, whatever the reader's ownership: a leased turn is held by a process-owned instance within its lease, then reaped", "tenure", (owner) => Effect.gen(function* () {
          const leasing = yield* leased(SHORT)
          const process = yield* processOwned({ self: { host: "conformance-host", pid: 505, startedAt: 5 }, running: [505], admission: admitAll })
          const address = yield* created(leasing.sessions, owner)
          const writer = yield* leasing.sessions.begin(address, say("leased"))
          yield* expect("tenure", Option.contains(yield* openTurn(process.sessions, address), 1), "a process-owned instance shows a turn within its lease closed")
          const early = yield* refusal(process.sessions, address, say("too early"))
          yield* expect("tenure", early === "SessionBusy", `a process-owned instance's begin within the lease gave ${early}`)
          yield* expect("tenure", (yield* writeRefused(writer)) === "stored", "the leased turn's holder was refused a write within its lease")
          yield* subject.advance(SHORT * 2)
          const next = yield* process.sessions.begin(address, say("after the lease"))
          const reaped = endings(yield* process.sessions.read(address, { kinds: ["turn.ended"] }))
          yield* expect("tenure", next.admitted.turn === 2 && reaped === "1:interrupted:turn.lease",
            `once the lease ran out the process-owned instance opened turn ${next.admitted.turn} and closed the leased one as ${reaped || "nothing"}`)
        })),
      ],
    }),

    scoped("TurnActivity agrees with what is open: a begin counts from the moment it is asked for, then its turn per session and turn until its scope closes", "activity", (owner) => Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const queued = yield* Deferred.make<void>()
      const refusing = yield* Ref.make(false)
      const admission = TurnAdmission.of({
        admit: Effect.fnUntraced(function* (turn, open) {
          if (yield* Ref.get(refusing)) return yield* Effect.fail(new TurnRefused({ session: turn.session.id, reason: "conformance", message: "the kit refuses it" }))
          if (turn.key === "held at admission") yield* Deferred.succeed(queued, undefined).pipe(Effect.andThen(Deferred.await(gate)))
          return yield* open
        }),
      })
      const { sessions, activity: provided } = yield* leased(LONG, admission)
      if (Option.isNone(provided)) return
      const activity = provided.value
      const other = yield* leased()
      const [a, b, c] = [yield* created(sessions, owner), yield* created(sessions, owner), yield* created(sessions, owner)]
      const label = (address: SessionAddress) => address.id === a.id ? "a" : address.id === b.id ? "b" : "other"
      const current = activity.current.pipe(Effect.map((now) => ({
        open: now.open.map((turn) => `${label({ id: turn.session, owner })}:${turn.turn}`).join(),
        since: now.open.map((turn) => turn.since),
        beginning: now.beginning,
      })))
      const shows = (open: string, beginning: number, when: string) => current.pipe(Effect.flatMap((now) =>
        expect("activity", now.open === open && now.beginning === beginning, `${when}: open [${now.open}], beginning ${now.beginning}; expected open [${open}], beginning ${beginning}`)))
      yield* shows("", 0, "before any begin")
      yield* expect("activity", yield* settles(yield* Effect.forkChild(activity.idle)), "idle does not complete with nothing open")

      const scopeA = yield* scopeOfCheck
      const beginning = yield* Effect.forkChild(sessions.begin(a, say("held at admission")).pipe(Scope.provide(scopeA)))
      yield* Deferred.await(queued)
      yield* shows("", 1, "a begin waiting for the host's admission")
      const idle = yield* Effect.forkChild(activity.idle)
      yield* expect("activity", !(yield* settles(idle)), "idle completed while a begin was waiting for its admission")
      yield* Deferred.succeed(gate, undefined)
      const first = yield* Fiber.join(beginning)
      yield* shows("a:1", 0, "a turn handed over")
      yield* subject.advance(10)
      const scopeB = yield* scopeOfCheck
      yield* sessions.begin(b, say("two")).pipe(Scope.provide(scopeB))
      yield* shows("a:1,b:1", 0, "two sessions with a turn open each")
      yield* Effect.scoped(Effect.gen(function* () {
        yield* other.sessions.begin(yield* created(other.sessions, owner), say("elsewhere"))
        yield* shows("a:1,b:1", 0, "with another instance's turn open")
      }))
      yield* first.end(completed)
      yield* shows("a:1,b:1", 0, "an ended turn whose scope is still open")
      yield* subject.advance(10)
      const scopeNext = yield* scopeOfCheck
      yield* sessions.begin(a, say("three")).pipe(Scope.provide(scopeNext))
      yield* shows("a:1,b:1,a:2", 0, "the session's next turn begun while the ended one's scope is open")
      const since = (yield* current).since
      yield* expect("activity", since.every((at, index) => index === 0 || at >= since[index - 1]!), `the open turns are not oldest first: since ${since.join()}`)
      yield* Scope.close(scopeA, Exit.void)
      yield* shows("b:1,a:2", 0, "after the ended turn's scope closed")
      yield* Ref.set(refusing, true)
      const refused = yield* refusal(sessions, c, say("refused"))
      yield* expect("activity", refused === "TurnRefused", `a begin the host refuses gave ${refused}`)
      yield* shows("b:1,a:2", 0, "after a begin the host refused")
      yield* Ref.set(refusing, false)
      yield* expect("activity", !(yield* settles(idle)), "idle completed while turns were open")
      yield* Scope.close(scopeB, Exit.void)
      yield* Scope.close(scopeNext, Exit.void)
      yield* shows("", 0, "after every scope closed")
      yield* expect("activity", yield* settles(idle), "idle did not complete once nothing was open")
    })),
  ]
}
