/**
 * A process that writes a directory session log, for the crash tests: run
 * with Bun by `src/session-recovery.test.ts`, and with Node over the packed
 * package by `scripts/verify-packages.ts`. Plain JavaScript importing the
 * packages by name, so the same file runs in both. The test reads its
 * `ready` (or `paused`) line and stops it, with SIGKILL when the point is a
 * process that dies.
 *
 *   session-files-holder.mjs commit-loop <root> <session> <events>
 *     commits <events> events at a time, for ever; ready after the first commit
 *   session-files-holder.mjs cas-increments <root> <session> <count> <label>
 *     says ready, waits for a `go` line on stdin, adds one to the state's
 *     `count` <count> times by compare-and-swap, reading the head again after
 *     each conflict, and says `done <conflicts>`
 *   session-files-holder.mjs pause <root> <session> <after-write|after-link>
 *     makes one commit and stops inside it, after its file is written (before
 *     the link that publishes it) or after the link (before it cleans up),
 *     says `paused` and waits to be killed
 *
 * Every mode stops when its stdin closes, so a holder dies with the test
 * process that spawned it, even one killed before it could stop its
 * holders; and none runs longer than two minutes.
 */
import { Deferred, Effect, Option, Ref } from "effect"
import { ConversationId } from "@xandreed/core"
import { makeSessionLogFiles, nodeFilesIo } from "@xandreed/plugin-session-files"

const [mode = "", root = "", ...rest] = process.argv.slice(2)
const argument = (index) => rest[index] ?? ""
const range = (length) => Array.from({ length }, (_, n) => n)
const say = (line) => Effect.sync(() => { process.stdout.write(`${line}\n`) })

/** One commit of `size` events numbered by the commit's revision, so a reader can tell a whole commit from a torn one. */
const commitOnce = (log, session, size) => Effect.gen(function* () {
  const head = yield* log.head(session)
  const commit = head.revision + 1
  yield* log.commit(session, {
    expect: head.revision,
    notAfter: Option.none(),
    events: range(size).map((index) => ({ kind: "part", turn: Option.none(), data: { commit, index, of: size, pad: "x".repeat(512) } })),
    state: Option.some({ commit }),
  })
})

const commitLoop = (session, size) => Effect.scoped(Effect.gen(function* () {
  const log = yield* makeSessionLogFiles(root)
  yield* commitOnce(log, session, size)
  yield* say("ready")
  return yield* Effect.forever(commitOnce(log, session, size))
}))

const casIncrements = (session, count, label, go) => Effect.scoped(Effect.gen(function* () {
  const log = yield* makeSessionLogFiles(root)
  const conflicts = yield* Ref.make(0)
  const increment = (n) => Effect.gen(function* () {
    const head = yield* log.head(session)
    const current = typeof head.state.count === "number" ? head.state.count : 0
    yield* log.commit(session, {
      expect: head.revision, notAfter: Option.none(), events: [{ kind: "increment", turn: Option.none(), data: { by: label, n } }], state: Option.some({ count: current + 1 }),
    })
  }).pipe(
    Effect.tapError((error) => Ref.update(conflicts, (total) => error._tag === "RevisionConflict" ? total + 1 : total)),
    Effect.retry({ while: (error) => error._tag === "RevisionConflict" }),
  )
  yield* say("ready")
  yield* Deferred.await(go)
  yield* Effect.forEach(range(count), increment, { concurrency: 1, discard: true })
  yield* say(`done ${yield* Ref.get(conflicts)}`)
}))

/** A file system that stops for good at `point` of the first commit: after writing its file, or after linking it. */
const pausing = (point) => {
  const paused = () => new Promise(() => { process.stdout.write("paused\n") })
  return {
    ...nodeFilesIo,
    link: (from, to) => to.endsWith(".jsonl") && point === "after-write" ? paused() : nodeFilesIo.link(from, to),
    // A session's own temporary file (the root itself may sit under the system's /tmp).
    unlink: (path) => /\/sessions\/[^/]+\/tmp\//.test(path) && point === "after-link" ? paused() : nodeFilesIo.unlink(path),
  }
}

const pause = (session, point) => Effect.scoped(Effect.gen(function* () {
  const log = yield* makeSessionLogFiles(root, { io: pausing(point), stallMs: 120_000 })
  yield* say("ready")
  yield* commitOnce(log, session, 3)
}))

const modes = {
  "commit-loop": () => commitLoop(ConversationId.make(argument(0)), Number(argument(1))),
  "cas-increments": (go) => casIncrements(ConversationId.make(argument(0)), Number(argument(1)), argument(2), go),
  "pause": () => pause(ConversationId.make(argument(0)), argument(1)),
}

const run = modes[mode]
if (run === undefined) {
  process.stderr.write(`unknown mode "${mode}"\n`)
  process.exit(1)
}
// The test process's lines: `go` releases cas-increments; the end of stdin (the test process is gone) stops this one.
const go = Effect.runSync(Deferred.make())
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { if (String(chunk).split("\n").includes("go")) Effect.runFork(Deferred.succeed(go, undefined)) })
process.stdin.on("end", () => process.exit(1))
setTimeout(() => process.exit(1), 120_000).unref()
Effect.runPromiseExit(run(go)).then((exit) => {
  if (exit._tag === "Failure") process.stderr.write(`${String(exit.cause)}\n`)
  process.exit(exit._tag === "Success" ? 0 : 1)
})
