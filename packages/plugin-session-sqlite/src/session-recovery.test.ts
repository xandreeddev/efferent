import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import { ConversationId, errorCodeOf, isStoreBusy, SessionLogEvent, Sessions, turnEndedOf, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { BeginTurn, SessionHeader, SessionLog, SessionLogError } from "@xandreed/core"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import type { SessionsConfig } from "@xandreed/plugin-sessions"
import { makeSessionLogSqlite, SessionLogSqliteLive } from "./session-log.adapter.js"

/*
 * Crash recovery against real processes: `session-holder.testing.ts` holds
 * the write lock, commits, or holds a turn in a child process, which these
 * tests stop (SIGKILL, when the point is a process that dies) and outlive.
 */

const directory = mkdtempSync(join(tmpdir(), "efferent-session-recovery-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const databasePath = () => join(directory, `${crypto.randomUUID()}.db`)

const holderScript = join(import.meta.dir, "session-holder.testing.ts")
/** Its stdin stays open while this process runs: a holder stops when it closes, so none outlives the test run. */
const launch = (args: ReadonlyArray<string>) => Bun.spawn([process.execPath, holderScript, ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
type Holder = ReturnType<typeof launch>

/** A holder process that said `ready`; killed and awaited when the scope closes, if it still runs. */
const holder = (...args: ReadonlyArray<string>): Effect.Effect<Holder, Error, Scope.Scope> => Effect.acquireRelease(
  Effect.sync(() => launch(args)),
  (child) => Effect.promise(() => { child.kill("SIGKILL"); return child.exited }),
).pipe(Effect.tap((child) => Stream.fromReadableStream({ evaluate: () => child.stdout, onError: (error) => new Error(String(error)), releaseLockOnEnd: true }).pipe(
  Stream.decodeText,
  Stream.splitLines,
  Stream.filter((line) => line === "ready"),
  Stream.runHead,
  Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Error(`the holder (${args.join(" ")}) stopped before it was ready`)), onSome: () => Effect.void })),
)))

/** What the holder printed after `ready`, read to the end of its output. */
const printed = (child: Holder) => Stream.fromReadableStream({ evaluate: () => child.stdout, onError: (error) => new Error(String(error)) }).pipe(
  Stream.decodeText,
  Stream.splitLines,
  Stream.runCollect,
)
/** Release a holder that waits for `go` on its stdin. */
const go = (child: Holder) => Effect.sync(() => child.stdin.write("go\n")).pipe(Effect.andThen(Effect.promise(async () => child.stdin.flush())))

/** Wait for the process to end; after a SIGKILL this also reaps it, so its pid no longer reads as running. */
const exited = (child: Holder) => Effect.promise(() => child.exited)
const killed = (child: Holder) => Effect.sync(() => child.kill("SIGKILL")).pipe(Effect.andThen(exited(child)), Effect.map(() => child.signalCode))

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))
const header = (id: ConversationId): SessionHeader => ({ id, owner: "owner-recovery", origin: "user", createdAt: 1_767_225_600_000, meta: {}, parent: Option.none() })
const freshId = () => ConversationId.make(crypto.randomUUID())
const range = (length: number) => Array.from({ length }, (_, n) => n)
const all = { after: 0, limit: Option.none<number>(), kinds: [] }

/** A log over the file, for the length of `body`. */
const withLog = <A, E>(path: string, body: (log: SessionLog["Service"]) => Effect.Effect<A, E>): Effect.Effect<A, E | SessionLogError> =>
  Effect.scoped(makeSessionLogSqlite(path).pipe(Effect.flatMap(body)))

describe("processes opening one new file at once", () => {
  test("all open it: the wait for a busy lock covers switching the file to WAL", () => run(Effect.gen(function* () {
    const path = databasePath()
    const openers = yield* Effect.forEach(range(4), () => holder("open", path), { concurrency: "unbounded" })
    yield* Effect.forEach(openers, go, { discard: true })
    const outcomes = yield* Effect.forEach(openers, (child) => Effect.all({ code: exited(child), lines: printed(child) }), { concurrency: "unbounded" })
    expect(outcomes.map((outcome) => [outcome.code, outcome.lines.includes("opened")])).toEqual(range(4).map(() => [0, true]))
  })), 30_000)
})

