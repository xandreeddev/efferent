import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, References, Scope } from "effect"
import { ConversationId, SessionIncarnation, sessionRef, SessionLog, STORED_FORMAT } from "@xandreed/core"
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

/** The payload directory of the session's live generation: `lives/<id>.<incarnation>`, its incarnation not tombstoned. */
const lifeDirectory = (root: string, id: ConversationId): string => {
  const tombstones = join(root, "sessions", id, "removed")
  const removed = existsSync(tombstones) ? readdirSync(tombstones) : []
  const life = readdirSync(join(root, "lives")).find((name) => name.startsWith(`${id}.`) && !removed.includes(name.slice(id.length + 1)))
  expect(life).toBeDefined()
  return join(root, "lives", life!)
}
/** The quarantine folder of the session's generation: `quarantine/<id>.<incarnation>`. */
const quarantineDirectory = (root: string, id: ConversationId) => {
  const folder = readdirSync(join(root, "quarantine")).find((name) => name.startsWith(`${id}.`))
  expect(folder).toBeDefined()
  return join(root, "quarantine", folder!)
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
    const logged: Array<Readonly<Record<string, unknown>>> = []
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { root, id, commits } = yield* withSession(3)
      const tail = join(commits, revisionFile(3))
      const whole = readFileSync(tail)
      writeFileSync(tail, whole.subarray(0, whole.length - 20))
      const reopened = yield* makeSessionLogFiles(root)
      const head = yield* reopened.head(id).pipe(Effect.provide(Logger.layer([Logger.make((options) => {
        logged.push(options.fiber.getRef(References.CurrentLogAnnotations))
      })])))
      const quarantined = readdirSync(quarantineDirectory(root, id))
      const kept = readFileSync(join(quarantineDirectory(root, id), quarantined[0] ?? ""))
      const next = yield* Effect.gen(function* () { const sessionHead = yield* reopened.head(id); return yield* reopened.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 2, notAfter: Option.none(), events: [note(30)], state: Option.none() }) })
      const events = yield* Effect.gen(function* () { const sessionHead = yield* reopened.head(id); return yield* reopened.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, everything) })
      return { head: [head.revision, head.seq, head.state], kept: kept.equals(whole.subarray(0, whole.length - 20)), next: next.revision, ns: events.map((event) => event.data["n"]), id, incarnation: head.incarnation }
    })))
    const { id, incarnation, ...rest } = observed
    expect(rest).toEqual({ head: [2, 2, { n: 2 }], kept: true, next: 3, ns: [1, 2, 30] })
    // The warning names the session by its id and incarnation, as strings.
    expect(logged.map((annotations) => [annotations["efferent.session.id"], annotations["efferent.session.incarnation"]])).toEqual([[id, incarnation]])
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
      const message = yield* Effect.flip(reopened.read(sessionRef(yield* reopened.head(id)), everything)).pipe(Effect.map((error) => error.message))
      return { read, head: (yield* reopened.head(id)).revision, files: readdirSync(commits).length, names: message.includes(`commit 2 of session ${id}`) && !message.includes("[object Object]") }
    })))
    expect(observed).toEqual({ read: "store.decode", head: 3, files: 3, names: true })
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

  test("a read on a cold handle opens the commits it needs, not every commit before them", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { root, id } = yield* withSession(32)
      /** The commit files a fresh handle opens for one read, its head lookup included. */
      const opened = (query: Parameters<SessionLog["Service"]["read"]>[1]) => Effect.gen(function* () {
        const counted = { files: 0 }
        const counting: FilesIo = {
          ...nodeFilesIo,
          read: (path) => { if (path.includes("/commits/")) counted.files += 1; return nodeFilesIo.read(path) },
          readStart: (path, length) => { if (path.includes("/commits/")) counted.files += 1; return nodeFilesIo.readStart(path, length) },
        }
        const cold = yield* makeSessionLogFiles(root, { io: counting })
        const events = yield* cold.read(sessionRef(yield* cold.head(id)), query)
        return { files: counted.files, ns: events.map((event) => event.data["n"]) }
      })
      return {
        point: yield* opened({ after: 29, through: 30, limit: Option.some(1), kinds: [] }),
        latest: yield* opened({ after: 0, limit: Option.some(1), kinds: [], from: "end" }),
        after: yield* opened({ after: 28, limit: Option.none(), kinds: [] }),
        nothingNewer: yield* opened({ after: 32, limit: Option.none(), kinds: [] }),
      }
    })))
    expect(observed.point.ns).toEqual([30])
    expect(observed.latest.ns).toEqual([32])
    expect(observed.after.ns).toEqual([29, 30, 31, 32])
    expect(observed.nothingNewer.ns).toEqual([])
    // The tail read by the head lookup, a binary search over 32 revisions (at most 6 first lines), then the commits that hold
    // the events, each its first line and its whole: never the commits before the first wanted one.
    expect(observed.point.files).toBeLessThanOrEqual(1 + 6 + 2)
    expect(observed.latest.files).toBeLessThanOrEqual(2)
    expect(observed.after.files).toBeLessThanOrEqual(1 + 6 + 2 * 4)
    expect(observed.nothingNewer.files).toBeLessThanOrEqual(1)
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

  test("an unmarked directory is adopted only when it holds nothing but empty sessions/ and quarantine/ folders and a staging/ folder of names the store writes; anything else is refused as it was", async () => {
    const foreign = written("unmarked-foreign-", { "notes.txt": "a host's own file" })
    const sessions = written("unmarked-sessions-", { "sessions/someone/header.json": "{}" })
    const quarantine = written("unmarked-quarantine-", { "quarantine/torn": "bytes" })
    const staged = written("unmarked-staging-", { "staging/notes.txt": "a host's own file", [`staging/${stagingName("link-probe", 1_000, crypto.randomUUID())}`]: "probe\n" })
    const empty = written("unmarked-empty-", { "sessions/": "", "staging/": "", "quarantine/": "" })
    // Another handle opening it at once may have staged its probe or its marker: names the store writes, with their time.
    const opening = written("unmarked-opening-", { "sessions/": "", [`staging/${stagingName("store.json", Date.now(), crypto.randomUUID())}`]: "{}" })
    const outcomes = await Promise.all([foreign, sessions, quarantine, staged].map(opened))
    expect(outcomes).toEqual([foreign, sessions, quarantine, staged].map(() => ({ outcome: "store.version", unchanged: true })))
    expect([(await opened(empty)).outcome, (await opened(opening)).outcome]).toEqual(["succeeded", "succeeded"])
    expect(readFileSync(join(empty, "store.json"), "utf8")).toBe(`${JSON.stringify({ layout: 2, format: STORED_FORMAT })}\n`)
  })

  test.each([STORED_FORMAT - 1, STORED_FORMAT + 1])("a layout-2 store that records stored format %s is refused with store.version before anything in it changes", async (format) => {
    const root = written(`format-${format}-`, { "store.json": `${JSON.stringify({ layout: 2, format })}\n`, "sessions/": "", "lives/": "", "staging/": "", "quarantine/": "" })
    expect(await opened(root)).toEqual({ outcome: "store.version", unchanged: true })
  })

  test("a layout-2 store that records no stored format, as the first layout-2 release wrote it, opens as format 19 and keeps its marker", async () => {
    const root = written("unrecorded-", { "store.json": `${JSON.stringify({ layout: 2 })}\n`, "sessions/": "", "lives/": "", "staging/": "", "quarantine/": "" })
    expect((await opened(root)).outcome).toBe(STORED_FORMAT === 19 ? "succeeded" : "store.version")
    expect(readFileSync(join(root, "store.json"), "utf8")).toBe(`${JSON.stringify({ layout: 2 })}\n`)
  })

  test.each(["the root", "its sessions"] as const)("a handle that inspects %s of a fresh directory while another opens it and creates a session opens it too", async (inspected) => {
    const root = mkdtempSync(join(directory, "fresh-race-"))
    const id = ConversationId.make(crypto.randomUUID())
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const resumed = Effect.runPromise(Deferred.await(release))
      const gate = { armed: true }
      const target = inspected === "the root" ? root : join(root, "sessions")
      // An empty sessions folder makes the late handle look inside it too.
      if (inspected === "its sessions") mkdirSync(target)
      // The late handle stops right before it lists what it inspects, until the other has opened and created a session.
      const late = yield* Effect.forkChild(makeSessionLogFiles(root, { io: { ...nodeFilesIo, list: (path) => gate.armed && path === target
        ? (gate.armed = false, Effect.runFork(Deferred.succeed(entered, undefined)), resumed.then(() => nodeFilesIo.list(path)))
        : nodeFilesIo.list(path) } }))
      yield* Deferred.await(entered)
      const first = yield* makeSessionLogFiles(root)
      yield* first.create({ header: header(id), state: {} })
      yield* Deferred.succeed(release, undefined)
      const opened = yield* Effect.exit(Fiber.join(late))
      return Exit.isSuccess(opened) ? (yield* opened.value.head(id)).revision : Option.getOrUndefined(Exit.findErrorOption(opened))?.code
    })))
    expect(observed).toBe(0)
  })

  test("a directory without hard links is refused with store.open, fresh or holding a store already", async () => {
    const noLinks: FilesIo = { ...nodeFilesIo, link: () => Promise.reject(Object.assign(new Error("not supported"), { code: "EPERM" })) }
    /** The code and whether the message names hard links. */
    const refusal = (root: string) => Effect.runPromise(Effect.scoped(Effect.flip(makeSessionLogFiles(root, { io: noLinks })).pipe(Effect.map((error) => [error.code, error.message.includes("hard links")]))))
    const fresh = mkdtempSync(join(directory, "nolinks-"))
    // A store initialized where links work, then copied or restored onto a mount without them.
    const existing = mkdtempSync(join(directory, "nolinks-existing-"))
    await Effect.runPromise(Effect.scoped(makeSessionLogFiles(existing)))
    expect({ fresh: await refusal(fresh), existing: await refusal(existing) }).toEqual({ fresh: ["store.open", true], existing: ["store.open", true] })
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
    const slow: FilesIo = { ...nodeFilesIo, create: (path, bytes) => /\/lives\/[^/]+\/tmp\//.test(path) ? new Promise((resolve) => setTimeout(resolve, 60)).then(() => nodeFilesIo.create(path, bytes)) : nodeFilesIo.create(path, bytes) }
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
      const remover = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, create: (path, bytes) => path.includes(`/sessions/${parent}/removed/`)
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
      const reader = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, list: (path) => path.includes(`/lives/${doomed}.`) && path.endsWith("/commits")
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

  test("a handle that read a torn tail while the session is removed leaves no quarantine folder of it behind", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { root, id, commits } = yield* withSession(2)
      const tail = join(commits, revisionFile(2))
      const whole = readFileSync(tail)
      writeFileSync(tail, whole.subarray(0, whole.length - 20))
      const making = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const resumed = Effect.runPromise(Deferred.await(release))
      const gated = { first: true }
      // This handle read the torn tail and stops right before it makes the quarantine folder.
      const late = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, mkdir: (path) => path.includes("/quarantine/") && gated.first
        ? (gated.first = false, Effect.runFork(Deferred.succeed(making, undefined)), resumed.then(() => nodeFilesIo.mkdir(path)))
        : nodeFilesIo.mkdir(path) } })
      const reading = yield* Effect.forkChild(outcomeOf(late.head(id)))
      yield* Deferred.await(making)
      const other = yield* makeSessionLogFiles(root)
      yield* other.remove(sessionRef(yield* other.head(id)))
      yield* Deferred.succeed(release, undefined)
      return { read: yield* Fiber.join(reading), quarantine: readdirSync(join(root, "quarantine")) }
    })))
    expect(observed).toEqual({ read: "SessionMissing", quarantine: [] })
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
      const stale = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, create: (path, bytes) => gated.armed && /\/lives\/[^/]+\/tmp\//.test(path)
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


