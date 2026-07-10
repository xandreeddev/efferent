import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Queue } from "effect"
import type { LoopEvent } from "@xandreed/engine"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import { coalesceDeltas, runEventPump } from "./pump.js"

const agent = (event: LoopEvent): SmithEvent => ({ type: "agent", event })

const delta = (turnIndex: number, channel: "text" | "reasoning", text: string): SmithEvent =>
  agent({ type: "assistant_delta", turnIndex, channel, id: `${channel}-1`, delta: text })

describe("coalesceDeltas", () => {
  test("adjacent same-chunk deltas merge; nothing crosses a non-delta event", () => {
    const toolStart = agent({
      type: "tool_start",
      turnIndex: 0,
      toolCallId: "t1",
      toolName: "ls",
      args: {},
    })
    const out = coalesceDeltas([
      delta(0, "text", "a"),
      delta(0, "text", "b"),
      delta(0, "reasoning", "r1"),
      delta(0, "text", "c"),
      toolStart,
      delta(0, "text", "d"),
      delta(0, "text", "e"),
    ])
    expect(out).toEqual([
      delta(0, "text", "ab"),
      delta(0, "reasoning", "r1"),
      delta(0, "text", "c"),
      toolStart,
      delta(0, "text", "de"),
    ])
  })

  test("different turns never merge; non-delta streams pass through unchanged", () => {
    const events: ReadonlyArray<SmithEvent> = [
      delta(0, "text", "a"),
      delta(1, "text", "b"),
      { type: "refine_start", idea: { _tag: "None" } as never },
    ]
    expect(coalesceDeltas(events)).toEqual(events)
  })
})

describe("runEventPump", () => {
  test("flushes are batched: many queued deltas arrive as ONE reduceBatch call, coalesced", async () => {
    const flushes: Array<ReadonlyArray<SmithEvent>> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<SmithEvent>()
        yield* Queue.offerAll(queue, [
          delta(0, "text", "a"),
          delta(0, "text", "b"),
          delta(0, "text", "c"),
        ])
        const pump = yield* Effect.fork(
          runEventPump(queue, (events) => void flushes.push(events)),
        )
        yield* Effect.sleep("20 millis")
        yield* Fiber.interrupt(pump)
      }),
    )
    expect(flushes).toHaveLength(1)
    expect(flushes[0]).toEqual([delta(0, "text", "abc")])
  })
})
