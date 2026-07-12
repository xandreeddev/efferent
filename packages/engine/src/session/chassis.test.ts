import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { makeSession } from "./chassis.js"

type Ev =
  | { readonly type: "note"; readonly text: string }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "error"; readonly message: string }

const cid = ConversationId.make("00000000-0000-4000-8000-000000000001")

describe("makeSession", () => {
  test("events land on the ledger with monotonic seqs; state reads them back", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* makeSession<Ev, never>({
          conversationId: cid,
          runTurn: (text, publish) => publish({ type: "note", text }),
          onError: (message) => ({ type: "error", message }),
        })
        yield* session.send("a")
        yield* session.send("b")
        const { log, cursor } = yield* session.state
        expect(cursor).toBe(2)
        expect(log.map((e) => e.seq)).toEqual([0, 1])
        expect(log.map((e) => (e.event.type === "note" ? e.event.text : "?"))).toEqual([
          "a",
          "b",
        ])
      }),
    )
  })

  test("sends are serialized: interleaved turns never interleave their events", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* makeSession<Ev, never>({
          conversationId: cid,
          runTurn: (text, publish) =>
            publish({ type: "note", text: `${text}:start` }).pipe(
              Effect.zipRight(Effect.sleep("10 millis")),
              Effect.zipRight(publish({ type: "note", text: `${text}:end` })),
            ),
          onError: (message) => ({ type: "error", message }),
        })
        const f1 = yield* Effect.fork(session.send("one"))
        const f2 = yield* Effect.fork(session.send("two"))
        yield* Fiber.join(f1)
        yield* Fiber.join(f2)
        const { log } = yield* session.state
        const texts = log.map((e) => (e.event.type === "note" ? e.event.text : "?"))
        const first = texts[0]?.split(":")[0] ?? ""
        const second = texts[2]?.split(":")[0] ?? ""
        expect(texts).toEqual([`${first}:start`, `${first}:end`, `${second}:start`, `${second}:end`])
        expect(new Set([first, second])).toEqual(new Set(["one", "two"]))
      }),
    )
  })

  test("a failing turn is CONTAINED into an error event — the session survives", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* makeSession<Ev, never>({
          conversationId: cid,
          runTurn: (text, publish) =>
            text === "boom" ? Effect.fail("provider down") : publish({ type: "note", text }),
          onError: (message) => ({ type: "error", message }),
        })
        yield* session.send("boom")
        yield* session.send("after")
        const { log } = yield* session.state
        expect(log[0]?.event).toEqual({ type: "error", message: "provider down" })
        expect(log[1]?.event).toEqual({ type: "note", text: "after" })
      }),
    )
  })

  test("a DEFECT is contained too", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* makeSession<Ev, never>({
          conversationId: cid,
          runTurn: () => Effect.die("kaboom"),
          onError: (message) => ({ type: "error", message }),
        })
        yield* session.send("x")
        const { log } = yield* session.state
        expect(log[0]?.event.type).toBe("error")
      }),
    )
  })

  test("subscribe(since) replays the ledger from the cursor, then streams live, deduped", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* makeSession<Ev, never>({
          conversationId: cid,
          runTurn: (text, publish) => publish({ type: "note", text }),
          onError: (message) => ({ type: "error", message }),
        })
        yield* session.send("a")
        yield* session.send("b")
        // Subscribe from 1: replay skips seq 0, then the live tail follows.
        const taker = yield* Effect.fork(
          Stream.runCollect(Stream.take(session.subscribe(1), 2)),
        )
        yield* Effect.sleep("5 millis")
        yield* session.send("c")
        const collected = yield* Fiber.join(taker)
        const seqs = [...collected].map((e) => e.seq)
        expect(seqs).toEqual([1, 2])
      }),
    )
  })

  test("isTransient routes to the lossy channel: never ledgered, never replayed, delivered live", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* makeSession<Ev, never>({
          conversationId: cid,
          runTurn: (text, publish) =>
            publish({ type: "delta", text: `${text}:d1` }).pipe(
              Effect.zipRight(publish({ type: "delta", text: `${text}:d2` })),
              Effect.zipRight(publish({ type: "note", text })),
            ),
          onError: (message) => ({ type: "error", message }),
          isTransient: (event) => event.type === "delta",
        })
        const taker = yield* Effect.fork(
          Stream.runCollect(Stream.take(session.transient, 2)),
        )
        yield* Effect.sleep("5 millis")
        yield* session.send("go")
        // The ledger holds ONLY the finalizer — a delta flood never grows it.
        const { log, cursor } = yield* session.state
        expect(cursor).toBe(1)
        expect(log.map((e) => e.event)).toEqual([{ type: "note", text: "go" }])
        // Replay sees no deltas either.
        const replayed = yield* Stream.runCollect(Stream.take(session.subscribe(0), 1))
        expect([...replayed].map((e) => e.event.type)).toEqual(["note"])
        // But the live transient subscriber received them, in order.
        const deltas = yield* Fiber.join(taker)
        expect([...deltas].map((e) => (e.type === "delta" ? e.text : "?"))).toEqual([
          "go:d1",
          "go:d2",
        ])
      }),
    )
  })
})
