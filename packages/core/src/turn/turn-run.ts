import { Context, Effect, Option, Ref } from "effect"
import { LanguageModel } from "effect/ai"
import { toolParametersSchema } from "../loop/toolSchema.js"
import { isBudgetTokens } from "../domain/token-usage.entity.functions.js"
import { HarnessError } from "../harness/plugin.entity.js"
import { canonicalJson, entriesSendingMedia, estimateTokens, fingerprintOf } from "../memory/memory-log.entity.functions.js"
import type { EntryId } from "../memory/memory-log.entity.js"
import type { ModelChoice, StepDirective, StepInfo } from "../ports/capability.port.js"
import { StepLoop } from "../ports/step-loop.port.js"
import type { LoopLimits, RunResult, StepPlan, StepRequest } from "../ports/step-loop.port.js"
import type { RunTools } from "../ports/tool-registry.port.js"
import { TurnEvents, TurnTasks } from "../ports/turn-events.port.js"
import type { TurnPolicy } from "../ports/turn.port.js"
import { TurnMemory, TurnPrompt, TurnToolbox } from "../ports/turn-scope.port.js"
import type { TurnRunOptions } from "../ports/turn-scope.port.js"
import type { TurnError } from "../session/sessions.entity.js"
import type { CompletionVerdict } from "./turn-event.entity.js"
import type { MemoryRenderRecipe } from "./model-request.entity.js"
import { CurrentPromptCacheKey } from "../loop/cacheKey.js"
import { CurrentModelCallPolicy } from "../loop/modelPolicy.js"
import { CurrentTraceContent, replayableContext } from "../loop/traceContent.js"
import {
  checkModelRequest,
  modelRequestDescriptorOf,
  modelRequestHeaderOf,
  modelRequestTools,
  reconstructModelRequest,
  resolveModelRequest,
} from "./model-request.entity.functions.js"

/** What a step's plan decided before it built the context: the model choice, the system prompt, the directive. */
interface StepDecision {
  readonly choice: Option.Option<ModelChoice>
  readonly system: string
  readonly directive: StepDirective
}

/** The step planned last: its decision, its resolved model, and the build its request was made of. */
interface PlannedStep {
  readonly step: number
  readonly decision: StepDecision
  readonly model: Option.Option<LanguageModel.LanguageModel>
  readonly through: Option.Option<EntryId>
  readonly render: MemoryRenderRecipe
}

/** The longest provider message an `OmitMedia` compaction keeps as its reason. */
const MEDIA_REJECTION_CHARS = 500

/** The turn services one run reads. */
export type TurnRunServices = TurnMemory | TurnToolbox | TurnPrompt | TurnEvents | TurnTasks

const defaultLimits: LoopLimits = { maxSteps: 50, toolConcurrency: 1, streaming: true, requireCompletion: false }
const defaultBudgetTokens = 64_000
const incomplete: CompletionVerdict = { complete: false, awaiting: [], facts: {} }
const noDirective: StepDirective = { context: Option.none(), toolChoice: Option.none() }
/** A host's verdict as the loop awaits it and the journal stores it: each awaited tag trimmed, the empty ones dropped. */
const normalVerdict = (verdict: CompletionVerdict): CompletionVerdict => ({
  ...verdict,
  awaiting: verdict.awaiting.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
})
const failure = (code: string, message: string) => new HarnessError({ code, message })

/** The tokens the active tools' descriptions and parameter schemas take in a request. */
export const schemaTokens = (tools: RunTools, active: ReadonlyArray<string>): number =>
  active.reduce((sum, name) => {
    const tool = tools.toolkit.tools[name]
    return tool === undefined ? sum : sum + estimateTokens(`${tool.description ?? ""}${canonicalJson(toolParametersSchema(tool))}`)
  }, 0)

/** The prompt-cache key of a conversation: `<prefix>:<conversation>`, none without a prefix. */
export const cacheKeyOf = (prefix: string, conversation: string): Option.Option<string> =>
  Option.map(Option.filter(Option.some(prefix), (value) => value.length > 0), (value) => `${value}:${conversation}`)

