import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { Data, Deferred, Duration, Effect, Fiber, Layer, Match, Option, Ref, Result, Schema, SchemaGetter, Stream, Tracer } from "effect"
import { CurrentAgentStep, CurrentEmptyResponseTolerance, CurrentTraceContent, Failure, HarnessError, hostNote, mediaFromBase64, ToolCallId } from "@xandreed/core"
import type { AgentMessage, FinishReason, TokenUsage } from "@xandreed/core"
import type { LoopEvent } from "./loop-event.entity.js"
import { DEFAULT_TOOL_CONCURRENCY, DEGENERATE_REPEAT_NUDGE, foldProgress, nextPhase, runLoop } from "./loop.js"
import type { CompactionPlan } from "./loop.js"
import { lengthCorrective, replyCutFailure } from "./response-gate.entity.functions.js"

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
    const text = p.text ?? ""
    return Match.value(p.type).pipe(
      Match.when("text", (): ReadonlyArray<unknown> => {
        const mid = Math.ceil(text.length / 2)
        return [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text.slice(0, mid) },
          { type: "text-delta", id: "t1", delta: text.slice(mid) },
          { type: "text-end", id: "t1" },
        ]
      }),
      Match.when("reasoning", (): ReadonlyArray<unknown> => [
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", delta: text },
        { type: "reasoning-end", id: "r1" },
      ]),
      // Every other part is streamed as it is.
      Match.orElse((): ReadonlyArray<unknown> => [part]),
    )
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

