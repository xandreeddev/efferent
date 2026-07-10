import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Tool, Toolkit } from "@effect/ai"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { Failure } from "../domain/Failure.js"
import type { LoopEvent } from "../domain/LoopEvent.js"
import { DEGENERATE_REPEAT_NUDGE, runLoop } from "./loop.js"

/** A scripted provider: call N returns `script(N)`'s encoded parts. */
const scriptedModel = (script: (call: number) => ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () =>
        Ref.getAndUpdate(calls, (n) => n + 1).pipe(
          Effect.map((n) => script(n) as never),
        ),
      streamText: () => Stream.die("not scripted") as never,
    })
  })

/** Decompose settled parts into their stream-part vocabulary — what a real
 *  streaming provider would emit for the same turn. */
const toStreamParts = (parts: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
  parts.flatMap((part) => {
    const p = part as { type?: string; text?: string }
    if (p.type === "text") {
      const mid = Math.ceil((p.text ?? "").length / 2)
      return [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: (p.text ?? "").slice(0, mid) },
        { type: "text-delta", id: "t1", delta: (p.text ?? "").slice(mid) },
        { type: "text-end", id: "t1" },
      ]
    }
    if (p.type === "reasoning") {
      return [
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: p.text ?? "" },
        { type: "reasoning-end", id: "r1" },
      ]
    }
    return [part]
  })

/** A provider that ONLY streams — generateText dies, proving the streamed
 *  path never touches it. */
const streamingModel = (script: (call: number) => ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.die("settled path must not run") as never,
      streamText: () =>
        Stream.unwrap(
          Ref.getAndUpdate(calls, (n) => n + 1).pipe(
            Effect.map((n) => Stream.fromIterable(toStreamParts(script(n)))),
          ),
        ) as never,
    })
  })

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish",
  reason,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
})

