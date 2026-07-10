import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { foldStreamParts } from "./streamFold.js"
import type { StreamDelta } from "./streamFold.js"

/** The fold's spec: ordered slots, empty-chunk drops, settled passthrough,
 *  finish extraction — the settled shape `step()` reads, from parts. */

const fold = (parts: ReadonlyArray<unknown>) => {
  const deltas: Array<StreamDelta> = []
  return Effect.runPromise(
    foldStreamParts(Stream.fromIterable(parts), (delta) =>
      Effect.sync(() => void deltas.push(delta)),
    ),
  ).then((turn) => ({ turn, deltas }))
}

describe("foldStreamParts", () => {
  test("chunks occupy ordered slots; deltas append; settled parts pass through in place", async () => {
    const { turn, deltas } = await fold([
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "thin" },
      { type: "reasoning-delta", id: "r1", delta: "king" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "a" },
      { type: "tool-call", id: "c1", name: "echo", params: { value: "x" } },
      { type: "text-delta", id: "t1", delta: "b" },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5 } },
    ])
    expect(turn.content).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "ab" },
      { type: "tool-call", id: "c1", name: "echo", params: { value: "x" } },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5 } },
    ])
    expect(turn.finishReason).toBe("tool-calls")
    expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(deltas).toEqual([
      { channel: "reasoning", id: "r1", delta: "thin" },
      { channel: "reasoning", id: "r1", delta: "king" },
      { channel: "text", id: "t1", delta: "a" },
      { channel: "text", id: "t1", delta: "b" },
    ])
  })

  test("a chunk that accumulated nothing is dropped (content-part identity)", async () => {
    const { turn, deltas } = await fold([
      { type: "text-start", id: "t1" },
      { type: "text-end", id: "t1" },
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 0 } },
    ])
    expect(turn.content).toEqual([
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 0 } },
    ])
    expect(deltas).toEqual([])
  })

  test("a delta with an unseen id opens its own chunk (robustness)", async () => {
    const { turn } = await fold([
      { type: "text-delta", id: "loose", delta: "hi" },
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ])
    expect(turn.content[0]).toEqual({ type: "text", text: "hi" })
  })

  test("choice-finish then usage-only finish: FIRST reason wins, usage-carrier wins", async () => {
    const { turn } = await fold([
      { type: "text-delta", id: "t1", delta: "x" },
      { type: "finish", reason: "tool-calls", usage: {} },
      { type: "finish", reason: "unknown", usage: { inputTokens: 7, outputTokens: 3 } },
    ])
    expect(turn.finishReason).toBe("tool-calls")
    expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
  })

  test("tool-result and unknown part types pass through untouched", async () => {
    const metadataPart = { type: "response-metadata", id: "m", modelId: "x" }
    const result = {
      type: "tool-result",
      id: "c1",
      name: "echo",
      result: { echoed: "x" },
      isFailure: false,
    }
    const { turn } = await fold([metadataPart, result])
    expect(turn.content).toEqual([metadataPart, result])
    expect(turn.finishReason).toBe("unknown")
  })

  test("a stream failure surfaces on the effect channel", async () => {
    const exit = await Effect.runPromiseExit(
      foldStreamParts(
        Stream.fromIterable([{ type: "text-delta", id: "t", delta: "x" }]).pipe(
          Stream.concat(Stream.fail("boom")),
        ),
        () => Effect.void,
      ),
    )
    expect(exit._tag).toBe("Failure")
  })
})
