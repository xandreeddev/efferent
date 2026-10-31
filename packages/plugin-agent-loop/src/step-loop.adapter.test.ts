import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Prompt, Response, Toolkit } from "effect/ai"
import type { Tool } from "effect/ai"
import { Cause, Context, Effect, Exit, Option, Ref, Stream } from "effect"
import { addUsage, ConversationId, CurrentAgentRun, CurrentAgentStep, CurrentEmptyResponseTolerance, CurrentModelCallPolicy, CurrentPromptCacheKey, CurrentTraceContent, harnessError, HarnessError, isTurnError, makeTurnEvents, makeTurnTasks, modelFailureCodeOf, modelFailureOf, plannedCallIdOf, reasonOf, RunId, RunOrdinal, StepLoop, StepLoopReferences, ToolCallId, TurnClosed, zeroUsage } from "@xandreed/core"
import { extractUsage, foldStreamParts, responseText, responseToAgentMessages, responseToolCalls, toPromptMessages, withToolCallIds } from "@xandreed/core/internal"
import { stepLoopConformance } from "@xandreed/core/conformance"
import type { CompletionVerdict, FinishReason, RunResult, RunTools, StepInfo, StepRequest, StepStatus, TokenUsage, TurnError, TurnEvent } from "@xandreed/core"
import { runSteps, STEP_LOOP } from "./step-loop.adapter.js"

/** A response the model could not form: its output, or a call's parameters, do not decode, or it names no tool. */
const isMalformed = (error: unknown): boolean => AiError.isAiError(error) &&
  Option.isNone(modelFailureOf(error)) && ["InvalidOutputError", "ToolParameterValidationError", "ToolNotFoundError"].includes(error.reason._tag)

/** The finish reasons of a whole response: any other cuts it short, but `unknown` (the provider gave none) cuts only a reply with calls to run. */
const WHOLE: ReadonlyArray<FinishReason> = ["stop", "tool-calls", "pause"]

/** The run's text after a reply: what it carries with the reply's text after it, else its text so far. */
const joined = (text: string, carried: string, reply: string): string => (carried + reply).length > 0 ? carried + reply : text

/** The answer to a call of a reply cut short: it was not run. */
const notRun = (call: Response.ToolCallPart<string, unknown>): Response.AnyPart => {
  const failure = { error: "ReplyCut", message: "Your reply was cut short, so this call was not run." }
  return Response.makePart("tool-result", {
    id: call.id, name: call.name, providerExecuted: false, preliminary: false, result: failure, encodedResult: failure, isFailure: true,
  })
}

/**
 * How a minimal loop is careless, if it is: `streamed` streams through
 * effect/ai's own tool call resolution, which starts a call's handler once
 * the next part arrives, before the finish says the reply was cut;
 * `settled` lets effect/ai resolve every reply's calls, which runs those of
 * a reply with no finish part; `cuts-with-calls` gates only a reply with
 * tool calls, so a reply of text alone cut short ends its step as a whole
 * one would; `ends-at-pause` ends the run at a paused reply with no calls,
 * as at a stop; `uncapped` answers every reply cut at the output limit
 * with a corrective, however many come in a row; `unreset` counts the
 * replies cut at the output limit over the run, not in a row: a malformed
 * or a whole step between them restarts nothing. `batch-tail` records the
 * response and all results only after every handler returns.
 */
type Carelessness = "careful" | "streamed" | "settled" | "cuts-with-calls" | "ends-at-pause" | "uncapped" | "unreset" | "batch-tail"

/**
 * The smallest loop that honours the StepLoop contract, written directly on
 * @effect/ai: proof that the kit checks the contract, not runLoop's shape.
 * It resolves a reply's tool calls itself (effect/ai's own resolution runs
 * those of a reply with no finish part): a whole reply's run, a cut one's
 * are answered as not run. It ends a cut step `truncated`, answers a reply
 * cut at the output limit with a corrective at most twice in a row (to call
 * again when it had calls, else to go on from it, its text carried to the
 * next reply's, as a paused reply's is), and fails the run with
 * `loop.truncated` at any other cut or a third. It does not stream, unless
 * careless.
 */