describe("a commit waiting for another process's write lock", () => {
  test("is refused once it waited past its notAfter, and when in time is stamped with the time it wrote", () => run(Effect.gen(function* () {
    const path = databasePath()
    const id = freshId()
    const log = yield* makeSessionLogSqlite(path)
    yield* log.create(header(id))

    const first = yield* holder("hold-lock", path, "1200")
    const notAfter = Date.now() + 300
    const refused = yield* Effect.flip(log.commit(id, { expect: 0, notAfter: Option.some(notAfter), events: [{ kind: "late", turn: Option.none(), data: {} }], state: Option.none() }))
    expect(refused._tag).toBe("LeaseExpired")
    expect(refused._tag === "LeaseExpired" && refused.now > notAfter).toBe(true)
    expect(yield* exited(first)).toBe(0)
    const head = yield* log.head(id)
    expect([head.revision, head.seq]).toEqual([0, 0])

    const second = yield* holder("hold-lock", path, "1200")
    const before = Date.now()
    const committed = yield* log.commit(id, { expect: 0, notAfter: Option.some(before + 30_000), events: [{ kind: "waited", turn: Option.none(), data: {} }], state: Option.none() })
    expect(committed.at - before).toBeGreaterThanOrEqual(600)
    expect(committed.events.map((event) => event.at)).toEqual([committed.at])
    expect((yield* log.head(id)).updatedAt).toBe(committed.at)
    expect(yield* exited(second)).toBe(0)
  })), 30_000)

  test("waits without blocking the thread: other fibers keep running until it commits", () => run(Effect.gen(function* () {
    const path = databasePath()
    const id = freshId()
    const log = yield* makeSessionLogSqlite(path)
    yield* log.create(header(id))
    const ticks = yield* Ref.make(0)
    yield* holder("hold-lock", path, "1000")
    const ticker = yield* Effect.forkScoped(Effect.forever(Effect.sleep("10 millis").pipe(Effect.andThen(Ref.update(ticks, (n) => n + 1)))))
    const committed = yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [{ kind: "waited", turn: Option.none(), data: {} }], state: Option.none() })
    const counted = yield* Ref.get(ticks)
    yield* Fiber.interrupt(ticker)
    expect(committed.revision).toBe(1)
    // About a hundred ticks while the lock is held; a wait that blocked the thread would let none through.
    expect(counted).toBeGreaterThan(20)
  })), 30_000)

  test("fails with store.busy, SQLite's error its cause, when the lock is held past the busy timeout, and goes on once the holder is gone", () => run(Effect.gen(function* () {
    const path = databasePath()
    const id = freshId()
    const log = yield* makeSessionLogSqlite(path)
    yield* log.create(header(id))
    const locked = yield* holder("hold-lock", path, "6000")
    const busy = yield* Effect.flip(log.commit(id, { expect: 0, notAfter: Option.none(), events: [{ kind: "blocked", turn: Option.none(), data: {} }], state: Option.none() }))
    expect(busy._tag === "SessionLogError" ? [busy.code, isStoreBusy(busy), Option.exists(errorCodeOf(busy.cause), (code) => code.startsWith("SQLITE_BUSY"))] : busy._tag)
      .toEqual(["store.busy", true, true])
    // A holder that dies inside its transaction takes the lock with it.
    expect(yield* killed(locked)).toBe("SIGKILL")
    expect((yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [], state: Option.none() })).revision).toBe(1)
  })), 30_000)
})

