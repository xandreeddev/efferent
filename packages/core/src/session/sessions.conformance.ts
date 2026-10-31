import { Deferred, Effect, Exit, Fiber, Match, Option, Ref, Schema, Scope, Stream } from "effect"
import type { Context } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, eventually, expect, failureCode, freshId, kindsOf, pixelPng, settles } from "../conformance.functions.js"
import { mediaFromBase64 } from "../domain/media.entity.functions.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { TurnEnding } from "../domain/turn-vocabulary.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import type { TurnActivity, TurnShutdown, WaitingInput } from "../ports/activity.port.js"
import type { Sessions, TurnWriter } from "../ports/sessions.port.js"
import { TurnAdmission } from "../ports/turn-admission.port.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { userRoleMessageOf } from "../turn/user-message.entity.functions.js"
import { TurnEndedData } from "./session-event.entity.js"
import { readStored } from "./session-event.entity.functions.js"
import { entriesOfEvents, frameworkDraft } from "./session-event.entity.functions.js"
import type { JsonObject, SessionLogEvent } from "./session-log.entity.js"
import { InboxItemId, TurnRefused } from "./sessions.entity.js"
import type { AdmittedTurn, BeginTurn, InboxItem, QueuedInput, SessionAddress, TurnError } from "./sessions.entity.js"

type Service = Context.Service.Shape<typeof Sessions>
type Admission = Context.Service.Shape<typeof TurnAdmission>

/** One `Sessions` instance as the kit builds it. */
export interface SessionsInstance {
  readonly sessions: Service
  /** Its `TurnActivity` (the turns it has in flight), when it provides one: then checked against what it opens. */
  readonly activity: Option.Option<Context.Service.Shape<typeof TurnActivity>>
  /** Its `TurnShutdown`, when it provides one: then checked to refuse its begins and close its turns. */
  readonly shutdown: Option.Option<Context.Service.Shape<typeof TurnShutdown>>
  /** Its owner-observed queued-input probe, when supplied. */
  readonly waitingInput: Option.Option<Context.Service.Shape<typeof WaitingInput>>
}

/**
 * A process as the kit names one, for process ownership: its host, its pid
 * and when it started.
 *
 * @public
 */
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
  /**
   * Stamp a session as a newer release would leave it: its stored format
   * above `STORED_FORMAT`, everything else as it was. The kit calls it on a
   * session an instance has written to (a turn begun and ended, an item
   * delivered). Leave it out for a backend that keeps no stored format: the
   * stored-format check is then not run.
   */
  readonly newerFormat?: (address: SessionAddress) => Effect.Effect<void, unknown>
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

const queued = (id: string, delivery: QueuedInput["delivery"] = "next"): QueuedInput => ({ id: InboxItemId.make(id), userMessage: new UserMessage({ text: `queued message ${id}` }), delivery, source: { kind: "conformance", id } })
const fromQueue = (input: string, runId: string): BeginTurn => ({ _tag: "Queued", input: InboxItemId.make(input), runId: RunId.make(runId) })

