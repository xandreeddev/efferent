import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option, Stream } from "effect"
import type { Scope } from "effect"
import { ConversationId } from "@xandreed/core"
import type { SessionHeader, SessionLog, SessionLogError } from "@xandreed/core"
import { makeSessionLogFiles } from "./session-log.adapter.js"

/*
 * Crash recovery against real processes: `fixtures/session-files-holder.mjs`
 * commits, races or stops inside a commit in a child process, which these
 * tests stop with SIGKILL and outlive. `verify:packages` runs the same
 * holder with Node over the packed package.
 */

const directory = mkdtempSync(join(tmpdir(), "efferent-files-recovery-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const freshRoot = () => mkdtempSync(join(directory, "root-"))

const holderScript = join(import.meta.dir, "../fixtures/session-files-holder.mjs")
/** Its stdin stays open while this process runs: a holder stops when it closes, so none outlives the test run. */
const launch = (args: ReadonlyArray<string>) => Bun.spawn([process.execPath, holderScript, ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
type Holder = ReturnType<typeof launch>

/** The holder's output lines, as they come. */
const lines = (child: Holder) => Stream.fromReadableStream({ evaluate: () => child.stdout, onError: (error) => new Error(String(error)), releaseLockOnEnd: true }).pipe(
  Stream.decodeText,
  Stream.splitLines,
)

/** A holder that said `line` (ready, or paused); killed and awaited when the scope closes, if it still runs. */
const holderSaying = (line: string, ...args: ReadonlyArray<string>): Effect.Effect<Holder, Error, Scope.Scope> => Effect.acquireRelease(
  Effect.sync(() => launch(args)),
  (child) => Effect.promise(() => { child.kill("SIGKILL"); return child.exited }),
).pipe(Effect.tap((child) => lines(child).pipe(
  Stream.filter((said) => said === line),
  Stream.runHead,
  Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Error(`the holder (${args.join(" ")}) stopped before it said ${line}`)), onSome: () => Effect.void })),
)))

const go = (child: Holder) => Effect.sync(() => child.stdin.write("go\n")).pipe(Effect.andThen(Effect.promise(async () => child.stdin.flush())))
const exited = (child: Holder) => Effect.promise(() => child.exited)
const killed = (child: Holder) => Effect.sync(() => child.kill("SIGKILL")).pipe(Effect.andThen(exited(child)), Effect.map(() => child.signalCode))

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))
const header = (id: ConversationId): SessionHeader => ({ id, owner: "owner-recovery", origin: "user", createdAt: 1_767_225_600_000, meta: {}, parent: Option.none() })
const freshId = () => ConversationId.make(crypto.randomUUID())
const range = (length: number) => Array.from({ length }, (_, n) => n)
const all = { after: 0, limit: Option.none<number>(), kinds: [] }

/** A log over the directory, for the length of `body`. */
const withLog = <A, E>(root: string, body: (log: SessionLog["Service"]) => Effect.Effect<A, E>): Effect.Effect<A, E | SessionLogError> =>
  Effect.scoped(makeSessionLogFiles(root).pipe(Effect.flatMap(body)))

const size = 5
/** The log as a new process reads it: only whole commits, dense sequence numbers, the head agreeing with the last. */
const whole = (root: string, id: ConversationId) => withLog(root, (log) => Effect.gen(function* () {
  const head = yield* log.head(id)
  const events = yield* log.read(id, all)
  expect(head.revision).toBe(events.length / size)
  expect(head.state).toEqual(events.length === 0 ? {} : { commit: head.revision })
  expect(events.every((event, index) => event.seq === index + 1 && event.data["commit"] === Math.floor(index / size) + 1 && event.data["index"] === index % size)).toBe(true)
  return head
}))

const tmpOf = (root: string, id: ConversationId) => readdirSync(join(root, "sessions", id, "tmp"))

