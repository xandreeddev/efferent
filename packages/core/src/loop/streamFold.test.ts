import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { foldStreamParts } from "./streamFold.js"
import type { StreamDelta } from "./streamFold.js"
import { responseToAgentMessages, toPromptMessages } from "./mapping.js"

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
      { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } },
    ])
    expect(turn.content).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "ab" },
      { type: "tool-call", id: "c1", name: "echo", params: { value: "x" } },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } },
    ])
    expect(turn.finishReason).toBe("tool-calls")
    expect(turn.usage).toEqual({ inputTokens: { total: 10 }, outputTokens: { total: 5 } })
    expect(deltas).toEqual([
      { channel: "reasoning", id: "r1", delta: "thin" },
      { channel: "reasoning", id: "r1", delta: "king" },
      { channel: "text", id: "t1", delta: "a" },
      { channel: "text", id: "t1", delta: "b" },
    ])
  })

  test("tool-params parts fan deltas AND pass through settled (streaming admission)", async () => {
    const { turn, deltas } = await fold([
      { type: "tool-params-start", id: "c1", name: "start_ui" },
      { type: "tool-params-delta", id: "c1", delta: '{"page":' },
      { type: "tool-params-delta", id: "c1", delta: '{"id":"x"}}' },
      { type: "tool-params-end", id: "c1" },
      { type: "tool-call", id: "c1", name: "start_ui", params: { page: { id: "x" } } },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 4 }, outputTokens: { total: 2 } } },
    ])
    // The settled content is byte-identical to the non-streamed path: the
    // params parts stay in place, no synthetic chunk appears.
    expect(turn.content).toEqual([
      { type: "tool-params-start", id: "c1", name: "start_ui" },
      { type: "tool-params-delta", id: "c1", delta: '{"page":' },
      { type: "tool-params-delta", id: "c1", delta: '{"id":"x"}}' },
      { type: "tool-params-end", id: "c1" },
      { type: "tool-call", id: "c1", name: "start_ui", params: { page: { id: "x" } } },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 4 }, outputTokens: { total: 2 } } },
    ])
    expect(deltas).toEqual([
      { channel: "tool-params", id: "c1", delta: "", toolName: "start_ui" },
      { channel: "tool-params", id: "c1", delta: '{"page":' },
      { channel: "tool-params", id: "c1", delta: '{"id":"x"}}' },
    ])
  })

  test("a chunk that accumulated nothing is dropped (content-part identity)", async () => {
    const { turn, deltas } = await fold([
      { type: "text-start", id: "t1" },
      { type: "text-end", id: "t1" },
      { type: "finish", reason: "stop", usage: { inputTokens: { total: 1 }, outputTokens: { total: 0 } } },
    ])
    expect(turn.content).toEqual([
      { type: "finish", reason: "stop", usage: { inputTokens: { total: 1 }, outputTokens: { total: 0 } } },
    ])
    expect(deltas).toEqual([])
  })

  test("a delta with an unseen id opens its own chunk (robustness)", async () => {
    const { turn } = await fold([
      { type: "text-delta", id: "loose", delta: "hi" },
      { type: "finish", reason: "stop", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ])
    expect(turn.content[0]).toEqual({ type: "text", text: "hi" })
  })

  test("reasoning metadata survives streaming and durable message replay without visible text", async () => {
    const details = [{ type: "reasoning.encrypted", data: "opaque-provider-signature", id: "r1" }]
    const { turn, deltas } = await fold([
      { type: "reasoning-start", id: "r1", metadata: { vercel: { trace: "trace-1" } } },
      { type: "reasoning-delta", id: "r1", delta: "", metadata: { vercel: { reasoningDetails: [] } } },
      { type: "reasoning-end", id: "r1", metadata: { vercel: { reasoningDetails: details } } },
      { type: "tool-call", id: "c1", name: "read_file", params: { path: "README.md" } },
    ])
    const metadata = { vercel: { trace: "trace-1", reasoningDetails: details } }
    expect(turn.content[0]).toEqual({ type: "reasoning", text: "", metadata })
    expect(deltas).toEqual([])
    const messages = responseToAgentMessages(turn.content)
    expect(messages[0]).toMatchObject({ role: "assistant", content: [{ type: "reasoning", text: "", providerOptions: metadata }, { type: "tool-call", toolCallId: "c1" }] })
    expect(toPromptMessages(messages)[0]).toMatchObject({ role: "assistant", content: [{ type: "reasoning", text: "", options: metadata }, { type: "tool-call", id: "c1" }] })
  })

  test("text chunk metadata is retained from start, delta and end in its ordered slot", async () => {
    const start = { provider: { trace: "trace-1" } }
    const { turn } = await fold([
      { type: "text-start", id: "t1", metadata: start },
      { type: "text-delta", id: "t1", delta: "hi", metadata: { provider: { cache: "hit" } } },
      { type: "tool-call", id: "c1", name: "echo", params: {} },
      { type: "text-end", id: "t1", metadata: { provider: { signature: "opaque" } } },
    ])
    expect(turn.content).toEqual([
      { type: "text", text: "hi", metadata: { provider: { trace: "trace-1", cache: "hit", signature: "opaque" } } },
      { type: "tool-call", id: "c1", name: "echo", params: {} },
    ])
    expect(start).toEqual({ provider: { trace: "trace-1" } })
  })

  test("choice-finish then usage-only finish: FIRST reason wins, usage-carrier wins", async () => {
    const { turn } = await fold([
      { type: "text-delta", id: "t1", delta: "x" },
      { type: "finish", reason: "tool-calls", usage: {} },
      { type: "finish", reason: "unknown", usage: { inputTokens: { total: 7 }, outputTokens: { total: 3 } } },
    ])
    expect(turn.finishReason).toBe("tool-calls")
    expect(turn.usage).toEqual({ inputTokens: { total: 7 }, outputTokens: { total: 3 } })
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