const steerEntry = (writer: TurnWriter, input: QueuedInput, index: number): LogEntry => ({
  id: EntryId.make(`${writer.admitted.runId}:${index}`), runId: writer.admitted.runId, turn: writer.admitted.turn, step: 0, at: 0,
  body: { _tag: "Message", message: userRoleMessageOf(input.userMessage), run: RunOrdinal.make(0), inbox: input.id },
})

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
/** A `SessionLogError` by its tag and fields, whichever copy of core made it. */
const isStoreError = Schema.is(Schema.Struct({ _tag: Schema.Literal("SessionLogError"), code: Schema.String }))
/** What a call answered: `SessionLogError(<its own code>)`, another failure's tag, or `done`. */
const answerOf = <R>(effect: Effect.Effect<unknown, { readonly _tag: string }, R>): Effect.Effect<string, never, R> => effect.pipe(Effect.match({
  onFailure: (error) => isStoreError(error) ? `SessionLogError(${error.code})` : error._tag,
  onSuccess: () => "done",
}))
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
 * `NotResumable` reason; a task's turn (`BeginTurn.Task`) admitted, stored
 * and shown to the admission with origin `task` and its `TaskRef`, keyed
 * like a user's and never resumed; an image its bytes do not support refused with
 * `AttachmentRejected` and an inbox turn with nothing to take with
 * `NothingPending`, opening nothing; the writer storing in order and its
 * end storing how the turn ended (completed, failed with a code, a scope
 * closed unended or interrupted), a write after its own end refused as
 * `TurnClosed` (`ended`); the closing drafts a turn holds stored only by
 * its end's commit, right before `turn.ended` (by its scope's end too,
 * ending as a held reply implies; dropped by a cancel); writing outside a turn and the reserved kinds,
 * refused as `ReservedKind` there and to a turn's writer unless the
 * framework's turn wrote them (`frameworkDraft`); `changes` signalling a
 * follower after its own session's commits only, the signals it did not
 * take merged into one; cancel and removal closing
 * the writer, a write after a cancel, a reap or a stopped holder refused as
 * `TurnClosed` with its reason (a writer must raise these tags, not a
 * `HarnessError` of their codes), and
 * a turn nobody holds any more reaped alike by a cancel or a delivery,
 * whichever comes first; the inbox (delivered once
 * per id, taken by one inbox turn, waiting for the open turn, given back
 * when its turn is interrupted from outside, done when its turn is
 * cancelled); a turn whose lease ran out shown closed, left alone by a
 * drain with nothing to take and reaped by the next begin; a begin with
 * `takeOver` closing a turn still held elsewhere at once (`turn.takeover`,
 * no attempt counted), resuming it, fencing its old writer and closing the
 * instance's own; a write renewing
 * the lease from that write; with `processOwned`, a turn whose process
 * stopped reaped, one whose process runs held, and a leased turn held by
 * a process-owned instance within its lease (a turn is judged as it was
 * taken, not by the reader's ownership); with `newerFormat`, a session a
 * newer release stamped refused for every write and turn (`begin`,
 * `deliver`, `drain`, `cancel`, `transact`, `fork`) with a
 * `SessionLogError` of code `session.version`, nothing written, and still
 * read (`get`, `list`, `read`); for an instance with a `TurnShutdown`, a
 * begin refused (`TurnRefused`, reason `shutdown`) once it refuses, the
 * turns open before running on and a drain opening nothing, then every
 * turn it holds closed by `interrupt` as interrupted with `turn.shutdown`,
 * its writer closed, and resumed by another instance; a turn past its time
 * limit (`timeLimitMs`) closed by its holder as interrupted with
 * `turn.time-limit`, its writer's `TurnClosed` `timed-out`, and resumed, a
 * turn within its limit left open; and, for an instance
 * with a `TurnActivity`, its activity agreeing with what is open, per
 * session and turn, a begin counting from the moment it is asked for (an
 * instance without either passes that check unchecked).
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

    scoped("a task's turn is admitted, stored and shown to the host's admission with origin task and its task's ref, keyed like a user's (its task in the fingerprint), and resuming it is NotResumable (task)", "task", (owner) => Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const recording = TurnAdmission.of({ admit: (turn, open) => Ref.update(seen, (all) => [...all, `${turn.origin} ${canonicalJson(turn.task ?? null)}`]).pipe(Effect.andThen(open)) })
      const { sessions } = yield* leased(LONG, recording)
      const parent = yield* created(sessions, owner)
      const spawn = yield* sessions.fork(parent, { origin: "conformance", inherit: false })
      const child: SessionAddress = { id: spawn.header.id, owner }
      const ref = { taskId: spawn.header.id, parent: parent.id }
      const task = (taskRef = ref): BeginTurn => ({ _tag: "Task", task: taskRef, userMessage: new UserMessage({ text: "look it up" }), runId: RunId.make("run-task"), key: "task:k1" })
      const writer = yield* sessions.begin(child, task())
      const admitted: AdmittedTurn = writer.admitted
      yield* expect("task", admitted.origin === "task" && canonicalJson(admitted.task ?? null) === canonicalJson(ref) && admitted.userMessage.text === "look it up"
        && admitted.key === "task:k1" && canonicalJson(admitted.command) === "{}" && admitted.claimed.length === 0,
      `the task's turn was admitted as ${canonicalJson({ ...admitted, userMessage: admitted.userMessage.text })}`)
      const stored = writer.started.data
      yield* expect("task", stored.origin === "task" && canonicalJson(stored.task ?? null) === canonicalJson(ref),
        `the task's turn was stored with origin ${canonicalJson(stored.origin ?? null)} and task ${canonicalJson(stored.task ?? null)}`)
      yield* expect("task", Option.exists((yield* sessions.get(child)).open, (open) => open.origin === "task"), "the session does not show its open turn as a task's")
      const admittedAs = (yield* Ref.get(seen)).at(0)
      yield* expect("task", admittedAs === `task ${canonicalJson(ref)}`, `the host's admission was asked for ${admittedAs ?? "nothing"}`)
      const retries = [yield* refusal(sessions, child, task()), yield* refusal(sessions, child, task({ ...ref, parent: child.id }))]
      yield* expect("task", retries.join() === "TurnDuplicate,KeyConflict", `the task's key with the same task and with another gave ${retries.join()}`)
      yield* sessions.cancel(child, admitted.turn)
      const resumed = yield* refusal(sessions, child, resume(admitted.turn))
      yield* expect("task", resumed === "NotResumable:task", `resuming the cancelled task's turn gave ${resumed}`)
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

    scoped("a turn's closing drafts are stored only by its end, in its commit right before turn.ended: the last hold's, none by a flush; its scope's end stores them, ending as a held reply implies; a cancel drops them", "closing", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const held = (n: number) => [{ kind: "conformance.reply", data: { n } }]
      const ofTurn = (turn: number) => sessions.read(address).pipe(Effect.map((all) => all.filter((event) => turnOf(event) === turn)))
      const late = (writer: TurnWriter) => writer.closing(held(0)).pipe(Effect.match({ onFailure: refusalOf, onSuccess: () => "held" }))
      // Turn 1, ended: the drafts of its last hold, stored by the end alone.
      const first = yield* Effect.scoped(Effect.gen(function* () {
        const writer = yield* sessions.begin(address, say("one"))
        yield* writer.append([{ kind: "conformance.a", data: {} }])
        yield* writer.closing(held(1))
        yield* writer.closing(held(2))
        const reserved = yield* writer.closing([{ kind: "turn.reply", data: {} }]).pipe(Effect.match({ onFailure: refusalOf, onSuccess: () => "held" }))
        yield* writer.append([{ kind: "conformance.b", data: {} }])
        yield* writer.flush
        const flushed = kindsOf(yield* ofTurn(1))
        yield* writer.end(completed)
        return { reserved, flushed, late: yield* late(writer) }
      }))
      yield* expect("closing", first.reserved === "ReservedKind", `holding a turn.reply the framework did not write gave ${first.reserved}`)
      yield* expect("closing", first.flushed === "turn.started@1,conformance.a@1,conformance.b@1", `after a flush turn 1 stored ${first.flushed}: held drafts are stored by the end only`)
      const ended = yield* ofTurn(1)
      const reply = ended.find((event) => event.kind === "conformance.reply")
      const closing = ended.find((event) => event.kind === "turn.ended")
      yield* expect("closing", kindsOf(ended) === "turn.started@1,conformance.a@1,conformance.b@1,conformance.reply@1,turn.ended@1" && reply?.data.n === 2,
        `the end stored ${kindsOf(ended)}, the reply held last ${reply === undefined ? "missing" : `as n ${String(reply.data.n)}`}`)
      yield* expect("closing", reply !== undefined && closing !== undefined && closing.seq === reply.seq + 1, "the held reply is not stored right before turn.ended")
      yield* expect("closing", first.late === "TurnClosed:ended", `a hold after the end gave ${first.late}`)
      // Turns 2 and 3, their scope closed unended: its end stores the drafts held, ending as a reply among them implies.
      yield* Effect.scoped(sessions.begin(address, say("two")).pipe(Effect.tap((writer) => writer.closing(held(3)))))
      const answer = say("three")
      yield* Effect.scoped(sessions.begin(address, answer).pipe(Effect.tap((writer) => writer.closing([frameworkDraft("turn.reply", {
        entry: `${answer.runId}:1`, runId: answer.runId, step: 0, at: 0, body: { outcome: "completed", reply: "done" },
      })]))))
      const scoped = [kindsOf(yield* ofTurn(2)), kindsOf(yield* ofTurn(3)), endings(yield* sessions.read(address, { kinds: ["turn.ended"] }))]
      yield* expect("closing", scoped.join(" | ") === "turn.started@2,conformance.reply@2,turn.ended@2 | turn.started@3,turn.reply@3,turn.ended@3 | 1:completed:none,2:failed:turn.unended,3:completed:none",
        `the scopes' ends stored ${scoped.join(" | ")}`)
      // Turn 4, cancelled: its held drafts are dropped, and the writer holds no more.
      const cancelled = yield* Effect.scoped(Effect.gen(function* () {
        const writer = yield* sessions.begin(address, say("four"))
        yield* writer.closing(held(4))
        yield* sessions.cancel(address, 4)
        return yield* late(writer)
      }))
      const fourth = kindsOf(yield* ofTurn(4))
      yield* expect("closing", fourth === "turn.started@4,turn.ended@4" && cancelled === "TurnClosed:cancelled",
        `a cancelled turn stored ${fourth}, and a hold after the cancel gave ${cancelled}`)
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

    scoped("a follower is signalled after its session's commits: one that did not pull holds one signal, and a commit to another session does not wake it", "changes", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const [followed, other] = [yield* created(sessions, owner), yield* created(sessions, owner)]
      const note = (address: SessionAddress) => sessions.transact(address, () => Effect.succeed({ drafts: [{ kind: "conformance.note", data: {} }], result: undefined }))
      const seen = yield* Ref.make(0)
      const first = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      // The follower takes a signal, then pulls nothing more until the gate opens.
      yield* Effect.forkScoped(sessions.changes(followed).pipe(Stream.runForEach(() => Ref.update(seen, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(first, undefined)), Effect.andThen(Deferred.await(gate))))))
      // It follows from its first pull, which runs on its own fiber: commit until it took a signal.
      const woken = (tries: number): Effect.Effect<boolean, unknown> => Deferred.isDone(first).pipe(Effect.flatMap((done) =>
        done || tries <= 0 ? Effect.succeed(done) : note(followed).pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.suspend(() => woken(tries - 1))))))
      yield* expect("changes", yield* woken(20), "a follower was not signalled after 20 commits to its session")
      yield* Effect.forEach([1, 2, 3], () => note(followed), { concurrency: 1 })
      yield* Deferred.succeed(gate, undefined)
      // Read until more than the one held signal came, or the follower stays caught up.
      const caughtUp = yield* eventually(Ref.get(seen), (count) => count > 2, 50)
      yield* expect("changes", caughtUp === 2, `a follower that pulled nothing during three commits then took ${caughtUp - 1} signals, not one`)
      yield* note(other)
      const unmoved = yield* eventually(Ref.get(seen), (count) => count > 2, 50)
      yield* expect("changes", unmoved === 2, `a commit to another session gave the follower ${unmoved - 2} signals`)
      yield* note(followed)
      const next = yield* eventually(Ref.get(seen), (count) => count > 2)
      yield* expect("changes", next > 2, "a follower that caught up was not signalled after its session's next commit")
    })),

    scoped("waiting broadcasts an initial signal and coalesced local commits to every subscriber across sessions", "waiting", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      yield* expect("waiting", sessions.waiting !== undefined, "Sessions has no global waiting signal")
      const [first, second] = [yield* created(sessions, owner), yield* created(sessions, owner)]
      const counts = [yield* Ref.make(0), yield* Ref.make(0)]
      const gate = yield* Deferred.make<void>()
      const payloads = yield* Ref.make(true)
      const followers = yield* Effect.forEach(counts, (seen) => Effect.forkScoped(sessions.waiting.pipe(Stream.runForEach((signal) =>
        Ref.update(seen, (n) => n + 1).pipe(Effect.andThen(Ref.update(payloads, (valid) => valid && signal === undefined)), Effect.andThen(Deferred.await(gate)))))), { concurrency: 1 })
      const read = Effect.forEach(counts, Ref.get, { concurrency: 1 })
      const initial = yield* eventually(read, (all) => all.every((n) => n > 0))
      yield* expect("waiting", initial.every((n) => n === 1), `two new subscribers received [${initial.join()}] initial signals without a commit`)
      yield* sessions.enqueue(first, queued("wake-a"))
      yield* sessions.enqueue(second, queued("wake-b"))
      yield* sessions.deliver(first, item("wake-notice"))
      yield* Deferred.succeed(gate, undefined)
      const caughtUp = yield* eventually(read, (all) => all.some((n) => n > 2), 50)
      yield* expect("waiting", caughtUp.every((n) => n === 2), `slow broadcast subscribers received [${caughtUp.join()}] signals instead of initial plus one coalesced wake`)
      yield* expect("waiting", (yield* sessions.get(first)).pending === 2 && (yield* sessions.get(second)).pending === 1,
        "a coalesced rescan cannot discover both sessions' committed items")
      yield* sessions.enqueue(second, queued("wake-c"))
      const next = yield* eventually(read, (all) => all.every((n) => n > 2))
      yield* expect("waiting", next.every((n) => n > 2) && (yield* Ref.get(payloads)), "a subscriber missed a later commit or a signal exposed a payload")
      yield* Fiber.interrupt(followers[0]!)
      const stopped = yield* Ref.get(counts[0]!)
      yield* sessions.enqueue(first, queued("wake-d"))
      const surviving = yield* eventually(Ref.get(counts[1]!), (n) => n > next[1]!)
      yield* expect("waiting", surviving > next[1]! && (yield* Ref.get(counts[0]!)) === stopped, "cancelling one subscription stopped another or kept delivering to it")
    })),

    scoped("WaitingInput refreshes only owner-observed queued inputs, excludes notices, and sees foreign claims, release, take, completion and removal", "waiting-input", (owner) => Effect.gen(function* () {
      const [observer, producer] = [yield* leased(), yield* leased()]
      if (Option.isNone(observer.waitingInput)) return
      const probe = observer.waitingInput.value
      const [address, hidden, secret] = [yield* created(producer.sessions, owner), yield* created(producer.sessions, owner), yield* created(producer.sessions, `${owner}-secret`)]
      yield* producer.sessions.enqueue(hidden, queued("hidden"))
      yield* producer.sessions.enqueue(secret, queued("secret"))
      const positive = probe.current.pipe(Effect.map((all) => all.filter((count) => count.pending > 0)))
      yield* expect("waiting-input", (yield* positive).length === 0, "a fresh instance observed queued sessions without an owner-checked operation")
      yield* Effect.result(observer.sessions.get({ id: secret.id, owner }))
      yield* expect("waiting-input", (yield* positive).length === 0, "a rejected owner check exposed queued input")
      yield* observer.sessions.get(address)
      yield* producer.sessions.deliver(address, item("notice-only"))
      yield* expect("waiting-input", (yield* positive).length === 0, "legacy notices counted as queued user input")
      yield* producer.sessions.enqueue(address, queued("observed-next"))
      const steer = queued("observed-steer", "steer")
      yield* producer.sessions.enqueue(address, steer)
      const shows = (pending: number, when: string) => positive.pipe(Effect.flatMap((all) => expect("waiting-input",
        pending === 0 ? all.length === 0 : all.length === 1 && all[0]!.session === address.id && all[0]!.pending === pending,
        `${when}: [${all.map((count) => `${count.session}:${count.pending}`).join()}], expected only ${pending} in the observed session`)))
      yield* shows(2, "foreign enqueue")
      const cached = (yield* probe.cached).filter((count) => count.pending > 0)
      yield* expect("waiting-input", cached.length === 1 && cached[0]!.pending === 2, "a successful refresh did not update cached knowledge")
      const claimed = yield* producer.sessions.begin(address, fromQueue("observed-next", "observed-attempt"))
      yield* shows(1, "foreign claim")
      yield* claimed.end({ reason: "partial", failure: Option.none() })
      yield* shows(2, "partial release")
      const writer = yield* producer.sessions.begin(address, say("consume steering", "waiting-steer"))
      yield* writer.take([steerEntry(writer, steer, 1)])
      yield* writer.end(completed)
      yield* shows(1, "durable take")
      const waiting = yield* Effect.forkScoped(probe.idle)
      yield* expect("waiting-input", !(yield* settles(waiting)), "idle completed with an unclaimed queued user input")
      const answering = yield* producer.sessions.begin(address, fromQueue("observed-next", "observed-completion"))
      yield* answering.end(completed)
      // This observer receives no local commit: its probe must also poll foreign changes.
      yield* subject.advance(10_000)
      yield* expect("waiting-input", yield* settles(waiting), "idle did not observe another instance's acknowledgement")
      yield* shows(0, "acknowledgement with a notice remaining")
      yield* observer.sessions.get(hidden)
      const visible = yield* positive
      yield* expect("waiting-input", visible.length === 1 && visible[0]!.session === hidden.id && visible[0]!.pending === 1, "a successful owner-checked read did not observe its session")
      yield* producer.sessions.remove(hidden)
      yield* shows(0, "foreign removal")
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

    scoped("queued input is stored once, starts one user turn with its exact message and attachments, and is acknowledged once", "queued-input", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const image = yield* mediaFromBase64(pixelPng)
      const input: QueuedInput = { ...queued("q1"), userMessage: new UserMessage({ text: "inspect the queued image", attachments: [image] }) }
      const delivered = [yield* sessions.enqueue(address, input), yield* sessions.enqueue(address, input)]
      yield* expect("queued-input", delivered.map((answer) => `${answer.enqueued}:${answer.pending}`).join() === "true:1,false:1", `enqueue answered ${canonicalJson(delivered)}`)
      const inbox = yield* refusal(sessions, address, { _tag: "Inbox", runId: RunId.make("notice-only") })
      yield* expect("queued-input", inbox === "NothingPending" && (yield* sessions.get(address)).pending === 1, `an inbox begin over input gave ${inbox}`)
      const writer = yield* sessions.begin(address, fromQueue("q1", "queued-first"))
      yield* expect("queued-input", writer.admitted.origin === "user" && writer.admitted.key === "input:q1" && writer.admitted.claimed.length === 0
        && canonicalJson(writer.admitted.userMessage) === canonicalJson(input.userMessage) && canonicalJson(writer.admitted.input) === canonicalJson(input)
        && writer.started.data.input === input.id, "the queued turn lost its user origin, exact input, provenance or attachment")
      const queuedRecords = yield* readStored("inbox.queued", yield* sessions.read(address, { kinds: ["inbox.queued"] }))
      yield* expect("queued-input", queuedRecords.length === 1 && queuedRecords[0]?.data.content === ""
        && canonicalJson(queuedRecords[0]?.data.input?.userMessage) === canonicalJson(input.userMessage), "the input was not stored once in the additive input form")
      yield* writer.end(completed)
      const again = yield* sessions.enqueue(address, input)
      const sameRun = yield* refusal(sessions, address, fromQueue("q1", "queued-first"))
      const duplicate = yield* refusal(sessions, address, fromQueue("q1", "queued-after-end"))
      yield* expect("queued-input", !again.enqueued && again.pending === 0 && sameRun === "TurnDuplicate" && duplicate === "TurnDuplicate", `after completion enqueue gave ${canonicalJson(again)}, same-run begin ${sameRun}, new-run begin ${duplicate}`)
    })),

    scoped("a queued input id cannot change its message, delivery or source, or collide with a notice, even after completion", "input-conflict", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      const input = queued("immutable")
      yield* sessions.enqueue(address, input)
      const before = (yield* sessions.read(address)).length
      const changes = [
        { ...input, userMessage: new UserMessage({ text: "another message" }) },
        { ...input, delivery: "steer" as const },
        { ...input, source: { kind: "another sender" } },
      ]
      const conflicts = yield* Effect.forEach(changes, (changed) => Effect.result(sessions.enqueue(address, changed)), { concurrency: 1 })
      yield* expect("input-conflict", conflicts.every((result) => result._tag === "Failure" && result.failure._tag === "InputConflict" && result.failure.id === input.id), `changed inputs gave ${conflicts.map((result) => result._tag === "Failure" ? result.failure._tag : "accepted").join()}`)
      yield* expect("input-conflict", (yield* sessions.read(address)).length === before, "conflicting inputs wrote events")
      yield* Effect.scoped(sessions.begin(address, fromQueue("immutable", "immutable-first")).pipe(Effect.tap((writer) => writer.end(completed))))
      const after = yield* Effect.result(sessions.enqueue(address, changes[0]!))
      yield* expect("input-conflict", after._tag === "Failure" && after.failure._tag === "InputConflict", "a completed input's id was reused for another message")
      yield* sessions.deliver(address, item("notice-id"))
      const notice = yield* Effect.result(sessions.enqueue(address, queued("notice-id")))
      yield* expect("input-conflict", notice._tag === "Failure" && notice.failure._tag === "InputConflict", "an input silently collided with a notice id")
      const untouched = yield* sessions.deliver(address, { ...item("immutable"), content: "a notice cannot replace input" })
      yield* expect("input-conflict", !untouched.delivered && (yield* sessions.read(address, { kinds: ["inbox.queued"] })).length === 2, "a notice replaced a recorded input")
    })),

    scoped("queued input survives failures beyond a notice's attempt ceiling and a new instance, partial stays pending, and completion or cancellation acknowledges it", "queued-retry", (owner) => Effect.gen(function* () {
      const first = yield* leased()
      const address = yield* created(first.sessions, owner)
      const input = queued("retry")
      yield* first.sessions.enqueue(address, input)
      const attempts = yield* Effect.forEach(Array.from({ length: 12 }, (_, index) => index), (index) => Effect.scoped(Effect.gen(function* () {
        const writer = yield* first.sessions.begin(address, fromQueue("retry", `retry-${index}`))
        yield* expect("queued-retry", writer.admitted.input?.id === input.id && writer.admitted.userMessage.text === input.userMessage.text, "an input retry lost its immutable input")
        yield* writer.end({ reason: "failed", failure: Option.some({ code: "conformance.retry", message: "try again" }) })
        return writer.admitted.key
      })), { concurrency: 1 })
      const reopened = yield* leased()
      yield* expect("queued-retry", new Set(attempts).size === attempts.length && (yield* reopened.sessions.get(address)).pending === 1
        && (yield* reopened.sessions.read(address, { kinds: ["inbox.dropped"] })).length === 0, "failed attempts dropped the input, reused a key or disappeared after reopen")
      yield* Effect.scoped(reopened.sessions.begin(address, fromQueue("retry", "retry-partial")).pipe(Effect.tap((writer) => writer.end({ reason: "partial", failure: Option.none() }))))
      yield* expect("queued-retry", (yield* reopened.sessions.get(address)).pending === 1, "a partial reply silently acknowledged queued input")
      const reply = (writer: TurnWriter) => writer.closing([frameworkDraft("turn.reply", {
        entry: `${writer.admitted.runId}:1`, runId: writer.admitted.runId, step: 0, at: 0,
        body: { outcome: "partial", reply: "the step cap left work unfinished" },
      })])
      const beforeDrain = (yield* reopened.sessions.get(address)).turns
      const partialDrain = yield* reopened.sessions.drain(address, reply, { take: "inputs", maxTurns: 1 })
      const partialEnd = endings(yield* reopened.sessions.read(address, { kinds: ["turn.ended"] })).split(",").at(-1)
      const heldReplies = yield* reopened.sessions.read(address, { kinds: ["turn.reply"] })
      yield* expect("queued-retry", partialDrain.turns === 1 && (yield* reopened.sessions.get(address)).pending === 1
        && partialEnd === `${beforeDrain + 1}:partial:none` && heldReplies.length === 1,
      "a successful drain callback's held partial reply was lost or acknowledged the unfinished input")
      yield* reopened.sessions.drain(address, (writer) => reply(writer).pipe(Effect.andThen(Effect.fail("the callback failed after holding its partial reply"))), { take: "inputs", maxTurns: 1 })
      const failedEnd = endings(yield* reopened.sessions.read(address, { kinds: ["turn.ended"] })).split(",").at(-1)
      yield* expect("queued-retry", (yield* reopened.sessions.get(address)).pending === 1 && failedEnd === `${beforeDrain + 2}:failed:turn.failed`,
        "a held partial reply hid the drain callback's failure or acknowledged the input")
      yield* Effect.scoped(reopened.sessions.begin(address, fromQueue("retry", "retry-complete")).pipe(Effect.tap((writer) => writer.end(completed))))
      yield* expect("queued-retry", (yield* reopened.sessions.get(address)).pending === 0, "completion did not acknowledge input")
      yield* reopened.sessions.enqueue(address, queued("cancelled"))
      const cancelling = yield* reopened.sessions.begin(address, fromQueue("cancelled", "queue-cancel"))
      const cancelled = yield* reopened.sessions.cancel(address, cancelling.admitted.turn)
      yield* expect("queued-retry", cancelled.cancelled && cancelled.pending === 0, "explicit cancellation left input to run again")
      const continued = yield* reopened.sessions.begin(address, resume(cancelling.admitted.turn, "queue-manual-continue"))
      yield* continued.end(completed)
      yield* expect("queued-retry", (yield* reopened.sessions.get(address)).pending === 0, "manually resuming cancelled queued input recreated an acknowledged queue slot")
    })),

    scoped("a user resume reclaims its interrupted queued input, including a failed resume, so successful completion leaves nothing to drain twice", "queued-resume", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      yield* sessions.enqueue(address, queued("resume-input"))
      const original = yield* sessions.begin(address, fromQueue("resume-input", "queue-root"))
      yield* original.end({ reason: "interrupted", failure: Option.some({ code: "turn.interrupted", message: "the holder stopped" }) })
      const failed = yield* sessions.begin(address, resume(original.admitted.turn, "queue-resume-failed"))
      yield* expect("queued-resume", failed.admitted.input?.id === InboxItemId.make("resume-input") && failed.started.data.input === "resume-input", "the resume did not claim its original queued input")
      yield* failed.end({ reason: "failed", failure: Option.some({ code: "conformance.retry", message: "retry the resume" }) })
      const successor = yield* leased()
      const resumed = yield* successor.sessions.begin(address, resume(original.admitted.turn, "queue-resume-done"))
      yield* expect("queued-resume", resumed.admitted.input?.id === InboxItemId.make("resume-input") && resumed.admitted.claimed.length === 0, "the second resume lost input or treated it as a notice")
      yield* resumed.end(completed)
      const drained = yield* successor.sessions.drain(address, () => Effect.void, { take: "inputs" })
      yield* expect("queued-resume", drained.turns === 0 && (yield* successor.sessions.get(address)).pending === 0, `successful resume left ${drained.turns} duplicate input turns`)
      yield* expect("queued-resume", (yield* successor.sessions.read(address, { kinds: ["inbox.queued"] })).length === 1, "resuming wrote the input into the queue again")
    })),

    scoped("drain selects inputs or notices without mixing messages, preserves queued order and attachments, and leaves busy or unknown input untouched", "drain-take", (owner) => Effect.gen(function* () {
      const { sessions } = yield* leased()
      const address = yield* created(sessions, owner)
      yield* sessions.enqueue(address, queued("input-1"))
      yield* sessions.deliver(address, item("notice-1"))
      yield* sessions.enqueue(address, queued("input-2", "steer"))
      yield* sessions.deliver(address, item("notice-2"))
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const observe = (writer: TurnWriter) => Ref.update(seen, (all) => [...all, `${writer.admitted.origin}:${writer.admitted.input?.id ?? writer.admitted.claimed.map((value) => value.id).join("+")}`])
      const notices = yield* sessions.drain(address, observe, { take: "notices", maxTurns: 1 })
      yield* expect("drain-take", notices.turns === 1 && (yield* Ref.get(seen)).join() === "inbox:notice-1+notice-2" && (yield* sessions.get(address)).pending === 2, "notice-only drain consumed user input or changed notice batching")
      const first = yield* sessions.drain(address, (writer) => observe(writer).pipe(Effect.andThen(sessions.enqueue(address, queued("input-3")))), { take: "inputs", maxTurns: 1 })
      const rest = yield* sessions.drain(address, observe, { take: "inputs", maxTurns: 5 })
      yield* expect("drain-take", first.turns === 1 && rest.turns === 2 && (yield* Ref.get(seen)).join() === "inbox:notice-1+notice-2,user:input-1,user:input-2,user:input-3", "input-only drain merged inputs, lost one delivered during a turn or broke delivery order")
      const selection = yield* created(sessions, owner)
      yield* sessions.deliver(selection, item("older-notice"))
      yield* sessions.enqueue(selection, queued("selected-input"))
      const selected = yield* sessions.drain(selection, observe, { take: "inputs", maxTurns: 1 })
      yield* expect("drain-take", selected.turns === 1 && (yield* Ref.get(seen)).at(-1) === "user:selected-input" && (yield* sessions.get(selection)).pending === 1, "input-only drain consumed an older notice instead of queued input")
      const held = yield* sessions.begin(address, say("held while input waits"))
      yield* sessions.enqueue(address, queued("busy-input"))
      yield* expect("drain-take", (yield* sessions.drain(address, observe, { take: "inputs" })).turns === 0 && (yield* sessions.get(address)).pending === 1, "a drain consumed input while a turn was open")
      yield* held.end(completed)
      const unknown = yield* refusal(sessions, address, fromQueue("unknown-input", "unknown-run"))
      yield* expect("drain-take", unknown === "NothingPending" && (yield* sessions.get(address)).pending === 1, `an unknown queued id gave ${unknown} or claimed another input`)
      yield* sessions.deliver(address, item("all-notice"))
      const all = yield* sessions.drain(address, observe, { take: "all", maxTurns: 5 })
      yield* expect("drain-take", all.turns === 2 && (yield* sessions.get(address)).pending === 0, "all did not drain both remaining input and notices")
    })),

    scoped("concurrent enqueue and queued begins over separate instances store each input once and claim it to at most one turn", "queued-race", (owner) => Effect.gen(function* () {
      const [one, two] = [yield* leased(), yield* leased()]
      const address = yield* created(one.sessions, owner)
      const results = yield* Effect.all([one.sessions.enqueue(address, queued("shared")), two.sessions.enqueue(address, queued("shared"))], { concurrency: 2 })
      yield* expect("queued-race", results.filter((result) => result.enqueued).length === 1, "two instances both enqueued the same id or neither stored it")
      yield* Effect.all([one.sessions.enqueue(address, queued("left")), two.sessions.enqueue(address, queued("right"))], { concurrency: 2 })
      const attempts = yield* Effect.all([Effect.result(one.sessions.begin(address, fromQueue("shared", "race-one"))), Effect.result(two.sessions.begin(address, fromQueue("shared", "race-two")))], { concurrency: 2 })
      const writers = attempts.flatMap((result) => result._tag === "Success" ? [result.success] : [])
      const refusals = attempts.flatMap((result) => result._tag === "Failure" ? [result.failure._tag] : [])
      yield* expect("queued-race", writers.length === 1 && refusals.every((tag) => tag === "SessionBusy" || tag === "TurnDuplicate"), `queued begin race opened ${writers.length} writers, refusals ${refusals.join()}`)
      const records = yield* one.sessions.read(address, { kinds: ["inbox.queued"] })
      yield* expect("queued-race", records.length === 3 && (yield* two.sessions.get(address)).pending === 2, "enqueue/claim CAS lost distinct input or recorded a duplicate")
      yield* writers[0]!.end(completed)
    })),

    scoped("queued admission sees the actual attempt key and input identity, and a refusal leaves the input pending", "queued-admission", (owner) => Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<{ readonly key: string; readonly input: Option.Option<InboxItemId> }>>([])
      const refuse = yield* Ref.make(false)
      const admission = TurnAdmission.of({ admit: Effect.fnUntraced(function* (turn, open) {
        yield* Ref.update(seen, (all) => [...all, { key: turn.key, input: Option.fromNullishOr(turn.input) }])
        if (yield* Ref.get(refuse)) return yield* Effect.fail(new TurnRefused({ session: turn.session.id, reason: "conformance", message: "not now" }))
        return yield* open
      }) })
      const { sessions } = yield* leased(LONG, admission)
      const address = yield* created(sessions, owner)
      yield* sessions.enqueue(address, queued("admitted-input"))
      const first = yield* sessions.begin(address, { ...fromQueue("admitted-input", "admitted-first"), meta: { request: "one" } })
      yield* first.end({ reason: "failed", failure: Option.none() })
      const second = yield* sessions.begin(address, { ...fromQueue("admitted-input", "admitted-next"), meta: { request: "two" } })
      yield* second.end({ reason: "failed", failure: Option.none() })
      const admissions = yield* Ref.get(seen)
      yield* expect("queued-admission", admissions.map((turn) => turn.key).join() === [first.admitted.key, second.admitted.key].join()
        && admissions.every((turn) => Option.contains(turn.input, InboxItemId.make("admitted-input")))
        && first.admitted.meta.request === "one" && second.admitted.meta.request === "two", "admission saw a guessed attempt key, lost input identity, or meta changed immutable input")
      yield* Ref.set(refuse, true)
      const refused = yield* refusal(sessions, address, fromQueue("admitted-input", "admitted-refused"))
      yield* expect("queued-admission", refused === "TurnRefused" && (yield* sessions.get(address)).pending === 1, `admission refused as ${refused} and consumed input`)
    })),

    scoped("a writer reads fresh waiting steers in order without writing, excluding next input, notices and its already claimed input", "steering-pending", (owner) => Effect.gen(function* () {
      const [holder, sender] = [yield* leased(), yield* leased()]
      const address = yield* created(holder.sessions, owner)
      yield* holder.sessions.enqueue(address, queued("claimed-steer", "steer"))
      const writer = yield* holder.sessions.begin(address, fromQueue("claimed-steer", "steering-pending"))
      yield* sender.sessions.enqueue(address, queued("next-only"))
      yield* sender.sessions.deliver(address, item("notice-only"))
      yield* sender.sessions.enqueue(address, queued("steer-one", "steer"))
      const image = yield* mediaFromBase64(pixelPng)
      const second: QueuedInput = { ...queued("steer-two", "steer"), userMessage: new UserMessage({ text: "inspect this steer", attachments: [image] }) }
      yield* sender.sessions.enqueue(address, second)
      const before = (yield* holder.sessions.read(address)).length
      const waiting = yield* writer.steers
      yield* expect("steering-pending", waiting.map((input) => input.id).join() === "steer-one,steer-two" && canonicalJson(waiting[1]) === canonicalJson(second), "the writer missed another instance's steer or included non-steering/claimed input")
      yield* expect("steering-pending", (yield* holder.sessions.read(address)).length === before, "reading waiting steers wrote a journal event")
      yield* sender.sessions.enqueue(address, queued("steer-later", "steer"))
      yield* expect("steering-pending", (yield* writer.steers).map((input) => input.id).join() === "steer-one,steer-two,steer-later", "the next read reused a stale waiting snapshot")
      const notices = yield* created(holder.sessions, owner)
      yield* holder.sessions.deliver(notices, item("only-probed"))
      yield* Effect.forEach(Array.from({ length: 12 }, (_, index) => index), (index) => Effect.scoped(Effect.gen(function* () {
        const untried = yield* holder.sessions.begin(notices, { _tag: "Inbox", runId: RunId.make(`only-probed-${index}`) })
        yield* untried.steers
        yield* untried.end({ reason: "interrupted", failure: Option.none() })
      })), { concurrency: 1 })
      yield* expect("steering-pending", (yield* holder.sessions.get(notices)).pending === 1 && (yield* holder.sessions.read(notices, { kinds: ["inbox.dropped"] })).length === 0,
        "a steering probe counted an untouched notice as tried")
    })),

    scoped("taking steers records exact user messages and receipts, acknowledges them once and leaves other pending work", "steering-take", (owner) => Effect.gen(function* () {
      const [holder, sender] = [yield* leased(), yield* leased()]
      const address = yield* created(holder.sessions, owner)
      const writer = yield* holder.sessions.begin(address, say("the turn being steered", "steering-take"))
      const one = queued("take-one", "steer")
      const image = yield* mediaFromBase64(pixelPng)
      const two: QueuedInput = { ...queued("take-two", "steer"), userMessage: new UserMessage({ text: "second exact steer", attachments: [image] }) }
      yield* sender.sessions.enqueue(address, one)
      yield* sender.sessions.enqueue(address, two)
      yield* sender.sessions.enqueue(address, queued("next-left"))
      yield* sender.sessions.deliver(address, item("notice-left"))
      const entries = [steerEntry(writer, one, 1), steerEntry(writer, two, 2)]
      const taken = yield* writer.take(entries)
      const events = yield* holder.sessions.read(address)
      const memory = yield* entriesOfEvents(events)
      const receipts = yield* readStored("inbox.taken", events)
      const messages = memory.filter((entry) => entry.body._tag === "Message" && entry.body.inbox !== undefined)
      yield* expect("steering-take", taken && canonicalJson(messages) === canonicalJson(entries)
        && receipts.map(({ data }) => `${data.id}:${data.entry}`).join() === entries.map((entry) => `${entry.body._tag === "Message" ? entry.body.inbox : ""}:${entry.id}`).join()
        && receipts.every(({ event }) => Option.contains(event.turn, writer.admitted.turn)), "take lost a user message, attachment or its receipt identity")
      yield* expect("steering-take", (yield* writer.steers).length === 0 && (yield* holder.sessions.get(address)).pending === 2, "take left a steer pending or consumed next input/notices")
      yield* expect("steering-take", !(yield* writer.take(entries)), "taking the same inputs twice succeeded")
      yield* writer.end(completed)
      const duplicate = yield* refusal(holder.sessions, address, fromQueue("take-one", "fresh-after-take"))
      const sameRun = yield* refusal(holder.sessions, address, fromQueue("take-one", writer.admitted.runId))
      const again = yield* sender.sessions.enqueue(address, one)
      yield* expect("steering-take", duplicate === "TurnDuplicate" && sameRun === "TurnDuplicate" && !again.enqueued && again.pending === 2, `a taken input was not acknowledged: new run ${duplicate}, same run ${sameRun}, enqueue ${canonicalJson(again)}`)
    })),

    scoped("racing takes consume one whole selected batch once, and stale or non-steering selections record nothing", "steering-race", (owner) => Effect.gen(function* () {
      const [holder, sender] = [yield* leased(), yield* leased()]
      const address = yield* created(holder.sessions, owner)
      const writer = yield* holder.sessions.begin(address, say("race the steering takes", "steering-race"))
      const one = queued("race-steer-one", "steer")
      const two = queued("race-steer-two", "steer")
      yield* sender.sessions.enqueue(address, one)
      yield* sender.sessions.enqueue(address, two)
      yield* sender.sessions.enqueue(address, queued("race-next"))
      const invalid: ReadonlyArray<ReadonlyArray<LogEntry>> = [
        [{ ...steerEntry(writer, one, 1), body: { _tag: "Message", run: RunOrdinal.make(0), inbox: one.id, message: { role: "user", content: "changed after enqueue" } } }],
        [steerEntry(writer, one, 1), steerEntry(writer, one, 2)],
      ]
      const beforeInvalid = (yield* holder.sessions.read(address)).length
      const refused = yield* Effect.forEach(invalid, (entries) => Effect.result(writer.take(entries)), { concurrency: 1 })
      yield* expect("steering-race", refused.every((result) => result._tag === "Failure") && (yield* holder.sessions.read(address)).length === beforeInvalid,
        "take accepted changed input text or duplicate input ids, or wrote part of an invalid selection")
      const selections = [[steerEntry(writer, one, 1), steerEntry(writer, two, 2)], [steerEntry(writer, one, 3), steerEntry(writer, two, 4)]]
      const outcomes = yield* Effect.forEach(selections, (entries) => writer.take(entries), { concurrency: 2 })
      yield* expect("steering-race", outcomes.filter(Boolean).length === 1, `racing whole-batch takes returned ${outcomes.join()}`)
      const before = (yield* holder.sessions.read(address)).length
      const stale = yield* writer.take(selections[0]!)
      const wrongDelivery = yield* writer.take([steerEntry(writer, queued("race-next"), 5)])
      yield* expect("steering-race", !stale && !wrongDelivery && (yield* holder.sessions.read(address)).length === before, "a rejected selection wrote an entry or took non-steering input")
      yield* sender.sessions.enqueue(address, queued("race-newer", "steer"))
      const receipts = yield* readStored("inbox.taken", yield* holder.sessions.read(address))
      const memory = yield* entriesOfEvents(yield* holder.sessions.read(address))
      const messages = memory.filter((entry) => entry.body._tag === "Message" && entry.body.inbox !== undefined)
      yield* expect("steering-race", receipts.length === 2 && messages.length === 2 && new Set(receipts.map(({ data }) => data.entry)).size === 2
        && (yield* writer.steers).map((input) => input.id).join() === "race-newer" && (yield* holder.sessions.get(address)).pending === 2, "racing take lost an input, duplicated a receipt or consumed an unselected arrival")
    })),

    scoped("a closed writer cannot read or take steers and leaves untaken user input pending", "steering-closed", (owner) => Effect.gen(function* () {
      const [holder, closer] = [yield* leased(), yield* leased()]
      const address = yield* created(holder.sessions, owner)
      const writer = yield* holder.sessions.begin(address, say("cancel before taking steering", "steering-closed"))
      const input = queued("not-taken", "steer")
      yield* closer.sessions.enqueue(address, input)
      yield* closer.sessions.cancel(address, writer.admitted.turn)
      const reading = yield* writer.steers.pipe(Effect.match({ onFailure: refusalOf, onSuccess: () => "read" }))
      const taking = yield* writer.take([steerEntry(writer, input, 1)]).pipe(Effect.match({ onFailure: refusalOf, onSuccess: () => "taken" }))
      yield* expect("steering-closed", reading === "TurnClosed:cancelled" && taking === "TurnClosed:cancelled", `closed writer read ${reading} and take ${taking}`)
      yield* expect("steering-closed", (yield* closer.sessions.get(address)).pending === 1 && (yield* closer.sessions.read(address, { kinds: ["inbox.taken", "memory.message"] })).length === 0, "a cancelled writer acknowledged input or recorded steering")
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

    scoped("a begin with takeOver closes a turn still held elsewhere at once, as interrupted with turn.takeover and no attempt counted, resumes it, and fences its old writer; without it the begin is SessionBusy", "takeover", (owner) => Effect.gen(function* () {
      const [stopped, successor] = [yield* leased(), yield* leased()]
      const address = yield* created(stopped.sessions, owner)
      yield* stopped.sessions.deliver(address, item("t1"))
      const inbox = yield* stopped.sessions.begin(address, { _tag: "Inbox", runId: RunId.make("run-inbox-held") })
      // Held for a long lease by an instance that stopped writing: a plain begin waits for it, a takeover does not.
      const busy = yield* refusal(successor.sessions, address, say("too early"))
      yield* expect("takeover", busy === "SessionBusy", `a begin without takeOver over a held turn gave ${busy}`)
      const taking = yield* successor.sessions.begin(address, { ...say("take it over"), takeOver: true })
      yield* expect("takeover", taking.admitted.turn === 2, `the takeover opened turn ${taking.admitted.turn}`)
      const taken = endings(yield* successor.sessions.read(address, { kinds: ["turn.ended"] }))
      yield* expect("takeover", taken === "1:interrupted:turn.takeover", `the turn taken over was closed as ${taken || "nothing"}`)
      const late = yield* writeRefused(inbox)
      yield* expect("takeover", late === "TurnClosed:interrupted", `a write by the old holder after the takeover gave ${late}`)
      yield* taking.end(completed)
      // The item the taken-over turn held waits again, with no attempt counted: a drain takes it, and it is not dropped.
      const drained = yield* successor.sessions.drain(address, () => Effect.void)
      const dropped = (yield* successor.sessions.read(address, { kinds: ["inbox.dropped"] })).length
      yield* expect("takeover", drained.turns === 1 && dropped === 0, `after the takeover a drain ran ${drained.turns} turns and ${dropped} items were dropped`)
      // A user's turn held elsewhere is taken over and resumed in one begin.
      const second = yield* created(stopped.sessions, owner)
      yield* stopped.sessions.begin(second, say("long running"))
      const resuming = yield* successor.sessions.begin(second, { ...resume(1), takeOver: true })
      yield* expect("takeover", resuming.admitted.turn === 2 && resuming.admitted.resumes === 1, `a takeover resuming turn 1 opened turn ${resuming.admitted.turn}, resuming ${resuming.admitted.resumes ?? "nothing"}`)
      // On the holder's own instance, its writer is closed at once.
      const third = yield* created(successor.sessions, owner)
      const own = yield* successor.sessions.begin(third, say("mine"))
      yield* Effect.scoped(successor.sessions.begin(third, { ...say("again"), takeOver: true }).pipe(Effect.flatMap((writer) => writer.end(completed))))
      const closed = yield* own.closed
      yield* expect("takeover", closed.reason === "interrupted" && closed.turn === 1, `the instance's own writer taken over was closed as ${closed.reason}`)
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

    ...Option.match(Option.fromNullishOr(subject.newerFormat), {
      onNone: () => [],
      onSome: (newerFormat) => [
        scoped("a session a newer release stamped (its stored format above STORED_FORMAT) refuses every write and turn with session.version, writing nothing, and is still read", "stored-format", (owner) => Effect.gen(function* () {
          const { sessions } = yield* leased()
          const address = yield* created(sessions, owner)
          yield* Effect.scoped(sessions.begin(address, say("before the upgrade")).pipe(Effect.flatMap((writer) => writer.end(completed))))
          yield* sessions.deliver(address, item("waiting"))
          yield* newerFormat(address)
          const before = yield* sessions.get(address)
          const stored = kindsOf(yield* sessions.read(address))
          const answers = [
            yield* answerOf(Effect.scoped(sessions.begin(address, say("after the upgrade")))),
            yield* answerOf(sessions.deliver(address, item("late"))),
            yield* answerOf(sessions.drain(address, () => Effect.void)),
            yield* answerOf(sessions.cancel(address, 1)),
            yield* answerOf(sessions.transact(address, () => Effect.succeed({ drafts: [{ kind: "conformance.note", data: {} }], result: undefined }))),
            yield* answerOf(sessions.fork(address, { origin: "conformance", inherit: true })),
          ]
          yield* expect("stored-format", answers.every((answer) => answer === "SessionLogError(session.version)"),
            `begin, deliver, drain, cancel, transact and fork of a newer release's session gave ${answers.join()}`)
          const after = yield* sessions.get(address)
          yield* expect("stored-format", after.seq === before.seq && after.updatedAt === before.updatedAt && after.turns === 1 && after.pending === 1 && Option.isNone(after.open),
            `the refused calls wrote to the session: ${after.turns} turns, ${after.pending} waiting, seq ${before.seq} then ${after.seq}`)
          const read = kindsOf(yield* sessions.read(address))
          yield* expect("stored-format", read === stored, `the session was read as ${read}, not ${stored}`)
          const listed = (yield* sessions.list({ owner })).sessions.map((view) => view.header.id)
          const children = (yield* sessions.list({ owner, parent: address.id })).sessions.length
          yield* expect("stored-format", listed.includes(address.id) && children === 0,
            `the owner's sessions listed ${listed.includes(address.id) ? "it" : "without it"}, and ${children} children under it`)
        })),
      ],
    }),

    scoped("TurnShutdown refuses every begin once it refuses while the open turns run on, then closes every turn the instance holds as interrupted with turn.shutdown and its writer, and another instance resumes it", "shutdown", (owner) => Effect.gen(function* () {
      const stopping = yield* leased()
      if (Option.isNone(stopping.shutdown)) return
      const shutdown = stopping.shutdown.value
      const successor = yield* leased()
      const [held, idle] = [yield* created(stopping.sessions, owner), yield* created(stopping.sessions, owner)]
      const writer = yield* stopping.sessions.begin(held, say("long running"))
      const refusedBegin = Effect.scoped(stopping.sessions.begin(idle, say("too late"))).pipe(Effect.match({
        onFailure: (error) => error._tag === "TurnRefused" ? `TurnRefused:${error.reason}` : error._tag,
        onSuccess: (opened) => `opened turn ${opened.admitted.turn}`,
      }))
      yield* shutdown.refuse
      const refused = yield* refusedBegin
      yield* expect("shutdown", refused === "TurnRefused:shutdown", `a begin once the instance refuses gave ${refused}`)
      // Deliveries are still stored; an inbox turn is refused like any other, so a drain opens nothing.
      yield* stopping.sessions.deliver(idle, item("while-stopping"))
      const drained = yield* stopping.sessions.drain(idle, () => Effect.void)
      const waiting = (yield* stopping.sessions.get(idle)).pending
      yield* expect("shutdown", drained.turns === 0 && waiting === 1, `a drain while refusing ran ${drained.turns} turns and left ${waiting} items waiting`)
      const running = yield* writeRefused(writer)
      yield* expect("shutdown", running === "stored", `a write by the turn open before the refusal gave ${running}`)
      const interrupted = (yield* shutdown.interrupt).map((turn) => `${turn.session === held.id ? "held" : turn.session}:${turn.turn}`).join()
      yield* expect("shutdown", interrupted === "held:1", `interrupt closed [${interrupted}], not [held:1]`)
      const ended = endings(yield* successor.sessions.read(held, { kinds: ["turn.ended"] }))
      yield* expect("shutdown", ended === "1:interrupted:turn.shutdown", `the interrupted turn was closed as ${ended || "nothing"}`)
      const closed = yield* writer.closed
      const late = yield* writeRefused(writer)
      yield* expect("shutdown", closed.reason === "interrupted" && late === "TurnClosed:interrupted", `the interrupted turn's writer was closed as ${closed.reason}, and a write after it gave ${late}`)
      const still = yield* refusedBegin
      yield* expect("shutdown", still === "TurnRefused:shutdown", `a begin after the interrupt gave ${still}`)
      // The next process resumes the interrupted turn, and takes what waited.
      const resuming = yield* successor.sessions.begin(held, resume(1))
      yield* expect("shutdown", resuming.admitted.turn === 2 && resuming.admitted.resumes === 1, `another instance resuming turn 1 opened turn ${resuming.admitted.turn}, resuming ${resuming.admitted.resumes ?? "nothing"}`)
      const taken = yield* successor.sessions.drain(idle, () => Effect.void)
      yield* expect("shutdown", taken.turns === 1, `another instance's drain of what waited ran ${taken.turns} turns`)
    })),

    scoped("a turn past its time limit is closed by its holder as interrupted with turn.time-limit, its writer TurnClosed timed-out, and resumed; one within its limit runs on", "time-limit", (owner) => Effect.gen(function* () {
      const [holder, other] = [yield* leased(), yield* leased()]
      const [limited, unlimited] = [yield* created(holder.sessions, owner), yield* created(holder.sessions, owner)]
      const writer = yield* holder.sessions.begin(limited, { ...say("bounded"), timeLimitMs: SHORT })
      const free = yield* holder.sessions.begin(unlimited, { ...say("unbounded"), timeLimitMs: LONG })
      const closing = yield* Effect.forkChild(writer.closed)
      yield* subject.advance(SHORT - 1)
      yield* expect("time-limit", !(yield* settles(closing)), "a turn was closed before its time limit")
      yield* subject.advance(1)
      const ended = yield* eventually(other.sessions.read(limited, { kinds: ["turn.ended"] }).pipe(
        Effect.map(endings),
        Effect.catch((error) => Effect.succeed(`unread (${error._tag})`)),
      ), (now) => now !== "", 2_000)
      yield* expect("time-limit", ended === "1:interrupted:turn.time-limit", `the turn past its time limit was closed as ${ended || "nothing"}`)
      yield* expect("time-limit", yield* settles(closing, 2_000), "the writer of a turn past its time limit was not closed")
      const closed = yield* Fiber.join(closing)
      const late = yield* writeRefused(writer)
      yield* expect("time-limit", closed.reason === "timed-out" && late === "TurnClosed:timed-out", `the writer was closed as ${closed.reason}, and a write after it gave ${late}`)
      const running = yield* writeRefused(free)
      yield* expect("time-limit", running === "stored", `a write by a turn within its time limit gave ${running}`)
      const resuming = yield* other.sessions.begin(limited, resume(1))
      yield* expect("time-limit", resuming.admitted.turn === 2 && resuming.admitted.resumes === 1, `resuming the turn past its limit opened turn ${resuming.admitted.turn}, resuming ${resuming.admitted.resumes ?? "nothing"}`)
    })),

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
