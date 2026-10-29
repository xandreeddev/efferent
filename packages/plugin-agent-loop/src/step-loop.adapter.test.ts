import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Prompt, Toolkit } from "effect/ai"
import type { Tool } from "effect/ai"
import { Cause, Context, Effect, Option, Ref, Stream } from "effect"
import { addUsage, ConversationId, CurrentAgentStep, CurrentPromptCacheKey, CurrentTraceContent, extractUsage, harnessError, HarnessError, isTurnError, makeTurnEvents, makeTurnTasks, reasonOf, responseText, responseToAgentMessages, responseToolCalls, StepLoop, stepLoopConformance, toPromptMessages, TurnClosed, zeroUsage } from "@xandreed/core"
import type { CompletionVerdict, RunResult, RunTools, StepInfo, StepRequest, TokenUsage, TurnError, TurnEvent } from "@xandreed/core"
import { runSteps, STEP_LOOP } from "./step-loop.adapter.js"

/**
 * The smallest loop that honours the StepLoop contract, written directly on
 * @effect/ai: proof that the kit checks the contract, not runLoop's shape.
 */
const minimalLoop = StepLoop.of({
  id: "minimal", version: "1",
  run: (request: StepRequest) => Effect.gen(function* () {
    const handlers = request.handlers as Context.Context<Tool.HandlersFor<Record<string, Tool.Any>>>
    const model = yield* Effect.orDie(Effect.fromOption(Context.getOption(request.handlers, LanguageModel.LanguageModel)))
    const toolkit = yield* request.tools.toolkit.pipe(Effect.provide(handlers))
    const evaluate = (info: StepInfo): Effect.Effect<CompletionVerdict, TurnError> => request.completion(info).pipe(
      Effect.tap((verdict) => request.events.publish({ _tag: "completion.evaluated", step: info.stepIndex, verdict })))
    const step = (index: number, text: string, usage: TokenUsage): Effect.Effect<RunResult, TurnError> => Effect.gen(function* () {
      if (index >= request.limits.maxSteps) return { outcome: "partial", reason: "step-cap", text, steps: index, usage } satisfies RunResult
      const activeTools = yield* request.tools.active
      const info: StepInfo = { stepIndex: index, activeTools, lastUsage: Option.none() }
      const planned = index === 0 ? request.initial : Option.none()
      yield* request.events.publish({ _tag: "step.started", step: index, planned: Option.isSome(planned), activeTools })
      // One attempt: plan, check the dispatch, call. A refusal over an image is attempted once more after
      // onMediaRejected answers true.
      const attempt = Effect.gen(function* () {
        const plan = Option.isSome(planned) ? Option.none() : Option.some(yield* request.plan(info))
        const provider = Option.isSome(planned)
          ? yield* LanguageModel.make({
            generateText: () => Effect.succeed([
              ...planned.value.calls.map((call, position) => ({ type: "tool-call" as const, id: `planned:${position}`, name: call.name, params: call.params, providerExecuted: false })),
              { type: "finish" as const, reason: "tool-calls" as const, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } },
            ]),
            streamText: () => Stream.empty,
          })
          : Option.getOrElse(Option.flatMap(plan, (value) => value.model), () => model)
        const prompt = Option.match(plan, {
          onNone: () => Prompt.empty,
          onSome: (value) => Prompt.concat(Prompt.make([{ role: "system", content: value.system }]), Prompt.make(toPromptMessages(value.messages) as Prompt.RawInput)),
        })
        const toolChoice = Option.flatMap(plan, (value) => value.toolChoice)
        if (Option.isSome(plan)) yield* request.dispatch(index, {
          prompt, tools: Object.values(toolkit.tools), toolChoice: Option.getOrElse(toolChoice, () => "auto"), model: provider,
        })
        // The tools declare no dependencies: the call needs no services (`Tool.Any` widens them to `any`).
        const generated: Effect.Effect<{ readonly content: ReadonlyArray<unknown> }, unknown> = provider.generateText({ prompt, toolkit, ...Option.match(toolChoice, { onNone: () => ({}), onSome: (choice) => ({ toolChoice: choice }) }) }) as never
        return yield* generated.pipe(
          // The run's trace content switch, for the model call to read.
          Effect.provideService(CurrentTraceContent, request.captureTraceContent),
          Effect.provide(handlers),
          Effect.provideService(CurrentAgentStep, Option.some(index)),
        )
      })
      const response = yield* attempt.pipe(
        Effect.catch((error) => !Option.isSome(planned) && AiError.isAiError(error) && error.reason._tag === "InvalidRequestError" && /image/i.test(error.reason.message)
          ? request.onMediaRejected(error.reason.message).pipe(Effect.flatMap((retry) => retry ? attempt : Effect.fail(error)))
          : Effect.fail(error)),
        Effect.mapError((error) => isTurnError(error) ? error : harnessError("loop.failed", reasonOf(Cause.fail(error)), error)),
      )
      const content: ReadonlyArray<unknown> = response.content
      const entries = yield* request.record(index, responseToAgentMessages(content))
      const used = extractUsage(undefined, content)
      const total = addUsage(usage, used)
      yield* request.events.publish({
        _tag: "assistant.message", step: index, text: responseText(content), reasoning: "", model: Option.none(),
        toolCalls: responseToolCalls(content).map((call) => ({ id: call.id, tool: call.toolName, input: call.args })), usage: used,
      })
      yield* request.events.publish({ _tag: "step.ended", step: index, status: "completed", results: entries.flatMap((entry) =>
        entry.body._tag === "ToolResult" ? [{ entry: entry.id, toolCallId: entry.body.toolCallId, tool: entry.body.toolName, ok: !entry.body.isError }] : []) })
      const first = yield* evaluate(info)
      const verdict = first.complete || first.awaiting.length === 0 ? first : yield* request.tasks.await(first.awaiting).pipe(Effect.andThen(evaluate(info)))
      const reply = responseText(content).length > 0 ? responseText(content) : text
      if (verdict.complete || responseToolCalls(content).length === 0) return { outcome: "completed", reason: "completed", text: reply, steps: index + 1, usage: total } satisfies RunResult
      return yield* step(index + 1, reply, total)
    })
    // The request's cache key, for the dispatch check and the model calls to read.
    return yield* step(0, "", zeroUsage).pipe(Effect.provideService(CurrentPromptCacheKey, request.cacheKey))
  }),
})

