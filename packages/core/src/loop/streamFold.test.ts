import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Response } from "effect/ai"
import fc from "fast-check"
import { foldStreamParts } from "./streamFold.js"
import type { StreamDelta } from "./streamFold.js"

/** The fold's spec: ordered slots, kept provider metadata, empty-chunk drops,
 *  settled passthrough, finish extraction — the settled shape `step()` reads,
 *  from parts. */

const fold = (parts: ReadonlyArray<unknown>) => {
  const deltas: Array<StreamDelta> = []
  return Effect.runPromise(
    foldStreamParts(Stream.fromIterable(parts), (delta) =>
      Effect.sync(() => void deltas.push(delta)),
    ),
  ).then((turn) => ({ turn, deltas }))
}

describe("foldStreamParts", () => {
  test("a stream without a finish part folds to no usage and an unknown reason", async () => {
    const { turn } = await fold([{ type: "text-delta", id: "t1", delta: "a" }])
    expect(turn.finishReason).toBe("unknown")
    expect("usage" in turn).toBe(false)
  })

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
      Response.makePart("reasoning", { text: "thinking" }),
      Response.makePart("text", { text: "ab" }),
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
    expect(turn.content[0]).toEqual(Response.makePart("text", { text: "hi" }))
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

  test("Anthropic thinking keeps its signature (an empty delta's) and a redacted block (a start's), as the settled response has them", async () => {
    const signed = { anthropic: { info: { type: "thinking" as const, signature: "sig-1" } } }
    const redacted = { anthropic: { info: { type: "redacted_thinking" as const, redactedData: "opaque" } } }
    const { turn, deltas } = await fold([
      { type: "reasoning-start", id: "0", metadata: {} },
      { type: "reasoning-delta", id: "0", delta: "think", metadata: {} },
      { type: "reasoning-delta", id: "0", delta: "", metadata: signed },
      { type: "reasoning-end", id: "0", metadata: {} },
      { type: "reasoning-start", id: "1", metadata: redacted },
      { type: "reasoning-end", id: "1", metadata: {} },
      { type: "text-start", id: "2", metadata: {} },
      { type: "text-delta", id: "2", delta: "hi", metadata: {} },
      { type: "text-end", id: "2", metadata: {} },
      { type: "finish", reason: "stop", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ])
    expect(turn.content.slice(0, 3)).toEqual([
      Response.makePart("reasoning", { text: "think", metadata: signed }),
      Response.makePart("reasoning", { text: "", metadata: redacted }),
      Response.makePart("text", { text: "hi" }),
    ])
    expect(deltas).toEqual([
      { channel: "reasoning", id: "0", delta: "think" },
      { channel: "text", id: "2", delta: "hi" },
    ])
  })

  test("OpenAI reasoning keeps its itemId and encryptedContent from the start and end, summary or not", async () => {
    const item = (encryptedContent?: string) => ({ openai: { itemId: "rs_1", ...(encryptedContent === undefined ? {} : { encryptedContent }) } })
    const { turn } = await fold([
      { type: "reasoning-start", id: "rs_1:0", metadata: item() },
      { type: "reasoning-delta", id: "rs_1:0", delta: "plan", metadata: item() },
      { type: "reasoning-end", id: "rs_1:0", metadata: item("enc-1") },
      { type: "reasoning-start", id: "rs_2:0", metadata: { openai: { itemId: "rs_2", encryptedContent: "enc-2" } } },
      { type: "reasoning-end", id: "rs_2:0", metadata: { openai: { itemId: "rs_2", encryptedContent: "enc-2" } } },
    ])
    expect(turn.content).toEqual([
      Response.makePart("reasoning", { text: "plan", metadata: item("enc-1") }),
      Response.makePart("reasoning", { text: "", metadata: { openai: { itemId: "rs_2", encryptedContent: "enc-2" } } }),
    ])
  })

  test("metadata merges per provider: a later part's fields win, other providers' stay, a value that is not an object replaces", async () => {
    const { turn } = await fold([
      { type: "text-start", id: "t", metadata: { a: { x: 1, y: 1 }, b: { kept: true } } },
      { type: "text-delta", id: "t", delta: "x", metadata: { a: { y: 2 }, c: "plain" } },
      { type: "text-end", id: "t", metadata: { c: { z: 3 }, b: null } },
    ])
    expect(turn.content).toEqual([
      Response.makePart("text", { text: "x", metadata: { a: { x: 1, y: 2 }, b: null, c: { z: 3 } } }),
    ])
  })
})

/** A settled block and the stream a provider sends for it, its metadata where that provider puts it. */
interface Block {
  readonly settled: Response.AnyPart
  readonly stream: (id: string) => ReadonlyArray<unknown>
}

/** Arbitrary chunks: the text split at any points, empty chunks included. */
const chunks = fc.array(fc.string({ maxLength: 5 }), { maxLength: 4 })

const deltasOf = (type: "text-delta" | "reasoning-delta", id: string, parts: ReadonlyArray<string>, metadata: Response.ProviderMetadata = {}) =>
  parts.map((delta) => ({ type, id, delta, metadata }))

const textBlock: fc.Arbitrary<Block> = chunks.filter((parts) => parts.join("").length > 0).map((parts) => ({
  settled: Response.makePart("text", { text: parts.join("") }),
  stream: (id) => [{ type: "text-start", id }, ...deltasOf("text-delta", id, parts), { type: "text-end", id }],
}))

/** Anthropic: the signature on an empty delta after the thinking text; a redacted block on its start. */
const anthropicThinking: fc.Arbitrary<Block> = fc.tuple(chunks, fc.string({ minLength: 1 })).map(([parts, signature]) => {
  const metadata = { anthropic: { info: { type: "thinking" as const, signature } } }
  return {
    settled: Response.makePart("reasoning", { text: parts.join(""), metadata }),
    stream: (id) => [
      { type: "reasoning-start", id },
      ...deltasOf("reasoning-delta", id, parts),
      { type: "reasoning-delta", id, delta: "", metadata },
      { type: "reasoning-end", id },
    ],
  }
})
const anthropicRedacted: fc.Arbitrary<Block> = fc.string({ minLength: 1 }).map((redactedData) => {
  const metadata = { anthropic: { info: { type: "redacted_thinking" as const, redactedData } } }
  return {
    settled: Response.makePart("reasoning", { text: "", metadata }),
    stream: (id) => [{ type: "reasoning-start", id, metadata }, { type: "reasoning-end", id }],
  }
})

/** OpenAI Responses: the itemId on every part, the encrypted content on the end, and on the start when the item had it. */
const openAiReasoning: fc.Arbitrary<Block> = fc.tuple(chunks, fc.option(fc.string({ minLength: 1 }), { nil: undefined }), fc.boolean())
  .map(([parts, encryptedContent, onStart]) => {
    const item = (withContent: boolean) => ({ openai: { itemId: "rs", ...(withContent && encryptedContent !== undefined ? { encryptedContent } : {}) } })
    return {
      settled: Response.makePart("reasoning", { text: parts.join(""), metadata: item(true) }),
      stream: (id) => [
        { type: "reasoning-start", id, metadata: item(onStart) },
        ...deltasOf("reasoning-delta", id, parts, item(false)),
        { type: "reasoning-end", id, metadata: item(true) },
      ],
    }
  })

const toolCall: fc.Arbitrary<Block> = fc.string().map((value) => {
  const part = Response.makePart("tool-call", { id: "c", name: "echo", params: { value }, providerExecuted: false })
  return { settled: part, stream: () => [part] }
})

const finishPart = Response.makePart("finish", {
  reason: "stop",
  usage: new Response.Usage({ inputTokens: { total: 1 }, outputTokens: { total: 1 } }),
})

describe("foldStreamParts over provider-shaped streams", () => {
  const property = (name: string, block: fc.Arbitrary<Block>) =>
    test(`${name}: a stream split at any point folds to the settled parts, metadata included`, () => {
      fc.assert(fc.property(fc.array(fc.oneof(block, textBlock, toolCall), { maxLength: 6 }), (blocks) => {
        const parts = [...blocks.flatMap((b, index) => b.stream(String(index))), finishPart]
        const turn = Effect.runSync(foldStreamParts(Stream.fromIterable(parts), () => Effect.void))
        expect(turn.content).toEqual([...blocks.map((b) => b.settled), finishPart])
      }))
    })

  property("Anthropic", fc.oneof(anthropicThinking, anthropicRedacted))
  property("OpenAI", openAiReasoning)
})