describe("a writer process killed while it commits", () => {
  test("leaves whole commits: the log reopens intact and takes the next commit, and the next commit sweeps what it left", () => run(Effect.gen(function* () {
    const root = freshRoot()
    const id = freshId()
    yield* withLog(root, (log) => log.create(header(id)))
    const heads = yield* Effect.forEach([100, 250, 400], (ms) => Effect.scoped(Effect.gen(function* () {
      const writer = yield* holderSaying("ready", "commit-loop", root, id, String(size))
      yield* Effect.sleep(ms)
      expect(yield* killed(writer)).toBe("SIGKILL")
      return yield* whole(root, id)
    })), { concurrency: 1 })
    expect(heads.every((head, index) => head.revision >= index + 1)).toBe(true)
    const last = heads[heads.length - 1]!
    const next = yield* withLog(root, (log) => log.commit(id, {
      expect: last.revision, notAfter: Option.none(), events: range(size).map((index) => ({ kind: "part", turn: Option.none(), data: { commit: last.revision + 1, index, of: size } })), state: Option.some({ commit: last.revision + 1 }),
    }))
    expect([next.revision, next.seq]).toEqual([last.revision + 1, last.seq + size])
    yield* whole(root, id)
    // A temporary file the killed writers left is for a revision taken since: the first commit of a new handle removed it.
    expect(tmpOf(root, id)).toEqual([])
  })), 60_000)

  test("killed after writing its file and before linking it, it committed nothing: the head is as before, and the next commit takes the revision", () => run(Effect.gen(function* () {
    const root = freshRoot()
    const id = freshId()
    yield* withLog(root, (log) => log.create(header(id)))
    const writer = yield* holderSaying("paused", "pause", root, id, "after-write")
    expect(yield* killed(writer)).toBe("SIGKILL")
    expect(tmpOf(root, id).length).toBe(1)
    const after = yield* withLog(root, (log) => Effect.gen(function* () {
      const head = yield* log.head(id)
      const next = yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [{ kind: "part", turn: Option.none(), data: { commit: 1, index: 0, of: 1 } }], state: Option.some({ commit: 1 }) })
      return { revision: head.revision, next: next.revision, events: (yield* log.read(id, all)).length }
    }))
    expect(after).toEqual({ revision: 0, next: 1, events: 1 })
    expect(tmpOf(root, id)).toEqual([])
  })), 30_000)

  test("killed after linking its file and before cleaning up, it committed: the commit is the head, whole, and its leftover is swept", () => run(Effect.gen(function* () {
    const root = freshRoot()
    const id = freshId()
    yield* withLog(root, (log) => log.create(header(id)))
    const writer = yield* holderSaying("paused", "pause", root, id, "after-link")
    expect(yield* killed(writer)).toBe("SIGKILL")
    expect(tmpOf(root, id).length).toBe(1)
    const after = yield* withLog(root, (log) => Effect.gen(function* () {
      const head = yield* log.head(id)
      const events = yield* log.read(id, all)
      const next = yield* log.commit(id, { expect: 1, notAfter: Option.none(), events: [], state: Option.some({ commit: 2 }) })
      return { revision: head.revision, events: events.map((event) => event.data["index"]), next: next.revision }
    }))
    expect(after).toEqual({ revision: 1, events: [0, 1, 2], next: 2 })
    expect(tmpOf(root, id)).toEqual([])
  })), 30_000)
})

describe("two processes racing by compare-and-swap on one directory", () => {
  test("200 increments each end at 400: they conflict, and no update is lost or stored twice", () => run(Effect.gen(function* () {
    const root = freshRoot()
    const id = freshId()
    yield* withLog(root, (log) => log.create(header(id)))
    const writers = [yield* holderSaying("ready", "cas-increments", root, id, "200", "a"), yield* holderSaying("ready", "cas-increments", root, id, "200", "b")]
    yield* Effect.forEach(writers, go, { concurrency: 1, discard: true })
    const outcomes = yield* Effect.forEach(writers, (child) => Effect.all({ code: exited(child), lines: Stream.runCollect(lines(child)) }, { concurrency: 2 }), { concurrency: 2 })
    expect(outcomes.map((outcome) => outcome.code)).toEqual([0, 0])
    const conflicts = outcomes.map((outcome) => Array.from(outcome.lines).flatMap((line) => line.startsWith("done ") ? [Number(line.slice("done ".length))] : []))
    expect(conflicts.map((done) => done.length)).toEqual([1, 1])
    // Both ran at once: some commits lost the race and were retried, which is the compare-and-swap under test.
    expect(conflicts.flat().reduce((total, count) => total + count, 0)).toBeGreaterThan(0)
    const { head, events } = yield* withLog(root, (log) => Effect.all({ head: log.head(id), events: log.read(id, all) }, { concurrency: 1 }))
    expect([head.revision, head.seq, head.state["count"]]).toEqual([400, 400, 400])
    expect(["a", "b"].map((label) => events.filter((event) => event.data["by"] === label).map((event) => event.data["n"]))).toEqual([range(200), range(200)])
  })), 90_000)
})

/** A real mount to run the kits and the crash tests on, opt-in: `EFFERENT_SESSION_FILES_MOUNT=/mnt/nfs/efferent-test bun test …`. */
const mount = process.env["EFFERENT_SESSION_FILES_MOUNT"]

describe.skipIf(mount === undefined)("on the mount EFFERENT_SESSION_FILES_MOUNT names", () => {
  test("a writer killed while it commits leaves whole commits, and two processes racing lose no update", () => run(Effect.gen(function* () {
    const root = mkdtempSync(join(mount ?? directory, "efferent-mount-"))
    const id = freshId()
    yield* withLog(root, (log) => log.create(header(id)))
    const writer = yield* holderSaying("ready", "commit-loop", root, id, String(size))
    yield* Effect.sleep(300)
    yield* killed(writer)
    yield* whole(root, id)
    const raced = freshId()
    yield* withLog(root, (log) => log.create(header(raced)))
    const writers = [yield* holderSaying("ready", "cas-increments", root, raced, "50", "a"), yield* holderSaying("ready", "cas-increments", root, raced, "50", "b")]
    yield* Effect.forEach(writers, go, { concurrency: 1, discard: true })
    yield* Effect.forEach(writers, exited, { concurrency: 2 })
    const head = yield* withLog(root, (log) => log.head(raced))
    expect(head.state["count"]).toBe(100)
    rmSync(root, { recursive: true, force: true })
  })), 120_000)
})
