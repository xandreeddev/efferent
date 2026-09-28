import { LanguageModel, Prompt } from "effect/ai"
import type { Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { CurrentAgentStep, CurrentPromptCacheKey, definePlugin, harnessDefectsAsFailures, HarnessError, StepLoop } from "@xandreed/core"
import type { AgentMessage, CompletionVerdict, LogEntry, LoopEvent, RunResult, StepInfo, StepPlan, StepRequest, StepResult, TokenUsage } from "@xandreed/core"
import { runLoop } from "./loop.js"
import type { LoopToolChoice } from "./loop.js"

export const STEP_LOOP = { id: "steps", version: "1" } as const

type StepStatus = "completed" | "failed" | "cancelled"

const resultsOf = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<StepResult> => entries.flatMap((entry) =>
  entry.body._tag === "ToolResult" ? [{ entry: entry.id, toolCallId: entry.body.toolCallId, tool: entry.body.toolName, ok: !entry.body.isError }] : [])

/**
 * The step loop over `runLoop`. Per step it publishes `step.started` (with
 * the active tools), lets the registry publish `tool.*` as calls settle,
 * records the tail, publishes `step.ended` with the recorded results, then
 * evaluates the host's completion (`completion.evaluated`). A verdict that
 * awaits tasks joins them and is evaluated once more. The plan for a step is
 * computed once and serves the model, the messages and the tool choice; a
 * host-planned first batch runs without a provider call or a plan.
 */
export const runSteps = (request: StepRequest): Effect.Effect<RunResult, HarnessError> => Effect.gen(function* () {
  const model = yield* Option.match(Context.getOption(request.handlers, LanguageModel.LanguageModel), {
    onNone: () => Effect.fail(new HarnessError({ code: "loop.model", message: "The turn's services carry no LanguageModel" })),
    onSome: Effect.succeed,
  })
  const hasInitial = Option.isSome(request.initial)
  const isPlanned = (step: number) => hasInitial && step === 0
  const cached = yield* Ref.make(Option.none<{ readonly step: number; readonly plan: StepPlan }>())
  const lastUsage = yield* Ref.make(Option.none<TokenUsage>())
  const results = yield* Ref.make(new Map<number, ReadonlyArray<StepResult>>())
  const ended = yield* Ref.make(new Set<number>())
  const steps = yield* Ref.make(0)
  const currentStep = Effect.service(CurrentAgentStep).pipe(Effect.map(Option.getOrElse(() => 0)))
  const infoOf = (step: number, activeTools: ReadonlyArray<string>) =>
    Ref.get(lastUsage).pipe(Effect.map((usage): StepInfo => ({ stepIndex: step, activeTools, lastUsage: usage })))

  const planFor = (info: StepInfo) => Ref.get(cached).pipe(Effect.flatMap((current) =>
    Option.isSome(current) && current.value.step === info.stepIndex
      ? Effect.succeed(current.value.plan)
      : request.plan(info).pipe(Effect.tap((plan) => Ref.set(cached, Option.some({ step: info.stepIndex, plan })))),
  ))

  const endStep = (step: number, status: StepStatus) => Effect.gen(function* () {
    const done = yield* Ref.get(ended)
    if (done.has(step)) return
    yield* Ref.set(ended, new Set([...done, step]))
    const recorded = (yield* Ref.get(results)).get(step) ?? []
    yield* request.events.publish({ _tag: "step.ended", step, status, results: recorded })
  })

  const evaluate = (info: StepInfo): Effect.Effect<CompletionVerdict, HarnessError> => request.completion(info).pipe(
    Effect.tap((verdict) => request.events.publish({ _tag: "completion.evaluated", step: info.stepIndex, verdict })),
  )

  const isComplete = () => Effect.gen(function* () {
    const step = yield* currentStep
    yield* endStep(step, "completed")
    const info = yield* infoOf(step, yield* request.tools.active)
    const first = yield* evaluate(info)
    if (first.complete || first.awaiting.length === 0) return first.complete
    yield* request.tasks.await(first.awaiting)
    return (yield* evaluate(info)).complete
  }).pipe(Effect.orDie)

  const onEvent = (event: LoopEvent): Effect.Effect<void> => {
    if (event.type === "assistant_delta") {
      return request.events.publish({ _tag: "assistant.delta", step: event.turnIndex, channel: event.channel, id: event.id, delta: event.delta }).pipe(Effect.orDie)
    }
    if (event.type === "assistant_message") {
      return Effect.gen(function* () {
        if (!isPlanned(event.turnIndex)) yield* Ref.set(lastUsage, Option.some(event.usage))
        yield* request.events.publish({
          _tag: "assistant.message", step: event.turnIndex, text: event.text, reasoning: event.reasoning,
          model: Option.fromNullishOr(event.model), toolCalls: event.toolCalls.map((call) => ({ id: call.id, tool: call.toolName, input: call.args })),
          usage: event.usage,
        })
      }).pipe(Effect.orDie)
    }
    if (event.type === "turn_end") {
      const ending = endStep(event.turnIndex, event.status)
      // A step that already failed must not fail again on its way out.
      return event.status === "completed" ? ending.pipe(Effect.orDie) : ending.pipe(Effect.catchCause(() => Effect.void))
    }
    return Effect.void
  }

  const loop = runLoop<Record<string, Tool.Any>>({
    system: "",
    messages: [],
    toolkit: request.tools.toolkit,
    maxSteps: request.limits.maxSteps,
    toolConcurrency: request.limits.toolConcurrency,
    streaming: request.limits.streaming,
    requireCompletion: request.limits.requireCompletion,
    pollableTools: request.tools.pollable,
    ...Option.match(request.correctives, { onNone: () => ({}), onSome: (correctives) => ({ correctives }) }),
    ...Option.match(request.initial, { onNone: () => ({}), onSome: (batch) => ({ initialStep: batch.calls }) }),
    activeTools: () => Effect.gen(function* () {
      const step = yield* currentStep
      const active = yield* request.tools.active
      yield* Ref.update(steps, (count) => Math.max(count, step + 1))
      yield* request.events.publish({ _tag: "step.started", step, planned: isPlanned(step), activeTools: active })
      return active
    }).pipe(Effect.orDie),
    prepareModel: (step) => infoOf(step.stepIndex, step.activeTools).pipe(
      Effect.flatMap(planFor),
      Effect.map((plan) => ({ model: Option.getOrElse(plan.model, () => model), system: Prompt.make([{ role: "system", content: plan.system }]) })),
      Effect.orDie,
    ),
    render: (view) => isPlanned(view.stepIndex)
      ? Effect.succeed<ReadonlyArray<AgentMessage>>([])
      : planFor(view).pipe(Effect.map((plan) => plan.messages), Effect.orDie),
    stepDirective: (view) => isPlanned(view.stepIndex)
      ? Effect.succeed({ toolChoice: Option.none<LoopToolChoice>() })
      : planFor(view).pipe(Effect.map((plan) => ({ toolChoice: plan.toolChoice })), Effect.orDie),
    isComplete,
    pendingInput: () => request.steering.pipe(Effect.orDie),
    onTail: (messages) => Effect.gen(function* () {
      const step = yield* currentStep
      const entries = yield* request.record(step, messages)
      const recorded = resultsOf(entries)
      yield* recorded.length === 0 ? Effect.void : Ref.update(results, (all) => new Map([...all, [step, [...(all.get(step) ?? []), ...recorded]]]))
      return []
    }).pipe(Effect.orDie),
    onEvent,
  })
  const handlers = request.handlers as Context.Context<Tool.HandlersFor<Record<string, Tool.Any>>>
  const result = yield* harnessDefectsAsFailures(loop.pipe(
    Effect.provide(handlers),
    Effect.provideService(LanguageModel.LanguageModel, model),
    Effect.provideService(CurrentPromptCacheKey, request.cacheKey),
    Effect.mapError((error) => error instanceof HarnessError ? error : new HarnessError({ code: "loop.failed", message: String(error) })),
  ))
  return {
    outcome: result.outcome === "ok" ? "completed" : "partial",
    reason: result.reason,
    text: result.finalText,
    steps: yield* Ref.get(steps),
  } satisfies RunResult
})

export const StepLoopLive = Layer.succeed(StepLoop, StepLoop.of({ ...STEP_LOOP, run: runSteps }))

/** The step loop as a runtime plugin; the turn supplies everything per run. */
export const stepLoopPlugin = definePlugin({
  id: "@xandreed/plugin-agent-loop/steps", version: "0.7.0-next.0", scope: "runtime",
  config: Schema.Struct({}), defaults: {},
  provides: [StepLoop],
  layer: () => StepLoopLive,
})