const minimalLoopOf = (careless: Carelessness) => StepLoop.of({
  id: `minimal-${careless}`, version: "1",
  run: (request: StepRequest) => Effect.gen(function* () {
    const model = yield* Effect.orDie(Effect.fromOption(Context.getOption(request.handlers, LanguageModel.LanguageModel)))
    const toolkit = yield* request.tools.toolkit.pipe(Effect.provide(request.handlers))
    const run = request.run.ordinal
    const ended = yield* Ref.make<ReadonlySet<number>>(new Set())
    const malformed = yield* Ref.make(0)
    const progress = yield* Ref.make<{ readonly seen: ReadonlySet<string>; readonly stale: number }>({ seen: new Set(), stale: 0 })
    const record = request.record
    const end = (step: number, status: StepStatus) => Ref.modify(ended, (all): readonly [boolean, ReadonlySet<number>] =>
      [!all.has(step), new Set([...all, step])]).pipe(Effect.flatMap((publish) => !publish ? Effect.void : request.recorded(step).pipe(
      Effect.flatMap((entries) => request.events.publish({
        _tag: "step.ended", step, run, status,
        results: entries.flatMap((entry) => entry.step === step && entry.body._tag === "ToolResult"
          ? [{ entry: entry.id, toolCallId: entry.body.toolCallId, tool: entry.body.toolName, ok: !entry.body.isError }] : []),
      })),
    )))
    const evaluate = (info: StepInfo): Effect.Effect<CompletionVerdict, TurnError> => request.completion(info).pipe(
      Effect.tap((verdict) => request.events.publish({ _tag: "completion.evaluated", step: info.stepIndex, run, verdict })))
    /** A whole reply's calls at step `index`, each last result recorded as it returns. */
    const runCalls = (calls: ReadonlyArray<Response.ToolCallPart<string, unknown>>, index: number) => Effect.forEach(calls, (call) =>
      (toolkit.handle(call.name as never, call.params as never, call.id) as Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>, unknown>, unknown>).pipe(
        Effect.flatMap((results) => Stream.runLast(Stream.filter(results, (result) => !result.preliminary))),
        Effect.flatMap(Effect.fromOption),
        Effect.map((result): Response.AnyPart => Response.makePart("tool-result", {
          id: call.id, name: call.name, providerExecuted: false, preliminary: false,
          result: result.result, encodedResult: result.encodedResult, isFailure: result.isFailure,
        })),
        Effect.tap((result) => careless === "batch-tail" ? Effect.void : record(index, responseToAgentMessages([result]))),
      ), { concurrency: request.limits.toolConcurrency }).pipe(
      Effect.provideService(CurrentAgentStep, Option.some(index)),
      Effect.provideService(CurrentAgentRun, Option.some(request.run)),
      // The turn's services outermost: the caller's step in them must not win.
      Effect.provide(request.handlers),
      Effect.mapError((error) => isTurnError(error) ? error : harnessError("loop.failed", reasonOf(Cause.fail(error)), error)),
    )
    // `text`: the run's text so far; `carried`: the text of the replies the next one goes on from (cut at the
    // output limit, or paused); `toolCalled`: whether the run has executed a tool call, the empty-response
    // tolerance of its model calls; `cuts`: the replies in a row cut at the output limit, each answered with a corrective.
    const step = (index: number, text: string, carried: string, usage: TokenUsage, toolCalled: boolean, cuts: number): Effect.Effect<RunResult, TurnError> => Effect.gen(function* () {
      if (index >= request.limits.maxSteps) return { outcome: "partial", reason: "step-cap", text: joined(text, carried, ""), steps: index, usage } satisfies RunResult
      const activeTools = yield* request.tools.active
      const info: StepInfo = { stepIndex: index, activeTools, lastUsage: Option.none() }
      const planned = index === 0 ? request.initial : Option.none()
      yield* request.events.publish({ _tag: "step.started", step: index, run, planned: Option.isSome(planned), activeTools })
      yield* request.steer(index)
      // Careless, a reply's calls are effect/ai's to resolve (a streamed one's, or every one's); otherwise the
      // loop's, once it knows the reply is whole.
      const streamedThrough = careless === "streamed" && request.limits.streaming && Option.isNone(planned)
      const resolvedThrough = streamedThrough || careless === "settled"
      // One attempt: plan, check the dispatch, call. A refusal over an image is attempted once more after
      // onMediaRejected answers true.
      const attempt = Effect.gen(function* () {
        const plan = Option.isSome(planned) ? Option.none() : Option.some(yield* request.plan(info))
        const provider = Option.isSome(planned)
          ? yield* LanguageModel.make({
            generateText: () => Effect.succeed([
              ...planned.value.calls.map((call, position) => ({ type: "tool-call" as const, id: plannedCallIdOf(request.run, position), name: call.name, params: call.params, providerExecuted: false })),
              { type: "finish" as const, reason: "tool-calls" as const, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } },
            ]),
            streamText: () => Stream.empty,
          })
          : Option.getOrElse(Option.flatMap(plan, (value) => value.model), () => model)
        const prompt = Option.match(plan, {
          onNone: () => Prompt.empty,
          onSome: (value) => Prompt.concat(Prompt.make([{ role: "system", content: value.system }]), Prompt.make(toPromptMessages(value.messages))),
        })
        const toolChoice = Option.flatMap(plan, (value) => value.toolChoice)
        if (Option.isSome(plan)) yield* request.dispatch(index, {
          prompt, tools: Object.values(toolkit.tools), toolChoice: Option.getOrElse(toolChoice, () => "auto"), model: provider,
        })
        // The tools declare no dependencies: the call needs no services (`Tool.Any` widens them to `any`).
        const options = { prompt, toolkit, ...Option.match(toolChoice, { onNone: () => ({}), onSome: (choice) => ({ toolChoice: choice }) }) }
        const generated: Effect.Effect<{ readonly content: ReadonlyArray<Response.AnyPart>; readonly finishReason: FinishReason }, unknown> = streamedThrough
          ? foldStreamParts(provider.streamText(options) as never, () => Effect.void)
          : provider.generateText(resolvedThrough ? options : { ...options, disableToolCallResolution: true }) as never
        return yield* generated.pipe(
          // The run's trace content switch, for the model call to read.
          Effect.provideService(CurrentTraceContent, request.captureTraceContent),
          Effect.provideService(CurrentAgentStep, Option.some(index)),
          Effect.provideService(CurrentAgentRun, Option.some(request.run)),
          Effect.provideService(CurrentEmptyResponseTolerance, toolCalled),
          Effect.provideService(CurrentPromptCacheKey, request.cacheKey),
          Effect.provideService(CurrentModelCallPolicy, request.callPolicy),
          // The turn's services outermost: the caller's values of the references in them must not win.
          Effect.provide(request.handlers),
        )
      })
      const answered = yield* attempt.pipe(
        Effect.catch((error) => !Option.isSome(planned) && AiError.isAiError(error) && error.reason._tag === "InvalidRequestError" && /image/i.test(error.reason.message)
          ? request.onMediaRejected(error.reason.message).pipe(Effect.flatMap((retry) => retry ? attempt : Effect.fail(error)))
          : Effect.fail(error)),
        Effect.map(Option.some),
        Effect.catch((error) => isMalformed(error) ? Effect.succeed(Option.none()) : Effect.fail(error)),
        Effect.mapError((error) => isTurnError(error) ? error : harnessError(Option.match(modelFailureOf(error), { onNone: () => "loop.failed", onSome: modelFailureCodeOf }), reasonOf(Cause.fail(error)), error)),
      )
      // A malformed step ends as such, without a verdict; its corrective is the next step's, when there is one.
      if (Option.isNone(answered)) {
        yield* end(index, "malformed")
        yield* request.pendingSteers
        if ((yield* Ref.updateAndGet(malformed, (count) => count + 1)) >= (request.limits.malformedLimit ?? 3)) return yield* Effect.fail(harnessError("loop.failed", "The malformed-response limit is reached"))
        if (index + 1 >= request.limits.maxSteps) return { outcome: "partial", reason: "step-cap", text: joined(text, carried, ""), steps: index + 1, usage } satisfies RunResult
        yield* request.record(index + 1, [{ role: "user", content: "Your reply could not be parsed: call a tool that exists, or answer in text." }])
        return yield* step(index + 1, text, carried, usage, toolCalled, careless === "unreset" ? cuts : 0)
      }
      const response = answered.value
      const failure = modelFailureOf(response.content)
      if (Option.isSome(failure)) return yield* Effect.fail(harnessError(modelFailureCodeOf(failure.value), "The model request failed.", response))
      yield* Ref.set(malformed, 0)
      // A provider's id-less calls get ids of this run's own, before the results answer them.
      const parts = withToolCallIds(response.content, index, request.run)
      const calls = parts.flatMap((part) => part.type === "tool-call" && part.providerExecuted !== true ? [part] : [])
      const cut = !WHOLE.includes(response.finishReason)
        && (careless === "cuts-with-calls" ? calls.length > 0 : response.finishReason !== "unknown" || calls.length > 0)
      const used = extractUsage(undefined, parts)
      const total = addUsage(usage, used)
      const publishAssistant = request.events.publish({
        _tag: "assistant.message", step: index, run, text: responseText(parts), reasoning: "", model: Option.none(),
        toolCalls: responseToolCalls(parts).map((call) => ({ id: ToolCallId.make(call.id), tool: call.toolName, input: call.args })), usage: used, finishReason: response.finishReason,
      })
      if (careless !== "batch-tail") {
        yield* record(index, responseToAgentMessages(parts))
        yield* publishAssistant
      }
      const answers = resolvedThrough ? [] : cut ? calls.map(notRun) : yield* runCalls(calls, index)
      if (cut && careless !== "batch-tail") yield* Effect.forEach(answers, (answer) => record(index, responseToAgentMessages([answer])), { concurrency: 1 })
      const content: ReadonlyArray<Response.AnyPart> = [...parts, ...answers]
      if (careless === "batch-tail") {
        yield* record(index, responseToAgentMessages(content))
        yield* publishAssistant
      }
      const reply = responseText(content)
      // A reply cut short: its calls were answered, not run, and it gets no verdict.
      if (cut) {
        yield* end(index, "truncated")
        yield* request.pendingSteers
        if (response.finishReason !== "length" || (cuts >= 2 && careless !== "uncapped")) return yield* Effect.fail(harnessError("loop.truncated", `the reply at step ${index} was cut short (${response.finishReason})`))
        // A reply of text alone is gone on from, its text carried to the next reply's; one with calls is replied anew.
        const [nextText, nextCarried] = calls.length === 0 ? [text, carried + reply] : [joined(text, carried, reply), ""]
        if (index + 1 >= request.limits.maxSteps) return { outcome: "partial", reason: "step-cap", text: joined(nextText, nextCarried, ""), steps: index + 1, usage: total } satisfies RunResult
        yield* request.record(index + 1, [{
          role: "user",
          content: calls.length === 0
            ? "Your reply reached the output limit: go on from where it stopped."
            : "Your reply reached the output limit, and none of its tool calls ran: call again the ones you still need.",
        }])
        return yield* step(index + 1, nextText, nextCarried, total, toolCalled, cuts + 1)
      }
      yield* end(index, "completed")
      const first = yield* evaluate(info)
      const verdict = first.complete || first.awaiting.length === 0 ? first : yield* request.tasks.await(first.awaiting).pipe(Effect.andThen(evaluate(info)))
      const pending = yield* request.pendingSteers
      const signature = content.flatMap((part) => part.type === "tool-result" && !request.tools.pollable.includes(part.name) ? [`${part.name}:${part.isFailure}:${JSON.stringify(part.result)}`] : []).toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0).join("|")
      const stale = yield* Ref.modify(progress, (held) => {
        const stale = signature === "" ? held.stale : held.seen.has(signature) ? held.stale + 1 : 0
        return [stale, { seen: new Set([...held.seen, ...(signature === "" ? [] : [signature])]), stale }] as const
      })
      const policy = request.limits.degenerate ?? { _tag: "Enabled", nudgeAfter: 3, breakAfter: 5 }
      if (policy._tag === "Enabled" && signature !== "" && stale >= policy.breakAfter) return { outcome: "partial", reason: "degenerate-loop", text: joined(text, carried, reply), steps: index + 1, usage: total } satisfies RunResult
      const paused = response.finishReason === "pause" && careless !== "ends-at-pause"
      // A step that is no cut restarts the count of cuts in a row.
      const counted = careless === "unreset" ? cuts : 0
      if (!pending && (verdict.complete || (calls.length === 0 && !paused))) return { outcome: "completed", reason: "completed", text: joined(text, carried, reply), steps: index + 1, usage: total } satisfies RunResult
      if (policy._tag === "Enabled" && signature !== "" && stale === policy.nudgeAfter && index + 1 < request.limits.maxSteps) yield* request.record(index + 1, [{ role: "user", content: "Choose a different action: the result repeated." }])
      // A paused reply goes on: the next call continues it, its text carried to the next reply's.
      return yield* (paused
        ? step(index + 1, text, carried + reply, total, toolCalled || calls.length > 0, counted)
        : step(index + 1, joined(text, carried, reply), "", total, toolCalled || calls.length > 0, counted))
    }).pipe(Effect.onExit((exit) => Exit.isFailure(exit)
      ? end(index, Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : "failed").pipe(Effect.orDie) : Effect.void))
    // The request's cache key and call policy, for the dispatch check and the model calls to read.
    return yield* step(0, "", "", zeroUsage, false, 0).pipe(
      Effect.provideService(CurrentPromptCacheKey, request.cacheKey),
      Effect.provideService(CurrentModelCallPolicy, request.callPolicy),
      Effect.provideService(CurrentAgentRun, Option.some(request.run)),
    )
  }),
})