const finish = (reason: FinishReason) => ({
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
    // The loop checks every call's parameters before any call runs: a
    // wrong-shaped set is a malformed response, answered with the corrective,
    // same as a hallucinated name: the turn survives, the model fixes it.
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
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Host note: your previous reply called echo with parameters that do not match its schema"),
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
    expect(result.newTail.filter((m) => m.role === "user")).toEqual([{
      role: "user",
      content: "[Host note: your previous reply called a tool you do not have; its name follows, as you wrote it. "
        + "The tools you can call are: echo. Reply again with one of them, its parameters as its schema gives them, or in plain text if you are done.]\n\n<tool-name>\nnot_a_tool\n</tool-name>",
    }])
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
      (m) => m.role === "user" && m.content === hostNote(DEGENERATE_REPEAT_NUDGE),
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
      "tail 2: assistant",
      "tail 2: tool",
      "settled 2: completed",
      "complete? 2",
      "tail 3: assistant",
      "settled 3: completed",
      "complete? 3",
    ])
  })

  /** A run's record, `[step, role]` for each message `onTail` received, the steps it started, and its tail's roles. */
  const recordOf = async (
    options: { readonly maxSteps?: number; readonly requireCompletion?: boolean; readonly isComplete?: (step: number) => Effect.Effect<boolean> },
    script: (call: number) => ReadonlyArray<unknown>,
  ) => {
    const log: Array<readonly [number, string]> = []
    const started: Array<number> = []
    const result = await run(runLoop({
      system: "sys", messages: [user("go")], toolkit: kit, ...options,
      onEvent: (event) => Effect.sync(() => void (event.type === "turn_start" && started.push(event.turnIndex))),
      onTail: (tail, step) => Effect.sync(() => {
        log.push(...tail.map((m) => [step, m.role] as const))
        return [] as ReadonlyArray<number>
      }),
    }), script)
    return { log, started, reason: result.reason, tail: result.newTail.map((m) => m.role) }
  }
  const echoed = (call: number) => [{ type: "tool-call", id: `c${call}`, name: "echo", params: { value: "same" } }, finish("tool-calls")]

  test("records nothing under a step that never runs: the step cap ends a run with a completion corrective due", async () => {
    const { log, started, reason, tail } = await recordOf(
      { maxSteps: 2, requireCompletion: true, isComplete: () => Effect.succeed(false) },
      () => [{ type: "text", text: "I will" }, finish("stop")],
    )
    expect([reason, started]).toEqual(["step-cap", [0, 1]])
    expect(log).toEqual([[0, "assistant"], [1, "user"], [1, "assistant"]])
    expect(tail).toEqual(["assistant", "user", "assistant"])
  })

  test.each([
    ["the step cap, a malformed corrective due", { maxSteps: 2 }, (call: number) => call === 0
      ? echoed(call)
      : [{ type: "tool-call", id: "m1", name: "not_a_tool", params: {} }, finish("tool-calls")], "step-cap"],
    ["the step cap, a degenerate-loop nudge due", { maxSteps: 4 }, echoed, "step-cap"],
    ["a complete verdict, a degenerate-loop nudge due", { isComplete: (step: number) => Effect.succeed(step >= 3) }, echoed, "completed"],
  ] as const)("records nothing under a step that never runs: %s", async (_name, options, script, reason) => {
    const ran = await recordOf(options, script)
    expect(ran.reason).toBe(reason)
    expect(ran.log.filter(([step]) => !ran.started.includes(step))).toEqual([])
    expect(ran.tail.at(-1)).not.toBe("user")
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

describe("runLoop's callbacks fail with the caller's error", () => {
  class Unrecorded extends Data.TaggedError("Unrecorded")<{ readonly step: number }> {}
  const answers = () => [{ type: "text", text: "done" }, finish("stop")]

  /** The run's failure, caught by its tag: a defect would reject the run instead. */
  const caught = <A, R>(loop: Effect.Effect<A, AiError.AiError | HarnessError | Unrecorded, R>) => loop.pipe(
    Effect.map(() => "completed"),
    Effect.catchTag("Unrecorded", (error) => Effect.succeed(`Unrecorded at ${error.step}`)),
  )

  test("a failure in a step fails it and the run, typed; one after the step settled leaves it completed", async () => {
    const outcome = (fails: "onTail" | "isComplete") => Effect.runPromise(Effect.gen(function* () {
      const settled = yield* Ref.make<ReadonlyArray<string>>([])
      const result = yield* caught(runLoop({
        system: "sys", messages: [user("go")], toolkit: kit,
        onTail: (_tail, step) => fails === "onTail" ? Effect.fail(new Unrecorded({ step })) : Effect.succeed([]),
        onStepSettled: (step, status) => Ref.update(settled, (all) => [...all, `${step}:${status}`]),
        isComplete: (step) => fails === "isComplete" ? Effect.fail(new Unrecorded({ step })) : Effect.succeed(true),
      })).pipe(Effect.provide(handlers), Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel(answers)))
      return { result, settled: yield* Ref.get(settled) }
    }))
    expect(await outcome("onTail")).toEqual({ result: "Unrecorded at 0", settled: ["0:failed"] })
    expect(await outcome("isComplete")).toEqual({ result: "Unrecorded at 0", settled: ["0:completed"] })
  })

  test("a failure of the event sink on a streamed delta fails the step with it: the stream does not fall back", async () => {
    const { result, seen } = await Effect.runPromise(Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const result = yield* caught(runLoop({
        system: "sys", messages: [user("go")], toolkit: kit, streaming: true,
        onEvent: (event) => event.type === "assistant_delta"
          ? Effect.fail(new Unrecorded({ step: event.turnIndex }))
          : Ref.update(seen, (all) => [...all, event.type === "turn_end" ? `turn_end ${event.status}` : event.type]),
      })).pipe(Effect.provide(handlers), Effect.provideServiceEffect(LanguageModel.LanguageModel, streamingModel(answers)))
      return { result, seen: yield* Ref.get(seen) }
    }))
    // `streamingModel` dies on `generateText`: a fallback would reject the run.
    expect(result).toBe("Unrecorded at 0")
    expect(seen).toEqual(["turn_start", "turn_end failed"])
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
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Host note: your previous reply could not be decoded"),
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

test("the run's callbacks read its own step and empty-response tolerance, never an outer run's", async () => {
  const seen = await Effect.runPromise(Effect.gen(function* () {
    const reads = yield* Ref.make<ReadonlyArray<string>>([])
    const read = Effect.all([Effect.service(CurrentAgentStep), Effect.service(CurrentEmptyResponseTolerance)], { concurrency: 1 }).pipe(
      Effect.flatMap(([step, tolerant]) => Ref.update(reads, (all) => [...all, `${Option.getOrElse(step, () => -1)}:${tolerant}`])))
    yield* runLoop({ system: "sys", messages: [user("go")], toolkit: kit, render: () => read.pipe(Effect.as([user("go")])) }).pipe(
      Effect.provide(handlers),
      Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel((call) => call === 0
        ? [{ type: "tool-call", id: "c1", name: "echo", params: { value: "ping" } }, finish("tool-calls")]
        : [{ type: "text", text: "done" }, finish("stop")])),
      // An outer run's step and tolerance, where this run starts.
      Effect.provideService(CurrentAgentStep, Option.some(7)),
      Effect.provideService(CurrentEmptyResponseTolerance, true),
    )
    return yield* Ref.get(reads)
  }))
  expect(seen).toEqual(["0:false", "1:true"])
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

test("each tool call runs under its own loop.tool_call span, its handler's spans under it; without trace content the step's span carries no call's parameters", async () => {
  const spans: Array<Tracer.NativeSpan> = []
  await Effect.runPromise(runLoop({ system: "sys", messages: [user("go")], toolkit: kit }).pipe(
    Effect.provide(kit.toLayer({ echo: ({ value }) => Effect.succeed({ echoed: value }).pipe(Effect.withSpan(`echo.${value}`)) })),
    Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel((call) => call === 0
      ? [{ type: "tool-call", id: "c1", name: "echo", params: { value: "a" } }, { type: "tool-call", id: "c2", name: "echo", params: { value: "b" } }, finish("tool-calls")]
      : [{ type: "text", text: "done" }, finish("stop")])),
    Effect.withTracer(capturingTracer(spans)),
  ))
  const idOf = (span: Tracer.NativeSpan | undefined): string => span?.spanId ?? "missing"
  const parentId = (span: Tracer.NativeSpan | undefined): string => Option.getOrElse(Option.flatMap(Option.fromNullishOr(span), (child) => Option.map(child.parent, (parent) => parent.spanId)), () => "none")
  const steps = spans.filter((span) => span.name === "engine.turn")
  // The step's span: neither effect/ai's annotation of a call (`tool`, `parameters`) nor the step's content.
  expect(steps.map((span) => ["tool", "parameters", "engine.step.input", "engine.step.output"].filter((key) => span.attributes.has(key)))).toEqual([[], []])
  const callSpan = (id: string) => spans.find((span) => span.name === "loop.tool_call" && span.attributes.get("engine.tool.call_id") === id)
  expect(spans.filter((span) => span.name === "loop.tool_call")).toHaveLength(2)
  // Each call's own span, under the step that ran it, holds that call's annotation alone: none overwrites another's.
  expect(["c1", "c2"].map((id) => [callSpan(id)?.attributes.get("engine.tool"), callSpan(id)?.attributes.get("parameters"), parentId(callSpan(id))])).toEqual([
    ["echo", { value: "a" }, idOf(steps[0])],
    ["echo", { value: "b" }, idOf(steps[0])],
  ])
  expect([parentId(spans.find((span) => span.name === "echo.a")), parentId(spans.find((span) => span.name === "echo.b"))]).toEqual([
    idOf(callSpan("c1")), idOf(callSpan("c2")),
  ])
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

describe("the loop's own text, exactly as the model reads it", () => {
  /** A provider whose first reply does not decode, with `description` as the decode error; then it answers in text. */
  const malformedOnce = (description: string) => Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Ref.getAndUpdate(calls, (n) => n + 1).pipe(Effect.flatMap((n) => n === 0
        ? Effect.fail(AiError.make({ module: "Test", method: "generateText", reason: new AiError.InvalidOutputError({ description }) }))
        : Effect.succeed([{ type: "text", text: "fixed" }, finish("stop")]))) as never,
      streamText: () => Stream.die("not scripted") as never,
    })
  })
  const correctiveAfter = (description: string) => Effect.runPromise(runLoop({ system: "sys", messages: [user("go")], toolkit: kit }).pipe(
    Effect.provide(handlers),
    Effect.provideServiceEffect(LanguageModel.LanguageModel, malformedOnce(description)),
    Effect.map((result) => result.newTail.filter((message) => message.role === "user")),
  ))

  /** The user-role messages after a first reply of `part` (a tool call that cannot be used), then a reply in text. */
  const correctiveFor = (part: unknown) => run(runLoop({ system: "sys", messages: [user("go")], toolkit: kit }), (call) => call === 0
    ? [part, finish("tool-calls")]
    : [{ type: "text", text: "fixed" }, finish("stop")]).then((result) => result.newTail.filter((message) => message.role === "user"))

  test("the malformed corrective: a host note with what went wrong and the step's tools; the parameters' report framed and clipped, a decoder's dump never", async () => {
    expect(await correctiveAfter("the reply is not valid JSON")).toEqual([{
      role: "user",
      content: "[Host note: your previous reply could not be decoded, which usually means a tool call's arguments were not valid JSON. "
        + "The tools you can call are: echo. Reply again with one of them, its parameters as its schema gives them, or in plain text if you are done.]",
    }])
    expect(await correctiveFor({ type: "tool-call", id: "c1", name: "echo", params: { wrong: true } })).toEqual([{
      role: "user",
      content: "[Host note: your previous reply called echo with parameters that do not match its schema; what did not match follows, and it may quote your reply. "
        + "The tools you can call are: echo. Reply again with one of them, its parameters as its schema gives them, or in plain text if you are done.]\n\n<parameter-errors>\nMissing key\n  at [\"value\"]\n</parameter-errors>",
    }])
    expect(await correctiveFor({ type: "tool-call", id: "c1", name: "echo", params: { value: 7 } })).toEqual([{
      role: "user",
      content: "[Host note: your previous reply called echo with parameters that do not match its schema; what did not match follows, and it may quote your reply. "
        + "The tools you can call are: echo. Reply again with one of them, its parameters as its schema gives them, or in plain text if you are done.]\n\n<parameter-errors>\nExpected string\n  at [\"value\"]\n</parameter-errors>",
    }])
  })

  test("the degenerate-loop nudge, and the reply of a run the breaker stopped with no text", async () => {
    const result = await run(
      runLoop({ system: "sys", messages: [user("go")], toolkit: kit }),
      () => [{ type: "tool-call", id: "c1", name: "echo", params: { value: "same" } }, finish("tool-calls")],
    )
    expect(result.newTail.filter((message) => message.role === "user")).toEqual([{
      role: "user",
      content: "[Host note: You've called the same tool(s) and gotten the same result several times in a row — you're looping without making progress. "
        + "STOP repeating that call. Take a DIFFERENT concrete action toward the task; if you're genuinely stuck, say what's blocking you and stop.]",
    }])
    expect(result.finalText).toBe("[stopped: repeated the same tool call with no progress — the run was looping]")
  })

  test("the incomplete corrective, after a stop that left the host's required work undone", async () => {
    const { events, onEvent } = collect()
    const result = await run(runLoop({
      system: "sys", messages: [user("deliver")], toolkit: kit, onEvent, requireCompletion: true, maxSteps: 3,
      isComplete: () => Effect.succeed(events.some((event) => event.type === "tool_end" && event.ok)),
    }), (call) => call === 0
      ? [{ type: "text", text: "I will do it" }, finish("stop")]
      : [{ type: "tool-call", id: "c1", name: "echo", params: { value: "delivered" } }, finish("tool-calls")])
    expect(result.newTail.filter((message) => message.role === "user")).toEqual([{
      role: "user",
      content: "[Host note: the host reports that the required work is not complete, so a reply in text does not finish this turn. "
        + "Complete it with the tools you can call; if it cannot be completed, use one of them that reports why, when there is one.]",
    }])
  })
})

describe("runLoop gates each response on its finish reason", () => {
  type EchoHandler = (params: { readonly value: string }, context: Toolkit.HandlerContext<typeof Echo>) => Effect.Effect<{ readonly echoed: string }>
  const echoBack: EchoHandler = ({ value }) => Effect.succeed({ echoed: value })

  /** A prompt's messages as `role: text`, a part other than text by its type. */
  const promptView = (prompt: Prompt.Prompt): ReadonlyArray<string> => prompt.content.map((message) =>
    `${message.role}: ${typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : `<${part.type}>`).join("")}`)

  /** A scripted provider, as `scriptedModel`, that also keeps the view of each request's prompt. */
  const promptedModel = (script: (call: number) => ReadonlyArray<unknown>, prompts: Array<ReadonlyArray<string>>) => Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: (request) => Ref.getAndUpdate(calls, (n) => n + 1).pipe(
        Effect.tap(() => Effect.sync(() => void prompts.push(promptView(request.prompt)))),
        Effect.map((n) => script(n) as never),
      ),
      streamText: () => Stream.die("not scripted") as never,
    })
  })

  /**
   * A run over `script`, settled or streamed: how it ended (its outcome, or the code and message of the
   * HarnessError it failed with), the values the echo handler ran with, `[step, message]` for each message
   * `onTail` received (and `[step, role]` for each), each step's settled status, the run's events, and the
   * view of each settled request's prompt.
   */
  const gated = (
    script: (call: number) => ReadonlyArray<unknown>,
    options: {
      readonly streaming?: boolean
      readonly toolConcurrency?: number
      readonly echo?: EchoHandler
      readonly maxSteps?: number
      readonly compact?: (messages: ReadonlyArray<AgentMessage>, lastTurnUsage: TokenUsage) => Effect.Effect<Option.Option<CompactionPlan>>
      readonly pendingInput?: () => Effect.Effect<Option.Option<string>>
      readonly requireCompletion?: boolean
      readonly isComplete?: (step: number) => Effect.Effect<boolean>
    } = {},
  ) => Effect.runPromise(Effect.gen(function* () {
    const ran: Array<string> = []
    const log: Array<readonly [number, AgentMessage]> = []
    const settled: Array<string> = []
    const prompts: Array<ReadonlyArray<string>> = []
    const { events, onEvent } = collect()
    const result = yield* runLoop({
      system: "sys", messages: [user("go")], toolkit: kit, onEvent, streaming: options.streaming ?? false,
      ...(options.toolConcurrency === undefined ? {} : { toolConcurrency: options.toolConcurrency }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.compact === undefined ? {} : { compact: options.compact }),
      ...(options.pendingInput === undefined ? {} : { pendingInput: options.pendingInput }),
      ...(options.requireCompletion === undefined ? {} : { requireCompletion: options.requireCompletion }),
      ...(options.isComplete === undefined ? {} : { isComplete: options.isComplete }),
      onTail: (tail, step) => Effect.sync(() => {
        log.push(...tail.map((message) => [step, message] as const))
        return [] as ReadonlyArray<number>
      }),
      onStepSettled: (step, status) => Effect.sync(() => void settled.push(`${step}:${status}`)),
    }).pipe(
      Effect.provide(kit.toLayer({
        echo: (params, context) => Effect.sync(() => void ran.push(params.value)).pipe(Effect.andThen((options.echo ?? echoBack)(params, context))),
      })),
      Effect.provideServiceEffect(LanguageModel.LanguageModel, options.streaming === true ? streamingModel(script) : promptedModel(script, prompts)),
      Effect.result,
    )
    const end = Result.match(result, {
      onSuccess: (done) => ({ outcome: done.outcome, reason: done.reason, finalText: done.finalText }),
      onFailure: (error) => Match.valueTags(error, {
        HarnessError: (harness) => ({ code: harness.code, message: harness.message }),
        AiError: (ai) => ({ aiError: ai.message }),
      }),
    })
    const tail = Result.match(result, { onFailure: (): ReadonlyArray<AgentMessage> => [], onSuccess: (done) => done.newTail })
    return { end, ran, log, tail, settled, events, prompts, roles: log.map(([step, message]) => [step, message.role] as const) }
  }))

  const echoCall = (id: string, params: unknown) => ({ type: "tool-call", id, name: "echo", params })
  /** An echo call's result as the tail records it. */
  const echoResult = (id: string, output: unknown, isError: boolean) => ({ type: "tool-result" as const, toolCallId: ToolCallId.make(id), toolName: "echo", output, isError })
  const answers = [{ type: "text", text: "done" }, finish("stop")]
  const toolStarts = (events: ReadonlyArray<LoopEvent>) => events.filter((event) => event.type === "tool_start")
  const userMessages = (log: ReadonlyArray<readonly [number, AgentMessage]>) => log.filter(([, message]) => message.role === "user")
  const toolMessages = (log: ReadonlyArray<readonly [number, AgentMessage]>) => log.filter(([, message]) => message.role === "tool")

  test("a reply cut at the output limit runs none of its calls: each is answered as cut, the step settles truncated, the next step reads the corrective", async () => {
    const gate = await gated((call) => call === 0
      // The second call's parameters do not decode: a cut reply's calls are answered as cut, never checked.
      ? [{ type: "text", text: "I will echo" }, echoCall("c1", { value: "a" }), echoCall("c2", { wrong: true }), finish("length")]
      : answers)
    expect(gate.ran).toEqual([])
    expect(toolStarts(gate.events)).toEqual([])
    expect(gate.settled).toEqual(["0:truncated", "1:completed"])
    expect(gate.roles).toEqual([[0, "assistant"], [0, "tool"], [0, "tool"], [1, "user"], [1, "assistant"]])
    expect(toolMessages(gate.log)).toEqual([[0, { role: "tool", content: [
      echoResult("c1", { error: "ReplyCut", message: "Your reply reached the output limit, so this call was not run. Call it again if you still need it." }, true),
    ] }], [0, { role: "tool", content: [
      echoResult("c2", { error: "ReplyCut", message: "Your reply reached the output limit, so this call was not run. Call it again if you still need it." }, true),
    ] }]])
    expect(userMessages(gate.log)).toEqual([[1, { role: "user", content: "[Host note: your previous reply reached the output limit and was cut short, so the tool calls it made were not run: their results say so. Call the tools you still need again, fewer in one reply and with less text before them.]" }]])
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "done" })
  })

  test("a reply in text cut at the output limit is asked to continue, and the run's text is that reply's followed by the next one's", async () => {
    const gate = await gated((call) => call === 0 ? [{ type: "text", text: "The first half" }, finish("length")] : [{ type: "text", text: "the rest" }, finish("stop")])
    expect(gate.settled).toEqual(["0:truncated", "1:completed"])
    expect(userMessages(gate.log)).toEqual([[1, { role: "user", content: "[Host note: your previous reply reached the output limit and was cut short. Continue from where it stopped, in replies short enough to finish.]" }]])
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "The first halfthe rest" })
  })

  test("two replies in text cut at the output limit, then a stop: the run's text is the three in order", async () => {
    const gate = await gated((call) => [
      [{ type: "text", text: "One, " }, finish("length")],
      [{ type: "text", text: "two, " }, finish("length")],
    ][call] ?? [{ type: "text", text: "three." }, finish("stop")])
    expect(gate.settled).toEqual(["0:truncated", "1:truncated", "2:completed"])
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "One, two, three." })
  })

  test("a reply cut at the output limit that held calls is not carried: the next reply is a new one", async () => {
    const gate = await gated((call) => call === 0
      ? [{ type: "text", text: "Calling echo" }, echoCall("c1", { value: "a" }), finish("length")]
      : [{ type: "text", text: "done anew" }, finish("stop")])
    expect(userMessages(gate.log)).toEqual([[1, { role: "user", content: lengthCorrective(true) }]])
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "done anew" })
  })

  test("the step cap ending a run while text is carried: the run's text holds it", async () => {
    const cutAtCap = await gated((call) => [{ type: "text", text: call === 0 ? "One, " : "two" }, finish("length")], { maxSteps: 2 })
    expect(cutAtCap.settled).toEqual(["0:truncated", "1:truncated"])
    expect(cutAtCap.end).toEqual({ outcome: "partial", reason: "step-cap", finalText: "One, two" })
    const pausedAtCap = await gated((call) => [{ type: "text", text: call === 0 ? "Part one, " : "part two" }, finish("pause")], { maxSteps: 2 })
    expect(pausedAtCap.end).toEqual({ outcome: "partial", reason: "step-cap", finalText: "Part one, part two" })
    // A malformed reply at the cap: the carried text alone.
    const malformedAtCap = await gated((call) => call === 0
      ? [{ type: "text", text: "The first half" }, finish("length")]
      : [{ type: "tool-call", id: "m1", name: "not_a_tool", params: {} }, finish("tool-calls")], { maxSteps: 2 })
    expect(malformedAtCap.settled).toEqual(["0:truncated", "1:malformed"])
    expect(malformedAtCap.end).toEqual({ outcome: "partial", reason: "step-cap", finalText: "The first half" })
  })

  test("a reply cut at the output limit, answered: the next step's input is compacted and steered as after any step", async () => {
    const compacted: Array<readonly [ReadonlyArray<string>, number]> = []
    const steers = ["the host's steer"]
    const gate = await gated((call) => call === 0 ? [{ type: "text", text: "The first half" }, finish("length")] : answers, {
      // Fold everything before the cut reply.
      compact: (messages, lastTurnUsage) => Effect.sync(() => {
        compacted.push([messages.map((message) => message.role), lastTurnUsage.inputTokens])
        return Option.some({ summary: "THE MID-RUN SUMMARY", keepFrom: messages.findIndex((message) => message.role === "assistant") })
      }),
      pendingInput: () => Effect.sync(() => Option.fromNullishOr(steers.shift())),
    })
    // Consulted over the buffer the next step would send (the corrective last), with the cut step's usage.
    expect(compacted).toEqual([[["user", "assistant", "user"], 10]])
    expect(gate.events.flatMap((event) => event.type === "compaction" ? [[event.turnIndex, event.tokens, event.kept]] : [])).toEqual([[0, 10, 2]])
    // The steer lands after the corrective, both recorded under the next step.
    expect(userMessages(gate.log)).toEqual([[1, { role: "user", content: lengthCorrective(false) }], [1, { role: "user", content: "the host's steer" }]])
    // The next request: the summary in place of the user's first message, the cut reply kept, the corrective, then the steer.
    const [system, summary, ...kept] = gate.prompts[1] ?? []
    expect(system).toBe("system: sys")
    expect(summary).toContain("THE MID-RUN SUMMARY")
    expect(kept).toEqual(["assistant: The first half", `user: ${lengthCorrective(false)}`, "user: the host's steer"])
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "The first halfdone" })
  })

  test("a third reply in a row cut at the output limit fails the run with loop.truncated, after two correctives", async () => {
    const gate = await gated(() => [{ type: "text", text: "cut" }, finish("length")])
    expect(gate.end).toEqual({ code: "loop.truncated", message: "the model's replies reached the output limit 3 times in a row, the last at step 2, after 2 correctives" })
    expect(gate.settled).toEqual(["0:truncated", "1:truncated", "2:truncated"])
    expect(gate.roles).toEqual([[0, "assistant"], [1, "user"], [1, "assistant"], [2, "user"], [2, "assistant"]])
    expect(userMessages(gate.log)).toEqual([[1, { role: "user", content: lengthCorrective(false) }], [2, { role: "user", content: lengthCorrective(false) }]])
  })

  test("a whole response resets the count of cuts in a row", async () => {
    const cut = [{ type: "text", text: "cut" }, finish("length")]
    const gate = await gated((call) => [cut, cut, [echoCall("c1", { value: "x" }), finish("tool-calls")], cut, cut][call] ?? answers)
    expect(gate.settled).toEqual(["0:truncated", "1:truncated", "2:completed", "3:truncated", "4:truncated", "5:completed"])
    expect(userMessages(gate.log).map(([step]) => step)).toEqual([1, 2, 4, 5])
    // The whole response ends the first continuation ("cutcut"), which the last one's two cuts and its stop continue.
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "cutcutdone" })
  })

  test("a malformed reply between cuts at the output limit resets the count of cuts in a row, and a cut one the count of malformed ones", async () => {
    const cut = (call: number) => [echoCall(`c${call}`, { value: "x" }), finish("length")]
    const malformed = (call: number) => [{ type: "tool-call", id: `m${call}`, name: "not_a_tool", params: {} }, finish("tool-calls")]
    // A third cut, not in a row: the run goes on.
    const cuts = await gated((call) => [cut, cut, malformed, cut][call]?.(call) ?? answers)
    expect(cuts.settled).toEqual(["0:truncated", "1:truncated", "2:malformed", "3:truncated", "4:completed"])
    expect(cuts.end).toEqual({ outcome: "ok", reason: "completed", finalText: "done" })
    // A third malformed reply, not in a row: the run goes on.
    const malformedOnes = await gated((call) => [malformed, malformed, cut, malformed, malformed][call]?.(call) ?? answers)
    expect(malformedOnes.settled).toEqual(["0:malformed", "1:malformed", "2:truncated", "3:malformed", "4:malformed", "5:completed"])
    expect(malformedOnes.end).toEqual({ outcome: "ok", reason: "completed", finalText: "done" })
  })

  test("a provider-executed call alone in a reply cut at the output limit: no ReplyCut result, and the corrective for a reply in text", async () => {
    const gate = await gated((call) => call === 0
      ? [{ type: "text", text: "Searching" }, { type: "tool-call", id: "p1", name: "web_search", params: { query: "x" }, providerExecuted: true }, finish("length")]
      : answers)
    expect(gate.settled).toEqual(["0:truncated", "1:completed"])
    expect(toolMessages(gate.log)).toEqual([])
    expect(userMessages(gate.log)).toEqual([[1, { role: "user", content: lengthCorrective(false) }]])
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "Searchingdone" })
  })

  test("a reply with no finish reason from the provider: one in text, or an empty one after tool calls, completes; one holding a call is cut", async () => {
    const text = await gated(() => [{ type: "text", text: "no finish" }])
    expect(text.settled).toEqual(["0:completed"])
    expect(text.end).toEqual({ outcome: "ok", reason: "completed", finalText: "no finish" })
    const empty = await gated((call) => call === 0 ? [echoCall("c1", { value: "a" }), finish("tool-calls")] : [])
    expect(empty.ran).toEqual(["a"])
    expect(empty.settled).toEqual(["0:completed", "1:completed"])
    expect(empty.end).toEqual({ outcome: "ok", reason: "completed", finalText: "" })
    const calls = await gated(() => [echoCall("c1", { value: "a" })])
    expect(calls.ran).toEqual([])
    expect(calls.settled).toEqual(["0:truncated"])
    expect(calls.end).toEqual({ code: "loop.truncated", message: "the model's reply at step 0 ended before the provider said it was complete" })
  })

  test.each([
    ["content-filter", "the model's reply at step 0 was stopped by the provider's content filter"],
    ["error", "the model's reply at step 0 was cut off by an error at the provider"],
    ["other", "the model's reply at step 0 was cut short for a reason the provider did not name"],
    ["unknown", "the model's reply at step 0 ended before the provider said it was complete"],
  ] as const)("a reply cut by %s fails the run at once with loop.truncated, its calls unrun", async (reason, message) => {
    const gate = await gated(() => [echoCall("c1", { value: "a" }), finish(reason)])
    expect(gate.end).toEqual({ code: "loop.truncated", message })
    expect(gate.ran).toEqual([])
    expect(gate.settled).toEqual(["0:truncated"])
    expect(gate.events.filter((event) => event.type === "turn_start")).toHaveLength(1)
    expect(toolMessages(gate.log)).toEqual([[0, { role: "tool", content: [
      echoResult("c1", replyCutFailure(reason), true),
    ] }]])
    expect(userMessages(gate.log)).toEqual([])
  })

  test("a streamed reply cut at the output limit runs none of its two calls", async () => {
    const gate = await gated((call) => call === 0
      ? [{ type: "text", text: "two calls" }, echoCall("c1", { value: "a" }), echoCall("c2", { value: "b" }), finish("length")]
      : answers, { streaming: true })
    expect(gate.ran).toEqual([])
    expect(toolStarts(gate.events)).toEqual([])
    expect(gate.events.some((event) => event.type === "stream_fallback")).toBe(false)
    expect(gate.settled).toEqual(["0:truncated", "1:completed"])
    expect(toolMessages(gate.log)).toEqual([[0, { role: "tool", content: [
      echoResult("c1", replyCutFailure("length"), true),
    ] }], [0, { role: "tool", content: [
      echoResult("c2", replyCutFailure("length"), true),
    ] }]])
    expect(userMessages(gate.log)).toEqual([[1, { role: "user", content: lengthCorrective(true) }]])
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "done" })
  })

  test("a paused reply continues to the next step, and the run's text is that reply's followed by the next one's", async () => {
    const gate = await gated((call) => call === 0 ? [{ type: "text", text: "Part one, " }, finish("pause")] : [{ type: "text", text: "part two." }, finish("stop")])
    expect(gate.settled).toEqual(["0:completed", "1:completed"])
    expect(gate.roles).toEqual([[0, "assistant"], [1, "assistant"]])
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "Part one, part two." })
  })

  test("a paused reply under requireCompletion gets no completion corrective: the next request ends on it, and the run's text is both parts", async () => {
    const gate = await gated((call) => call === 0 ? [{ type: "text", text: "Part one, " }, finish("pause")] : [{ type: "text", text: "part two." }, finish("stop")], {
      requireCompletion: true,
      // The host's work is not complete after the paused reply, only after the one that finishes it.
      isComplete: (step) => Effect.succeed(step >= 1),
    })
    expect(gate.settled).toEqual(["0:completed", "1:completed"])
    expect(userMessages(gate.log)).toEqual([])
    expect(gate.prompts[1]).toEqual(["system: sys", "user: go", "assistant: Part one, "])
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "Part one, part two." })
  })

  test.each([
    ["has parameters that do not decode", { value: 7 }, "echo", "[Host note: your previous reply called echo with parameters that do not match its schema; what did not match follows, and it may quote your reply. "
      + "The tools you can call are: echo. Reply again with one of them, its parameters as its schema gives them, or in plain text if you are done.]\n\n<parameter-errors>\nExpected string\n  at [\"value\"]\n</parameter-errors>"],
    ["names a tool the step does not have", { value: "b" }, "not_a_tool", "[Host note: your previous reply called a tool you do not have; its name follows, as you wrote it. "
      + "The tools you can call are: echo. Reply again with one of them, its parameters as its schema gives them, or in plain text if you are done.]\n\n<tool-name>\nnot_a_tool\n</tool-name>"],
    ["is named constructor, which the step's tools inherit as an object but is no tool", {}, "constructor", "[Host note: your previous reply called a tool you do not have; its name follows, as you wrote it. "
      + "The tools you can call are: echo. Reply again with one of them, its parameters as its schema gives them, or in plain text if you are done.]\n\n<tool-name>\nconstructor\n</tool-name>"],
  ] as const)("a whole response whose second call %s runs neither call and is answered as malformed", async (_what, params, name, corrective) => {
    const gate = await gated((call) => call === 0
      ? [echoCall("c1", { value: "fine" }), { type: "tool-call", id: "c2", name, params }, finish("tool-calls")]
      : [{ type: "text", text: "fixed" }, finish("stop")])
    expect(gate.ran).toEqual([])
    expect(toolStarts(gate.events)).toEqual([])
    expect(gate.settled).toEqual(["0:malformed", "1:completed"])
    // Nothing of the malformed step is recorded: the corrective and the next reply are step 1's.
    expect(gate.roles).toEqual([[1, "user"], [1, "assistant"]])
    expect(userMessages(gate.log)).toEqual([[1, { role: "user", content: corrective }]])
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "fixed" })
  })

  test.each([
    [1, 1],
    [2, 2],
    [undefined, DEFAULT_TOOL_CONCURRENCY],
  ] as const)("a whole response's calls run with toolConcurrency %p (%p at once), their results in call order", async (toolConcurrency, atOnce) => {
    const values = ["a", "b", "c", "d", "e"]
    const inFlight = { now: 0, most: 0 }
    // The later a call, the sooner it ends: the results come back out of order.
    const gate = await gated((call) => call === 0 ? [...values.map((value, n) => echoCall(`c${n}`, { value })), finish("tool-calls")] : answers, {
      ...(toolConcurrency === undefined ? {} : { toolConcurrency }),
      echo: ({ value }) => Effect.sync(() => {
        inFlight.now = inFlight.now + 1
        inFlight.most = Math.max(inFlight.most, inFlight.now)
      }).pipe(
        Effect.andThen(Effect.sleep(Duration.millis((values.length - values.indexOf(value)) * 5))),
        Effect.andThen(Effect.sync(() => {
          inFlight.now = inFlight.now - 1
        })),
        Effect.as({ echoed: value }),
      ),
    })
    expect(inFlight.most).toBe(atOnce)
    expect(gate.ran).toEqual(values)
    expect(gate.tail.flatMap((message) => message.role === "tool" ? message.content.map((part) => [part.toolCallId, part.output]) : [])).toEqual(
      values.map((value, n) => [`c${n}`, { echoed: value }]),
    )
    expect(gate.end).toEqual({ outcome: "ok", reason: "completed", finalText: "done" })
  })

  test("a tool that reports preliminary results is answered with its final one alone", async () => {
    const gate = await gated((call) => call === 0 ? [echoCall("c1", { value: "ping" }), finish("tool-calls")] : answers, {
      echo: ({ value }, context) => context.preliminary({ echoed: "working" }).pipe(
        Effect.andThen(context.preliminary({ echoed: "almost" })),
        Effect.as({ echoed: value }),
      ),
    })
    expect(toolMessages(gate.log)).toEqual([[0, { role: "tool", content: [
      echoResult("c1", { echoed: "ping" }, false),
    ] }]])
    expect(gate.events.flatMap((event) => event.type === "tool_end" ? [event.result] : [])).toEqual([{ echoed: "ping" }])
  })

  test("each assistant_message carries its response's finish reason", async () => {
    const gate = await gated((call) => [
      [echoCall("c1", { value: "a" }), finish("tool-calls")],
      [{ type: "text", text: "cut" }, finish("length")],
      [{ type: "text", text: "Part one" }, finish("pause")],
    ][call] ?? answers)
    expect(gate.events.flatMap((event) => event.type === "assistant_message" ? [event.finishReason] : [])).toEqual(["tool-calls", "length", "pause", "stop"])
    expect(gate.events.flatMap((event) => event.type === "turn_end" ? [event.status] : [])).toEqual(["completed", "truncated", "completed", "completed"])
  })
})