/** The files under `root` (paths relative to it) whose bytes hold `needle`. */
const filesHolding = (root: string, needle: string): ReadonlyArray<string> => readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && readFileSync(join(entry.parentPath, entry.name), "latin1").includes(needle))
  .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))

/** `effect` with the wall clock `ms` ahead: what a handle opened or a call made that much later sees. */
const later = (ms: number) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => Clock.clockWith((clock) => Effect.provideService(effect, Clock.Clock, {
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + ms,
  currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + ms),
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(ms) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe() + BigInt(ms) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: Effect.sync(() => clock.monotonicTimeNanosUnsafe()),
  sleep: (duration) => clock.sleep(duration),
}))

const failing = (code: string) => Promise.reject(Object.assign(new Error(`injected ${code}`), { code }))

/** `nodeFilesIo` with every call passed through `around`: its paths, and the call itself. */
const aroundIo = (around: <A>(paths: ReadonlyArray<string>, run: () => Promise<A>) => Promise<A>): FilesIo => ({
  mkdir: (path) => around([path], () => nodeFilesIo.mkdir(path)),
  create: (path, bytes) => around([path], () => nodeFilesIo.create(path, bytes)),
  link: (from, to) => around([from, to], () => nodeFilesIo.link(from, to)),
  rename: (from, to) => around([from, to], () => nodeFilesIo.rename(from, to)),
  read: (path) => around([path], () => nodeFilesIo.read(path)),
  readStart: (path, length) => around([path], () => nodeFilesIo.readStart(path, length)),
  list: (path) => around([path], () => nodeFilesIo.list(path)),
  exists: (path) => around([path], () => nodeFilesIo.exists(path)),
  unlink: (path) => around([path], () => nodeFilesIo.unlink(path)),
  removeTree: (path) => around([path], () => nodeFilesIo.removeTree(path)),
  syncDirectory: (path) => around([path], () => nodeFilesIo.syncDirectory(path)),
})

