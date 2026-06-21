import { describe, expect, test } from "bun:test"
import { Chunk, Effect, Fiber, Stream } from "effect"
import type { AgentEvent } from "@xandreed/sdk-core"
import { makeEventLedger } from "./eventLedger.js"

// A cheap, distinct event per index — `turn_start` carries an int we can assert.
const turn = (i: number): AgentEvent => ({ type: "turn_start", turnIndex: i })
const seqs = (c: Chunk.Chunk<{ readonly seq: number }>): number[] =>
  Chunk.toReadonlyArray(c).map((e) => e.seq)
const turnIdxs = (
  c: Chunk.Chunk<{ readonly event: AgentEvent }>,
): number[] =>
  Chunk.toReadonlyArray(c).map((e) =>
    e.event.type === "turn_start" ? e.event.turnIndex : -1,
  )

describe("EventLedger", () => {
  test("publish stamps a monotonic seq from 1; latestSeq tracks it", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const l = yield* makeEventLedger()
        const a = yield* l.publish(turn(0))
        const b = yield* l.publish(turn(1))
        const c = yield* l.publish(turn(2))
        return { seqs: [a.seq, b.seq, c.seq], latest: yield* l.latestSeq }
      }),
    )
    expect(result.seqs).toEqual([1, 2, 3])
    expect(result.latest).toBe(3)
  })

  test("replay(since) returns only events with seq > since, in order", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const l = yield* makeEventLedger()
        yield* l.publish(turn(0)) // seq 1
        yield* l.publish(turn(1)) // seq 2
        yield* l.publish(turn(2)) // seq 3
        return {
          all: yield* l.replay(),
          afterFirst: yield* l.replay(1),
          afterAll: yield* l.replay(3),
        }
      }),
    )
    expect(result.all.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(result.afterFirst.map((e) => e.seq)).toEqual([2, 3])
    expect(result.afterAll).toEqual([])
  })

  test("ring is bounded — oldest evicted; replay(0) returns only the retained tail", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const l = yield* makeEventLedger({ ringSize: 3 })
        for (let i = 0; i < 6; i++) yield* l.publish(turn(i)) // seqs 1..6
        return { retained: yield* l.replay(0), latest: yield* l.latestSeq }
      }),
    )
    // Only the last 3 (seqs 4,5,6) survive the bound; seq still counts all 6.
    expect(result.retained.map((e) => e.seq)).toEqual([4, 5, 6])
    expect(result.latest).toBe(6)
  })

  test("hasGap is false within the ring and true once since predates the evicted region", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const l = yield* makeEventLedger({ ringSize: 3 })
        for (let i = 0; i < 6; i++) yield* l.publish(turn(i)) // ring now holds 4,5,6
        return {
          gapAtZero: yield* l.hasGap(0), // wants 1.. but 1,2,3 evicted → gap
          gapAtThree: yield* l.hasGap(3), // wants 4.. and 4 is retained → ok
          gapAtSix: yield* l.hasGap(6), // fully caught up → ok
        }
      }),
    )
    expect(result.gapAtZero).toBe(true)
    expect(result.gapAtThree).toBe(false)
    expect(result.gapAtSix).toBe(false)
  })

  test("fresh ledger has no gap for since=0 (nothing dropped yet)", async () => {
    const noGap = await Effect.runPromise(
      Effect.gen(function* () {
        const l = yield* makeEventLedger()
        return yield* l.hasGap(0)
      }),
    )
    expect(noGap).toBe(false)
  })

  test("stream(since) replays the retained tail then completes (take past replay)", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const l = yield* makeEventLedger()
        yield* l.publish(turn(10)) // seq 1
        yield* l.publish(turn(11)) // seq 2
        yield* l.publish(turn(12)) // seq 3
        // Replay everything after seq 1 → exactly seqs 2,3 (deterministic, no live).
        return yield* l.stream(1).pipe(Stream.take(2), Stream.runCollect)
      }),
    )
    expect(seqs(collected)).toEqual([2, 3])
    expect(turnIdxs(collected)).toEqual([11, 12])
  })

  test("stream tails live events published after subscribe, with no seam duplicate", async () => {
    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const l = yield* makeEventLedger()
        yield* l.publish(turn(0)) // seq 1 — in the ring (replayed)
        // Start a stream from seq 0: replays seq 1, then must pick up live 2,3.
        const fiber = yield* l
          .stream(0)
          .pipe(Stream.take(3), Stream.runCollect, Effect.fork)
        // Let the fiber subscribe before the live publishes.
        yield* Effect.sleep("50 millis")
        yield* l.publish(turn(1)) // seq 2 (live)
        yield* l.publish(turn(2)) // seq 3 (live)
        return yield* Fiber.join(fiber)
      }),
    )
    // seq 1 from replay (exactly once — not doubled by the live tail), 2 & 3 live.
    expect(seqs(collected)).toEqual([1, 2, 3])
  })

  test("multiple subscribers each receive every live event (fan-out)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const l = yield* makeEventLedger()
        const a = yield* l.stream().pipe(Stream.take(2), Stream.runCollect, Effect.fork)
        const b = yield* l.stream().pipe(Stream.take(2), Stream.runCollect, Effect.fork)
        yield* Effect.sleep("50 millis")
        yield* l.publish(turn(0)) // seq 1
        yield* l.publish(turn(1)) // seq 2
        return { a: yield* Fiber.join(a), b: yield* Fiber.join(b) }
      }),
    )
    expect(seqs(result.a)).toEqual([1, 2])
    expect(seqs(result.b)).toEqual([1, 2])
  })
})
