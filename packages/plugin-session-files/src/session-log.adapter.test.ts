import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { ConversationId, SessionLog } from "@xandreed/core"
import { sessionLogConformance, sessionLogRecoveryConformance } from "@xandreed/core/conformance"
import type { LeaseExpired, RevisionConflict, SessionExists, SessionHeader, SessionLogError, SessionMissing } from "@xandreed/core"
import { nodeFilesIo } from "./files-io.adapter.js"
import type { FilesIo } from "./files-io.adapter.js"
import { makeSessionLogFiles, SessionLogFilesLive } from "./session-log.adapter.js"
import { revisionFile, stagingName } from "./session-files.entity.functions.js"

const directory = mkdtempSync(join(tmpdir(), "efferent-session-files-"))
const scope = Effect.runSync(Scope.make())
const log = Context.get(await Effect.runPromise(Layer.buildWithScope(SessionLogFilesLive(join(directory, "kit")), scope)), SessionLog)
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)).then(() => rmSync(directory, { recursive: true, force: true })))

describe("the file session log conforms to the SessionLog contract", () => {
  sessionLogConformance(log).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }, 30_000))
})

describe("the file session log keeps its data across handles, reopening and interruption", () => {
  sessionLogRecoveryConformance({ open: makeSessionLogFiles(join(directory, "recovery")), callerClock: true }).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }, 40_000))
})

const header = (id: ConversationId, owner = "owner-files"): SessionHeader => ({ id, owner, origin: "user", createdAt: 1_767_225_600_000, meta: {}, parent: Option.none() })
const note = (n: number) => ({ kind: "note", turn: Option.none<number>(), data: { n } })
const everything = { after: 0, limit: Option.none<number>(), kinds: [] }

type LogFailure = SessionLogError | SessionMissing | SessionExists | RevisionConflict | LeaseExpired

/** A failure's own code (`SessionLogError.code`), another failure's tag, or `succeeded`. */
const outcomeOf = <A, R>(effect: Effect.Effect<A, LogFailure, R>) => Effect.exit(effect).pipe(Effect.map((exit) =>
  Exit.isSuccess(exit) ? "succeeded" : Option.match(Exit.findErrorOption(exit), {
    onNone: () => "defect",
    onSome: (error) => error._tag === "SessionLogError" ? error.code : error._tag,
  })))

/** A fresh directory and a session in it with `commits` notes, each its own commit. */
const withSession = (commits: number) => Effect.gen(function* () {
  const root = mkdtempSync(join(directory, "case-"))
  const id = ConversationId.make(crypto.randomUUID())
  const first = yield* makeSessionLogFiles(root)
  yield* first.create(header(id))
  yield* Effect.forEach(Array.from({ length: commits }, (_, n) => n), (n) =>
    first.commit(id, { expect: n, notAfter: Option.none(), events: [note(n + 1)], state: Option.some({ n: n + 1 }) }), { concurrency: 1, discard: true })
  return { root, id, commits: join(root, "sessions", id, "commits") }
})