/**
 * Prepare one run of the step loop over the turn's services, in this
 * order: the run is started (`TurnMemory.startRun`: its ordinal is on the
 * run's step contexts, request headers and step events, and its dispatch
 * check reads the header of its own run and step, so each run of a turn
 * rebuilds its own requests), the run's budget is checked (`turn.budget`
 * unless it is an integer of at least 1), the policy's planned skills are
 * activated, the turn-tier sections are recorded, and memory is maintained
 * for the turn's start with the whole budget. Each step gives memory what the system prompt and
 * the active tools' schemas leave of the budget, and fails with
 * `context.budget` when they leave nothing. Everything
 * where this runs (the policy's services, the turn's, a host layer's) is
 * captured: the policy callbacks, the prompt sections and the tool handlers
 * run with it, without the span current here (`replayableContext`), so
 * their spans nest under the step that calls them. Trace content is the
 * policy's `captureTraceContent`, else the options', else
 * `CurrentTraceContent` here. When a provider refuses a step's request over
 * an image, `onMediaRejected` records an `OmitMedia` of the images that
 * build sent, and the step's next plan, that one only, rebuilds the context
 * with the same model choice, system prompt, directive and resolved model
 * (no second `policy.model` or `policy.step` call, no second
 * `StepContext`). Any other plan of a step calls the policy again. The
 * request's `cacheKey` is the turn's (`options.cacheKey`), its `callPolicy`
 * the `CurrentModelCallPolicy` where this runs, read once; each request
 * header records both, and the dispatch check compares them with what the
 * model call will read, `CurrentPromptCacheKey` and `CurrentModelCallPolicy`
 * where the loop dispatches, so a loop that does not provide the request's
 * `cacheKey` and `callPolicy` (`StepLoopReferences`) fails with
 * `request.diverged` before the provider is called.
 */
