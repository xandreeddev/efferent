import { describe, expect, test } from "bun:test"
import { Cause, Effect, Option, Tracer } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { SessionLog } from "../ports/session-log.port.js"
import { sessionLogConformance } from "./session-log.conformance.js"
import { SessionLogMemoryLive } from "./session-log.memory.adapter.js"

describe("the in-memory session log conforms to the SessionLog contract", () => {
  const log = Effect.runSync(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))
  sessionLogConformance(log).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

describe("the kit catches a backend that breaks the contract", () => {
  const log = Effect.runSync(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))
  /** Last write wins: every commit is applied at the head's current revision. */
  const careless = SessionLog.of({
    ...log,
    commit: (id, commit) => log.head(id).pipe(Effect.flatMap((head) => log.commit(id, { ...commit, expect: head.revision }))),
  })
  test("a commit that ignores the revision fails the conflict and race checks", async () => {
    const failed = await Effect.runPromise(Effect.forEach(sessionLogConformance(careless), (check) =>
      Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : []))))
    expect(failed.flat().toSorted()).toEqual(["conflict", "race"])
  })
  test("a backend that ignores the read ceiling fails its own conformance check", async () => {
    const careless = SessionLog.of({
      ...log,
      read: (id, { through: _through, ...query }) => log.read(id, query),
    })
    const failed = await Effect.runPromise(Effect.forEach(sessionLogConformance(careless), (check) =>
      Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : []))))
    expect(failed.flat()).toEqual(["read-through"])
  })
})

describe("what the in-memory log keeps is JSON, as a store on disk keeps it", () => {
  const log = Effect.runSync(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))
  const header = (id: ConversationId) => ({ id, owner: "test", origin: "test", createdAt: 0, meta: {}, parent: Option.none() })

  test("a commit returns the JSON a later read gives, undefined fields dropped and copied apart from the caller's", async () => {
    const id = ConversationId.make("00000000-0000-4000-8000-000000000001")
    const data = { kept: 1, dropped: undefined, nested: { list: [1, 2] } }
    const result = await Effect.runPromise(Effect.gen(function* () {
      yield* log.create(header(id))
      const committed = yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: data as never }], state: Option.none() })
      data.nested.list.push(3)
      const read = yield* log.read(id, { after: 0, limit: Option.none(), kinds: [] })
      return { committed: committed.events.map((event) => event.data), read: read.map((event) => event.data) }
    }))
    expect(result.committed).toEqual([{ kept: 1, nested: { list: [1, 2] } }])
    expect(result.read).toEqual(result.committed)
    expect(Object.keys(result.read[0] ?? {})).toEqual(["kept", "nested"])
  })

  test("data JSON cannot hold fails the commit with store.encode instead of dying", async () => {
    const id = ConversationId.make("00000000-0000-4000-8000-000000000002")
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      yield* log.create(header(id))
      return yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: { big: 1n } as never }], state: Option.none() })
    }))
    expect(exit._tag === "Failure" && exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error._tag === "SessionLogError" && reason.error.code === "store.encode")).toBe(true)
  })
})

describe("the in-memory log traces each operation", () => {
  test("as session_log.<op>, carrying the session's id when the operation names one, and ending as the operation does", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const id = ConversationId.make("00000000-0000-4000-8000-000000000003")
    await Effect.runPromise(Effect.gen(function* () {
      const log = yield* SessionLog
      yield* log.create({ id, owner: "test", origin: "test", createdAt: 0, meta: {}, parent: Option.none() })
      yield* log.head(id)
      yield* log.list({ owner: "test", limit: 10, before: Option.none(), parent: Option.none() })
      yield* log.commit(id, { expect: 0, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: {} }], state: Option.none() })
      yield* log.read(id, { after: 0, limit: Option.none(), kinds: [] })
      yield* log.remove(id)
      yield* Effect.exit(log.head(id))
    }).pipe(Effect.provide(SessionLogMemoryLive), Effect.withTracer(tracer)))
    expect(spans.map((span) => [span.name, span.attributes.get("efferent.session.id"), span.status._tag === "Ended" && span.status.exit._tag])).toEqual([
      ["session_log.create", id, "Success"],
      ["session_log.head", id, "Success"],
      ["session_log.list", undefined, "Success"],
      ["session_log.commit", id, "Success"],
      ["session_log.read", id, "Success"],
      ["session_log.remove", id, "Success"],
      ["session_log.head", id, "Failure"],
    ])
  })
})