const conform = (name: string, loop: Context.Service.Shape<typeof StepLoop>) => describe(`${name} conforms to StepLoop`, () => {
  stepLoopConformance(loop).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

conform("StepLoopLive", StepLoop.of({ ...STEP_LOOP, run: runSteps }))
conform("a minimal loop", minimalLoop)

/** One run of `runSteps` over a model, no tools, a record that keeps nothing: the bus events and the trace content switch the model saw. */
const runWith = (model: LanguageModel.LanguageModel, options: {
  readonly streaming: boolean
  readonly captureTraceContent: boolean
  readonly steps?: number
  /** A subscriber that fails the turn with `error` on the first event of this kind. */
  readonly failOn?: { readonly tag: TurnEvent["_tag"]; readonly error: TurnError }
}) => Effect.scoped(Effect.gen(function* () {
  const events = yield* makeTurnEvents({ maxDepth: 8 })
  const tasks = yield* makeTurnTasks(yield* Effect.scope)
  const seen = yield* Ref.make<ReadonlyArray<TurnEvent>>([])
  yield* events.subscribe(Option.some, (event: TurnEvent) => Ref.update(seen, (all) => [...all, event]).pipe(
    Effect.andThen(options.failOn !== undefined && event._tag === options.failOn.tag ? Effect.fail(options.failOn.error) : Effect.void)))
  const tools: RunTools = {
    toolkit: Toolkit.empty, handlers: Context.empty(), active: Effect.succeed([]), activate: () => Effect.succeed([]),
    match: (userMessage) => Effect.succeed({ userMessage, skills: [], probabilities: Option.none(), record: Option.none() }),
    apply: () => Effect.succeed([]), select: () => Effect.succeed([]),
    views: {
      view: (_tool, encoded) => Effect.succeed({ text: String(encoded), version: "1", subjects: [], artifacts: [], pinned: false }),
      compact: () => Effect.succeed(Option.none()),
      digest: () => Effect.succeed(Option.none()),
    },
    pollable: [], skills: [],
  }
  const steps = options.steps ?? 1
  const result = yield* runSteps({
    tools,
    handlers: Context.make(LanguageModel.LanguageModel, model) as Context.Context<never>,
    limits: { maxSteps: 6, toolConcurrency: 1, streaming: options.streaming, requireCompletion: false },
    initial: Option.none(),
    plan: () => Effect.succeed({ model: Option.none(), system: "sys", messages: [{ role: "user", content: "go" }], toolChoice: Option.none() }),
    dispatch: () => Effect.void,
    record: () => Effect.succeed([]),
    onMediaRejected: () => Effect.succeed(false),
    // Complete after `steps` steps; a model stop ends the run earlier.
    completion: (info) => Effect.succeed({ complete: info.stepIndex + 1 >= steps, awaiting: [], facts: {} }),
    steering: Effect.succeed(Option.none()),
    correctives: Option.none(),
    events,
    tasks,
    cacheKey: Option.none(),
    captureTraceContent: options.captureTraceContent,
  })
  return { result, events: yield* Ref.get(seen) }
}))

/** A model whose stream dies at once, and whose `generateText` answers and records the trace content switch it saw. */
const unstreamable = (reads: Ref.Ref<ReadonlyArray<boolean>>) => LanguageModel.make({
  generateText: () => Effect.service(CurrentTraceContent).pipe(
    Effect.tap((capture) => Ref.update(reads, (all) => [...all, capture])),
    Effect.as([{ type: "text" as const, text: "answer" }, { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: { total: 4 }, outputTokens: { total: 2 } } }]),
  ),
  streamText: () => Stream.die("the gateway closed the stream"),
})

describe("runSteps streaming", () => {
  test("a stream that fails before its first part publishes stream.fallback once, and the run completes without streaming", async () => {
    const { result, events } = await Effect.runPromise(Effect.gen(function* () {
      const reads = yield* Ref.make<ReadonlyArray<boolean>>([])
      return yield* runWith(yield* unstreamable(reads), { streaming: true, captureTraceContent: false })
    }))
    expect(result.outcome).toBe("completed")
    expect(result.text).toBe("answer")
    const fallbacks = events.filter((event) => event._tag === "stream.fallback")
    expect(fallbacks).toEqual([{ _tag: "stream.fallback", step: 0, message: expect.stringContaining("the gateway closed the stream") }])
    // Inside its step: after step.started, before the step's assistant.message.
    const tags = events.map((event) => event._tag)
    expect(tags.indexOf("step.started")).toBeLessThan(tags.indexOf("stream.fallback"))
    expect(tags.indexOf("stream.fallback")).toBeLessThan(tags.indexOf("assistant.message"))
    expect(events.some((event) => event._tag === "assistant.delta")).toBe(false)
  })

  test("without streaming there is no fallback to report", async () => {
    const { events } = await Effect.runPromise(Effect.gen(function* () {
      const reads = yield* Ref.make<ReadonlyArray<boolean>>([])
      return yield* runWith(yield* unstreamable(reads), { streaming: false, captureTraceContent: false })
    }))
    expect(events.some((event) => event._tag === "stream.fallback")).toBe(false)
  })
})

describe("runSteps failures", () => {
  test("a provider failure fails the run with loop.failed, the AiError kept as its cause and its text as the message", async () => {
    const down = AiError.make({ module: "Test", method: "generateText", reason: new AiError.UnknownError({ description: "the provider was down" }) })
    const failed = await Effect.runPromise(Effect.flip(Effect.gen(function* () {
      return yield* runWith(yield* LanguageModel.make({ generateText: () => Effect.fail(down), streamText: () => Stream.fail(down) }), { streaming: false, captureTraceContent: false })
    })))
    expect([failed._tag, failed._tag === "HarnessError" ? failed.code : null, failed.message]).toEqual(["HarnessError", "loop.failed", "AiError: Test.generateText: the provider was down"])
    expect(failed._tag === "HarnessError" ? failed.cause : null).toBe(down)
  })

  // `step.started` reaches the loop as a typed failure, `assistant.message` as a defect behind its `never` callback.
  test.each(["step.started", "assistant.message"] as const)("a turn's failure on %s (the writer's TurnClosed) fails the run with its own tag, not loop.failed", async (tag) => {
    const closed = new TurnClosed({ session: ConversationId.make("00000000-0000-4000-8000-0000000000d1"), turn: 1, reason: "cancelled" })
    const failed = await Effect.runPromise(Effect.flip(Effect.gen(function* () {
      const reads = yield* Ref.make<ReadonlyArray<boolean>>([])
      return yield* runWith(yield* unstreamable(reads), { streaming: false, captureTraceContent: false, failOn: { tag, error: closed } })
    })))
    expect([failed._tag, failed._tag === "TurnClosed" ? failed.reason : null]).toEqual(["TurnClosed", "cancelled"])
  })
})

describe("runSteps trace content", () => {
  test.each([false, true])("the request's captureTraceContent (%p) is CurrentTraceContent for the run's model calls", async (capture) => {
    const reads = await Effect.runPromise(Effect.gen(function* () {
      const reads = yield* Ref.make<ReadonlyArray<boolean>>([])
      // The switch where the run starts is the opposite: the request's wins.
      yield* runWith(yield* unstreamable(reads), { streaming: false, captureTraceContent: capture }).pipe(Effect.provideService(CurrentTraceContent, !capture))
      return yield* Ref.get(reads)
    }))
    expect(reads).toEqual([capture])
  })
})
