import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { ConversationId, sessionRef, SessionLog } from "@xandreed/core"
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

const lifeDirectory = (root: string, id: ConversationId): string => {
  const lives = join(root, "sessions", id, "lives")
  const incarnation = readdirSync(lives).find((name) => !readdirSync(join(lives, name)).includes("removed"))
  expect(incarnation).toBeDefined()
  return join(lives, incarnation!)
}
const quarantineDirectory = (root: string, id: ConversationId) => {
  const parent = join(root, "quarantine", id)
  return join(parent, readdirSync(parent)[0]!)
}

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
  yield* first.create({ header: header(id), state: {} })
  yield* Effect.forEach(Array.from({ length: commits }, (_, n) => n), (n) =>
    Effect.gen(function* () { const sessionHead = yield* first.head(id); return yield* first.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: n, notAfter: Option.none(), events: [note(n + 1)], state: Option.some({ n: n + 1 }) }) }), { concurrency: 1, discard: true })
  return { root, id, commits: join(lifeDirectory(root, id), "commits") }
})

describe("the directory", () => {
  test("holds one file per commit, named by its revision, and nothing in flight once a commit returns", async () => {
    const files = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { root, id, commits } = yield* withSession(3)
      return { commits: readdirSync(commits).sort(), tmp: readdirSync(join(lifeDirectory(root, id), "tmp")) }
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
      const quarantined = readdirSync(quarantineDirectory(root, id))
      const kept = readFileSync(join(quarantineDirectory(root, id), quarantined[0] ?? ""))
      const next = yield* Effect.gen(function* () { const sessionHead = yield* reopened.head(id); return yield* reopened.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 2, notAfter: Option.none(), events: [note(30)], state: Option.none() }) })
      const events = yield* Effect.gen(function* () { const sessionHead = yield* reopened.head(id); return yield* reopened.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, everything) })
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
      const read = yield* outcomeOf(Effect.gen(function* () { const sessionHead = yield* reopened.head(id); return yield* reopened.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, everything) }))
      return { read, head: (yield* reopened.head(id)).revision, files: readdirSync(commits).length }
    })))
    expect(observed).toEqual({ read: "store.decode", head: 3, files: 3 })
  })

  test("a read from the end opens the newest commits only: damage in an older one does not reach it", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { root, id, commits } = yield* withSession(3)
      const first = join(commits, revisionFile(1))
      const bytes = readFileSync(first)
      bytes[bytes.length - 30] = bytes[bytes.length - 30] === 48 ? 49 : 48
      writeFileSync(first, bytes)
      const reopened = yield* makeSessionLogFiles(root)
      const latest = yield* Effect.gen(function* () { const sessionHead = yield* reopened.head(id); return yield* reopened.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { ...everything, limit: Option.some(2), from: "end" }) })
      return { latest: latest.map((event) => [event.seq, event.data["n"]]), fromStart: yield* outcomeOf(Effect.gen(function* () { const sessionHead = yield* reopened.head(id); return yield* reopened.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, everything) })) }
    })))
    expect(observed).toEqual({ latest: [[2, 2], [3, 3]], fromStart: "store.decode" })
  })

  /** Every name under `root` with its bytes (a directory as `/`), sorted: what an open must leave as it was. */
  const treeOf = (root: string): ReadonlyArray<readonly [string, string]> => readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry): readonly [string, string] => {
      const path = join(entry.parentPath, entry.name).slice(root.length + 1)
      return [path, entry.isDirectory() ? "/" : readFileSync(join(root, path), "latin1")]
    })
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  /** A tree written as `files` lists it (a name ending in `/` is an empty directory). */
  const written = (prefix: string, files: Readonly<Record<string, string>>): string => {
    const root = mkdtempSync(join(directory, prefix))
    Object.entries(files).forEach(([path, content]) => {
      if (path.endsWith("/")) return void mkdirSync(join(root, path), { recursive: true })
      mkdirSync(join(root, path, ".."), { recursive: true })
      writeFileSync(join(root, path), content)
    })
    return root
  }
  /** Open `root` once: the outcome, and whether the tree is as it was before. */
  const opened = async (root: string) => {
    const before = treeOf(root)
    const outcome = await Effect.runPromise(Effect.scoped(outcomeOf(makeSessionLogFiles(root))))
    return { outcome, unchanged: JSON.stringify(treeOf(root)) === JSON.stringify(before) }
  }

  test("an unsupported layout (one a newer release wrote) is refused with store.version, and the whole directory is left as it was", async () => {
    const root = written("newer-", { "store.json": `${JSON.stringify({ layout: 3 })}\n`, "sessions/": "", [`staging/${stagingName("header", 0, "00000000-0000-4000-8000-000000000001")}`]: "abandoned" })
    expect(await opened(root)).toEqual({ outcome: "store.version", unchanged: true })
  })

  test("a store a 0.19.2 release wrote (layout 1, with a session and an abandoned staging entry) is refused with store.version, and nothing in it changes or is swept", async () => {
    const id = "00000000-0000-4000-8000-0000000019a2"
    const root = written("layout-1-", {
      "store.json": `${JSON.stringify({ layout: 1 })}\n`,
      [`sessions/${id}/header.json`]: `${JSON.stringify({ id, owner: "earlier", origin: "user", createdAt: 1, meta: {}, parent: null })}\n`,
      [`sessions/${id}/commits/${revisionFile(1)}`]: `${JSON.stringify({ revision: 1, seq: 1 })}\n`,
      [`staging/${stagingName("commit", 0, "00000000-0000-4000-8000-000000000002")}`]: "abandoned long ago",
      "trash/": "",
      "quarantine/": "",
    })
    expect(await opened(root)).toEqual({ outcome: "store.version", unchanged: true })
  })

  test("an unmarked directory is adopted only when it holds nothing but empty sessions/, staging/ and quarantine/ folders; anything else is refused as it was", async () => {
    const foreign = written("unmarked-foreign-", { "notes.txt": "a host's own file" })
    const sessions = written("unmarked-sessions-", { "sessions/someone/header.json": "{}" })
    const quarantine = written("unmarked-quarantine-", { "quarantine/torn": "bytes" })
    const empty = written("unmarked-empty-", { "sessions/": "", "staging/": "", "quarantine/": "" })
    const outcomes = await Promise.all([foreign, sessions, quarantine].map(opened))
    expect(outcomes).toEqual([{ outcome: "store.version", unchanged: true }, { outcome: "store.version", unchanged: true }, { outcome: "store.version", unchanged: true }])
    expect((await opened(empty)).outcome).toBe("succeeded")
    expect(readFileSync(join(empty, "store.json"), "utf8")).toBe(`${JSON.stringify({ layout: 2 })}\n`)
  })

  test("a directory without hard links is refused with store.open", async () => {
    const noLinks: FilesIo = { ...nodeFilesIo, link: () => Promise.reject(Object.assign(new Error("not supported"), { code: "EPERM" })) }
    const outcome = await Effect.runPromise(Effect.scoped(outcomeOf(makeSessionLogFiles(mkdtempSync(join(directory, "nolinks-")), { io: noLinks }))))
    expect(outcome).toBe("store.open")
  })

  test("a call that does not answer within stallMs fails with store.stalled; later calls fail at once until one, let through a stallMs later, answers", async () => {
    const root = mkdtempSync(join(directory, "stall-"))
    const hanging = { on: false, calls: 0 }
    const io: FilesIo = { ...nodeFilesIo, read: (path) => { hanging.calls += 1; return hanging.on ? new Promise(() => undefined) : nodeFilesIo.read(path) } }
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root, { io, stallMs: 150 })
      const id = ConversationId.make(crypto.randomUUID())
      yield* store.create({ header: header(id), state: {} })
      hanging.on = true
      const stalled = yield* outcomeOf(store.head(id))
      const beforeFast = hanging.calls
      const failsFast = yield* outcomeOf(store.head(id))
      const extraCalls = hanging.calls - beforeFast
      hanging.on = false
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
      const healed = yield* outcomeOf(store.head(id))
      return { stalled, failsFast, extraCalls, healed }
    })))
    expect(observed).toEqual({ stalled: "store.stalled", failsFast: "store.stalled", extraCalls: 0, healed: "succeeded" })
  })

  test("a link whose answer was lost (it landed but failed) is settled by the commit's own nonce: the commit stands, once", async () => {
    const root = mkdtempSync(join(directory, "retransmit-"))
    const lossy: FilesIo = { ...nodeFilesIo, link: (from, to) => to.endsWith(".jsonl") ? nodeFilesIo.link(from, to).then(() => Promise.reject(Object.assign(new Error("lost answer"), { code: "EIO" }))) : nodeFilesIo.link(from, to) }
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root, { io: lossy })
      const id = ConversationId.make(crypto.randomUUID())
      yield* store.create({ header: header(id), state: {} })
      const committed = yield* Effect.gen(function* () { const sessionHead = yield* store.head(id); return yield* store.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.none(), events: [note(1)], state: Option.none() }) })
      return { revision: committed.revision, events: (yield* Effect.gen(function* () { const sessionHead = yield* store.head(id); return yield* store.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, everything) })).length }
    })))
    expect(observed).toEqual({ revision: 1, events: 1 })
  })

  test("a session created twice, by two handles at once, is created once", async () => {
    const root = mkdtempSync(join(directory, "create-race-"))
    const id = ConversationId.make(crypto.randomUUID())
    const outcomes = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const [a, b] = yield* Effect.all([makeSessionLogFiles(root), makeSessionLogFiles(root)], { concurrency: 2 })
      return yield* Effect.all([outcomeOf(a.create({ header: header(id), state: {} })), outcomeOf(b.create({ header: header(id), state: {} }))], { concurrency: 2 })
    })))
    expect([...outcomes].sort()).toEqual(["SessionExists", "succeeded"])
  })

  test("a commit whose write runs past its notAfter publishes nothing: the lease is checked again right before the link", async () => {
    const root = mkdtempSync(join(directory, "late-"))
    const slow: FilesIo = { ...nodeFilesIo, create: (path, bytes) => /\/sessions\/[^/]+\/lives\/[^/]+\/tmp\//.test(path) ? new Promise((resolve) => setTimeout(resolve, 60)).then(() => nodeFilesIo.create(path, bytes)) : nodeFilesIo.create(path, bytes) }
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root, { io: slow })
      const id = ConversationId.make(crypto.randomUUID())
      const created = yield* store.create({ header: header(id), state: {} })
      const late = yield* outcomeOf(Effect.gen(function* () { const sessionHead = yield* store.head(id); return yield* store.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.some(created.now + 20), events: [note(1)], state: Option.none() }) }))
      return { late, head: (yield* store.head(id)).revision, commits: readdirSync(join(lifeDirectory(root, id), "commits")), tmp: readdirSync(join(lifeDirectory(root, id), "tmp")) }
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
      const remover = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, create: (path, bytes) => path.includes(`/sessions/${parent}/lives/`) && path.endsWith("/removed")
        ? (Effect.runFork(Deferred.succeed(renaming, undefined)), resumed.then(() => nodeFilesIo.create(path, bytes)))
        : nodeFilesIo.create(path, bytes) } })
      const creator = yield* makeSessionLogFiles(root)
      yield* creator.create({ header: header(parent), state: {} })
      const parentRef = { id: parent, owner: "owner-files", incarnation: (yield* creator.head(parent)).incarnation }
      const removing = yield* Effect.forkChild(Effect.gen(function* () { const sessionHead = yield* remover.head(parent); return yield* remover.remove({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }) }))
      yield* Deferred.await(renaming)
      const created = yield* outcomeOf(creator.create({ header: { ...header(child), parent: Option.some({ ...parentRef, through: 0, turnAtFork: 0 }) }, state: {} }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(removing)
      const listed = yield* creator.list({ owner: "owner-files", limit: 10, before: Option.none(), parent: Option.some(parentRef) })
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
      const reader = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, list: (path) => path.includes(`/sessions/${doomed}/lives/`) && path.endsWith("/commits")
        ? (Effect.runFork(Deferred.succeed(reached, undefined)), resumed.then(() => nodeFilesIo.list(path)))
        : nodeFilesIo.list(path) } })
      const remover = yield* makeSessionLogFiles(root)
      yield* remover.create({ header: header(doomed), state: {} })
      yield* remover.create({ header: header(other), state: {} })
      const listing = yield* Effect.forkChild(Effect.result(reader.list({ owner: "owner-files", limit: 10, before: Option.none(), parent: Option.none() })))
      yield* Deferred.await(reached)
      yield* Effect.gen(function* () { const sessionHead = yield* remover.head(doomed); return yield* remover.remove({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }) })
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
      const again = yield* Effect.gen(function* () { const sessionHead = yield* other.head(id); return yield* other.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: repaired.revision, notAfter: Option.none(), events: [note(20)], state: Option.some({ n: 20 }) }) })
      yield* Deferred.succeed(release, undefined)
      const seen = yield* Fiber.join(reading)
      const fresh = yield* makeSessionLogFiles(root)
      const events = yield* Effect.gen(function* () { const sessionHead = yield* fresh.head(id); return yield* fresh.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, everything) })
      return { repaired: repaired.revision, again: again.revision, seen: [seen.revision, seen.state], ns: events.map((event) => event.data["n"]), quarantined: readdirSync(quarantineDirectory(root, id)).length }
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

  test("a paused commit cannot write to a replacement session", async () => {
    /** A stale writer stopped right before it writes its commit's temporary file, while another handle removes the session and creates it again. */
    const recreatedWhileWriting = () => Effect.scoped(Effect.gen(function* () {
      const root = mkdtempSync(join(directory, "recreated-"))
      const id = ConversationId.make(crypto.randomUUID())
      const writing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const resumed = Effect.runPromise(Deferred.await(release))
      const gated = { armed: false }
      const stale = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, create: (path, bytes) => gated.armed && /\/sessions\/[^/]+\/lives\/[^/]+\/tmp\//.test(path)
        ? (gated.armed = false, Effect.runFork(Deferred.succeed(writing, undefined)), resumed.then(() => nodeFilesIo.create(path, bytes)))
        : nodeFilesIo.create(path, bytes) } })
      const other = yield* makeSessionLogFiles(root)
      yield* stale.create({ header: header(id), state: {} })
      yield* Effect.gen(function* () { const sessionHead = yield* stale.head(id); return yield* stale.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.none(), events: [note(1)], state: Option.none() }) })
      gated.armed = true
      const writer = yield* Effect.forkChild(outcomeOf(Effect.gen(function* () { const sessionHead = yield* stale.head(id); return yield* stale.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, {
        expect: 1, notAfter: Option.none(), events: [note(99)], state: Option.some({ stale: true }),
      }) })))
      yield* Deferred.await(writing)
      // The session created again reaches the revision the stale writer expects.
      yield* Effect.gen(function* () { const sessionHead = yield* other.head(id); return yield* other.remove({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }) })
      yield* other.create({ header: header(id), state: {} })
      yield* Effect.gen(function* () { const sessionHead = yield* other.head(id); return yield* other.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.none(), events: [note(2)], state: Option.none() }) })
      yield* Deferred.succeed(release, undefined)
      const outcome = yield* Fiber.join(writer)
      const events = yield* Effect.gen(function* () { const sessionHead = yield* other.head(id); return yield* other.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, everything) })
      const head = yield* other.head(id)
      return { outcome, ns: events.map((event) => event.data["n"]), head: [head.revision, head.state], tmp: readdirSync(join(lifeDirectory(root, id), "tmp")) }
    }))
    expect(await Effect.runPromise(recreatedWhileWriting())).toEqual({ outcome: "SessionMissing", ns: [2], head: [1, {}], tmp: [] })
  })

  test.each(["read", "link"] as const)("a payload %s paused across removal reports SessionMissing despite its retained header", async (operation) => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { root, id } = yield* withSession(1)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const resumed = Effect.runPromise(Deferred.await(release))
      const gate = { armed: false }
      const pause = <A>(run: () => Promise<A>) => {
        gate.armed = false
        Effect.runFork(Deferred.succeed(entered, undefined))
        return resumed.then(run)
      }
      const reader = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo,
        read: (path) => gate.armed && operation === "read" && path.includes("/commits/") ? pause(() => nodeFilesIo.read(path)) : nodeFilesIo.read(path),
        link: (from, to) => gate.armed && operation === "link" && to.includes("/commits/") ? pause(() => nodeFilesIo.link(from, to)) : nodeFilesIo.link(from, to),
      } })
      const remover = yield* makeSessionLogFiles(root)
      const reference = sessionRef(yield* reader.head(id))
      gate.armed = true
      const pending = yield* Effect.forkChild(outcomeOf(operation === "read"
        ? reader.read(reference, everything).pipe(Effect.asVoid)
        : reader.commit(reference, { expect: 1, notAfter: Option.none(), events: [note(99)], state: Option.none() }).pipe(Effect.asVoid)))
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      yield* Deferred.await(entered)
      yield* remover.remove(reference)
      const replacement = yield* remover.create({ header: header(id, "replacement-owner"), state: { replacement: true } })
      yield* Deferred.succeed(release, undefined)
      return { outcome: yield* Fiber.join(pending), replacement: (yield* remover.head(id)).state, events: yield* remover.read(sessionRef(replacement), everything) }
    }).pipe(Effect.timeout("10 seconds"))))
    expect(observed).toEqual({ outcome: "SessionMissing", replacement: { replacement: true }, events: [] })
  }, 15_000)

  test("a commit naming the incarnation it read, of a session removed and created again since, is SessionMissing before it writes", async () => {
    const root = mkdtempSync(join(directory, "recreated-before-"))
    const id = ConversationId.make(crypto.randomUUID())
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const [stale, other] = [yield* makeSessionLogFiles(root), yield* makeSessionLogFiles(root)]
      const first = yield* stale.create({ header: header(id), state: {} })
      yield* Effect.gen(function* () { const sessionHead = yield* other.head(id); return yield* other.remove({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }) })
      const again = yield* other.create({ header: header(id), state: {} })
      const refused = yield* outcomeOf(Effect.gen(function* () { const sessionHead = yield* stale.head(id); return yield* stale.commit({ ...{ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, incarnation: first.incarnation }, { expect: 0, notAfter: Option.none(), events: [note(1)], state: Option.none() }) }))
      const reopened = yield* makeSessionLogFiles(root)
      return { refused, distinct: first.incarnation !== again.incarnation, stable: (yield* reopened.head(id)).incarnation === again.incarnation, seq: (yield* reopened.head(id)).seq }
    })))
    expect(observed).toEqual({ refused: "SessionMissing", distinct: true, stable: true, seq: 0 })
  })
})