describe("removal", () => {
  /** A session with a secret in its owner, meta, state and events, and a child of it with its own: what removal must not leave behind. */
  const secretFamily = (store: SessionLog["Service"], secret: string) => Effect.gen(function* () {
    const owner = `owner-${secret}`
    const parent = ConversationId.make(crypto.randomUUID())
    const child = ConversationId.make(crypto.randomUUID())
    const created = yield* store.create({ header: { ...header(parent, owner), meta: { title: `meta-${secret}` } }, state: { kept: `state-${secret}` } })
    yield* store.commit(sessionRef(created), { expect: 0, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: { said: `event-${secret}` } }], state: Option.some({ kept: `later-${secret}` }) })
    const forked = yield* store.create({ header: { ...header(child, owner), meta: { title: `child-meta-${secret}` }, parent: Option.some({ ...sessionRef(created), through: 1, turnAtFork: 1 }) }, state: { kept: `child-state-${secret}` } })
    yield* store.commit(sessionRef(forked), { expect: 0, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: { said: `child-event-${secret}` } }], state: Option.none() })
    return { parent, child, parentRef: sessionRef(created), childRef: sessionRef(forked) }
  })

  test("removing a session leaves on disk none of its owner, meta, initial state, state or events, nor its children's, a torn tail set aside included", async () => {
    const root = mkdtempSync(join(directory, "residue-"))
    const secret = crypto.randomUUID()
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root)
      const { parent, child, parentRef } = yield* secretFamily(store, secret)
      // A torn tail, set aside by a later head: its bytes are kept in quarantine until the session is removed.
      yield* store.commit(parentRef, { expect: 1, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: { said: `torn-${secret}` } }], state: Option.none() })
      const torn = filesHolding(root, `torn-${secret}`).find((path) => path.endsWith(revisionFile(2)))!
      const whole = readFileSync(join(root, torn))
      writeFileSync(join(root, torn), whole.subarray(0, whole.length - 20))
      const reopened = yield* makeSessionLogFiles(root)
      const repaired = (yield* reopened.head(parent)).revision
      yield* reopened.remove(parentRef)
      return { repaired, parent: yield* outcomeOf(reopened.head(parent)), child: yield* outcomeOf(reopened.head(child)), left: filesHolding(root, secret), quarantine: readdirSync(join(root, "quarantine")) }
    })))
    expect(observed).toEqual({ repaired: 1, parent: "SessionMissing", child: "SessionMissing", left: [], quarantine: [] })
  })

  test("a listing and a removal do the same file system work however many sessions were removed before them", async () => {
    const root = mkdtempSync(join(directory, "bounded-"))
    const owner = "owner-bounded"
    const work = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root)
      yield* Effect.forEach([1, 2, 3], () => store.create({ header: header(ConversationId.make(crypto.randomUUID()), owner), state: {} }), { concurrency: 1, discard: true })
      /** The calls a fresh handle makes to list the owner's sessions, then to remove a new one. */
      const measured = Effect.gen(function* () {
        const counted = { calls: 0 }
        const counting = aroundIo((_paths, run) => { counted.calls += 1; return run() })
        const fresh = yield* makeSessionLogFiles(root, { io: counting })
        const doomed = yield* store.create({ header: header(ConversationId.make(crypto.randomUUID()), owner), state: {} })
        counted.calls = 0
        const listed = (yield* fresh.list({ owner, limit: 10, before: Option.none(), parent: Option.none() })).length
        const listing = counted.calls
        counted.calls = 0
        yield* fresh.remove(sessionRef(doomed))
        return { listed, listing, removal: counted.calls }
      })
      const before = yield* measured
      // Many sessions created and removed since, of this owner and of others.
      yield* Effect.forEach(Array.from({ length: 40 }, (_, n) => n), (n) => store.create({ header: header(ConversationId.make(crypto.randomUUID()), n % 2 === 0 ? owner : "owner-other"), state: {} }).pipe(
        Effect.flatMap((created) => store.remove(sessionRef(created)))), { concurrency: 1, discard: true })
      return { before, after: yield* measured }
    })))
    expect(work.after).toEqual(work.before)
  })

  test("a removal that fails part way, after its tombstone, is finished by removing the reference again", async () => {
    const root = mkdtempSync(join(directory, "partial-"))
    const secret = crypto.randomUUID()
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root)
      const { parent, child, parentRef } = yield* secretFamily(store, secret)
      const fault = { armed: false }
      // The remover's first read of anything of the child, once it is open, fails: the removal cannot tell whether it is a child.
      const remover = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, read: (path) => fault.armed && path.includes(child) ? (fault.armed = false, failing("EIO")) : nodeFilesIo.read(path) } })
      fault.armed = true
      const first = yield* outcomeOf(remover.remove(parentRef))
      const hidden = [yield* outcomeOf(store.head(parent)), yield* outcomeOf(store.head(child))]
      const again = yield* outcomeOf(store.remove(parentRef))
      return { first, hidden, again, left: filesHolding(root, secret) }
    })))
    expect(observed).toEqual({ first: "store.io", hidden: ["SessionMissing", "SessionMissing"], again: "SessionMissing", left: [] })
  })

  test("a removal stopped right after its tombstone (its process gone) is finished when the directory is opened again", async () => {
    const root = mkdtempSync(join(directory, "stopped-"))
    const secret = crypto.randomUUID()
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root)
      const { parent, child, parentRef } = yield* secretFamily(store, secret)
      const stopped = { now: false }
      const dead = <A>(run: () => Promise<A>): Promise<A> => stopped.now ? failing("EIO") : run()
      // Every call after the parent's tombstone fails, as if the process stopped there.
      const remover = yield* makeSessionLogFiles(root, { io: {
        ...aroundIo((_paths, run) => dead(run)),
        create: (path, bytes) => dead(() => nodeFilesIo.create(path, bytes)).then(() => { if (path.includes(parent) && /\/removed(\/|$)/.test(path)) stopped.now = true }),
      } })
      const first = yield* outcomeOf(remover.remove(parentRef))
      const reopened = yield* makeSessionLogFiles(root)
      return { first, parent: yield* outcomeOf(reopened.head(parent)), child: yield* outcomeOf(reopened.head(child)), left: filesHolding(root, secret) }
    })))
    expect(observed).toEqual({ first: "store.io", parent: "SessionMissing", child: "SessionMissing", left: [] })
  })

  test("a create whose claim failed with its outcome unknown leaves nothing once the directory is opened an hour later, and the id can be created again", async () => {
    const root = mkdtempSync(join(directory, "abandoned-"))
    const secret = crypto.randomUUID()
    const id = ConversationId.make(crypto.randomUUID())
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      // The claim's link lands but answers an error, and reading the claim back fails too: the creator cannot tell.
      const lossy = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo,
        link: (from, to) => to.includes("/claims/") ? nodeFilesIo.link(from, to).then(() => failing("EIO")) : nodeFilesIo.link(from, to),
        read: (path) => path.includes("/claims/") ? failing("EIO") : nodeFilesIo.read(path),
      } })
      const created = yield* outcomeOf(lossy.create({ header: { ...header(id), meta: { title: `meta-${secret}` } }, state: { kept: `state-${secret}` } }))
      const reopened = yield* later(2 * 3_600_000)(makeSessionLogFiles(root))
      const again = yield* later(2 * 3_600_000)(outcomeOf(reopened.create({ header: header(id), state: {} })))
      return { created, again, left: filesHolding(root, secret) }
    })))
    expect(observed).toEqual({ created: "store.io", again: "succeeded", left: [] })
  })

  test("a session whose header is damaged does not stop another session's removal or a listing", async () => {
    const root = mkdtempSync(join(directory, "damaged-other-"))
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeSessionLogFiles(root)
      const damaged = ConversationId.make(crypto.randomUUID())
      yield* store.create({ header: header(damaged, "owner-damaged"), state: {} })
      const headerFile = readdirSync(root, { recursive: true, withFileTypes: true }).find((entry) => entry.name === "header.json" && join(entry.parentPath, entry.name).includes(damaged))!
      writeFileSync(join(headerFile.parentPath, headerFile.name), "{not json")
      const kept = ConversationId.make(crypto.randomUUID())
      yield* store.create({ header: header(kept), state: {} })
      const doomed = yield* store.create({ header: header(ConversationId.make(crypto.randomUUID())), state: {} })
      const fresh = yield* makeSessionLogFiles(root)
      const removed = yield* outcomeOf(fresh.remove(sessionRef(doomed)))
      const listed = yield* fresh.list({ owner: "owner-files", limit: 10, before: Option.none(), parent: Option.none() }).pipe(Effect.map((heads) => heads.map((head) => head.header.id)), Effect.orElseSucceed(() => "failed"))
      return { removed, listed, kept: [kept], damaged: yield* outcomeOf(fresh.head(damaged)) }
    })))
    expect(observed).toEqual({ removed: "succeeded", listed: observed.kept, kept: observed.kept, damaged: "store.decode" })
  })

  /** A handle whose first `rename` into `lives/` of `id` (a creation publishing its claimed payload) waits for `release`, `entered` told. */
  const publishingPaused = (root: string, id: ConversationId) => Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const resumed = Effect.runPromise(Deferred.await(release))
    const gate = { armed: true }
    const store = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo, rename: (from, to) => gate.armed && to.includes(`/lives/${id}.`)
      ? (gate.armed = false, Effect.runFork(Deferred.succeed(entered, undefined)), resumed.then(() => nodeFilesIo.rename(from, to)))
      : nodeFilesIo.rename(from, to) } })
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    return { store, entered, release }
  })
  const claimOf = (root: string, id: ConversationId, generation: number) =>
    JSON.parse(readFileSync(join(root, "sessions", id, "claims", `${generation}.json`), "utf8")) as { readonly id: string; readonly incarnation: string }

  test("a child claimed while its parent is removed, its payload published after the removal looked for children, is removed by its creator's check after publication", async () => {
    const root = mkdtempSync(join(directory, "recheck-"))
    const parent = ConversationId.make(crypto.randomUUID())
    const child = ConversationId.make(crypto.randomUUID())
    const secret = crypto.randomUUID()
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { store: creator, entered, release } = yield* publishingPaused(root, child)
      const remover = yield* makeSessionLogFiles(root)
      const parentRef = sessionRef(yield* remover.create({ header: header(parent), state: {} }))
      const creating = yield* Effect.forkChild(outcomeOf(creator.create({ header: { ...header(child), meta: { title: `meta-${secret}` }, parent: Option.some({ ...parentRef, through: 0, turnAtFork: 0 }) }, state: {} })))
      yield* Deferred.await(entered)
      // The child is claimed, not yet under lives/: the removal does not see it.
      yield* remover.remove(parentRef)
      yield* Deferred.succeed(release, undefined)
      const created = yield* Fiber.join(creating)
      const claimed = claimOf(root, child, 1)
      const tombstone = existsSync(join(root, "sessions", child, "removed", claimed.incarnation))
      const payload = existsSync(join(root, "lives", `${child}.${claimed.incarnation}`))
      const head = yield* outcomeOf(remover.head(child))
      const again = yield* remover.create({ header: header(child), state: {} })
      return { created, tombstone, payload, head, again: [claimOf(root, child, 2).incarnation === again.incarnation, again.incarnation !== claimed.incarnation], left: filesHolding(root, secret) }
    })))
    expect(observed).toEqual({ created: "SessionMissing", tombstone: true, payload: false, head: "SessionMissing", again: [true, true], left: [] })
  })

  test("a child published after its parent's removal looked for children, its creator stopped before its check, is removed by an open once it is older than any creation takes", async () => {
    const root = mkdtempSync(join(directory, "orphan-"))
    const parent = ConversationId.make(crypto.randomUUID())
    const child = ConversationId.make(crypto.randomUUID())
    const secret = crypto.randomUUID()
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const resumed = Effect.runPromise(Deferred.await(release))
      const gate = { armed: true, stopped: false }
      // The creator's rename into lives/ waits for the parent's removal; every call after it fails, as if its process stopped there.
      const creator = yield* makeSessionLogFiles(root, { io: {
        ...aroundIo((_paths, run) => gate.stopped ? failing("EIO") : run()),
        rename: (from, to) => gate.stopped ? failing("EIO") : gate.armed && to.includes(`/lives/${child}.`)
          ? (gate.armed = false, Effect.runFork(Deferred.succeed(entered, undefined)), resumed.then(() => nodeFilesIo.rename(from, to)).then(() => { gate.stopped = true }))
          : nodeFilesIo.rename(from, to),
      } })
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const remover = yield* makeSessionLogFiles(root)
      const parentRef = sessionRef(yield* remover.create({ header: header(parent), state: {} }))
      const creating = yield* Effect.forkChild(outcomeOf(creator.create({ header: { ...header(child), meta: { title: `meta-${secret}` }, parent: Option.some({ ...parentRef, through: 0, turnAtFork: 0 }) }, state: { kept: `state-${secret}` } })))
      yield* Deferred.await(entered)
      yield* remover.remove(parentRef)
      yield* Deferred.succeed(release, undefined)
      const created = yield* Fiber.join(creating)
      const hidden = yield* outcomeOf(remover.head(child))
      // An open soon after leaves a generation that young alone (its creator may still be checking it); one an hour later removes it.
      yield* makeSessionLogFiles(root)
      const soon = filesHolding(root, secret).length > 0
      const reopened = yield* later(2 * 3_600_000)(makeSessionLogFiles(root))
      return { created, hidden, soon, child: yield* outcomeOf(reopened.head(child)), left: filesHolding(root, secret) }
    })))
    expect(observed).toEqual({ created: "store.io", hidden: "SessionMissing", soon: true, child: "SessionMissing", left: [] })
  })

  test("removing again a reference whose removal finished writes nothing and reads no other session, whatever owner it names", async () => {
    const root = mkdtempSync(join(directory, "finished-"))
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const touched: Array<string> = []
      const counting = { on: false }
      const spying = aroundIo((paths, run) => { if (counting.on) touched.push(...paths); return run() })
      const store = yield* makeSessionLogFiles(root, { io: { ...spying,
        create: (path, bytes) => { if (counting.on) touched.push(`create ${path}`); return nodeFilesIo.create(path, bytes) },
        list: (path) => { if (counting.on) touched.push(`list ${path}`); return nodeFilesIo.list(path) },
      } })
      yield* Effect.forEach([1, 2, 3], () => store.create({ header: header(ConversationId.make(crypto.randomUUID()), "owner-other"), state: {} }), { concurrency: 1, discard: true })
      const removed = sessionRef(yield* store.create({ header: header(ConversationId.make(crypto.randomUUID())), state: {} }))
      yield* store.remove(removed)
      counting.on = true
      const outcomes = [yield* outcomeOf(store.remove(removed)), yield* outcomeOf(store.remove({ ...removed, owner: "owner-stranger" }))]
      counting.on = false
      return { outcomes, writes: touched.filter((entry) => entry.startsWith("create ")), listings: touched.filter((entry) => entry.startsWith("list ")), others: touched.filter((path) => path.includes("/lives/") && !path.includes(removed.id)) }
    })))
    expect(observed).toEqual({ outcomes: ["SessionMissing", "SessionMissing"], writes: [], listings: [], others: [] })
  })

  test("a creation claimed but not yet published holds its id: another creation of it is SessionExists, and the first one lands", async () => {
    const root = mkdtempSync(join(directory, "in-flight-"))
    const id = ConversationId.make(crypto.randomUUID())
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { store: first, entered, release } = yield* publishingPaused(root, id)
      const second = yield* makeSessionLogFiles(root)
      const creating = yield* Effect.forkChild(first.create({ header: header(id), state: { first: true } }))
      yield* Deferred.await(entered)
      const raced = yield* outcomeOf(second.create({ header: header(id), state: { second: true } }))
      yield* Deferred.succeed(release, undefined)
      const created = yield* Fiber.join(creating)
      const head = yield* second.head(id)
      return { raced, same: head.incarnation === created.incarnation, state: head.state }
    })))
    expect(observed).toEqual({ raced: "SessionExists", same: true, state: { first: true } })
  })

  test("a claimed generation whose payload could not be published, nor removed, leaves none of its files and holds its id only until a creation an hour later", async () => {
    const root = mkdtempSync(join(directory, "unpublished-"))
    const id = ConversationId.make(crypto.randomUUID())
    const secret = crypto.randomUUID()
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const broken = yield* makeSessionLogFiles(root, { io: { ...nodeFilesIo,
        rename: (from, to) => to.includes(`/lives/${id}.`) ? failing("EIO") : nodeFilesIo.rename(from, to),
        create: (path, bytes) => path.includes("/removing/") ? failing("EIO") : nodeFilesIo.create(path, bytes),
      } })
      const created = yield* outcomeOf(broken.create({ header: { ...header(id), meta: { title: `meta-${secret}` } }, state: {} }))
      const store = yield* makeSessionLogFiles(root)
      const soon = yield* outcomeOf(store.create({ header: header(id), state: {} }))
      const left = filesHolding(root, secret)
      const hourLater = yield* later(2 * 3_600_000)(outcomeOf(store.create({ header: header(id), state: {} })))
      return { created, soon, left, hourLater, tombstoned: existsSync(join(root, "sessions", id, "removed", claimOf(root, id, 1).incarnation)), generation: claimOf(root, id, 2).id }
    })))
    expect(observed).toEqual({ created: "store.io", soon: "SessionExists", left: [], hourLater: "succeeded", tombstoned: true, generation: id })
  })

  test("a reference with an incarnation that is not one the store minted is SessionMissing, and no file outside the store is looked at", async () => {
    const root = mkdtempSync(join(directory, "crafted-"))
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const paths: Array<string> = []
      const spying = aroundIo((called, run) => { paths.push(...called); return run() })
      const store = yield* makeSessionLogFiles(root, { io: spying })
      const id = ConversationId.make(crypto.randomUUID())
      yield* store.create({ header: header(id), state: {} })
      paths.length = 0
      const crafted = { id, owner: "owner-files", incarnation: SessionIncarnation.make("../../../../../../../../tmp/elsewhere") }
      const outcomes = [
        yield* outcomeOf(store.read(crafted, everything)),
        yield* outcomeOf(store.commit(crafted, { expect: 0, notAfter: Option.none(), events: [note(1)], state: Option.none() })),
        yield* outcomeOf(store.remove(crafted)),
        yield* outcomeOf(store.create({ header: { ...header(ConversationId.make(crypto.randomUUID())), parent: Option.some({ ...crafted, through: 0, turnAtFork: 0 }) }, state: {} })),
      ]
      return { outcomes, outside: paths.filter((path) => !resolve(path).startsWith(`${resolve(root)}${sep}`)) }
    })))
    expect(observed).toEqual({ outcomes: ["SessionMissing", "SessionMissing", "SessionMissing", "SessionMissing"], outside: [] })
  })
})