export const stepRequestOf = Effect.fnUntraced(function* <P>(policy: TurnPolicy<P>, options: TurnRunOptions = {}): Effect.fn.Return<StepRequest, TurnError, P | TurnRunServices> {
  const runServices = replayableContext(yield* Effect.context<P>())
  const inRun = <A, E>(effect: Effect.Effect<A, E, P>): Effect.Effect<A, E> => effect.pipe(Effect.provide(runServices))
  const memory = yield* TurnMemory
  const prompt = yield* TurnPrompt
  const events = yield* TurnEvents
  const tasks = yield* TurnTasks
  const tools = yield* (yield* TurnToolbox).tools
  const session = memory.session
  const run = yield* memory.startRun
  const defaultModel = Context.getOption(runServices, LanguageModel.LanguageModel)
  const limits: LoopLimits = { ...defaultLimits, ...options.limits, ...policy.limits }
  const budget = policy.budgetTokens ?? options.budgetTokens ?? defaultBudgetTokens
  if (!isBudgetTokens(budget)) return yield* Effect.fail(failure("turn.budget", `budgetTokens must be an integer of at least 1, not ${budget}`))
  const stepContext = policy.stepContext ?? "tail"
  const cacheKey = options.cacheKey ?? Option.none()
  const callPolicy = yield* Effect.service(CurrentModelCallPolicy)
  yield* Option.match(Option.fromNullishOr(policy.initial), {
    onNone: () => Effect.void,
    onSome: (batch) => batch.skills.length === 0 ? Effect.void : tools.activate(batch.skills, "host").pipe(Effect.asVoid),
  })
  yield* inRun(prompt.turnSections)
  yield* session.maintain({ phase: "turn-start", lastUsage: Option.none(), budgetTokens: budget, views: tools.views })

  // The step planned last, and what its build sent: the refusal names that build's images. `replanning`
  // is the step `onMediaRejected` refused, once: only its next plan keeps the model choice, system
  // prompt, directive and resolved model; any other plan of a step decides again.
  const planned = yield* Ref.make(Option.none<PlannedStep>())
  const replanning = yield* Ref.make(Option.none<PlannedStep>())
  const decide = (info: StepInfo): Effect.Effect<StepDecision, TurnError> => Effect.gen(function* () {
    const choice = policy.model === undefined ? Option.none<ModelChoice>() : yield* inRun(policy.model(info))
    const system = yield* inRun(prompt.system(Option.flatMap(choice, (value) => value.variant)))
    const directive = policy.step === undefined ? noDirective : yield* inRun(policy.step(info))
    yield* Option.match(directive.context, {
      onNone: () => Effect.void,
      onSome: (text) => session.record([{ _tag: "StepContext", step: info.stepIndex, run: run.ordinal, text }], info.stepIndex).pipe(Effect.asVoid),
    })
    return { choice, system, directive }
  })

  const plan = (info: StepInfo): Effect.Effect<StepPlan, TurnError> => Effect.gen(function* () {
    const again = Option.filter(yield* Ref.getAndSet(replanning, Option.none()), (last) => last.step === info.stepIndex)
    const { choice, system, directive } = Option.isSome(again) ? again.value.decision : yield* decide(info)
    const reserved = estimateTokens(system) + schemaTokens(tools, info.activeTools)
    if (budget <= reserved) {
      return yield* Effect.fail(failure("context.budget",
        `The system prompt and tool schemas take ${reserved} tokens, all of the ${budget}-token context budget: raise budgetTokens or offer fewer tools`))
    }
    yield* session.maintain({ phase: "step", lastUsage: info.lastUsage, budgetTokens: budget - reserved, views: tools.views })
    const built = yield* session.build({ stepContext: stepContext === "tail" ? "tail" : "none", run: run.ordinal })
    const render = yield* session.renderRecipe(stepContext === "tail" ? "tail" : "none", run.ordinal)
    // A reaction may record memory now: the header's cut (`through`) keeps it for the next step.
    yield* events.publish({
      _tag: "context.built", step: info.stepIndex, turn: run.turn, run: run.ordinal,
      strategy: session.strategy.id, strategyVersion: session.strategy.version,
      fingerprint: built.fingerprint, systemFingerprint: fingerprintOf(system),
      estimatedTokens: built.estimatedTokens, reservedTokens: reserved, budgetTokens: budget,
      compactions: built.compactions.length, activeTools: info.activeTools,
    })
    const stepText = stepContext === "system" ? Option.getOrElse(directive.context, () => "") : ""
    const finalSystem = [system, stepText].filter((part) => part.length > 0).join("\n\n")
    // Resolved once for the step: the header describes the model every attempt of the step calls.
    const model = Option.isSome(again) ? again.value.model : yield* Option.match(Option.orElse(Option.map(choice, (value) => value.model), () => defaultModel), {
      onNone: () => Effect.succeed(Option.none<LanguageModel.LanguageModel>()),
      onSome: (chosen) => resolveModelRequest(chosen).pipe(Effect.map(Option.some)),
    })
    yield* Ref.set(planned, Option.some({ step: info.stepIndex, decision: { choice, system, directive }, model, through: built.through, render }))
    yield* memory.prepareRequest({
      version: 1, runId: run.id, run: run.ordinal, step: info.stepIndex,
      strategyVersion: session.strategy.version,
      system: finalSystem,
      render,
      through: built.through,
      contextFingerprint: built.fingerprint,
      tools: modelRequestTools(info.activeTools.flatMap((name) => tools.toolkit.tools[name] === undefined ? [] : [tools.toolkit.tools[name]])),
      toolChoice: Option.getOrElse(directive.toolChoice, () => "auto"),
      model: yield* Option.match(model, { onNone: () => Effect.succeed(Option.none()), onSome: modelRequestDescriptorOf }),
      cacheKey,
      callPolicy,
    })
    return {
      model,
      system: finalSystem,
      messages: built.messages,
      toolChoice: directive.toolChoice,
    }
  })

  return {
    run,
    tools,
    handlers: Context.merge(runServices, tools.handlers),
    limits,
    initial: Option.fromNullishOr(policy.initial),
    plan,
    dispatch: Effect.fnUntraced(function* (step, actual) {
      const stored = yield* memory.requestSnapshot
      const header = yield* modelRequestHeaderOf(stored.requests, run.id, step, run.ordinal)
      const expected = yield* reconstructModelRequest(header, stored.entries)
      yield* checkModelRequest(expected, {
        prompt: actual.prompt,
        tools: modelRequestTools(actual.tools),
        toolChoice: actual.toolChoice,
        model: yield* modelRequestDescriptorOf(actual.model),
        // What the provider adapter reads at call time, not the turn's own inputs again.
        cacheKey: yield* Effect.service(CurrentPromptCacheKey),
        callPolicy: yield* Effect.service(CurrentModelCallPolicy),
      })
    }),
    record: (step, tail) => session.recordTail(tail, tools.views, step),
    onMediaRejected: Effect.fnUntraced(function* (reason) {
      const last = yield* Ref.get(planned)
      if (Option.isNone(last)) return false
      const entries = yield* session.entries
      const through = last.value.through
      const built = Option.isNone(through) ? [] : entries.slice(0, entries.findIndex((entry) => entry.id === through.value) + 1)
      const sent = entriesSendingMedia(built, last.value.render)
      if (sent.length === 0) return false
      yield* session.record([{
        _tag: "Compaction", strategy: session.strategy.id, version: session.strategy.version,
        action: { _tag: "OmitMedia", entries: sent, reason: reason.slice(0, MEDIA_REJECTION_CHARS) },
      }], last.value.step)
      yield* Ref.set(replanning, last)
      return true
    }),
    completion: (info) => policy.completion === undefined ? Effect.succeed(incomplete) : inRun(policy.completion(info)).pipe(Effect.map(normalVerdict)),
    steering: options.steering ?? Effect.succeed(Option.none()),
    correctives: Option.fromNullishOr(policy.correctives),
    events,
    tasks,
    cacheKey,
    callPolicy,
    captureTraceContent: policy.captureTraceContent ?? options.captureTraceContent ?? (yield* Effect.service(CurrentTraceContent)),
  } satisfies StepRequest
})

/** One run of the turn: `stepRequestOf`, then the StepLoop. */
export const runTurnLoop = <P>(policy: TurnPolicy<P>, options: TurnRunOptions = {}): Effect.Effect<RunResult, TurnError, P | TurnRunServices | StepLoop> =>
  stepRequestOf(policy, options).pipe(Effect.flatMap((request) => StepLoop.pipe(Effect.flatMap((loop) => loop.run(request)))))