describe("the loop checks a call's parameters as the toolkit decodes them", () => {
  // A tool whose parameters decode in an Effect (asynchronously), as effect/ai's toolkit allows.
  const Later = Tool.make("later", {
    description: "Echo a value decoded later.",
    parameters: Schema.Struct({
      value: Schema.String.pipe(Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transformEffect((text: string) => Effect.succeed(text).pipe(Effect.delay("1 millis"))),
        encode: SchemaGetter.transform((text: string) => text),
      })),
    }),
    success: Schema.String,
  })
  const laterKit = Toolkit.make(Later)
  const laterHandlers = laterKit.toLayer({ later: ({ value }) => Effect.succeed(`got ${value}`) })

  test("a whole response calling a tool whose parameters decode asynchronously runs it, and the run goes on", async () => {
    const result = await Effect.runPromise(runLoop({ system: "sys", messages: [{ role: "user", content: "go" }], toolkit: laterKit }).pipe(
      Effect.provide(laterHandlers),
      Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel((call) => call === 0
        ? [{ type: "tool-call", id: "c1", name: "later", params: { value: "x" }, providerExecuted: false }, { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }]
        : [{ type: "text", text: "done" }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }])),
    ))
    expect(result.finalText).toBe("done")
    expect(result.newTail.some((message) => message.role === "tool")).toBe(true)
  })
})

