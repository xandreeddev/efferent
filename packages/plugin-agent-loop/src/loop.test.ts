import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { Effect, Layer, Option, Ref, Schema, Stream, Tracer } from "effect"
import { CurrentTraceContent, Failure, mediaFromBase64 } from "@xandreed/core"
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
  type: "finish" as const,
  reason,
  usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
})

const Echo = Tool.make("echo", {
  description: "echo a value back",
  parameters: Schema.Struct({ value: Schema.String }),
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
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("could not be parsed"),
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
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("could not be parsed"),
    )
    expect(corrective).toBeDefined()
  })

  test("the degenerate-loop breaker nudges once, then force-stops as partial", async () => {
    const nudgedAt: Array<number> = []
    const settled: Array<string> = []
    const result = await run(
      runLoop({
        system: "sys", messages: [user("go")], toolkit: kit,
        onTail: (tail, step) => Effect.sync(() => {
          if (tail.some((m) => m.role === "user")) nudgedAt.push(step)
          return [] as ReadonlyArray<number>
        }),
        onStepSettled: (step, status) => Effect.sync(() => void settled.push(`${step}:${status}`)),
      }),
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
    // Step 3 is the third stale one: the nudge is what step 4 reads, recorded under it.
    expect(nudgedAt).toEqual([4])
    expect(settled).toEqual(["0:completed", "1:completed", "2:completed", "3:completed", "4:completed", "5:completed"])
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

describe("runLoop settles each step once", () => {
  test("after its tail and before its completion; a corrective, a nudge and a steer are the next step's", async () => {
    const trail: Array<string> = []
    const steers = ["steer"]
    const result = await run(runLoop({
      system: "sys", messages: [user("go")], toolkit: kit, requireCompletion: true, maxSteps: 6,
      onTail: (tail, step) => Effect.sync(() => {
        trail.push(`tail ${step}: ${tail.map((m) => m.role).join(",")}`)
        return [] as ReadonlyArray<number>
      }),
      onStepSettled: (step, status) => Effect.sync(() => void trail.push(`settled ${step}: ${status}`)),
      isComplete: (step) => Effect.sync(() => {
        trail.push(`complete? ${step}`)
        return step >= 3
      }),
      pendingInput: () => Effect.sync(() => Option.fromNullishOr(steers.shift())),
    }), (call) => [
      [{ type: "tool-call", id: "m1", name: "not_a_tool", params: {} }, finish("tool-calls")],
      [{ type: "text", text: "I will" }, finish("stop")],
      [{ type: "tool-call", id: "c1", name: "echo", params: { value: "x" } }, finish("tool-calls")],
    ][call] ?? [{ type: "text", text: "done" }, finish("stop")])
    expect([result.outcome, result.finalText]).toEqual(["ok", "done"])
    expect(trail).toEqual([
      // A malformed step settles as such, and its completion is never asked.
      "settled 0: malformed",
      "tail 1: user",
      "tail 1: assistant",
      "settled 1: completed",
      "complete? 1",
      // The completion nudge, then the steer: both read by step 2.
      "tail 2: user",
      "tail 2: user",
      "tail 2: assistant,tool",
      "settled 2: completed",
      "complete? 2",
      "tail 3: assistant",
      "settled 3: completed",
      "complete? 3",
    ])
  })

  test("a step whose call fails settles failed; one whose completion dies afterwards stays completed", async () => {
    const settledWith = (options: { readonly call: "fails" | "answers"; readonly completion: "dies" | "holds" }) => Effect.runPromise(Effect.gen(function* () {
      const settled = yield* Ref.make<ReadonlyArray<string>>([])
      const invalid = AiError.make({ module: "Test", method: "generateText", reason: new AiError.InvalidResponseError({ description: "not a chat completion" }) })
      const model = yield* LanguageModel.make({
        generateText: () => (options.call === "fails" ? Effect.fail(invalid) : Effect.succeed([{ type: "text", text: "done" }, finish("stop")])) as never,
        streamText: () => Stream.die("not scripted") as never,
      })
      const exit = yield* Effect.exit(runLoop({
        system: "sys", messages: [user("go")], toolkit: kit,
        onStepSettled: (step, status) => Ref.update(settled, (all) => [...all, `${step}:${status}`]),
        isComplete: () => options.completion === "dies" ? Effect.die("the completion policy broke") : Effect.succeed(true),
      }).pipe(Effect.provide(handlers), Effect.provideService(LanguageModel.LanguageModel, model)))
      return { failed: exit._tag === "Failure", settled: yield* Ref.get(settled) }
    }))
    expect(await settledWith({ call: "fails", completion: "holds" })).toEqual({ failed: true, settled: ["0:failed"] })
    expect(await settledWith({ call: "answers", completion: "dies" })).toEqual({ failed: true, settled: ["0:completed"] })
    expect(await settledWith({ call: "answers", completion: "holds" })).toEqual({ failed: false, settled: ["0:completed"] })
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
        pendingInput: () => Effect.sync(() => Option.fromNullishOr(queue.shift())),
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
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("focus on the ERROR path"),
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
  test("checks dispatch again before a streaming fallback and freezes prompt data", async () => {
    const { checks, calls, frozen } = await Effect.runPromise(Effect.gen(function* () {
      const checks = yield* Ref.make<ReadonlyArray<number>>([])
      const calls = yield* Ref.make(0)
      const frozen = yield* Ref.make(false)
      const model = yield* LanguageModel.make({
        generateText: (options) => Effect.gen(function* () {
          yield* Ref.update(calls, (count) => count + 1)
          yield* Ref.set(frozen, Object.isFrozen(options.prompt) && Object.isFrozen(options.prompt.content) && options.prompt.content.every(Object.isFrozen))
          return [{ type: "text" as const, text: "done" }, finish("stop")]
        }),
        streamText: () => Stream.die("stream unavailable"),
      })
      yield* runLoop({
        system: "sys", messages: [user("go")], toolkit: Toolkit.empty, streaming: true,
        beforeDispatch: (step) => Ref.update(checks, (all) => [...all, step]),
      }).pipe(Effect.provideService(LanguageModel.LanguageModel, model))
      return { checks: yield* Ref.get(checks), calls: yield* Ref.get(calls), frozen: yield* Ref.get(frozen) }
    }))
    expect(checks).toEqual([0, 0])
    expect(calls).toBe(1)
    expect(frozen).toBe(true)
  })
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
    // One stream_fallback for the run, in the step that fell back, before its message.
    expect(events.filter((e) => e.type === "stream_fallback")).toEqual([
      { type: "stream_fallback", turnIndex: 0, message: expect.stringContaining("scripted providers do not stream") },
    ])
    const order = events.map((e) => e.type)
    expect(order.indexOf("stream_fallback")).toBeLessThan(order.indexOf("assistant_message"))
  })

  test("FALLBACK: the stream_fallback message is the stream's error, cut to 300 characters", async () => {
    const { events, onEvent } = collect()
    await Effect.runPromise(Effect.gen(function* () {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([{ type: "text" as const, text: "done" }, finish("stop")]),
        streamText: () => Stream.die("x".repeat(1_000)),
      })
      yield* runLoop({ system: "sys", messages: [user("go")], toolkit: Toolkit.empty, streaming: true, onEvent })
        .pipe(Effect.provideService(LanguageModel.LanguageModel, model))
    }))
    const fallbacks = events.flatMap((e) => e.type === "stream_fallback" ? [e.message] : [])
    expect(fallbacks.map((message) => message.length)).toEqual([300])
  })

  test("FALLBACK: a stream that dies with an object reports it as JSON, not [object Object]", async () => {
    const { events, onEvent } = collect()
    await Effect.runPromise(Effect.gen(function* () {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([{ type: "text" as const, text: "done" }, finish("stop")]),
        streamText: () => Stream.die({ status: 502, reason: "bad gateway" }),
      })
      yield* runLoop({ system: "sys", messages: [user("go")], toolkit: Toolkit.empty, streaming: true, onEvent })
        .pipe(Effect.provideService(LanguageModel.LanguageModel, model))
    }))
    expect(events.flatMap((e) => e.type === "stream_fallback" ? [e.message] : [])).toEqual(["{\"status\":502,\"reason\":\"bad gateway\"}"])
  })

  test("a stream that fails after its first part fails the step: no stream_fallback", async () => {
    const { events, onEvent } = collect()
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.die("settled path must not run"),
        streamText: () => Stream.concat(Stream.fromIterable(toStreamParts([{ type: "text", text: "partial" }])), Stream.die("cut off")) as never,
      })
      yield* runLoop({ system: "sys", messages: [user("go")], toolkit: Toolkit.empty, streaming: true, onEvent })
        .pipe(Effect.provideService(LanguageModel.LanguageModel, model))
    }))
    expect(exit._tag).toBe("Failure")
    expect(events.some((e) => e.type === "stream_fallback")).toBe(false)
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
                          AiError.make({
                            module: "Test",
                            method: "streamText",
                            reason: new AiError.InvalidOutputError({ description: "the stream broke mid-turn" }),
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
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("could not be parsed"),
    )
    expect(corrective).toBeDefined()
  })

  test("a provider's invalid response (its wire, not the model's output) fails the run: no corrective turn, settled or streamed", async () => {
    const invalid = AiError.make({ module: "Test", method: "generateText", reason: new AiError.InvalidResponseError({ description: "the completion body is not a chat completion" }) })
    const outcome = (streaming: boolean) => Effect.runPromise(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const model = yield* LanguageModel.make({
        generateText: () => Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(Effect.fail(invalid))) as never,
        streamText: () => Stream.unwrap(Ref.update(calls, (n) => n + 1).pipe(Effect.as(
          Stream.fromIterable([{ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "partial…" }]).pipe(Stream.concat(Stream.fail(invalid))),
        ))) as never,
      })
      const tails: Array<ReadonlyArray<unknown>> = []
      const onTail = (tail: ReadonlyArray<unknown>) =>
        Effect.sync(() => {
          tails.push(tail)
          return [] as ReadonlyArray<number>
        })
      const exit = yield* Effect.exit(runLoop({ system: "sys", messages: [user("go")], toolkit: kit, streaming, onTail }).pipe(
        Effect.provide(handlers),
        Effect.provideService(LanguageModel.LanguageModel, model),
      ))
      return { failed: exit._tag === "Failure", calls: yield* Ref.get(calls), correctives: tails.flat().length }
    }))
    expect(await outcome(false)).toEqual({ failed: true, calls: 1, correctives: 0 })
    expect(await outcome(true)).toEqual({ failed: true, calls: 1, correctives: 0 })
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
  const Done = Tool.make("done", { parameters: Schema.Struct({}), success: Schema.Boolean })
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
  // Unset, the option is CurrentTraceContent where the run starts.
  await run(runLoop({ system: "ambient system", messages: [user("ambient")], toolkit: kit, onEvent: capture }).pipe(Effect.provideService(CurrentTraceContent, true)),
    () => [{ type: "text", text: "ambient answer" }, finish("stop")])
  expect(String(snapshots[2]?.get("engine.step.input"))).toContain("ambient")
  // The option wins over the reference.
  await run(runLoop({ system: "explicit system", messages: [user("explicit")], toolkit: kit, captureTraceContent: false, onEvent: capture }).pipe(Effect.provideService(CurrentTraceContent, true)),
    () => [{ type: "text", text: "explicit answer" }, finish("stop")])
  expect(snapshots[3]?.has("engine.step.input")).toBe(false)
})

