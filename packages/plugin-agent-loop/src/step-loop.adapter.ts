import { LanguageModel, Prompt } from "effect/ai"
import type { Tool } from "effect/ai"
import { Cause, Context, Effect, Layer, Match, Option, Ref, Schema } from "effect"
import { CurrentAgentStep, CurrentModelCallPolicy, CurrentPromptCacheKey, definePlugin, harnessDefectsAsFailures, harnessError, HarnessError, isTurnError, messagesOf, StepLoop, StreamPartId, ToolCallId } from "@xandreed/core"
import type { AgentMessage, CompletionVerdict, RunResult, StepInfo, StepRequest, StepStatus, TurnError } from "@xandreed/core"
import { runLoop } from "./loop.js"
import type { LoopEvent } from "./loop-event.entity.js"
import type { LoopToolChoice } from "./loop.js"
import { emptyLedger } from "./step-ledger.entity.js"
import { cachedPlan, planned, replanned, started, stepResultsOf, used } from "./step-ledger.entity.functions.js"

/** @public */
export const STEP_LOOP = { id: "steps", version: "1" } as const

/**
 * The step loop over `runLoop`. Per step it publishes `step.started` (with
 * the active tools), lets the registry publish `tool.*` as calls settle,
 * records the tail, and publishes `step.ended` once, when `runLoop` settles
 * the step (`onStepSettled`), with the recorded results and the status of
 * the step's own call, tools and tail (`malformed` for a response the model
 * could not form, `truncated` for one cut short, none of whose tool calls
 * ran). Only then is the host's completion evaluated (`completion.evaluated`;
 * none after a malformed or truncated step), a query that ends no step: a
 * completion that fails fails the run and leaves the step `completed`. A
 * verdict that awaits tasks joins them and is evaluated once more. A reply
 * cut short that `runLoop` does not correct fails the run with
 * `loop.truncated`, a `HarnessError` it passes on as it is. The loop's own messages (a corrective, a nudge, a steer) are
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
    // A raw result can be durable before its view returns or fails. Read the actual stored order,
    // not callback completion order, and keep those results on a failed or cancelled step too.
    const ending = request.recorded(step).pipe(Effect.flatMap((entries) =>
      request.events.publish({ _tag: "step.ended", step, run, status, results: stepResultsOf(entries) })))
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

  // Every LoopEvent has its case: the ones the turn's events carry otherwise (the registry's tool.*, the loop's
  // own step.* from onStepSettled) or not at all publish nothing here.
  const onEvent = (event: LoopEvent): Effect.Effect<void, TurnError> => Match.value(event).pipe(Match.discriminatorsExhaustive("type")({
    assistant_delta: (delta): Effect.Effect<void, TurnError> =>
      request.events.publish({ _tag: "assistant.delta", step: delta.turnIndex, channel: delta.channel, id: StreamPartId.make(delta.id), delta: delta.delta }),
    assistant_message: (message): Effect.Effect<void, TurnError> => Effect.gen(function* () {
      if (!isPlanned(message.turnIndex)) yield* Ref.update(ledger, used(message.usage))
      yield* request.events.publish({
        _tag: "assistant.message", step: message.turnIndex, run, text: message.text, reasoning: message.reasoning,
        model: Option.fromNullishOr(message.model), toolCalls: message.toolCalls.map((call) => ({ id: ToolCallId.make(call.id), tool: call.toolName, input: call.args })),
        usage: message.usage, finishReason: message.finishReason,
      })
    }),
    stream_fallback: (fallback): Effect.Effect<void, TurnError> =>
      request.events.publish({ _tag: "stream.fallback", step: fallback.turnIndex, run, message: fallback.message }),
    turn_start: () => Effect.void,
    turn_end: () => Effect.void,
    tool_start: () => Effect.void,
    tool_end: () => Effect.void,
    compaction: () => Effect.void,
    agent_end: () => Effect.void,
  }))

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
    onTail: (messages, step) => request.record(step, messages).pipe(Effect.as([])),
    onEvent,
  })
  const result = yield* harnessDefectsAsFailures(loop.pipe(
    // The request's references innermost: the turn's services (`handlers`) capture the context the turn runs
    // in, so a caller's `CurrentPromptCacheKey` or `CurrentModelCallPolicy` is in them too, and must not win.
    Effect.provideService(CurrentPromptCacheKey, request.cacheKey),
    Effect.provideService(CurrentModelCallPolicy, request.callPolicy),
    Effect.provideService(LanguageModel.LanguageModel, model),
    Effect.provide(request.handlers),
    // A turn's failure (a HarnessError, the writer's TurnClosed and the other TurnError tags) keeps its tag: the request's
    // callbacks fail with it, typed, and a tool handler's carries it as a defect, which `harnessDefectsAsFailures` restores.
    // What else failed underneath (a provider's `AiError`) is `loop.failed`, with it as the cause and its messages (never its tag or stack) as the message,
    // which a background task's notice may show the model.
    Effect.mapError((error) => isTurnError(error) ? error : harnessError("loop.failed", messagesOf(Cause.fail(error)), error)),
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
