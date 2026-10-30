import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Response } from "effect/ai"
import fc from "fast-check"
import { foldStreamParts } from "./stream-fold.entity.functions.js"
import type { StreamDelta } from "./stream-fold.entity.functions.js"

/** The fold's spec: ordered slots, kept provider metadata, empty-chunk drops,
 *  settled passthrough, finish extraction — the settled shape `step()` reads,
 *  from parts. */

const fold = (parts: ReadonlyArray<Response.AnyPart>) => {
  const deltas: Array<StreamDelta> = []
  return Effect.runPromise(
    foldStreamParts(Stream.fromIterable(parts), (delta) =>
      Effect.sync(() => void deltas.push(delta)),
    ),
  ).then((turn) => ({ turn, deltas }))
}

const part = Response.makePart
const usage = (input: number | undefined, output: number | undefined) =>
  new Response.Usage({ inputTokens: { total: input }, outputTokens: { total: output } })
const finish = (reason: Response.FinishReason, used: Response.Usage) => part("finish", { reason, usage: used })
const call = (id: string, name: string, params: unknown) => part("tool-call", { id, name, params, providerExecuted: false })

describe("foldStreamParts", () => {
  test("a stream without a finish part folds to no usage and an unknown reason", async () => {
    const { turn } = await fold([part("text-delta", { id: "t1", delta: "a" })])
    expect(turn.finishReason).toBe("unknown")
    expect("usage" in turn).toBe(false)
  })

  test("chunks occupy ordered slots; deltas append; settled parts pass through in place", async () => {
    const { turn, deltas } = await fold([
      part("reasoning-start", { id: "r1" }),
      part("reasoning-delta", { id: "r1", delta: "thin" }),
      part("reasoning-delta", { id: "r1", delta: "king" }),
      part("reasoning-end", { id: "r1" }),
      part("text-start", { id: "t1" }),
      part("text-delta", { id: "t1", delta: "a" }),
      call("c1", "echo", { value: "x" }),
      part("text-delta", { id: "t1", delta: "b" }),
      finish("tool-calls", usage(10, 5)),
    ])
    expect(turn.content).toEqual([
      part("reasoning", { text: "thinking" }),
      part("text", { text: "ab" }),
      call("c1", "echo", { value: "x" }),
      finish("tool-calls", usage(10, 5)),
    ])
    expect(turn.finishReason).toBe("tool-calls")
    expect(turn.usage).toEqual(usage(10, 5))
    expect(deltas).toEqual([
      { channel: "reasoning", id: "r1", delta: "thin" },
      { channel: "reasoning", id: "r1", delta: "king" },
      { channel: "text", id: "t1", delta: "a" },
      { channel: "text", id: "t1", delta: "b" },
    ])
  })

  test("tool-params parts fan deltas AND pass through settled (streaming admission)", async () => {
    const params = [
      part("tool-params-start", { id: "c1", name: "start_ui", providerExecuted: false }),
      part("tool-params-delta", { id: "c1", delta: '{"page":' }),
      part("tool-params-delta", { id: "c1", delta: '{"id":"x"}}' }),
      part("tool-params-end", { id: "c1" }),
      call("c1", "start_ui", { page: { id: "x" } }),
      finish("tool-calls", usage(4, 2)),
    ]
    const { turn, deltas } = await fold(params)
    // The settled content is byte-identical to the non-streamed path: the
    // params parts stay in place, no synthetic chunk appears.
    expect(turn.content).toEqual(params)
    expect(deltas).toEqual([
      { channel: "tool-params", id: "c1", delta: "", toolName: "start_ui" },
      { channel: "tool-params", id: "c1", delta: '{"page":' },
      { channel: "tool-params", id: "c1", delta: '{"id":"x"}}' },
    ])
  })

  test("a chunk that accumulated nothing is dropped (content-part identity)", async () => {
    const { turn, deltas } = await fold([
      part("text-start", { id: "t1" }),
      part("text-end", { id: "t1" }),
      finish("stop", usage(1, 0)),
    ])
    expect(turn.content).toEqual([finish("stop", usage(1, 0))])
    expect(deltas).toEqual([])
  })

  test("a delta with an unseen id opens its own chunk (robustness)", async () => {
    const { turn } = await fold([
      part("text-delta", { id: "loose", delta: "hi" }),
      finish("stop", usage(1, 1)),
    ])
    expect(turn.content[0]).toEqual(part("text", { text: "hi" }))
  })

  test("choice-finish then usage-only finish: FIRST reason wins, usage-carrier wins", async () => {
    const { turn } = await fold([
      part("text-delta", { id: "t1", delta: "x" }),
      finish("tool-calls", usage(undefined, undefined)),
      finish("unknown", usage(7, 3)),
    ])
    expect(turn.finishReason).toBe("tool-calls")
    expect(turn.usage).toEqual(usage(7, 3))
  })

  test("tool-result and unknown part types pass through untouched", async () => {
    const metadataPart = part("response-metadata", { id: "m", modelId: "x", timestamp: undefined, request: undefined })
    const result = part("tool-result", {
      id: "c1",
      name: "echo",
      result: { echoed: "x" },
      encodedResult: { echoed: "x" },
      isFailure: false,
      providerExecuted: false,
      preliminary: false,
    })
    const { turn } = await fold([metadataPart, result])
    expect(turn.content).toEqual([metadataPart, result])
    expect(turn.finishReason).toBe("unknown")
  })

  test("a stream failure surfaces on the effect channel", async () => {
    const exit = await Effect.runPromiseExit(
      foldStreamParts(
        Stream.fromIterable([part("text-delta", { id: "t", delta: "x" })]).pipe(
          Stream.concat(Stream.fail("boom")),
        ),
        () => Effect.void,
      ),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("a failure of onDelta fails the fold with it, typed", async () => {
    const folded: Effect.Effect<unknown, "unrendered"> = foldStreamParts(
      Stream.fromIterable([part("text-delta", { id: "t", delta: "x" })]),
      () => Effect.fail("unrendered" as const),
    )
    expect(await Effect.runPromise(Effect.flip(folded))).toBe("unrendered")
  })

  test("Anthropic thinking keeps its signature (an empty delta's) and a redacted block (a start's), as the settled response has them", async () => {
    const signed = { anthropic: { info: { type: "thinking" as const, signature: "sig-1" } } }
    const redacted = { anthropic: { info: { type: "redacted_thinking" as const, redactedData: "opaque" } } }
    const { turn, deltas } = await fold([
      part("reasoning-start", { id: "0" }),
      part("reasoning-delta", { id: "0", delta: "think" }),
      part("reasoning-delta", { id: "0", delta: "", metadata: signed }),
      part("reasoning-end", { id: "0" }),
      part("reasoning-start", { id: "1", metadata: redacted }),
      part("reasoning-end", { id: "1" }),
      part("text-start", { id: "2" }),
      part("text-delta", { id: "2", delta: "hi" }),
      part("text-end", { id: "2" }),
      finish("stop", usage(1, 1)),
    ])
    expect(turn.content.slice(0, 3)).toEqual([
      part("reasoning", { text: "think", metadata: signed }),
      part("reasoning", { text: "", metadata: redacted }),
      part("text", { text: "hi" }),
    ])
    expect(deltas).toEqual([
      { channel: "reasoning", id: "0", delta: "think" },
      { channel: "text", id: "2", delta: "hi" },
    ])
  })

  test("OpenAI reasoning keeps its itemId and encryptedContent from the start and end, summary or not", async () => {
    const item = (encryptedContent?: string) => ({ openai: { itemId: "rs_1", ...(encryptedContent === undefined ? {} : { encryptedContent }) } })
    const { turn } = await fold([
      part("reasoning-start", { id: "rs_1:0", metadata: item() }),
      part("reasoning-delta", { id: "rs_1:0", delta: "plan", metadata: item() }),
      part("reasoning-end", { id: "rs_1:0", metadata: item("enc-1") }),
      part("reasoning-start", { id: "rs_2:0", metadata: { openai: { itemId: "rs_2", encryptedContent: "enc-2" } } }),
      part("reasoning-end", { id: "rs_2:0", metadata: { openai: { itemId: "rs_2", encryptedContent: "enc-2" } } }),
    ])
    expect(turn.content).toEqual([
      part("reasoning", { text: "plan", metadata: item("enc-1") }),
      part("reasoning", { text: "", metadata: { openai: { itemId: "rs_2", encryptedContent: "enc-2" } } }),
    ])
  })

  test("metadata merges per provider: a later part's fields win, other providers' stay, a value that is not an object replaces", async () => {
    const { turn } = await fold([
      part("text-start", { id: "t", metadata: { a: { x: 1, y: 1 }, b: { kept: true } } }),
      part("text-delta", { id: "t", delta: "x", metadata: { a: { y: 2 }, c: "plain" } }),
      part("text-end", { id: "t", metadata: { c: { z: 3 }, b: null } }),
    ])
    expect(turn.content).toEqual([
      part("text", { text: "x", metadata: { a: { x: 1, y: 2 }, b: null, c: { z: 3 } } }),
    ])
  })
})

/** A settled block and the stream a provider sends for it, its metadata where that provider puts it. */
interface Block {
  readonly settled: Response.AnyPart
  readonly stream: (id: string) => ReadonlyArray<Response.AnyPart>
}

/** Arbitrary chunks: the text split at any points, empty chunks included. */
const chunks = fc.array(fc.string({ maxLength: 5 }), { maxLength: 4 })

const textDeltas = (id: string, parts: ReadonlyArray<string>) => parts.map((delta) => part("text-delta", { id, delta }))
const reasoningDeltas = (id: string, parts: ReadonlyArray<string>, metadata: Response.ReasoningDeltaPartMetadata = {}) =>
  parts.map((delta) => part("reasoning-delta", { id, delta, metadata }))

const textBlock: fc.Arbitrary<Block> = chunks.filter((parts) => parts.join("").length > 0).map((parts) => ({
  settled: part("text", { text: parts.join("") }),
  stream: (id) => [part("text-start", { id }), ...textDeltas(id, parts), part("text-end", { id })],
}))

/** Anthropic: the signature on an empty delta after the thinking text; a redacted block on its start. */
const anthropicThinking: fc.Arbitrary<Block> = fc.tuple(chunks, fc.string({ minLength: 1 })).map(([parts, signature]) => {
  const metadata = { anthropic: { info: { type: "thinking" as const, signature } } }
  return {
    settled: part("reasoning", { text: parts.join(""), metadata }),
    stream: (id) => [
      part("reasoning-start", { id }),
      ...reasoningDeltas(id, parts),
      part("reasoning-delta", { id, delta: "", metadata }),
      part("reasoning-end", { id }),
    ],
  }
})
const anthropicRedacted: fc.Arbitrary<Block> = fc.string({ minLength: 1 }).map((redactedData) => {
  const metadata = { anthropic: { info: { type: "redacted_thinking" as const, redactedData } } }
  return {
    settled: part("reasoning", { text: "", metadata }),
    stream: (id) => [part("reasoning-start", { id, metadata }), part("reasoning-end", { id })],
  }
})

/** OpenAI Responses: the itemId on every part, the encrypted content on the end, and on the start when the item had it. */
const openAiReasoning: fc.Arbitrary<Block> = fc.tuple(chunks, fc.option(fc.string({ minLength: 1 }), { nil: undefined }), fc.boolean())
  .map(([parts, encryptedContent, onStart]) => {
    const item = (withContent: boolean) => ({ openai: { itemId: "rs", ...(withContent && encryptedContent !== undefined ? { encryptedContent } : {}) } })
    return {
      settled: part("reasoning", { text: parts.join(""), metadata: item(true) }),
      stream: (id) => [
        part("reasoning-start", { id, metadata: item(onStart) }),
        ...reasoningDeltas(id, parts, item(false)),
        part("reasoning-end", { id, metadata: item(true) }),
      ],
    }
  })

const toolCall: fc.Arbitrary<Block> = fc.string().map((value) => {
  const settled = call("c", "echo", { value })
  return { settled, stream: () => [settled] }
})

const finishPart = finish("stop", usage(1, 1))

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