test("the run's model calls and callbacks read the run's trace content switch", async () => {
  const seen = await Effect.runPromise(Effect.gen(function* () {
    const reads = yield* Ref.make<ReadonlyArray<string>>([])
    const read = (where: string) => Effect.service(CurrentTraceContent).pipe(Effect.flatMap((on) => Ref.update(reads, (all) => [...all, `${where}:${on}`])))
    const model = yield* LanguageModel.make({
      generateText: () => read("model").pipe(Effect.as([{ type: "text" as const, text: "done" }, finish("stop")])),
      streamText: () => Stream.die("unused"),
    })
    yield* runLoop({ system: "sys", messages: [user("go")], toolkit: Toolkit.empty, captureTraceContent: true, onEvent: (event) => event.type === "turn_start" ? read("event") : Effect.void })
      .pipe(Effect.provideService(LanguageModel.LanguageModel, model))
    return yield* Ref.get(reads)
  }))
  expect(seen).toEqual(["event:true", "model:true"])
})

test("a caller's span does not capture the loop's callbacks: they run under the step that calls them", async () => {
  const spans: Array<Tracer.NativeSpan> = []
  const parents = await Effect.runPromise(Effect.gen(function* () {
    const observed = yield* Ref.make<ReadonlyArray<string>>([])
    const parentName = (where: string) => Effect.currentSpan.pipe(Effect.orDie, Effect.flatMap((span) => Ref.update(observed, (all) => [...all, `${where}:${span.name}`])))
    yield* runLoop({
      system: "sys", messages: [user("go")], toolkit: kit,
      activeTools: () => parentName("activeTools").pipe(Effect.as(["echo" as const])),
      render: () => parentName("render").pipe(Effect.as([user("go")])),
    }).pipe(
      Effect.provide(kit.toLayer({ echo: ({ value }) => Effect.succeed({ echoed: value }).pipe(Effect.withSpan("echo.handler")) })),
      Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel((call) => call === 0
        ? [{ type: "tool-call", id: "c1", name: "echo", params: { value: "ping" } }, finish("tool-calls")]
        : [{ type: "text", text: "done" }, finish("stop")])),
      Effect.withSpan("caller"),
      Effect.withTracer(capturingTracer(spans)),
    )
    return yield* Ref.get(observed)
  }))
  expect(parents).toEqual(["activeTools:engine.turn", "render:engine.turn", "activeTools:engine.turn", "render:engine.turn"])
  const byId = new Map(spans.map((span) => [span.spanId, span]))
  const parentOf = (span: Tracer.NativeSpan | undefined) => Option.flatMap(Option.flatMap(Option.fromNullishOr(span), (child) => child.parent), (parent) => Option.fromNullishOr(byId.get(parent.spanId)))
  expect(Option.map(parentOf(spans.find((span) => span.name === "engine.run")), (span) => span.name)).toEqual(Option.some("caller"))
  expect(Option.map(parentOf(spans.find((span) => span.name === "engine.turn")), (span) => span.name)).toEqual(Option.some("engine.run"))
})

