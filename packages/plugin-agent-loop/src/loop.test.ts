import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "@effect/ai"
import { Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { Failure } from "@xandreed/core"
import type { LoopEvent } from "@xandreed/core"
import { DEGENERATE_REPEAT_NUDGE, foldProgress, nextPhase, runLoop } from "./loop.js"

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
    expect(events.map((e) => e.type)).toEqual(["turn_start", "assistant_message", "turn_end", "agent_end"])
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

  test("host completion stops after durable tool delivery without another model call", async () => {
    const { events, onEvent } = collect()
    const result = await run(runLoop({
      system: "sys", messages: [user("go")], toolkit: kit, onEvent,
      isComplete: () => Effect.succeed(events.some((event) => event.type === "tool_end" && event.ok)),
    }), () => [{ type: "tool-call", id: "c1", name: "echo", params: { value: "delivered" } }, finish("tool-calls")])
    expect(result.outcome).toBe("ok")
    expect(events.filter((event) => event.type === "turn_start")).toHaveLength(1)
    expect(result.newTail.some((message) => message.role === "tool")).toBe(true)
  })

  test("required host completion continues after a premature provider stop", async () => {
    const { events, onEvent } = collect()
    const result = await run(runLoop({
      system: "sys", messages: [user("deliver")], toolkit: kit, onEvent,
      requireCompletion: true, maxSteps: 3,
      isComplete: () => Effect.succeed(events.some((event) => event.type === "tool_end" && event.ok)),
    }), (call) => call === 0
      ? [{ type: "text", text: "I will do it" }, finish("stop")]
      : [{ type: "tool-call", id: "c1", name: "echo", params: { value: "delivered" } }, finish("tool-calls")])
    expect(result.outcome).toBe("ok")
    expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2)
    expect(events.some((event) => event.type === "tool_end" && event.ok)).toBe(true)
    expect(result.newTail.some((message) => message.role === "user")).toBe(true)
  })

  test("required host completion remains bounded when the provider never delivers", async () => {
    const { events, onEvent } = collect()
    const result = await run(runLoop({
      system: "sys", messages: [user("deliver")], toolkit: kit, onEvent,
      requireCompletion: true, maxSteps: 2,
      isComplete: () => Effect.succeed(false),
    }), () => [{ type: "text", text: "I will do it" }, finish("stop")])
    expect(result.outcome).toBe("partial")
    expect(result.reason).toBe("step-cap")
    expect(events.filter((event) => event.type === "turn_start")).toHaveLength(2)
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

describe("runLoop steering (pendingInput)", () => {
  test("text queued mid-run lands as a user message BEFORE the next model call", async () => {
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
    const persisted: Array<string> = []
    const queue: Array<string> = ["focus on the ERROR path, not the happy path"]
    const result = await Effect.runPromise(
      runLoop({
        system: "sys",
        messages: [user("go")],
        toolkit: kit,
        pendingInput: () => Effect.sync(() => Option.fromNullable(queue.shift())),
        onTail: (tail) =>
          Effect.sync(() => {
            persisted.push(...tail.map((m) => m.role))
            return [] as ReadonlyArray<number>
          }),
      }).pipe(
        Effect.provide(handlers),
        Effect.provideServiceEffect(LanguageModel.LanguageModel, spy),
      ),
    )
    expect(result.finalText).toBe("done")
    // The steering text is IN the second call's prompt…
    expect(prompts[1]).toContain("focus on the ERROR path")
    // …persisted through onTail…
    expect(persisted).toEqual(["assistant", "tool", "user", "assistant"])
    // …and part of the durable tail.
    const steer = result.newTail.find(
      (m) => m.role === "user" && m.content.includes("focus on the ERROR path"),
    )
    expect(steer).toBeDefined()
  })

  test("a finished run never consults the seam mid-loop (the last turn skips it)", async () => {
    const consulted: Array<number> = []
    await run(
      runLoop({
        system: "sys",
        messages: [user("hi")],
        toolkit: kit,
        pendingInput: () =>
          Effect.sync(() => {
            consulted.push(1)
            return Option.none<string>()
          }),
      }),
      () => [{ type: "text", text: "instant" }, finish("stop")],
    )
    expect(consulted).toHaveLength(0)
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

describe("runLoop — the decisions, pure", () => {
  test("foldProgress: an empty signature is inert; a repeat counts; nudge at 3, break at 5", () => {
    const start = { seen: new Set<string>(), staleTurns: 0 }
    const first = foldProgress(start, "echo:ok:x")
    expect(first.stale).toBe(0)
    expect(first.seen.has("echo:ok:x")).toBe(true)
    // The fold's output feeds the next turn's input.
    const carry = (r: ReturnType<typeof foldProgress>) => ({ seen: r.seen, staleTurns: r.stale })
    const idle = foldProgress(carry(first), "")
    expect(idle.stale).toBe(0)
    expect(idle.seen).toBe(first.seen)
    const repeats = [1, 2, 3, 4, 5].reduce(
      (acc) => [...acc, foldProgress(carry(acc[acc.length - 1] ?? first), "echo:ok:x")],
      [first],
    )
    expect(repeats.map((r) => r.stale)).toEqual([0, 1, 2, 3, 4, 5])
    expect(repeats.map((r) => r.nudge)).toEqual([false, false, false, true, false, false])
    expect(repeats.map((r) => r.broke)).toEqual([false, false, false, false, false, true])
    // Fresh progress resets the count.
    expect(foldProgress(carry(repeats[5]!), "echo:ok:y").stale).toBe(0)
  })

  test("nextPhase: the breaker outranks the model, the cap outranks 'more tools'", () => {
    expect(nextPhase({ broke: true, wantsMore: true, turnIndex: 1, maxSteps: 10 })).toBe("degenerate-loop")
    expect(nextPhase({ broke: false, wantsMore: false, turnIndex: 1, maxSteps: 10 })).toBe("completed")
    expect(nextPhase({ broke: false, wantsMore: true, turnIndex: 10, maxSteps: 10 })).toBe("step-cap")
    expect(nextPhase({ broke: false, wantsMore: true, turnIndex: 3, maxSteps: 10 })).toBe("continue")
  })

  test("a malformed streak cannot carry a run past the step cap — the corrective turns count", async () => {
    const { events, onEvent } = collect()
    const result = await run(
      runLoop({
        system: "sys",
        messages: [user("go")],
        toolkit: kit,
        maxSteps: 2,
        onEvent,
      }),
      () => [
        { type: "tool-call", id: "c", name: "not_a_tool", params: {} },
        finish("tool-calls"),
      ],
    )
    // Two model calls (turn 0 malformed → corrective; turn 1 hits the cap),
    // never a third: the cap is honoured on the recovery path too.
    expect(result.outcome).toBe("partial")
    expect(result.reason).toBe("step-cap")
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(2)
  })
})

test("capability selection is recomputed after a tool expands the active recipe", async () => {
  const Done = Tool.make("done", { parameters: {}, success: Schema.Boolean })
  const dynamicKit = Toolkit.make(Echo, Done)
  const visible: string[][] = []
  await Effect.runPromise(Effect.gen(function* () {
    const active = yield* Ref.make<ReadonlyArray<"echo" | "done">>(["echo"])
    const completed = yield* Ref.make(false)
    const model = yield* LanguageModel.make({
      generateText: (options) => Effect.sync(() => {
        visible.push(options.tools.map((tool) => tool.name))
        return visible.length === 1
          ? [{ type: "tool-call", id: "expand", name: "echo", params: { value: "expand" } }, finish("tool-calls")] as never
          : [{ type: "tool-call", id: "finish", name: "done", params: {} }, finish("tool-calls")] as never
      }),
      streamText: () => Stream.die("unused") as never,
    })
    const handlers = dynamicKit.toLayer({
      echo: ({ value }) => Ref.set(active, ["done"]).pipe(Effect.as({ echoed: value })),
      done: () => Ref.set(completed, true).pipe(Effect.as(true)),
    })
    const result = yield* runLoop({ system: "sys", messages: [user("go")], toolkit: dynamicKit,
      activeTools: () => Ref.get(active), isComplete: () => Ref.get(completed),
    }).pipe(Effect.provide(handlers), Effect.provideService(LanguageModel.LanguageModel, model))
    expect(result.outcome).toBe("ok")
  }))
  expect(visible).toEqual([["echo"], ["done"]])
})


test("the turn span covers events, tool execution and completion hooks", async () => {
  const parents = await Effect.runPromise(Effect.gen(function* () {
    const observed = yield* Ref.make<ReadonlyArray<{ event: string; span: string }>>([])
    yield* runLoop({
      system: "sys", messages: [user("go")], toolkit: kit,
      isComplete: () => Effect.gen(function* () {
        const span = yield* Effect.currentSpan.pipe(Effect.orDie)
        yield* Ref.update(observed, rows => [...rows, { event: "completion", span: span.name }])
        return true
      }),
      onEvent: event => Effect.gen(function* () {
        const span = yield* Effect.currentSpan.pipe(Effect.orDie)
        yield* Ref.update(observed, rows => [...rows, { event: event.type, span: span.name }])
      }),
    }).pipe(
      Effect.provide(kit.toLayer({ echo: ({ value }) => Effect.succeed({ echoed: value }) })),
      Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel(() => [
        { type: "tool-call", id: "c1", name: "echo", params: { value: "ping" } }, finish("tool-calls"),
      ])),
    )
    return yield* Ref.get(observed)
  }))
  expect(parents.filter(row => ["turn_start", "assistant_message", "completion"].includes(row.event)).every(row => row.span === "engine.turn")).toBe(true)
  expect(parents.find(row => row.event === "agent_end")?.span).toBe("engine.run")
})


test("step trace content is explicit, includes replay context and is off by default", async () => {
  const snapshots: Array<ReadonlyMap<string, unknown>> = []
  const capture = (event: LoopEvent) => event.type === "turn_start"
    ? Effect.currentSpan.pipe(Effect.tap((span) => Effect.sync(() => snapshots.push(span.attributes))), Effect.asVoid, Effect.orDie)
    : Effect.void
  await run(runLoop({ system: "stable system", messages: [user("previous question"), user("follow-up")], toolkit: kit, captureTraceContent: true, onEvent: capture }),
    () => [{ type: "text", text: "answer" }, finish("stop")])
  expect(snapshots[0]?.get("engine.step")).toBe(1)
  expect(String(snapshots[0]?.get("engine.step.input"))).toContain("previous question")
  expect(String(snapshots[0]?.get("engine.step.input"))).toContain("follow-up")
  expect(String(snapshots[0]?.get("engine.step.output"))).toContain("answer")
  await run(runLoop({ system: "private system", messages: [user("private")], toolkit: kit, onEvent: capture }),
    () => [{ type: "text", text: "private answer" }, finish("stop")])
  expect(snapshots[1]?.has("engine.step.input")).toBe(false)
  expect(snapshots[1]?.has("engine.step.output")).toBe(false)
})


test("native prompt instructions preserve messages and provider metadata", async () => {
  const instructions = Prompt.make([{ role: "system", content: "shared" }, { role: "system", content: "model-specific", options: { google: { fixture: true } } }])
  const captured: Prompt.Prompt[] = []
  const model = Effect.gen(function* () {
    return yield* LanguageModel.make({
      generateText: (options) => Effect.sync(() => { captured.push(options.prompt); return [{ type: "text", text: "done" }, finish("stop")] as never }),
      streamText: () => Stream.die("unused") as never,
    })
  })
  await Effect.runPromise(runLoop({ system: instructions, messages: [user("question")], toolkit: kit }).pipe(Effect.provide(handlers), Effect.provideServiceEffect(LanguageModel.LanguageModel, model)))
  expect(captured[0]?.content.slice(0, 2)).toEqual([...instructions.content])
  expect(captured[0]?.content[2]?.role).toBe("user")
  expect(instructions.content).toHaveLength(2)
})
