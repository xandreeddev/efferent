/**
 * A process that holds or writes a SQLite session log, for the crash tests
 * in `session-recovery.test.ts`: they run it with Bun, read its `ready`
 * line, and stop it, with SIGKILL when the point is a process that dies.
 *
 *   bun session-holder.testing.ts open <db>
 *     says ready, waits for `go` on stdin, opens the log (creating the file),
 *     says `opened` and closes it
 *   bun session-holder.testing.ts hold-lock <db> <ms>
 *     takes the write lock (BEGIN IMMEDIATE), says ready, holds it for <ms>
 *   bun session-holder.testing.ts commit-loop <db> <session> <events>
 *     commits <events> events at a time, for ever; ready after the first commit
 *   bun session-holder.testing.ts cas-increments <db> <session> <count> <label>
 *     says ready, waits for a `go` line on stdin, adds one to the state's
 *     `count` <count> times by compare-and-swap, reading the head again after
 *     each conflict, and says `done <conflicts>`
 *   bun session-holder.testing.ts hold-turn <db> <session> <owner> <process|lease>
 *     creates the session through plugin-sessions, begins a turn, says ready, waits
 *
 * Every mode stops when its stdin closes, so a holder dies with the test
 * process that spawned it with a piped stdin, even one killed before it could
 * stop its holders; and none runs longer than two minutes.
 */
import { Database } from "bun:sqlite"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Ref, Stream } from "effect"
import { ConversationId, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { SessionLog } from "@xandreed/core"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import type { SessionsConfig } from "@xandreed/plugin-sessions"
import { makeSessionLogSqlite, SessionLogSqliteLive } from "./session-log.adapter.js"

const [mode = "", path = "", ...rest] = process.argv.slice(2)
const argument = (index: number) => rest[index] ?? ""
const range = (length: number) => Array.from({ length }, (_, n) => n)
const say = (line: string) => Effect.sync(() => { process.stdout.write(`${line}\n`) })

/** The write lock, held by a connection of this process for `ms`. */
const holdLock = (ms: number) => Effect.acquireUseRelease(
  Effect.sync(() => new Database(path, { strict: true })),
  (db) => Effect.gen(function* () {
    yield* Effect.sync(() => db.exec("BEGIN IMMEDIATE"))
    yield* say("ready")
    yield* Effect.sleep(ms)
    yield* Effect.sync(() => db.exec("COMMIT"))
  }),
  (db) => Effect.sync(() => db.close()),
)

/** One commit of `size` events numbered by the commit's revision, so a reader can tell a whole commit from a torn one. */
const commitOnce = (log: SessionLog["Service"], session: ConversationId, size: number) => Effect.gen(function* () {
  const head = yield* log.head(session)
  const commit = head.revision + 1
  yield* log.commit(session, {
    expect: head.revision,
    notAfter: Option.none(),
    events: range(size).map((index) => ({ kind: "part", turn: Option.none(), data: { commit, index, of: size, pad: "x".repeat(512) } })),
    state: Option.some({ commit }),
  })
})

const commitLoop = (session: ConversationId, size: number) => Effect.scoped(Effect.gen(function* () {
  const log = yield* makeSessionLogSqlite(path)
  yield* commitOnce(log, session, size)
  yield* say("ready")
  return yield* Effect.forever(commitOnce(log, session, size))
}))

/** Add one to `count`: read the head, commit against its revision, and read again after a conflict, counted in `conflicts`. */
const increment = (log: SessionLog["Service"], session: ConversationId, label: string, n: number, conflicts: Ref.Ref<number>) => Effect.gen(function* () {
  const head = yield* log.head(session)
  const count = typeof head.state.count === "number" ? head.state.count : 0
  yield* log.commit(session, {
    expect: head.revision, notAfter: Option.none(), events: [{ kind: "increment", turn: Option.none(), data: { by: label, n } }], state: Option.some({ count: count + 1 }),
  })
}).pipe(
  Effect.tapError((error) => Ref.update(conflicts, (total) => error._tag === "RevisionConflict" ? total + 1 : total)),
  Effect.retry({ while: (error) => error._tag === "RevisionConflict" }),
)

const casIncrements = (session: ConversationId, count: number, label: string, go: Deferred.Deferred<void>) => Effect.scoped(Effect.gen(function* () {
  const log = yield* makeSessionLogSqlite(path)
  const conflicts = yield* Ref.make(0)
  yield* say("ready")
  yield* Deferred.await(go)
  yield* Effect.forEach(range(count), (n) => increment(log, session, label, n, conflicts), { discard: true })
  yield* say(`done ${yield* Ref.get(conflicts)}`)
}))

const holdTurn = (session: ConversationId, owner: string, ownership: string) => Effect.scoped(Effect.gen(function* () {
  const config: SessionsConfig = { ...sessionsDefaults, ownership: ownership === "process" ? { mode: "process" } : { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }
  const sessions = Context.get(yield* Layer.build(SessionsLive(config).pipe(Layer.provide(Layer.merge(SessionLogSqliteLive(path), TurnAdmissionOpen)))), Sessions)
  yield* sessions.create({ owner, id: session })
  yield* sessions.begin({ id: session, owner }, {
    _tag: "User", userMessage: new UserMessage({ text: "held by a process that is about to stop" }), runId: "run-held", key: "held", command: {},
  })
  yield* say("ready")
  // A pending timer keeps the process alive (Effect.never alone would let it exit) until it is killed.
  return yield* Effect.forever(Effect.sleep("1 minute"))
}))

const modes: Record<string, (go: Deferred.Deferred<void>) => Effect.Effect<unknown, unknown>> = {
  "open": (go) => say("ready").pipe(Effect.andThen(Deferred.await(go)), Effect.andThen(Effect.scoped(makeSessionLogSqlite(path))), Effect.andThen(say("opened"))),
  "hold-lock": () => holdLock(Number(argument(0))),
  "commit-loop": () => commitLoop(ConversationId.make(argument(0)), Number(argument(1))),
  "cas-increments": (go) => casIncrements(ConversationId.make(argument(0)), Number(argument(1)), argument(2), go),
  "hold-turn": () => holdTurn(ConversationId.make(argument(0)), argument(1), argument(2)),
}

/** The lines the test process writes; the stream ends when it closes stdin or dies. */
const stdin = Stream.fromReadableStream({ evaluate: () => Bun.stdin.stream(), onError: (error) => new Error(String(error)) }).pipe(Stream.decodeText, Stream.splitLines)

/** The mode, until it ends, stdin closes or two minutes pass; a `go` on stdin releases `open` and `cas-increments`. */
const program = Option.match(Option.fromNullishOr(modes[mode]), {
  onNone: () => Effect.fail(`unknown mode "${mode}"`),
  onSome: (run) => Effect.gen(function* () {
    const go = yield* Deferred.make<void>()
    const listen = stdin.pipe(Stream.filter((line) => line === "go"), Stream.runForEach(() => Deferred.succeed(go, undefined)))
    return yield* Effect.raceFirst(run(go), listen.pipe(Effect.andThen(Effect.fail("stdin closed: the test process is gone"))))
  }).pipe(Effect.timeout("2 minutes")),
})

void Effect.runPromiseExit(program).then((exit) => {
  if (Exit.isFailure(exit)) process.stderr.write(`${Cause.pretty(exit.cause)}\n`)
  process.exit(Exit.isSuccess(exit) ? 0 : 1)
})
