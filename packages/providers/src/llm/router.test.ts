import { describe, expect, test } from "bun:test"
import { LanguageModel } from "@effect/ai"
import { Chunk, Effect, Metric, Stream } from "effect"
import { stampResponse, tapStreamTelemetry } from "./router.js"

const finish = {
  type: "finish",
  reason: "tool-calls",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
}

const content = [
  { type: "text", text: "listing…" },
  { type: "tool-call", id: "c1", name: "ls", params: { path: "." } },
  finish,
]

describe("stampResponse", () => {
  test("stamps the resolved model onto the finish part's metadata", () => {
    const stamped = stampResponse({ content }, "opencode:kimi-k2.6")
    const finishPart = stamped.content.find(
      (p) => (p as { type?: string }).type === "finish",
    ) as { metadata?: { router?: { model?: string } } }
    expect(finishPart.metadata?.router?.model).toBe("opencode:kimi-k2.6")
  })

  test("REGRESSION: the class getters survive — a plain spread killed the loop", () => {
    // finishReason/text/usage are prototype getters on GenerateTextResponse;
    // `{...res}` strips them, finishReason reads undefined, and the engine
    // loop sees every tool-calling turn as "completed" (one tool call, then
    // the run silently dies). stampResponse must return a REAL instance.
    const stamped = stampResponse(
      new LanguageModel.GenerateTextResponse(content as never),
      "opencode:kimi-k2.6",
    )
    expect(stamped).toBeInstanceOf(LanguageModel.GenerateTextResponse)
    expect(stamped.finishReason).toBe("tool-calls")
    expect(stamped.text).toBe("listing…")
    expect(stamped.usage.totalTokens).toBe(15)
  })
})

/** The SAME metric identities the router registers — description + tags are
 *  part of the registry key, so this pins the metric contract too. */
const counterValue = (name: string, description: string, tags: ReadonlyArray<[string, string]>) =>
  Effect.runPromise(
    Metric.value(
      tags.reduce(
        (metric, [key, value]) => Metric.tagged(metric, key, value),
        Metric.counter(name, { description, incremental: true }),
      ),
    ),
  ).then((state) => state.count)

const streamedParts = [
  { type: "reasoning-start", id: "reasoning-1" },
  { type: "reasoning-delta", id: "reasoning-1", delta: "because…" },
  { type: "reasoning-end", id: "reasoning-1" },
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "listing…" },
  { type: "text-end", id: "text-1" },
  { type: "tool-call", id: "c1", name: "ls", params: { path: "." } },
  {
    type: "finish",
    reason: "tool-calls",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  },
]

describe("tapStreamTelemetry", () => {
  test("parts pass through unchanged; the finish part moves the SAME token counters generateWith moves", async () => {
    const label = "test:stream-parity"
    const collected = await Effect.runPromise(
      Stream.runCollect(
        tapStreamTelemetry(label)(Stream.fromIterable(streamedParts)),
      ).pipe(Effect.map(Chunk.toReadonlyArray)),
    )
    expect(collected).toEqual(streamedParts)
    expect(
      await counterValue(
        "llm.usage.input_tokens",
        "prompt tokens consumed by routed LLM calls",
        [["llm.model", label]],
      ),
    ).toBe(10)
    expect(
      await counterValue(
        "llm.usage.output_tokens",
        "completion tokens produced by routed LLM calls",
        [["llm.model", label]],
      ),
    ).toBe(5)
    expect(
      await counterValue(
        "llm.requests",
        "routed LLM calls by final outcome (after retries)",
        [
          ["llm.model", label],
          ["outcome", "ok"],
        ],
      ),
    ).toBe(1)
  })

  test("a failing stream counts outcome=error, not ok", async () => {
    const label = "test:stream-error"
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(
        tapStreamTelemetry(label)(
          Stream.fromIterable(streamedParts.slice(0, 2)).pipe(
            Stream.concat(Stream.fail({ _tag: "HttpResponseError" })),
          ),
        ),
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(
      await counterValue(
        "llm.requests",
        "routed LLM calls by final outcome (after retries)",
        [
          ["llm.model", label],
          ["outcome", "error"],
        ],
      ),
    ).toBe(1)
    expect(
      await counterValue(
        "llm.requests",
        "routed LLM calls by final outcome (after retries)",
        [
          ["llm.model", label],
          ["outcome", "ok"],
        ],
      ),
    ).toBe(0)
  })
})