test("traced step content names an image by its size, never its bytes", async () => {
  const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  const pixel = await Effect.runPromise(mediaFromBase64(pixelPng))
  const snapshots: Array<ReadonlyMap<string, unknown>> = []
  const capture = (event: LoopEvent) => event.type === "turn_start"
    ? Effect.currentSpan.pipe(Effect.tap((span) => Effect.sync(() => snapshots.push(span.attributes))), Effect.asVoid, Effect.orDie)
    : Effect.void
  await run(runLoop({ system: "sys", messages: [{ role: "user", content: [pixel, { type: "text", text: "what is this?" }] }], toolkit: kit, captureTraceContent: true, onEvent: capture }),
    () => [{ type: "text", text: "a pixel" }, finish("stop")])
  const input = String(snapshots[0]?.get("engine.step.input"))
  expect(input).toContain("what is this?")
  expect(input).toContain(`[${pixelPng.length} base64 characters]`)
  expect(input).not.toContain(pixelPng.slice(0, 24))
})


describe("a request the provider refuses over an image", () => {
  const refusal = (description: string) => AiError.make({ module: "Test", method: "generateText", reason: new AiError.InvalidRequestError({ description }) })
  /**
   * A model that refuses its first request with `first`, then answers; it records how many requests it got and
   * whether each was streamed. With `afterPart`, the first streamed response sends a part before the refusal.
   */
  const refusingOnce = (first: AiError.AiError, calls: Ref.Ref<ReadonlyArray<string>>, afterPart: boolean) => LanguageModel.make({
    generateText: () => Ref.modify(calls, (all): [number, ReadonlyArray<string>] => [all.length, [...all, "settled"]]).pipe(
      Effect.flatMap((n) => n === 0 ? Effect.fail(first) : Effect.succeed([{ type: "text", text: "seen without the image" }, finish("stop")] as never))),
    streamText: () => Stream.unwrap(Ref.modify(calls, (all): [number, ReadonlyArray<string>] => [all.length, [...all, "streamed"]]).pipe(
      Effect.map((n) => n > 0 ? Stream.fromIterable(toStreamParts([{ type: "text", text: "seen without the image" }, finish("stop")]))
        : afterPart ? Stream.concat(Stream.fromIterable(toStreamParts([{ type: "text", text: "partial" }])), Stream.fail(first))
        : Stream.fail(first)))) as never,
  })
  const attempt = (first: AiError.AiError, options: { readonly streaming: boolean; readonly omit: boolean; readonly afterPart?: boolean }) => Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const renders = yield* Ref.make(0)
    const reasons = yield* Ref.make<ReadonlyArray<string>>([])
    const { events, onEvent } = collect()
    const result = yield* runLoop({
      system: "sys", messages: [user("look")], toolkit: kit, streaming: options.streaming, onEvent,
      render: () => Ref.updateAndGet(renders, (n) => n + 1).pipe(Effect.map((n) => [user(n === 1 ? "look [an image]" : "look [image omitted]")])),
      onMediaRejected: (reason) => Ref.update(reasons, (all) => [...all, reason]).pipe(Effect.as(options.omit)),
    }).pipe(Effect.provide(handlers), Effect.provideServiceEffect(LanguageModel.LanguageModel, refusingOnce(first, calls, options.afterPart ?? false)), Effect.result)
    return { result, calls: yield* Ref.get(calls), renders: yield* Ref.get(renders), reasons: yield* Ref.get(reasons), events }
  })

  test.each([false, true])("is rendered again and sent once more after onMediaRejected deals with it (streaming %p, never a stream fallback)", async (streaming) => {
    const outcome = await Effect.runPromise(attempt(refusal("messages.1.content.0.image.source.base64: image exceeds 5 MB maximum"), { streaming, omit: true }))
    expect(outcome.result._tag === "Success" ? outcome.result.success.finalText : "failed").toBe("seen without the image")
    expect(outcome.calls).toEqual(streaming ? ["streamed", "streamed"] : ["settled", "settled"])
    expect(outcome.renders).toBe(2)
    expect(outcome.reasons).toEqual([expect.stringContaining("image exceeds 5 MB maximum")])
    expect(outcome.events.map((event) => event.type).filter((type) => type !== "assistant_delta")).toEqual(["turn_start", "assistant_message", "turn_end", "agent_end"])
  })

  test("fails the step when onMediaRejected has nothing to omit, or the refusal names no image", async () => {
    const nothing = await Effect.runPromise(attempt(refusal("Could not process image"), { streaming: false, omit: false }))
    expect([nothing.result._tag, nothing.calls.length]).toEqual(["Failure", 1])
    const other = await Effect.runPromise(attempt(refusal("max_tokens is too large"), { streaming: false, omit: true }))
    expect([other.result._tag, other.calls.length, other.reasons]).toEqual(["Failure", 1, []])
  })

  test("is not sent again once a part of the streamed response arrived (its deltas went out)", async () => {
    const outcome = await Effect.runPromise(attempt(refusal("Could not process image"), { streaming: true, omit: true, afterPart: true }))
    expect([outcome.result._tag, outcome.calls, outcome.reasons, outcome.renders]).toEqual(["Failure", ["streamed"], [], 1])
  })
})