describe("durable tool-call boundaries", () => {
  test("records the response before handlers and each result while another call is still held", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const slowStarted = yield* Deferred.make<void>()
      const fastStored = yield* Deferred.make<void>()
      const persisted = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
      const sawAssistant = yield* Ref.make<ReadonlyArray<boolean>>([])
      const own = kit.toLayer({ echo: ({ value }) => Effect.gen(function* () {
        const stored = yield* Ref.get(persisted)
        yield* Ref.update(sawAssistant, (all) => [...all, stored.some((message) => message.role === "assistant")])
        if (value === "slow") {
          yield* Deferred.succeed(slowStarted, undefined)
          yield* Deferred.await(release)
        } else yield* Deferred.await(slowStarted)
        return { echoed: value }
      }) })
      const running = yield* runLoop({
        system: "sys", messages: [user("go")], toolkit: kit, toolConcurrency: 2,
        onTail: (messages) => Ref.update(persisted, (all) => [...all, ...messages]).pipe(
          Effect.andThen(messages.some((message) => message.role === "tool" && message.content.some((part) => part.toolCallId === "fast"))
            ? Deferred.succeed(fastStored, undefined) : Effect.void), Effect.as([]),
        ),
      }).pipe(
        Effect.provide(own),
        Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel((n) => n === 0 ? [
          { type: "tool-call", id: "slow", name: "echo", params: { value: "slow" } },
          { type: "tool-call", id: "fast", name: "echo", params: { value: "fast" } },
          finish("tool-calls"),
        ] : [{ type: "text", text: "done" }, finish("stop")])), Effect.forkChild,
      )
      const early = yield* Deferred.await(fastStored).pipe(Effect.timeoutOption("1 second"))
      const before = yield* Ref.get(persisted)
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(running)
      return { early, before, saw: yield* Ref.get(sawAssistant), persisted: yield* Ref.get(persisted), result }
    })))
    expect(Option.isSome(observed.early)).toBe(true)
    expect(observed.saw).toEqual([true, true])
    expect(observed.before.flatMap((message) => message.role === "tool" ? message.content.map((part) => String(part.toolCallId)) : [])).toEqual(["fast"])
    expect(observed.persisted.flatMap((message) => message.role === "tool" ? message.content.map((part) => String(part.toolCallId)) : [])).toEqual(["fast", "slow"])
    expect(observed.result.newTail.flatMap((message) => message.role === "tool" ? message.content.map((part) => String(part.toolCallId)) : [])).toEqual(["slow", "fast"])
  })

  test("a response persistence failure prevents every handler and settles the step failed", async () => {
    const ran: Array<string> = []
    const settled: Array<string> = []
    const result = await Effect.runPromise(runLoop({
      system: "sys", messages: [user("go")], toolkit: kit,
      onTail: () => Effect.fail("the store refused the response"),
      onStepSettled: (_, status) => Effect.sync(() => { settled.push(status) }),
    }).pipe(
      Effect.provide(kit.toLayer({ echo: ({ value }) => Effect.sync(() => { ran.push(value); return { echoed: value } }) })),
      Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel(() => [
        { type: "tool-call", id: "c1", name: "echo", params: { value: "a" } }, finish("tool-calls"),
      ])), Effect.result,
    ))
    expect(result).toEqual(Result.fail("the store refused the response"))
    expect(ran).toEqual([])
    expect(settled).toEqual(["failed"])
  })
})

test("a whole response with duplicate tool-call ids runs none of its calls and asks for unambiguous calls", async () => {
  const ran: Array<string> = []
  const recorded: Array<AgentMessage> = []
  const result = await Effect.runPromise(runLoop({
    system: "sys", messages: [user("go")], toolkit: kit,
    onTail: (tail) => Effect.sync(() => { recorded.push(...tail); return [] }),
  }).pipe(
    Effect.provide(kit.toLayer({ echo: ({ value }) => Effect.sync(() => { ran.push(value); return { echoed: value } }) })),
    Effect.provideServiceEffect(LanguageModel.LanguageModel, scriptedModel((n) => n === 0 ? [
      { type: "tool-call", id: "same", name: "echo", params: { value: "a" } },
      { type: "tool-call", id: "same", name: "echo", params: { value: "b" } },
      finish("tool-calls"),
    ] : [{ type: "text", text: "done" }, finish("stop")])),
  ))
  expect(ran).toEqual([])
  expect(recorded[0]).toEqual({ role: "user", content: "[Host note: your previous reply reused one id for multiple tool calls, so none ran. Reply again with a separate call for each action. The tools you can call are: echo.]" })
  expect(result.finalText).toBe("done")
})
