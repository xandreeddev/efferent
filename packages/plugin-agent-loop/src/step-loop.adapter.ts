import { LanguageModel, Prompt } from "effect/ai"
import type { Tool } from "effect/ai"
import { Cause, Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { CurrentAgentStep, CurrentModelCallPolicy, CurrentPromptCacheKey, definePlugin, harnessDefectsAsFailures, harnessError, HarnessError, isTurnError, reasonOf, StepLoop, StreamPartId, ToolCallId } from "@xandreed/core"
import type { AgentMessage, CompletionVerdict, LoopEvent, RunResult, StepInfo, StepRequest, StepStatus, TurnError } from "@xandreed/core"
import { runLoop } from "./loop.js"
import type { LoopToolChoice } from "./loop.js"
import { emptyLedger } from "./step-ledger.entity.js"
import { cachedPlan, planned, recorded, replanned, resultsOf, started, used } from "./step-ledger.entity.functions.js"

/** @public */
export const STEP_LOOP = { id: "steps", version: "1" } as const

/**
 * The step loop over `runLoop`. Per step it publishes `step.started` (with
 * the active tools), lets the registry publish `tool.*` as calls settle,
 * records the tail, and publishes `step.ended` once, when `runLoop` settles
 * the step (`onStepSettled`), with the recorded results and the status of
 * the step's own call, tools and tail (`malformed` for a response the model
 * could not form). Only then is the host's completion evaluated
 * (`completion.evaluated`; none after a malformed step), a query that ends
 * no step: a completion that fails fails the run and leaves the step
 * `completed`. A verdict that awaits tasks joins them and is evaluated once
 * more. The loop's own messages (a corrective, a nudge, a steer) are
 * recorded under the next step, so nothing is recorded under a step after
 * its `step.ended`. The plan for a step is computed once and serves the
 * model, the messages and the tool choice; a host-planned first batch runs
 * without a provider call or a plan. A stream that fails before its first
 * part publishes `stream.fallback` once, and the run goes on without
 * streaming. It provides `StepLoopReferences`: the request's `cacheKey`
 * and `callPolicy` here, `captureTraceContent`, the empty-response
 * tolerance and the step through `runLoop`. A request a provider refuses
 * over an image goes to `request.onMediaRejected`; when it records an
 * `OmitMedia`, the step is planned again and sent once more. Every step event carries the request's
 * run ordinal, and the ids of a provider's id-less tool calls are minted
 * from its run (`toolCallIdOf`). What it keeps across steps is one
 * `StepLedger`.
 */
export const runSteps = Effect.fnUntraced(function* (request: StepRequest): Effect.fn.Return<RunResult, TurnError> {
  const model = yield* Option.match(Context.getOption(request.handlers, LanguageModel.LanguageModel), {
    onNone: () => Effect.fail(new HarnessError({ code: "loop.model", message: "The turn's services carry no LanguageModel" })),
    onSome: Effect.succeed,
  })
  const run = request.run.ordinal
  const hasInitial = Option.isSome(request.initial)
  const isPlanned = (step: number) => hasInitial && step === 0
  const ledger = yield* Ref.make(emptyLedger)
  const currentStep = Effect.service(CurrentAgentStep).pipe(Effect.map(Option.getOrElse(() => 0)))
  const infoOf = (step: number, activeTools: ReadonlyArray<string>) =>
    Ref.get(ledger).pipe(Effect.map((current): StepInfo => ({ stepIndex: step, activeTools, lastUsage: current.lastUsage })))

  const planFor = (info: StepInfo) => Ref.get(ledger).pipe(Effect.flatMap((current) => Option.match(cachedPlan(current, info.stepIndex), {
    onSome: Effect.succeed,
    onNone: () => request.plan(info).pipe(Effect.tap((plan) => Ref.update(ledger, planned(info.stepIndex, plan)))),
  })))

  // Once per step, from `runLoop`: a step that already failed must not fail again on its way out.
  const settle = (step: number, status: StepStatus) => {
    const ending = Ref.get(ledger).pipe(Effect.flatMap((current) =>
      request.events.publish({ _tag: "step.ended", step, run, status, results: resultsOf(current, step) })))
    return status === "failed" || status === "cancelled"
      ? ending.pipe(Effect.ignoreCause({ log: "Warn", message: `the end of failed step ${step} was not recorded` }))
      : ending
  }

  const evaluate = (info: StepInfo): Effect.Effect<CompletionVerdict, TurnError> => request.completion(info).pipe(
    Effect.tap((verdict) => request.events.publish({ _tag: "completion.evaluated", step: info.stepIndex, run, verdict })),
  )

  const isComplete = (step: number) => Effect.gen(function* () {
    const info = yield* infoOf(step, yield* request.tools.active)
    const first = yield* evaluate(info)
    if (first.complete || first.awaiting.length === 0) return first.complete
    yield* request.tasks.await(first.awaiting)
    return (yield* evaluate(info)).complete
  })

  const onEvent = (event: LoopEvent): Effect.Effect<void, TurnError> => {
    if (event.type === "assistant_delta") {
      return request.events.publish({ _tag: "assistant.delta", step: event.turnIndex, channel: event.channel, id: StreamPartId.make(event.id), delta: event.delta })
    }
    if (event.type === "assistant_message") {
      return Effect.gen(function* () {
        if (!isPlanned(event.turnIndex)) yield* Ref.update(ledger, used(event.usage))
        yield* request.events.publish({
          _tag: "assistant.message", step: event.turnIndex, run, text: event.text, reasoning: event.reasoning,
          model: Option.fromNullishOr(event.model), toolCalls: event.toolCalls.map((call) => ({ id: ToolCallId.make(call.id), tool: call.toolName, input: call.args })),
          usage: event.usage,
        })
      })
    }
    if (event.type === "stream_fallback") {
      return request.events.publish({ _tag: "stream.fallback", step: event.turnIndex, run, message: event.message })
    }
    return Effect.void
  }

  const loop = runLoop<Record<string, Tool.Any>, TurnError>({
    run: request.run,
    system: "",
    messages: [],
    toolkit: request.tools.toolkit,
    maxSteps: request.limits.maxSteps,
    toolConcurrency: request.limits.toolConcurrency,
    streaming: request.limits.streaming,
    requireCompletion: request.limits.requireCompletion,
    captureTraceContent: request.captureTraceContent,
    pollableTools: request.tools.pollable,
    ...Option.match(request.correctives, { onNone: () => ({}), onSome: (correctives) => ({ correctives }) }),
    ...Option.match(request.initial, { onNone: () => ({}), onSome: (batch) => ({ initialStep: batch.calls }) }),
    activeTools: () => Effect.gen(function* () {
      const step = yield* currentStep
      const active = yield* request.tools.active
      yield* Ref.update(ledger, started(step))
      yield* request.events.publish({ _tag: "step.started", step, run, planned: isPlanned(step), activeTools: active })
      return active
    }),
    prepareModel: (step) => infoOf(step.stepIndex, step.activeTools).pipe(
      Effect.flatMap(planFor),
      Effect.map((plan) => ({ model: Option.getOrElse(plan.model, () => model), system: Prompt.make([{ role: "system", content: plan.system }]) })),
    ),
    render: (view) => isPlanned(view.stepIndex)
      ? Effect.succeed<ReadonlyArray<AgentMessage>>([])
      : planFor(view).pipe(Effect.map((plan) => plan.messages)),
    stepDirective: (view) => isPlanned(view.stepIndex)
      ? Effect.succeed({ toolChoice: Option.none<LoopToolChoice>() })
      : planFor(view).pipe(Effect.map((plan) => ({ toolChoice: plan.toolChoice }))),
    beforeDispatch: (step, actual) => request.dispatch(step, actual),
    // The images are omitted from now on: the step is planned again for its second attempt.
    onMediaRejected: (reason) => request.onMediaRejected(reason).pipe(
      Effect.tap((retry) => retry ? Ref.update(ledger, replanned) : Effect.void),
    ),
    isComplete,
    onStepSettled: settle,
    pendingInput: () => request.steering,
    onTail: (messages, step) => request.record(step, messages).pipe(
      Effect.flatMap((entries) => Ref.update(ledger, recorded(step, entries))),
      Effect.as([]),
    ),
    onEvent,
  })
  const result = yield* harnessDefectsAsFailures(loop.pipe(
    Effect.provide(request.handlers),
    Effect.provideService(LanguageModel.LanguageModel, model),
    Effect.provideService(CurrentPromptCacheKey, request.cacheKey),
    Effect.provideService(CurrentModelCallPolicy, request.callPolicy),
    // A turn's failure (a HarnessError, the writer's TurnClosed and the other TurnError tags) keeps its tag: the request's
    // callbacks fail with it, typed, and a tool handler's carries it as a defect, which `harnessDefectsAsFailures` restores.
    // What else failed underneath (a provider's `AiError`) is `loop.failed`, with it as the cause and its text, never its stack, as the message.
    Effect.mapError((error) => isTurnError(error) ? error : harnessError("loop.failed", reasonOf(Cause.fail(error)), error)),
  ))
  // The loop's sum of the usage each `assistant.message` carried.
  const totals = { text: result.finalText, steps: (yield* Ref.get(ledger)).steps, usage: result.usage }
  return result.reason === "completed"
    ? { outcome: "completed", reason: "completed", ...totals }
    : { outcome: "partial", reason: result.reason, ...totals }
})

export const StepLoopLive = Layer.succeed(StepLoop, StepLoop.of({ ...STEP_LOOP, run: runSteps }))

/**
 * The step loop as a runtime plugin; the turn supplies everything per run.
 *
 * @public
 */
export const stepLoopPlugin = definePlugin({
  id: "@xandreed/plugin-agent-loop/steps", version: "0.14.0", scope: "runtime",
  config: Schema.Struct({}), defaults: {},
  provides: [StepLoop],
  layer: () => StepLoopLive,
})