describe("the directory", () => {
  test("holds one file per commit, named by its revision, and nothing in flight once a commit returns", async () => {
    const files = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { root, id, commits } = yield* withSession(3)
      return { commits: readdirSync(commits).sort(), tmp: readdirSync(join(root, "sessions", id, "tmp")) }
    })))
    expect(files).toEqual({ commits: [revisionFile(1), revisionFile(2), revisionFile(3)], tmp: [] })
  })

  test("a torn tail is set aside with its bytes kept: the commit before it is the head, and the next commit takes its revision", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { root, id, commits } = yield* withSession(3)
      const tail = join(commits, revisionFile(3))
      const whole = readFileSync(tail)
      writeFileSync(tail, whole.subarray(0, whole.length - 20))
      const reopened = yield* makeSessionLogFiles(root)
      const head = yield* reopened.head(id)
      const quarantined = readdirSync(join(root, "quarantine", id))
      const kept = readFileSync(join(root, "quarantine", id, quarantined[0] ?? ""))
      const next = yield* reopened.commit(id, { expect: 2, notAfter: Option.none(), events: [note(30)], state: Option.none() })
      const events = yield* reopened.read(id, everything)
      return { head: [head.revision, head.seq, head.state], kept: kept.equals(whole.subarray(0, whole.length - 20)), next: next.revision, ns: events.map((event) => event.data["n"]) }
    })))
    expect(observed).toEqual({ head: [2, 2, { n: 2 }], kept: true, next: 3, ns: [1, 2, 30] })
  })

  test("damage before the tail fails the read with store.decode, and nothing is moved", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { root, id, commits } = yield* withSession(3)
      const middle = join(commits, revisionFile(2))
      const bytes = readFileSync(middle)
      bytes[bytes.length - 30] = bytes[bytes.length - 30] === 48 ? 49 : 48
      writeFileSync(middle, bytes)
      const reopened = yield* makeSessionLogFiles(root)
      const read = yield* outcomeOf(reopened.read(id, everything))
      return { read, head: (yield* reopened.head(id)).revision, files: readdirSync(commits).length }
    })))
    expect(observed).toEqual({ read: "store.decode", head: 3, files: 3 })
  })

  test("a layout a newer release wrote is refused with store.version, and the directory is left as it was", async () => {
    const root = mkdtempSync(join(directory, "newer-"))
    writeFileSync(join(root, "store.json"), `${JSON.stringify({ layout: 2 })}\n`)
    const outcome = await Effect.runPromise(Effect.scoped(outcomeOf(makeSessionLogFiles(root))))
    expect([outcome, readFileSync(join(root, "store.json"), "utf8")]).toEqual(["store.version", `${JSON.stringify({ layout: 2 })}\n`])
  })

  test("a directory without hard links is refused with store.open", async () => {
    const noLinks: FilesIo = { ...nodeFilesIo, link: () => Promise.reject(Object.assign(new Error("not supported"), { code: "EPERM" })) }
    const outcome = await Effect.runPromise(Effect.scoped(outcomeOf(makeSessionLogFiles(mkdtempSync(join(directory, "nolinks-")), { io: noLinks }))))
    expect(outcome).toBe("store.open")
  })

  test("a call that does not answer within stallMs fails with store.stalled; later calls fail at once until one, let through a stallMs later, answers", async () => {
    const root = mkdtempSync(join(directory, "stall-"))
    const hanging = { on: false }
    const io: FilesIo = { ...nodeFilesIo, read: (path) => hanging.on ? new Promise(() => undefined) : nodeFilesIo.read(path) }
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root, { io, stallMs: 150 })
      const id = ConversationId.make(crypto.randomUUID())
      yield* store.create(header(id))
      hanging.on = true
      const started = Date.now()
      const stalled = yield* outcomeOf(store.head(id))
      const waited = Date.now() - started
      const fastStarted = Date.now()
      const failsFast = yield* outcomeOf(store.head(id))
      const fast = Date.now() - fastStarted
      hanging.on = false
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
      const healed = yield* outcomeOf(store.head(id))
      return { stalled, waited: waited >= 140, failsFast, fast: fast < 100, healed }
    })))
    expect(observed).toEqual({ stalled: "store.stalled", waited: true, failsFast: "store.stalled", fast: true, healed: "succeeded" })
  })

  test("a link whose answer was lost (it landed but failed) is settled by the commit's own nonce: the commit stands, once", async () => {
    const root = mkdtempSync(join(directory, "retransmit-"))
    const lossy: FilesIo = { ...nodeFilesIo, link: (from, to) => to.endsWith(".jsonl") ? nodeFilesIo.link(from, to).then(() => Promise.reject(Object.assign(new Error("lost answer"), { code: "EIO" }))) : nodeFilesIo.link(from, to) }
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root, { io: lossy })
      const id = ConversationId.make(crypto.randomUUID())
      yield* store.create(header(id))
      const committed = yield* store.commit(id, { expect: 0, notAfter: Option.none(), events: [note(1)], state: Option.none() })
      return { revision: committed.revision, events: (yield* store.read(id, everything)).length }
    })))
    expect(observed).toEqual({ revision: 1, events: 1 })
  })

  test("a session created twice, by two handles at once, is created once", async () => {
    const root = mkdtempSync(join(directory, "create-race-"))
    const id = ConversationId.make(crypto.randomUUID())
    const outcomes = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const [a, b] = yield* Effect.all([makeSessionLogFiles(root), makeSessionLogFiles(root)], { concurrency: 2 })
      return yield* Effect.all([outcomeOf(a.create(header(id))), outcomeOf(b.create(header(id)))], { concurrency: 2 })
    })))
    expect([...outcomes].sort()).toEqual(["SessionExists", "succeeded"])
  })

  test("a commit whose write runs past its notAfter publishes nothing: the lease is checked again right before the link", async () => {
    const root = mkdtempSync(join(directory, "late-"))
    const slow: FilesIo = { ...nodeFilesIo, create: (path, bytes) => /\/sessions\/[^/]+\/tmp\//.test(path) ? new Promise((resolve) => setTimeout(resolve, 60)).then(() => nodeFilesIo.create(path, bytes)) : nodeFilesIo.create(path, bytes) }
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root, { io: slow })
      const id = ConversationId.make(crypto.randomUUID())
      const created = yield* store.create(header(id))
      const late = yield* outcomeOf(store.commit(id, { expect: 0, notAfter: Option.some(created.now + 20), events: [note(1)], state: Option.none() }))
      return { late, head: (yield* store.head(id)).revision, commits: readdirSync(join(root, "sessions", id, "commits")), tmp: readdirSync(join(root, "sessions", id, "tmp")) }
    })))
    expect(observed).toEqual({ late: "LeaseExpired", head: 0, commits: [], tmp: [] })
  })

  test("a child created while its parent is removed goes with the parent", async () => {
    const root = mkdtempSync(join(directory, "orphan-"))
    const parent = ConversationId.make(crypto.randomUUID())
    const child = ConversationId.make(crypto.randomUUID())
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const renaming = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const resumed = Effect.runPromise(Deferred.await(release))
      // The remover stops right before it moves the parent away.
      const remover = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, rename: (from, to) => from.endsWith(`/sessions/${parent}`)
        ? (Effect.runFork(Deferred.succeed(renaming, undefined)), resumed.then(() => nodeFilesIo.rename(from, to)))
        : nodeFilesIo.rename(from, to) } })
      const creator = yield* makeSessionLogFiles(root)
      yield* creator.create(header(parent))
      const removing = yield* Effect.forkChild(remover.remove(parent))
      yield* Deferred.await(renaming)
      const created = yield* outcomeOf(creator.create({ ...header(child), parent: Option.some({ id: parent, through: 0, turnAtFork: 0 }) }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(removing)
      const listed = yield* creator.list({ owner: "owner-files", limit: 10, before: Option.none(), parent: Option.some(parent) })
      return { created, parent: yield* outcomeOf(creator.head(parent)), child: yield* outcomeOf(creator.head(child)), listed: listed.length }
    })))
    expect(observed).toEqual({ created: "succeeded", parent: "SessionMissing", child: "SessionMissing", listed: 0 })
  })

  test("a session removed while a read is under way is SessionMissing, and a listing leaves it out", async () => {
    const root = mkdtempSync(join(directory, "removed-under-"))
    const doomed = ConversationId.make(crypto.randomUUID())
    const other = ConversationId.make(crypto.randomUUID())
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const resumed = Effect.runPromise(Deferred.await(release))
      // The reader stops right before it lists the doomed session's commits.
      const reader = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, list: (path) => path.endsWith(`${doomed}/commits`)
        ? (Effect.runFork(Deferred.succeed(reached, undefined)), resumed.then(() => nodeFilesIo.list(path)))
        : nodeFilesIo.list(path) } })
      const remover = yield* makeSessionLogFiles(root)
      yield* remover.create(header(doomed))
      yield* remover.create(header(other))
      const listing = yield* Effect.forkChild(Effect.result(reader.list({ owner: "owner-files", limit: 10, before: Option.none(), parent: Option.none() })))
      yield* Deferred.await(reached)
      yield* remover.remove(doomed)
      yield* Deferred.succeed(release, undefined)
      const listed = yield* Fiber.join(listing)
      return { listed: listed._tag === "Success" ? listed.success.map((head) => head.header.id) : listed.failure._tag, head: yield* outcomeOf(reader.head(doomed)) }
    })))
    expect(observed).toEqual({ listed: [other], head: "SessionMissing" })
  })

  test("a handle that read a torn tail never sets aside the commit another writer published at that revision since", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { root, id, commits } = yield* withSession(2)
      const tail = join(commits, revisionFile(2))
      const whole = readFileSync(tail)
      writeFileSync(tail, whole.subarray(0, whole.length - 20))
      const moving = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const resumed = Effect.runPromise(Deferred.await(release))
      const gated = { first: true }
      // This handle read the torn tail and stops right before it moves it aside.
      const late = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, rename: (from, to) => to.includes("/quarantine/") && gated.first
        ? (gated.first = false, Effect.runFork(Deferred.succeed(moving, undefined)), resumed.then(() => nodeFilesIo.rename(from, to)))
        : nodeFilesIo.rename(from, to) } })
      const reading = yield* Effect.forkChild(late.head(id))
      yield* Deferred.await(moving)
      // Meanwhile another handle sets the torn tail aside and a writer publishes revision 2 again.
      const other = yield* makeSessionLogFiles(root)
      const repaired = yield* other.head(id)
      const again = yield* other.commit(id, { expect: repaired.revision, notAfter: Option.none(), events: [note(20)], state: Option.some({ n: 20 }) })
      yield* Deferred.succeed(release, undefined)
      const seen = yield* Fiber.join(reading)
      const fresh = yield* makeSessionLogFiles(root)
      const events = yield* fresh.read(id, everything)
      return { repaired: repaired.revision, again: again.revision, seen: [seen.revision, seen.state], ns: events.map((event) => event.data["n"]), quarantined: readdirSync(join(root, "quarantine", id)).length }
    })))
    expect(observed).toEqual({ repaired: 1, again: 2, seen: [2, { n: 20 }], ns: [1, 20], quarantined: 1 })
  })

  test("an open sweeps what stopped creates and probes left in staging long ago, never a staging in flight", async () => {
    const root = mkdtempSync(join(directory, "staging-"))
    await Effect.runPromise(Effect.scoped(makeSessionLogFiles(root)))
    const staging = join(root, "staging")
    const old = stagingName(crypto.randomUUID(), 1_000, crypto.randomUUID())
    mkdirSync(join(staging, old, "commits"), { recursive: true })
    writeFileSync(join(staging, old, "header.json"), "{}")
    const oldProbe = `${stagingName("link-probe", 1_000, crypto.randomUUID())}.linked`
    writeFileSync(join(staging, oldProbe), "probe\n")
    const oldMarker = stagingName("store.json", 1_000, crypto.randomUUID())
    writeFileSync(join(staging, oldMarker), "{}")
    const inFlight = stagingName(crypto.randomUUID(), Date.now(), crypto.randomUUID())
    mkdirSync(join(staging, inFlight))
    const earlier = `${crypto.randomUUID()}.${crypto.randomUUID()}`
    mkdirSync(join(staging, earlier))
    await Effect.runPromise(Effect.scoped(makeSessionLogFiles(root)))
    expect(readdirSync(staging).sort()).toEqual([earlier, inFlight].sort())
  })
})