/** A tracer keeping every span it starts, to read their attributes once they ended. */
const capturingTracer = (spans: Array<Tracer.NativeSpan>) => Tracer.make({
  span: (options) => {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  },
})

test("the run's usage sums its steps; each step's span carries its call's usage, the run's span the sum", async () => {
  const spans: Array<Tracer.NativeSpan> = []
  const billed = (reason: "stop" | "tool-calls", input: { readonly total: number; readonly cacheRead: number; readonly cacheWrite: number }, output: { readonly total: number; readonly reasoning: number }) => ({
    ...finish(reason),
    usage: {
      inputTokens: { ...input, uncached: input.total - input.cacheRead - input.cacheWrite },
      outputTokens: { ...output, text: output.total - output.reasoning },
    },
  })
  const result = await run(runLoop({ system: "sys", messages: [user("echo")], toolkit: kit }).pipe(Effect.withTracer(capturingTracer(spans))), (call) => call === 0
    ? [{ type: "tool-call", id: "c1", name: "echo", params: { value: "x" } }, billed("tool-calls", { total: 1000, cacheRead: 700, cacheWrite: 200 }, { total: 60, reasoning: 40 })]
    : [{ type: "text", text: "done" }, billed("stop", { total: 1500, cacheRead: 900, cacheWrite: 300 }, { total: 80, reasoning: 50 })])
  expect(result.usage).toEqual({ inputTokens: 2500, outputTokens: 140, totalTokens: 2640, cacheReadTokens: 1600, cacheWriteTokens: 500, reasoningTokens: 90 })
  const read = (span: Tracer.NativeSpan | undefined, keys: ReadonlyArray<string>) => keys.map((key) => span?.attributes.get(key))
  const genAi = ["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.reasoning.output_tokens"]
  expect(spans.filter((span) => span.name === "engine.turn").map((span) => read(span, genAi))).toEqual([
    [1000, 60, 700, 200, 40],
    [1500, 80, 900, 300, 50],
  ])
  const runSpan = spans.find((span) => span.name === "engine.run")
  expect(read(runSpan, [
    "engine.usage.input_tokens", "engine.usage.output_tokens", "engine.usage.cache_read_tokens",
    "engine.usage.cache_write_tokens", "engine.usage.reasoning_tokens", "engine.usage.total_tokens",
  ])).toEqual([2500, 140, 1600, 500, 90, 2640])
  // The GenAI names stay on the calls: a backend summing them over the trace counts each call once per level.
  expect([...(runSpan?.attributes.keys() ?? [])].filter((key) => key.startsWith("gen_ai."))).toEqual([])
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

 test("host initial batch executes once before the first provider call", async () => {
  const { events, onEvent } = collect()
  const result = await run(runLoop({
    system: "test", messages: [user("echo")], toolkit: kit, maxSteps: 2,
    initialStep: [{ name: "echo", params: { value: "prepared" } }], onEvent,
  }), () => [{ type: "text", text: "done" }, finish("stop")])
  expect(result.outcome).toBe("ok")
  expect(events.filter(e => e.type === "tool_end")).toHaveLength(1)
  expect(events.filter(e => e.type === "turn_start").map(e => e.turnIndex)).toEqual([0, 1])
  expect(result.newTail.some(m => m.role === "tool")).toBe(true)
})
 test("host batch obeys completion without a provider call", async () => {
  const result = await run(runLoop({
    system: "test", messages: [user("echo")], toolkit: kit,
    initialStep: [{ name: "echo", params: { value: "prepared" } }],
    isComplete: () => Effect.succeed(true), requireCompletion: true,
  }), () => [])
  expect(result.outcome).toBe("ok")
})

 test("continuation hook sees the initial tool result and replaces the provider", async () => {
  const contexts: Array<{ stepIndex: number; messages: readonly { role: string }[] }> = []
  const chosen = await Effect.runPromise(scriptedModel(() => [{ type: "text", text: "chosen" }, finish("stop")]))
  const result = await run(runLoop({ system: "base", messages: [user("echo")], toolkit: kit, maxSteps: 2,
    initialStep: [{ name: "echo", params: { value: "prepared" } }],
    prepareModel: (context) => Effect.sync(() => { contexts.push(context); return { model: chosen, system: Prompt.make("selected instructions") } }),
  }), () => [{ type: "text", text: "wrong provider" }, finish("stop")])
  expect(contexts).toHaveLength(1)
  expect(contexts[0]?.stepIndex).toBe(1)
  expect(contexts[0]?.messages.some(m => m.role === "tool")).toBe(true)
  expect(JSON.stringify(result.newTail)).toContain("chosen")
})
 test("completed initial work does not prepare a continuation model", async () => {
  const calls: number[] = []
  const chosen = await Effect.runPromise(scriptedModel(() => []))
  await run(runLoop({ system: "base", messages: [user("echo")], toolkit: kit,
    initialStep: [{ name: "echo", params: { value: "prepared" } }],
    isComplete: () => Effect.succeed(true), requireCompletion: true,
    prepareModel: () => Effect.sync(() => { calls.push(1); return { model: chosen, system: Prompt.make("chosen") } }),
  }), () => [])
  expect(calls).toHaveLength(0)
})
 test("streaming uses the model chosen by the continuation hook", async () => {
  const chosen = await Effect.runPromise(streamingModel(() => [{ type: "text", text: "streamed selection" }, finish("stop")]))
  const result = await run(runLoop({ system: "base", messages: [user("echo")], toolkit: kit, streaming: true,
    prepareModel: () => Effect.succeed({ model: chosen, system: Prompt.make("selected") }),
  }), () => [{ type: "text", text: "wrong provider" }, finish("stop")])
  expect(JSON.stringify(result.newTail)).toContain("streamed selection")
})