describe("a process killed while it commits", () => {
  const size = 20
  /** Whole commits only: every event belongs to a commit with all of its events, in order, and the head agrees. */
  const whole = (path: string, id: ConversationId) => withLog(path, (log) => Effect.gen(function* () {
    const head = yield* log.head(id)
    const events = yield* log.read(id, all)
    expect(events.every((event) => Schema.is(SessionLogEvent)(event))).toBe(true)
    expect(events.length).toBe(head.seq)
    expect(events.length % size).toBe(0)
    expect(head.revision).toBe(events.length / size)
    expect(head.state).toEqual(events.length === 0 ? {} : { commit: head.revision })
    expect(events.every((event, index) => event.seq === index + 1 && event.data.commit === Math.floor(index / size) + 1 && event.data.index === index % size)).toBe(true)
    expect(events.every((event, index) => index === 0 || events[index - 1]!.at <= event.at)).toBe(true)
    return head
  }))

  test("leaves whole commits: the log reopens intact, decodes, and takes the next commit", () => run(Effect.gen(function* () {
    const path = databasePath()
    const id = freshId()
    yield* withLog(path, (log) => log.create(header(id)))
    const heads = yield* Effect.forEach([100, 250, 400], (ms) => Effect.scoped(Effect.gen(function* () {
      const writer = yield* holder("commit-loop", path, id, String(size))
      yield* Effect.sleep(ms)
      expect(yield* killed(writer)).toBe("SIGKILL")
      return yield* whole(path, id)
    })))
    expect(heads.every((head, index) => head.revision >= index + 1)).toBe(true)
    const integrity = new Database(path, { readonly: true })
    expect(integrity.query<{ readonly integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
    integrity.close()
    const last = heads[heads.length - 1]!
    const next = yield* withLog(path, (log) => log.commit(id, {
      expect: last.revision, notAfter: Option.none(), events: range(size).map((index) => ({ kind: "part", turn: Option.none(), data: { commit: last.revision + 1, index, of: size } })), state: Option.some({ commit: last.revision + 1 }),
    }))
    expect([next.revision, next.seq]).toEqual([last.revision + 1, last.seq + size])
    yield* whole(path, id)
  })), 30_000)
})

describe("two processes racing by compare-and-swap", () => {
  test("200 increments each end at 400: they conflict, and no update is lost or stored twice", () => run(Effect.gen(function* () {
    const path = databasePath()
    const id = freshId()
    yield* withLog(path, (log) => log.create(header(id)))
    const writers = [yield* holder("cas-increments", path, id, "200", "a"), yield* holder("cas-increments", path, id, "200", "b")]
    yield* Effect.forEach(writers, go, { discard: true })
    const outcomes = yield* Effect.forEach(writers, (child) => Effect.all({ code: exited(child), lines: printed(child) }), { concurrency: "unbounded" })
    expect(outcomes.map((outcome) => outcome.code)).toEqual([0, 0])
    const conflicts = outcomes.map((outcome) => outcome.lines.flatMap((line) => line.startsWith("done ") ? [Number(line.slice("done ".length))] : []))
    expect(conflicts.map((done) => done.length)).toEqual([1, 1])
    // Both ran at once: some commits lost the race and were retried, which is the compare-and-swap under test.
    expect(conflicts.flat().reduce((total, count) => total + count, 0)).toBeGreaterThan(0)
    const { head, events } = yield* withLog(path, (log) => Effect.all({ head: log.head(id), events: log.read(id, all) }))
    expect([head.revision, head.seq, head.state.count]).toEqual([400, 400, 400])
    expect(["a", "b"].map((label) => events.filter((event) => event.data.by === label).map((event) => event.data.n))).toEqual([range(200), range(200)])
  })), 60_000)
})

describe("a turn whose holder process was killed", () => {
  const owner = "owner-recovery"
  const say = (text: string): BeginTurn => ({ _tag: "User", userMessage: new UserMessage({ text }), runId: `run-${text}`, key: text, command: {} })
  const sessionsOver = (path: string, config: SessionsConfig) =>
    Layer.build(SessionsLive(config).pipe(Layer.provide(Layer.merge(SessionLogSqliteLive(path), TurnAdmissionOpen)))).pipe(Effect.map(Context.get(Sessions)))
  /** The turn the next begin reaped: turn 1 ended as interrupted, by `turn.lease`, and turn 2 open. */
  const reaped = (sessions: Context.Service.Shape<typeof Sessions>, id: ConversationId) => Effect.gen(function* () {
    const address = { id, owner }
    expect(Option.isNone((yield* sessions.get(address)).open)).toBe(true)
    const writer = yield* sessions.begin(address, say("after the crash"))
    expect(writer.admitted.turn).toBe(2)
    const ended = yield* Effect.forEach(yield* sessions.read(address, { kinds: ["turn.ended"] }), turnEndedOf)
    expect(ended.map((end) => [end.reason, Option.map(end.failure, (failure) => failure.code)])).toEqual([["interrupted", Option.some("turn.lease")]])
  })

  test("under process ownership, is held while the process runs and reaped once it is gone", () => run(Effect.gen(function* () {
    const path = databasePath()
    const id = freshId()
    const turnHolder = yield* holder("hold-turn", path, id, owner, "process")
    const sessions = yield* sessionsOver(path, { ...sessionsDefaults, ownership: { mode: "process" } })
    expect(Option.map((yield* sessions.get({ id, owner })).open, (open) => open.turn)).toEqual(Option.some(1))
    expect((yield* Effect.flip(sessions.begin({ id, owner }, say("while it runs"))))._tag).toBe("SessionBusy")
    expect(yield* killed(turnHolder)).toBe("SIGKILL")
    yield* reaped(sessions, id)
  })), 30_000)

  test("under lease ownership, stays held until the lease runs out, then is reaped", () => run(Effect.gen(function* () {
    const path = databasePath()
    const id = freshId()
    const ttlMs = 60_000
    const turnHolder = yield* holder("hold-turn", path, id, owner, "lease")
    expect(yield* killed(turnHolder)).toBe("SIGKILL")
    const sessions = yield* sessionsOver(path, { ...sessionsDefaults, ownership: { mode: "lease", ttlMs, renew: "on-commit" } })
    yield* TestClock.setTime(Date.now())
    expect((yield* Effect.flip(sessions.begin({ id, owner }, say("within the lease"))))._tag).toBe("SessionBusy")
    yield* TestClock.setTime(Date.now() + ttlMs + 1_000)
    yield* reaped(sessions, id)
  }).pipe(Effect.provide(TestClock.layer()))), 30_000)
})