const Echo = Tool.make("echo", {
  description: "echo a value back",
  parameters: { value: Schema.String },
  success: Schema.Struct({ echoed: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

const kit = Toolkit.make(Echo)
const handlers = Layer.mergeAll(
  kit.toLayer({ echo: ({ value }) => Effect.succeed({ echoed: value }) }),
)

const run = <A, E>(
  effect: Effect.Effect<A, E, LanguageModel.LanguageModel | Tool.Handler<"echo">>,
  script: (call: number) => ReadonlyArray<unknown>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(handlers),
      Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel(script)),
    ),
  )

const collect = () => {
  const events: Array<LoopEvent> = []
  const onEvent = (e: LoopEvent) => Effect.sync(() => void events.push(e))
  return { events, onEvent }
}

const user = (content: string) => ({ role: "user" as const, content })

describe("runLoop", () => {
  test("a plain text response completes in one turn with the event trail", async () => {
    const { events, onEvent } = collect()
    const result = await run(
      runLoop({ system: "sys", messages: [user("hi")], toolkit: kit, onEvent }),
      () => [{ type: "text", text: "hello there" }, finish("stop")],
    )
    expect(result.finalText).toBe("hello there")
    expect(result.outcome).toBe("ok")
    expect(result.reason).toBe("completed")
    expect(result.newTail).toHaveLength(1)
    expect(events.map((e) => e.type)).toEqual(["turn_start", "assistant_message", "agent_end"])
  })

  test("a tool-call turn resolves the handler and iterates to completion", async () => {
    const { events, onEvent } = collect()
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit, onEvent }),
      (call) =>
        call === 0
          ? [
              { type: "tool-call", id: "c1", name: "echo", params: { value: "ping" } },
              finish("tool-calls"),
            ]
          : [{ type: "text", text: "done" }, finish("stop")],
    )
    expect(result.finalText).toBe("done")
    expect(result.outcome).toBe("ok")
    const toolEnd = events.find((e) => e.type === "tool_end")
    expect(toolEnd).toMatchObject({ toolName: "echo", ok: true })
    // The tool message persisted into the tail alongside the assistant ones.
    expect(result.newTail.filter((m) => m.role === "tool")).toHaveLength(1)
  })

  test("a wrong-shaped tool call is recovered — corrective feedback, then success", async () => {
    // In @effect/ai 0.35 a wrong-shaped param set fails at RESPONSE decode
    // (before Toolkit.handle), so recovery rides the loop's corrective path —
    // same outcome as a hallucinated name: the turn survives, the model fixes.
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit }),
      (call) =>
        call === 0
          ? [
              { type: "tool-call", id: "c1", name: "echo", params: { wrong: true } },
              finish("tool-calls"),
            ]
          : [{ type: "text", text: "fixed" }, finish("stop")],
    )
    expect(result.finalText).toBe("fixed")
    expect(result.outcome).toBe("ok")
    const corrective = result.newTail.find(
      (m) => m.role === "user" && m.content.includes("could not be parsed"),
    )
    expect(corrective).toBeDefined()
  })

  test("a hallucinated tool NAME feeds a corrective and retries, bounded", async () => {
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit }),
      (call) =>
        call === 0
          ? [
              { type: "tool-call", id: "c1", name: "not_a_tool", params: {} },
              finish("tool-calls"),
            ]
          : [{ type: "text", text: "recovered" }, finish("stop")],
    )
    expect(result.finalText).toBe("recovered")
    const corrective = result.newTail.find(
      (m) => m.role === "user" && m.content.includes("could not be parsed"),
    )
    expect(corrective).toBeDefined()
  })

  test("the degenerate-loop breaker nudges once, then force-stops as partial", async () => {
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit }),
      () => [
        { type: "tool-call", id: "c1", name: "echo", params: { value: "same" } },
        finish("tool-calls"),
      ],
    )
    expect(result.outcome).toBe("partial")
    expect(result.reason).toBe("degenerate-loop")
    const nudges = result.newTail.filter(
      (m) => m.role === "user" && m.content === DEGENERATE_REPEAT_NUDGE,
    )
    expect(nudges).toHaveLength(1)
  })

  test("the step cap stops a run that still wants tools, as partial", async () => {
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit, maxSteps: 2 }),
      (call) => [
        { type: "tool-call", id: `c${call}`, name: "echo", params: { value: `v${call}` } },
        finish("tool-calls"),
      ],
    )
    expect(result.outcome).toBe("partial")
    expect(result.reason).toBe("step-cap")
  })

  test("onTail receives every appended message incrementally, correctives included", async () => {
    const seen: Array<string> = []
    const onTail = (tail: ReadonlyArray<{ role: string }>) =>
      Effect.sync(() => {
        seen.push(...tail.map((m) => m.role))
        return [] as ReadonlyArray<number>
      })
    await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit, onTail }),
      (call) =>
        call === 0
          ? [
              { type: "tool-call", id: "c1", name: "echo", params: { value: "x" } },
              finish("tool-calls"),
            ]
          : [{ type: "text", text: "done" }, finish("stop")],
    )
    expect(seen).toEqual(["assistant", "tool", "assistant"])
  })

  test("the compact seam folds at a turn boundary — the NEXT call sends summary + kept tail", async () => {
    const prompts: Array<string> = []
    const spy = Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      return yield* LanguageModel.make({
        generateText: (options) =>
          Ref.getAndUpdate(calls, (n) => n + 1).pipe(
            Effect.tap((n) =>
              Effect.sync(() => {
                prompts[n] = JSON.stringify(options.prompt.content)
              }),
            ),
            Effect.map(
              (n) =>
                (n === 0
                  ? [
                      { type: "tool-call", id: "c1", name: "echo", params: { value: "x" } },
                      finish("tool-calls"),
                    ]
                  : [{ type: "text", text: "done" }, finish("stop")]) as never,
            ),
          ),
        streamText: () => Stream.die("not scripted") as never,
      })
    })
    const { events, onEvent } = collect()
    const result = await Effect.runPromise(
      runLoop({
        system: "sys",
        messages: [user("the ORIGINAL brief")],
        toolkit: kit,
        onEvent,
        // Fold everything before the just-finished turn's assistant message.
        compact: (messages) =>
          Effect.succeed(
            Option.some({
              summary: "THE MID-RUN SUMMARY",
              keepFrom: messages.findIndex((m) => m.role === "assistant"),
            }),
          ),
      }).pipe(
        Effect.provide(handlers),
        Effect.provideServiceEffect(LanguageModel.LanguageModel, spy),
      ),
    )
    expect(result.finalText).toBe("done")
    // Call 1's prompt: the handoff replaced the original head; the turn's
    // assistant + tool messages survive verbatim.
    expect(prompts[1]).toContain("THE MID-RUN SUMMARY")
    expect(prompts[1]).not.toContain("the ORIGINAL brief")
    expect(prompts[1]).toContain("echo")
    // newTail is persistence-truth: untouched by the load-side rewrite.
    expect(result.newTail.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"])
    const compaction = events.find((e) => e.type === "compaction")
    expect(compaction?.type === "compaction" && compaction.kept).toBe(2)
  })

  test("an invalid plan (cut on a tool message) is IGNORED — the run continues unfolded", async () => {
    const prompts: Array<string> = []
    const spy = Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      return yield* LanguageModel.make({
        generateText: (options) =>
          Ref.getAndUpdate(calls, (n) => n + 1).pipe(
            Effect.tap((n) =>
              Effect.sync(() => {
                prompts[n] = JSON.stringify(options.prompt.content)
              }),
            ),
            Effect.map(
              (n) =>
                (n === 0
                  ? [
                      { type: "tool-call", id: "c1", name: "echo", params: { value: "x" } },
                      finish("tool-calls"),
                    ]
                  : [{ type: "text", text: "done" }, finish("stop")]) as never,
            ),
          ),
        streamText: () => Stream.die("not scripted") as never,
      })
    })
    const { events, onEvent } = collect()
    await Effect.runPromise(
      runLoop({
        system: "sys",
        messages: [user("the ORIGINAL brief")],
        toolkit: kit,
        onEvent,
        compact: (messages) =>
          Effect.succeed(
            Option.some({
              summary: "BAD PLAN",
              keepFrom: messages.findIndex((m) => m.role === "tool"),
            }),
          ),
      }).pipe(
        Effect.provide(handlers),
        Effect.provideServiceEffect(LanguageModel.LanguageModel, spy),
      ),
    )
    expect(prompts[1]).toContain("the ORIGINAL brief")
    expect(prompts[1]).not.toContain("BAD PLAN")
    expect(events.some((e) => e.type === "compaction")).toBe(false)
  })
})

