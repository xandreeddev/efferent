import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel } from "effect/ai"
import { Effect, Metric, Option, Stream } from "effect"
import { ModelSelection, parseModelSelection } from "@xandreed/core"
import { stampResponse, tapStreamTelemetry, withFallbackRung } from "./router.js"

const finish = {
  type: "finish",
  reason: "tool-calls",
  usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
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
    expect(stamped.usage.inputTokens.total).toBe(10)
  })
})

/** The SAME metric identities the router registers — description + attributes
 *  are part of the registry key, so this pins the metric contract too. */
const counterValue = (name: string, description: string, tags: ReadonlyArray<[string, string]>) =>
  Effect.runPromise(
    Metric.value(
      Metric.withAttributes(Metric.counter(name, { description, incremental: true }), Object.fromEntries(tags)),
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
    usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
  },
]

describe("tapStreamTelemetry", () => {
  test("parts pass through unchanged; the finish part moves the SAME token counters generateWith moves", async () => {
    const label = "test:stream-parity"
    const collected = await Effect.runPromise(
      Stream.runCollect(
        tapStreamTelemetry(label)(Stream.fromIterable(streamedParts)),
      ),
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

describe("withFallbackRung", () => {
  const sel = (raw: string): ModelSelection =>
    Option.getOrThrow(parseModelSelection(raw))
  const primary = sel("opencode:kimi-k2.6")
  const fallback = Option.some(sel("google:gemini-3.5-flash"))
  const request = { method: "POST" as const, url: "https://gw.example/chat", urlParams: [], headers: {} }
  const statusError = (status: number) =>
    AiError.make({
      module: "Test",
      method: "generateText",
      reason: AiError.reasonFromHttpStatus({ status, http: { request, response: { status, headers: {} } } }),
    })
  const transient = statusError(503)
  const permanent = statusError(401)

  const scripted = (outcomes: Record<string, Effect.Effect<string, unknown>>) => {
    const calls: Array<{ readonly model: string; readonly isFallback: boolean }> = []
    const call = (selection: ModelSelection, isFallback: boolean) => {
      const key = `${selection.provider}:${selection.modelId}`
      calls.push({ model: key, isFallback })
      return outcomes[key] ?? Effect.fail("unscripted")
    }
    return { call, calls }
  }

  test("a TRANSIENT primary failure runs the fallback once, labeled", async () => {
    const { call, calls } = scripted({
      "opencode:kimi-k2.6": Effect.fail(transient),
      "google:gemini-3.5-flash": Effect.succeed("saved"),
    })
    const out = await Effect.runPromise(
      withFallbackRung(primary, fallback, call) as Effect.Effect<string>,
    )
    expect(out).toBe("saved")
    expect(calls).toEqual([
      { model: "opencode:kimi-k2.6", isFallback: false },
      { model: "google:gemini-3.5-flash", isFallback: true },
    ])
  })

  test("a PERMANENT failure never falls back — a different model can't fix a bad request", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.fail(permanent) })
    const exit = await Effect.runPromiseExit(withFallbackRung(primary, fallback, call))
    expect(exit._tag).toBe("Failure")
    expect(calls).toHaveLength(1)
  })

  test("no fallback configured, or fallback === primary → the error passes through", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.fail(transient) })
    const none = await Effect.runPromiseExit(withFallbackRung(primary, Option.none(), call))
    expect(none._tag).toBe("Failure")
    const same = await Effect.runPromiseExit(
      withFallbackRung(primary, Option.some(primary), call),
    )
    expect(same._tag).toBe("Failure")
    expect(calls).toHaveLength(2)
  })

  test("a healthy primary never touches the fallback", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.succeed("fine") })
    const out = await Effect.runPromise(
      withFallbackRung(primary, fallback, call) as Effect.Effect<string>,
    )
    expect(out).toBe("fine")
    expect(calls).toEqual([{ model: "opencode:kimi-k2.6", isFallback: false }])
  })
})
