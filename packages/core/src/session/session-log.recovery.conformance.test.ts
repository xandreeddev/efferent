import { describe, expect, test } from "bun:test"
import { Clock, Effect, Option, Ref } from "effect"
import type { Context } from "effect"
import { atTime } from "../conformance.functions.js"
import { SessionLog } from "../ports/session-log.port.js"
import type { SessionLogEvent } from "./session-log.entity.js"
import { sessionLogRecoveryConformance } from "./session-log.recovery.conformance.js"
import type { SessionLogSubject } from "./session-log.recovery.conformance.js"
import { SessionLogMemoryLive } from "./session-log.memory.adapter.js"

type Log = Context.Service.Shape<typeof SessionLog>

/** A new in-memory log, with a store of its own, each time it runs. */
const memoryLog = Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive))

const failedChecks = (subject: SessionLogSubject) => Effect.runPromise(Effect.forEach(sessionLogRecoveryConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : [])))).then((failed) => failed.flat().toSorted())

describe("the in-memory session log passes the recovery kit when every open shares its store", () => {
  const log = Effect.runSync(memoryLog)
  sessionLogRecoveryConformance({ open: Effect.succeed(log), callerClock: true }).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

/** One write a handle made: replayed at its own time when the store is opened again. */
interface Write {
  readonly at: number
  readonly apply: (log: Log) => Effect.Effect<unknown, unknown>
}

/**
 * A careless backend that buffers writes until close: each handle works on
 * a private copy of the store, rebuilt by replaying what closed handles
 * wrote, and adds its own writes to the store only when its scope closes.
 * A process that stops loses them, and nobody else sees them meanwhile.
 */
const bufferedUntilClose = (store: Ref.Ref<ReadonlyArray<Write>>): SessionLogSubject["open"] => Effect.gen(function* () {
  const local = yield* memoryLog
  yield* Effect.forEach(yield* Ref.get(store), (write) => write.apply(local).pipe(Effect.ignore, atTime(write.at)), { discard: true })
  const mine = yield* Ref.make<ReadonlyArray<Write>>([])
  yield* Effect.addFinalizer(() => Ref.get(mine).pipe(Effect.flatMap((writes) => Ref.update(store, (all) => [...all, ...writes]))))
  const kept = <A, E>(apply: (log: Log) => Effect.Effect<A, E>, at: (result: A) => number) =>
    Effect.uninterruptible(apply(local).pipe(Effect.tap((result) => Ref.update(mine, (all) => [...all, { at: at(result), apply }]))))
  return SessionLog.of({
    ...local,
    create: (header) => kept((log) => log.create(header), (head) => head.updatedAt),
    commit: (id, commit) => kept((log) => log.commit(id, commit), (committed) => committed.at),
    remove: (id) => kept((log) => log.remove(id), () => 0),
  })
})

/**
 * A careless backend that writes a commit row by row with no transaction
 * around it: each event is a row that readers see as soon as it is written,
 * and the head moves when all of them are. Run to the end, every commit is
 * whole and the log is correct; interrupted between two rows, a commit
 * leaves part of its events behind.
 */
const rowByRow = (log: Log, rows: Ref.Ref<ReadonlyArray<SessionLogEvent>>): Log => SessionLog.of({
  ...log,
  read: (id, query) => Effect.all([log.read(id, { ...query, limit: Option.none() }), Ref.get(rows)]).pipe(Effect.map(([stored, written]) => {
    const events = [...stored, ...written.filter((event) => event.session === id && event.seq > query.after && (query.kinds.length === 0 || query.kinds.includes(event.kind)))]
    return Option.match(query.limit, { onNone: () => events, onSome: (limit) => events.slice(0, limit) })
  })),
  commit: (id, commit) => Effect.gen(function* () {
    const head = yield* log.head(id)
    const at = yield* Clock.currentTimeMillis
    const events = commit.events.map((draft, index): SessionLogEvent => ({ session: id, seq: head.seq + index + 1, turn: draft.turn, kind: draft.kind, at, data: draft.data }))
    yield* Effect.forEach(events, (event) => Ref.update(rows, (all) => [...all, event]).pipe(Effect.andThen(Effect.yieldNow)), { discard: true })
    // The head moves and covers the rows; rows still listed after this belong to a commit interrupted before it.
    return yield* log.commit(id, commit).pipe(Effect.ensuring(Ref.update(rows, (all) => all.filter((event) => !events.includes(event)))))
  }),
})

describe("the recovery kit catches backends that lose or hide writes", () => {
  test("a backend that buffers writes until close fails the checks with two handles open and the unclosed handle", async () => {
    const store = Effect.runSync(Ref.make<ReadonlyArray<Write>>([]))
    expect(await failedChecks({ open: bufferedUntilClose(store), callerClock: true })).toEqual(["cross-handle", "cross-handle-race", "unclosed-handle"])
  })

  test("a backend that writes a commit row by row fails only the interrupted commit, with part of a commit stored", async () => {
    const log = rowByRow(Effect.runSync(memoryLog), Effect.runSync(Ref.make<ReadonlyArray<SessionLogEvent>>([])))
    const subject: SessionLogSubject = { open: Effect.succeed(log), callerClock: true }
    expect(await failedChecks(subject)).toEqual(["interrupted-commit"])
    const interrupted = sessionLogRecoveryConformance(subject).find((check) => check.name.startsWith("an interrupted commit"))
    const exit = await Effect.runPromise(Effect.result(interrupted?.run ?? Effect.void))
    expect(exit._tag === "Failure" ? exit.failure.message : "passed").toMatch(/^an interrupted commit left ([1-9]|[1-3][0-9]) of its 40 events/)
  })

  test("a store per open (a new SessionLogMemoryLive each time) fails every check that opens the store again", async () => {
    expect(await failedChecks({ open: memoryLog, callerClock: true }))
      .toEqual(["cross-handle", "cross-handle-race", "interrupted-commit", "reopen", "reopen-twice", "unclosed-handle"])
  })

  test("the expiry boundary is checked only when the backend stamps with the caller's clock", () => {
    const log = Effect.runSync(memoryLog)
    const names = (subject: SessionLogSubject) => sessionLogRecoveryConformance(subject).map((check) => check.name)
    expect(names({ open: Effect.succeed(log), callerClock: true }).length - names({ open: Effect.succeed(log) }).length).toBe(1)
  })
})