describe("runLoop streaming", () => {
  const script = (call: number): ReadonlyArray<unknown> =>
    call === 0
      ? [
          { type: "reasoning", text: "plan" },
          { type: "tool-call", id: "c1", name: "echo", params: { value: "ping" } },
          finish("tool-calls"),
        ]
      : [{ type: "text", text: "all done" }, finish("stop")]

  test("PARITY: the streamed run's result and final events deep-equal the settled run's", async () => {
    const settledEvents = collect()
    const settledResult = await run(
      runLoop({
        system: "sys",
        messages: [user("go")],
        toolkit: kit,
        onEvent: settledEvents.onEvent,
      }),
      script,
    )
    const streamedEvents = collect()
    const streamedResult = await Effect.runPromise(
      runLoop({
        system: "sys",
        messages: [user("go")],
        toolkit: kit,
        streaming: true,
        onEvent: streamedEvents.onEvent,
      }).pipe(
        Effect.provide(handlers),
        Effect.provideServiceEffect(LanguageModel.LanguageModel, streamingModel(script)),
      ),
    )
    expect(streamedResult).toEqual(settledResult)
    const finals: ReadonlyArray<LoopEvent> = streamedEvents.events.filter(
      (e) => e.type !== "assistant_delta",
    )
    expect(finals).toEqual(settledEvents.events)
    // The deltas concatenate to exactly the final text/reasoning.
    const deltas = streamedEvents.events.flatMap((e) =>
      e.type === "assistant_delta" ? [e] : [],
    )
    expect(deltas.length).toBeGreaterThan(0)
    expect(
      deltas.filter((d) => d.channel === "text").map((d) => d.delta).join(""),
    ).toBe("all done")
    expect(
      deltas.filter((d) => d.channel === "reasoning").map((d) => d.delta).join(""),
    ).toBe("plan")
  })

  test("FALLBACK: a pre-first-part stream death falls back to generateText for the RUN (no re-probe)", async () => {
    const streamProbes = { count: 0 }
    const dyingStreamModel = Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      return yield* LanguageModel.make({
        generateText: () =>
          Ref.getAndUpdate(calls, (n) => n + 1).pipe(Effect.map((n) => script(n) as never)),
        streamText: () =>
          Stream.unwrap(
            Effect.sync(() => {
              streamProbes.count = streamProbes.count + 1
              return Stream.die("scripted providers do not stream")
            }),
          ) as never,
      })
    })
    const { events, onEvent } = collect()
    const result = await Effect.runPromise(
      runLoop({
        system: "sys",
        messages: [user("go")],
        toolkit: kit,
        streaming: true,
        onEvent,
      }).pipe(
        Effect.provide(handlers),
        Effect.provideServiceEffect(LanguageModel.LanguageModel, dyingStreamModel),
      ),
    )
    expect(result.finalText).toBe("all done")
    expect(result.outcome).toBe("ok")
    // Turn 0 probed the stream once; turn 1 went straight to generateText.
    expect(streamProbes.count).toBe(1)
    expect(events.some((e) => e.type === "assistant_delta")).toBe(false)
  })

  test("a MID-stream malformed failure (after content) rides the corrective path", async () => {
    const malformedThenClean = Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      return yield* LanguageModel.make({
        generateText: () => Effect.die("settled path must not run") as never,
        streamText: () =>
          Stream.unwrap(
            Ref.getAndUpdate(calls, (n) => n + 1).pipe(
              Effect.map((n) =>
                n === 0
                  ? Stream.fromIterable([
                      { type: "text-start", id: "t1" },
                      { type: "text-delta", id: "t1", delta: "partial…" },
                    ]).pipe(
                      Stream.concat(
                        Stream.fail(
                          new AiError.MalformedOutput({
                            module: "Test",
                            method: "streamText",
                            description: "the stream broke mid-turn",
                          }),
                        ),
                      ),
                    )
                  : Stream.fromIterable(toStreamParts(script(1))),
              ),
            ),
          ) as never,
      })
    })
    const result = await Effect.runPromise(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit, streaming: true }).pipe(
        Effect.provide(handlers),
        Effect.provideServiceEffect(LanguageModel.LanguageModel, malformedThenClean),
      ),
    )
    expect(result.finalText).toBe("all done")
    const corrective = result.newTail.find(
      (m) => m.role === "user" && m.content.includes("could not be parsed"),
    )
    expect(corrective).toBeDefined()
  })
})