const conform = (name: string, loop: Context.Service.Shape<typeof StepLoop>) => describe(`${name} conforms to StepLoop`, () => {
  stepLoopConformance(loop).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

conform("StepLoopLive", StepLoop.of({ ...STEP_LOOP, run: runSteps }))
conform("a minimal loop", minimalLoopOf("careful"))

/** The ids of the kit's checks a loop fails, each once, sorted. */
const failedChecks = (loop: Context.Service.Shape<typeof StepLoop>) => Effect.runPromise(Effect.forEach(stepLoopConformance(loop), (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : [])), { concurrency: 1 }))
  .then((failed) => [...new Set(failed.flat())].toSorted())

test("the model-failures check rejects a loop that erases semantic failure codes", async () => {
  const careless = StepLoop.of({ ...STEP_LOOP, run: (request) => runSteps(request).pipe(
    Effect.mapError((error) => harnessError("loop.failed", "the model failed", error)),
  ) })
  const check = stepLoopConformance(careless).find((candidate) => candidate.name.startsWith("typed model failures"))
  const result = check === undefined ? undefined : await Effect.runPromise(Effect.result(check.run))
  expect(result?._tag === "Failure" ? result.failure.check : "passed").toBe("model-failures")
})

/** `runSteps` with every event it publishes passed through `rewrite` first, as a careless loop would publish it. */
const republishing = (rewrite: (event: TurnEvent) => TurnEvent) => StepLoop.of({
  id: "republishing", version: "1",
  run: (request) => runSteps({ ...request, events: { ...request.events, publish: (event) => request.events.publish(rewrite(event)) } }),
})

describe("a loop careless with durable steering", () => {
  test("ignoring host loop policies fails both policy checks", async () => {
    const careless = StepLoop.of({ ...STEP_LOOP, run: (request) => {
      const { degenerate: _degenerate, malformedLimit: _malformedLimit, ...limits } = request.limits
      return runSteps({ ...request, limits })
    } })
    expect(await failedChecks(careless)).toEqual(["degenerate-policy", "malformed-limit"])
  })
  test("ignoring the final pending probe loses new work or its completion boundary", async () => {
    expect(await failedChecks(StepLoop.of({ ...STEP_LOOP, run: (request) => runSteps({ ...request, pendingSteers: Effect.succeed(false) }) })))
      .toEqual(["durable-steering", "steering-cap", "steering-empty-poll"])
  })

  test("skipping atomic take loses first-step input and its failures", async () => {
    expect(await failedChecks(StepLoop.of({ ...STEP_LOOP, run: (request) => runSteps({ ...request, steer: () => Effect.succeed([]) }) })))
      .toEqual(["durable-steering", "steering-error", "steering-first"])
  })

  test("recording already committed steering a second time duplicates intent", async () => {
    expect(await failedChecks(StepLoop.of({ ...STEP_LOOP, run: (request) => runSteps({
      ...request, steer: (step) => request.steer(step).pipe(Effect.tap((messages) => messages.length === 0 ? Effect.void : request.record(step, messages))),
    }) }))).toEqual(["durable-steering", "steering-first"])
  })

  test("taking during the final probe records input under a step that never starts", async () => {
    expect(await failedChecks(StepLoop.of({ ...STEP_LOOP, run: (request) => runSteps({
      ...request, pendingSteers: request.steer(999).pipe(Effect.map((messages) => messages.length > 0)),
    }) }))).toEqual(["durable-steering", "steering-cap", "steering-empty-poll"])
  })
})

describe("a loop careless with a reply cut short", () => {
  test("one that records the whole tail after all tools return fails every per-call durability check", async () => {
    expect(await failedChecks(minimalLoopOf("batch-tail"))).toEqual(["assistant-first", "incremental-results", "record-failure"])
  })

  test("one that publishes every assistant.message as finished with stop fails the finish reason's checks", async () => {
    expect(await failedChecks(republishing((event) => event._tag === "assistant.message" ? { ...event, finishReason: "stop" } : event)))
      .toEqual(["cut", "cut-stream", "cut-text", "cut-unknown", "finish"])
  })

  test("one that ends a truncated step completed fails the cut checks", async () => {
    expect(await failedChecks(republishing((event) => event._tag === "step.ended" && event.status === "truncated" ? { ...event, status: "completed" } : event)))
      .toEqual(["cut", "cut-fail", "cut-reset", "cut-stream", "cut-text", "cut-unknown"])
  })

  test("one that streams through effect/ai's own tool call resolution starts a call before it records the response and before the finish arrives", async () => {
    expect(await failedChecks(minimalLoopOf("streamed"))).toEqual(["assistant-first", "cut-stream"])
  })

  test("one that settles through effect/ai's own tool call resolution runs unrecorded calls, including a reply with no finish part", async () => {
    expect(await failedChecks(minimalLoopOf("settled"))).toEqual(["assistant-first", "cut-unknown", "incremental-results", "model-failures", "record-failure"])
  })

  test("one that gates a cut only when the reply has tool calls fails the checks of a reply of text alone cut short", async () => {
    expect(await failedChecks(minimalLoopOf("cuts-with-calls"))).toEqual(["cut-fail", "cut-text", "malformed-limit"])
  })

  test("one that ends the run at a paused reply with no calls fails pause", async () => {
    expect(await failedChecks(minimalLoopOf("ends-at-pause"))).toEqual(["pause"])
  })

  test("one that answers every reply cut at the output limit with a corrective, however many in a row, fails cut-fail", async () => {
    expect(await failedChecks(minimalLoopOf("uncapped"))).toEqual(["cut-fail"])
  })

  test("one that counts the replies cut at the output limit over the run, not in a row, fails cut-reset", async () => {
    expect(await failedChecks(minimalLoopOf("unreset"))).toEqual(["cut-reset"])
  })
})

/**
 * `runSteps` made careless, as a loop that ends its steps in its completion
 * check would be: a step ends when its completion is evaluated, with that
 * evaluation's exit, a malformed step ends `completed`, and the loop's own
 * messages are recorded under the step it is in; and as one that records
 * the next step's corrective before it knows that step runs: a run the step
 * cap ends leaves one under the step it never takes.
 */
const carelessLoop = StepLoop.of({
  id: "careless", version: "1",
  run: (request) => {
    const ended = (step: number, status: StepStatus) => request.events.publish({ _tag: "step.ended", step, run: request.run.ordinal, status, results: [] })
    const endOnce = (event: Extract<TurnEvent, { readonly _tag: "step.ended" }>) =>
      event.status === "completed" ? Effect.void : request.events.publish(event.status === "malformed" ? { ...event, status: "completed" } : event)
    return runSteps({
      ...request,
      events: { ...request.events, publish: (event) => event._tag === "step.ended" ? endOnce(event) : request.events.publish(event) },
      completion: (info) => request.completion(info).pipe(Effect.onExit((exit) => ended(info.stepIndex, Exit.isSuccess(exit) ? "completed" : "failed").pipe(Effect.orDie))),
      record: (step, tail) => Effect.service(CurrentAgentStep).pipe(Effect.flatMap((current) => request.record(Option.getOrElse(current, () => step), tail))),
    }).pipe(Effect.tap((result) => result.reason === "step-cap"
      ? request.record(result.steps, [{ role: "user", content: "Complete the requested work." }])
      : Effect.void))
  },
})

describe("a careless loop", () => {
  const checks = stepLoopConformance(carelessLoop)
  test.each([
    "ends each step once, and records nothing under a step after its step.ended (correctives, nudges and steers included)",
    "records nothing under a step that never starts (the step cap or a complete verdict ends the run first)",
    "a completion that fails after a completed step fails the run and leaves that step completed",
    "a malformed step ends malformed, with no completion.evaluated, and the run goes on",
  ])("fails the kit's check: %s", async (name) => {
    const check = checks.find((candidate) => candidate.name === name)
    expect(check).toBeDefined()
    const exit = await Effect.runPromise(Effect.result(check?.run ?? Effect.void))
    expect(exit._tag).toBe("Failure")
  })
})

/** `runSteps` with a wrong value of one of `StepLoopReferences` provided to its model calls, as a careless loop would. */
const misproviding = <A>(reference: Context.Reference<A>, wrong: A) => ({
  key: reference.key,
  loop: StepLoop.of({
    id: "misproviding", version: "1",
    run: (request) => Effect.orDie(Effect.fromOption(Context.getOption(request.handlers, LanguageModel.LanguageModel))).pipe(Effect.flatMap((model) => runSteps({
      ...request,
      handlers: Context.add(request.handlers, LanguageModel.LanguageModel, {
        ...model,
        generateText: ((options: never) => model.generateText(options).pipe(Effect.provideService(reference, wrong))) as never,
      }),
    }))),
  }),
})

describe("a loop that provides a wrong value of one of StepLoopReferences", () => {
  const careless = [
    misproviding(CurrentPromptCacheKey, Option.some("careless")),
    misproviding(CurrentModelCallPolicy, Option.some({ effort: "none" as const })),
    misproviding(CurrentTraceContent, true),
    misproviding(CurrentEmptyResponseTolerance, true),
    misproviding(CurrentAgentStep, Option.none()),
    misproviding(CurrentAgentRun, Option.none()),
  ]
  test.each(StepLoopReferences.map((reference) => reference.key))("fails the kit's check of %s", async (key) => {
    const loop = careless.find((candidate) => candidate.key === key)?.loop
    expect(loop).toBeDefined()
    // The kit's check of a reference names it.
    const checks = loop === undefined ? [] : stepLoopConformance(loop).filter((check) => check.name.includes(key.slice(key.lastIndexOf("/") + 1)))
    expect(checks.length).toBe(1)
    const exits = await Promise.all(checks.map((check) => Effect.runPromise(Effect.result(check.run))))
    expect(exits.map((exit) => exit._tag)).toEqual(["Failure"])
  })
})

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
  const toolkit: Toolkit.Toolkit<Record<string, Tool.Any>> = Toolkit.empty
  const tools: RunTools = {
    toolkit, handlers: yield* toolkit.toHandlers({}), active: Effect.succeed([]), activate: () => Effect.succeed([]),
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
    run: { id: RunId.make("run-1"), turn: 1, ordinal: RunOrdinal.make(0) },
    tools,
    handlers: Context.merge(tools.handlers, Context.make(LanguageModel.LanguageModel, model)),
    limits: { maxSteps: 6, toolConcurrency: 1, streaming: options.streaming, requireCompletion: false },
    initial: Option.none(),
    plan: () => Effect.succeed({ model: Option.none(), system: "sys", messages: [{ role: "user", content: "go" }], toolChoice: Option.none() }),
    dispatch: () => Effect.void,
    record: () => Effect.succeed([]),
    recorded: () => Effect.succeed([]),
    pendingSteers: Effect.succeed(false),
    steer: () => Effect.succeed([]),
    onMediaRejected: () => Effect.succeed(false),
    // Complete after `steps` steps; a model stop ends the run earlier.
    completion: (info) => Effect.succeed({ complete: info.stepIndex + 1 >= steps, awaiting: [], facts: {} }),
    steering: Effect.succeed(Option.none()),
    correctives: Option.none(),
    events,
    tasks,
    cacheKey: Option.none(),
    callPolicy: Option.none(),
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
    expect(fallbacks).toEqual([{ _tag: "stream.fallback", step: 0, run: RunOrdinal.make(0), message: expect.stringContaining("the gateway closed the stream") }])
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
  test("an unknown provider failure keeps the AiError as its cause and its message without its tag", async () => {
    const down = AiError.make({ module: "Test", method: "generateText", reason: new AiError.UnknownError({ description: "the provider was down" }) })
    const failed = await Effect.runPromise(Effect.flip(Effect.gen(function* () {
      return yield* runWith(yield* LanguageModel.make({ generateText: () => Effect.fail(down), streamText: () => Stream.fail(down) }), { streaming: false, captureTraceContent: false })
    })))
    expect([failed._tag, failed._tag === "HarnessError" ? failed.code : null, failed.message]).toEqual(["HarnessError", "model.failed", "Test.generateText: the provider was down"])
    expect(failed._tag === "HarnessError" ? failed.cause : null).toBe(down)
  })

  // Each reaches the loop as a typed failure of the callback that published it.
  test.each([
    ["step.started", false],
    ["assistant.message", false],
    ["step.ended", false],
    ["stream.fallback", true],
  ] as const)("a turn's failure on %s (the writer's TurnClosed) fails the run with its own tag, not loop.failed", async (tag, streaming) => {
    const closed = new TurnClosed({ session: ConversationId.make("00000000-0000-4000-8000-0000000000d1"), turn: 1, reason: "cancelled" })
    const failed = await Effect.runPromise(Effect.flip(Effect.gen(function* () {
      const reads = yield* Ref.make<ReadonlyArray<boolean>>([])
      return yield* runWith(yield* unstreamable(reads), { streaming, captureTraceContent: false, failOn: { tag, error: closed } })
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

test("the recorded-results check catches a loop that drops the durable snapshot after a presentation failure", async () => {
  const forgetful = StepLoop.of({ ...STEP_LOOP, run: (request) => runSteps({ ...request, recorded: () => Effect.succeed([]) }) })
  const check = stepLoopConformance(forgetful).find((candidate) => candidate.name === "a failed result presentation leaves its raw result listed on the failed step by durable entry id")
  expect(check).toBeDefined()
  const result = await Effect.runPromise(Effect.result(check?.run ?? Effect.void))
  expect(result._tag === "Failure" ? result.failure.check : "passed").toBe("recorded-results")
})
