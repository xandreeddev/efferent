import { Context, Deferred, Effect, Exit, Option, Ref, Schema } from "effect"
import { LanguageModel } from "effect/ai"
import {
  AcceptedModelInput as AcceptedInputSchema,
  assistantUsage,
  canonicalJson,
  CurrentAgentRun,
  CurrentAgentStep,
  CurrentModelCallPolicy,
  CurrentPromptCacheKey,
  CurrentTraceContent,
  fingerprintOf,
  formatModelSelection,
  freezeModelRequest,
  HarnessError,
  harnessDefectsAsFailures,
  isBudgetTokens,
  ModelCatalog,
  ModelOverflowEvidence,
  modelRequestDescriptorOf,
  parseModelSelection,
  replayableContext,
  resolveModelRequest,
  scaledTokens,
  StepLoop,
  TurnEvents,
  TurnMemory,
  TurnPrompt,
  TurnTasks,
  TurnToolbox,
} from "@xandreed/core"
import type {
  AcceptedModelInput,
  CompletionVerdict,
  EntryId,
  LoopLimits,
  MemoryRenderRecipe,
  ModelChoice,
  ModelLimits,
  ModelRequestHeader,
  ModelSelection,
  RunResult,
  RunTools,
  RunRef,
  StepDirective,
  StepInfo,
  StepPlan,
  StepRequest,
  TurnError,
  TurnPolicy,
  TurnRunOptions,
} from "@xandreed/core"
import {
  checkModelRequest,
  entriesSendingMedia,
  estimateTokens,
  markVolatileContext,
  modelRequestHeaderOf,
  modelRequestTools,
  reconstructModelRequest,
  toolParametersSchema,
} from "@xandreed/core/internal"
import { TurnObservation } from "./turn-observation.entity.js"
import { matchingObservation, observeAcceptedInput } from "./turn-observation.entity.functions.js"
import { tighterOverflowBudget } from "./turn-overflow.entity.functions.js"

/** What a step's plan decided before it built the context: the model choice, the system prompt, the directive. */
interface StepDecision {
  readonly choice: Option.Option<ModelChoice>
  readonly system: string
  readonly directive: StepDirective
}

/** The step planned last: its decision, its resolved model, and the build its request was made of. */
interface PlannedStep {
  readonly run: RunRef
  readonly step: number
  readonly decision: StepDecision
  readonly model: Option.Option<LanguageModel.LanguageModel>
  readonly through: Option.Option<EntryId>
  readonly render: MemoryRenderRecipe
  readonly fingerprint: string
  readonly estimatedTokens: number
  readonly reservedTokens: number
  readonly baseReservedTokens: number
  readonly identity: Option.Option<ModelSelection>
  readonly header: ModelRequestHeader
  readonly outgoing: StepPlan
}

/** The longest provider message an `OmitMedia` compaction keeps as its reason. */
const MEDIA_REJECTION_CHARS = 500

/**
 * The turn services one run reads.
 *
 * @public
 */
export type TurnRunServices = TurnMemory | TurnToolbox | TurnPrompt | TurnEvents | TurnTasks

/** A prepared request and its once-only maintenance after a successful loop return. @public */
export interface PreparedRun {
  readonly request: StepRequest
  readonly afterRun: Effect.Effect<void, TurnError>
}

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

/**
 * The prompt-cache key of a conversation: `<prefix>:<conversation>`, none without a prefix.
 *
 * @public
 */
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
 * `request.diverged` before the provider is called. The returned `afterRun`
 * is cached and runs advisory maintenance once after a successful loop return,
 * with this run's last accepted input and the durable context, without its
 * obsolete StepContext. Manual hosts call it after `StepLoop.run(request)`;
 * `runTurnLoop` does so for completed and partial results. It needs no extra
 * scope and keeps helper recorder failures as their original `TurnError`.
 *
 * @public
 */
export const prepareRun = Effect.fnUntraced(function* <P = never>(policy: TurnPolicy<P>, options: TurnRunOptions = {}): Effect.fn.Return<PreparedRun, TurnError, P | TurnRunServices> {
  const runServices = replayableContext(yield* Effect.context<P>())
  const memory = yield* TurnMemory
  const prompt = yield* TurnPrompt
  const events = yield* TurnEvents
  const tasks = yield* TurnTasks
  const tools = yield* (yield* TurnToolbox).tools
  const session = memory.session
  const run = yield* memory.startRun
  const inRun = <A, E>(effect: Effect.Effect<A, E, P>, step: Option.Option<number> = Option.none()): Effect.Effect<A, E> => effect.pipe(
    Effect.provideService(CurrentAgentRun, Option.some(run)),
    Effect.provideService(CurrentAgentStep, step),
    Effect.provide(runServices),
  )
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
  const renderScope = { run: run.ordinal, stepContext: stepContext === "tail" ? "tail" as const : "none" as const }
  yield* inRun(session.maintain({ phase: "turn-start", lastUsage: Option.none(), budgetTokens: budget, views: tools.views, render: renderScope }))

  // The step planned last, and what its build sent: the refusal names that build's images. `replanning`
  // is the step `onMediaRejected` refused, once: only its next plan keeps the model choice, system
  // prompt, directive and resolved model; any other plan of a step decides again.
  const planned = yield* Ref.make(Option.none<PlannedStep>())
  const replanning = yield* Ref.make(Option.none<PlannedStep>())
  const privatePlans = yield* Ref.make<ReadonlyMap<string, PlannedStep>>(new Map())
  const dispatched = yield* Ref.make<ReadonlyMap<number, PlannedStep>>(new Map())
  const recovery = yield* Ref.make(Option.none<PlannedStep>())
  const recoveryClaims = yield* Ref.make<ReadonlyMap<number, Deferred.Deferred<boolean, TurnError>>>(new Map())
  const inputCeiling = yield* Ref.make(budget)
  const observed = yield* Ref.make<TurnObservation>({ observed: Option.none(), usage: Option.none(), baseReservedTokens: Option.none() })
  const recoveryOutcome = Effect.fnUntraced(function* (done: Deferred.Deferred<boolean, TurnError>): Effect.fn.Return<boolean, TurnError> {
    if (!(yield* Deferred.isDone(done))) return false
    const terminal = yield* Deferred.await(done).pipe(Effect.interruptible, Effect.exit)
    return Exit.isFailure(terminal) ? yield* terminal : false
  })
  const decide = (info: StepInfo): Effect.Effect<StepDecision, TurnError> => Effect.gen(function* () {
    const choice = policy.model === undefined ? Option.none<ModelChoice>() : yield* inRun(policy.model(info), Option.some(info.stepIndex))
    const system = yield* inRun(prompt.system(Option.flatMap(choice, (value) => value.variant)), Option.some(info.stepIndex))
    const directive = policy.step === undefined ? noDirective : yield* inRun(policy.step(info), Option.some(info.stepIndex))
    yield* Option.match(directive.context, {
      onNone: () => Effect.void,
      onSome: (text) => session.record([{ _tag: "StepContext", step: info.stepIndex, run: run.ordinal, text }], info.stepIndex).pipe(Effect.asVoid),
    })
    return { choice, system, directive }
  }).pipe(Effect.provideService(CurrentAgentRun, Option.some(run)), Effect.provideService(CurrentAgentStep, Option.some(info.stepIndex)))

  const plan = (info: StepInfo): Effect.Effect<StepPlan, TurnError> => Effect.gen(function* () {
    const ready = Option.filter(yield* Ref.get(recovery), (candidate) => candidate.step === info.stepIndex)
    if (Option.isSome(ready)) {
      yield* Ref.set(recovery, Option.none())
      yield* Ref.set(planned, ready)
      return ready.value.outgoing
    }
    const ceiling = yield* Ref.get(inputCeiling)
    const again = Option.filter(yield* Ref.getAndSet(replanning, Option.none()), (last) => last.step === info.stepIndex)
    const { choice, system, directive } = Option.isSome(again) ? again.value.decision : yield* decide(info)
    const stepText = stepContext === "system" ? Option.getOrElse(directive.context, () => "") : ""
    const finalSystem = [system, stepText].filter((part) => part.length > 0).join("\n\n")
    const toolTokens = schemaTokens(tools, info.activeTools)
    const reserved = estimateTokens(finalSystem) + toolTokens
    const baseReserved = estimateTokens(system) + toolTokens
    if (ceiling <= reserved) {
      return yield* Effect.fail(failure("context.budget",
        `The system prompt and tool schemas take ${reserved} tokens, all of the ${ceiling}-token context budget: raise budgetTokens or offer fewer tools`))
    }
    // Resolve once before maintenance so only matching selected evidence applies.
    const model = Option.isSome(again) ? again.value.model : yield* Option.match(Option.orElse(Option.map(choice, (value) => value.model), () => defaultModel), {
      onNone: () => Effect.succeed(Option.none<LanguageModel.LanguageModel>()),
      onSome: (chosen) => resolveModelRequest(chosen).pipe(Effect.map(Option.some)),
    })
    const descriptor = yield* Option.match(model, { onNone: () => Effect.succeed(Option.none()), onSome: modelRequestDescriptorOf })
    const identity = Option.flatMap(descriptor, (value) => parseModelSelection(`${value.provider}:${value.model}`))
    const prior = matchingObservation(identity, (yield* Ref.get(observed)).observed)
    yield* session.maintain({
      phase: "step", lastUsage: info.lastUsage, budgetTokens: ceiling - reserved, views: tools.views, render: renderScope,
      ...Option.match(prior, { onNone: () => ({}), onSome: (observed) => ({ observed }) }),
    })
    const built = yield* session.build({ stepContext: stepContext === "tail" ? "tail" : "none", run: run.ordinal })
    const render = yield* session.renderRecipe(stepContext === "tail" ? "tail" : "none", run.ordinal)
    // Scalars belong to this exact cut, before context.built reactions can append.
    const header: ModelRequestHeader = {
      version: 1, runId: run.id, run: run.ordinal, step: info.stepIndex,
      strategyVersion: session.strategy.version, system: finalSystem, render,
      through: built.through, contextFingerprint: built.fingerprint, stableMessages: built.stableMessages,
      tools: modelRequestTools(info.activeTools.flatMap((name) => tools.toolkit.tools[name] === undefined ? [] : [tools.toolkit.tools[name]])),
      toolChoice: Option.getOrElse(directive.toolChoice, () => "auto"), model: descriptor, cacheKey, callPolicy,
    }
    const outgoing: StepPlan = { model, system: finalSystem, messages: markVolatileContext(built.messages, built.stableMessages), toolChoice: directive.toolChoice }
    const frozen: PlannedStep = {
      run, step: info.stepIndex, decision: { choice, system, directive }, model, identity,
      through: built.through, render, fingerprint: built.fingerprint,
      estimatedTokens: built.estimatedTokens, reservedTokens: reserved, baseReservedTokens: baseReserved,
      header, outgoing,
    }
    // A reaction may record memory now: the header's cut (`through`) keeps it for the next step.
    yield* events.publish({
      _tag: "context.built", step: info.stepIndex, turn: run.turn, run: run.ordinal,
      strategy: session.strategy.id, strategyVersion: session.strategy.version,
      fingerprint: built.fingerprint, systemFingerprint: fingerprintOf(system),
      estimatedTokens: built.estimatedTokens, reservedTokens: reserved, budgetTokens: ceiling,
      compactions: built.compactions.length, activeTools: info.activeTools,
    })
    yield* memory.prepareRequest(header)
    yield* Ref.update(privatePlans, (all) => new Map([...all, [canonicalJson(header), frozen]]))
    yield* Ref.set(planned, Option.some(frozen))
    return outgoing
  }).pipe(Effect.provideService(CurrentAgentRun, Option.some(run)), Effect.provideService(CurrentAgentStep, Option.some(info.stepIndex)))

  const request: StepRequest = {
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
      const frozen = (yield* Ref.get(privatePlans)).get(canonicalJson(header))
      yield* Ref.update(dispatched, (all) => {
        const next = new Map(all)
        if (frozen === undefined) next.delete(step)
        else next.set(step, { ...frozen, header })
        return next
      })
    }),
    record: (step, tail, accepted?: AcceptedModelInput) => Effect.gen(function* () {
      const sent = Option.fromNullishOr((yield* Ref.get(dispatched)).get(step))
      const prepared = Option.fromNullishOr([...(yield* Ref.get(privatePlans)).values()].findLast((plan) => plan.step === step))
      const frozen = Option.filter(Option.orElse(sent, () => prepared), (plan) => plan.run.id === run.id && plan.run.ordinal === run.ordinal)
      const usage = Option.flatMap(Option.fromNullishOr(tail.find((message) => message.role === "assistant")), assistantUsage)
      const candidate = accepted === undefined ? Option.none<TurnObservation>() : yield* Schema.encodeEffect(Schema.fromJsonString(AcceptedInputSchema))(accepted).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(AcceptedInputSchema))),
        Effect.map((fact): TurnObservation => ({
          observed: Option.flatMap(frozen, (plan) => observeAcceptedInput({ estimatedTokens: plan.estimatedTokens, reservedTokens: plan.reservedTokens }, fact)),
          usage,
          baseReservedTokens: Option.map(frozen, (plan) => plan.baseReservedTokens),
        })),
        Effect.flatMap((state) => Schema.encodeEffect(Schema.fromJsonString(TurnObservation))(state)),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TurnObservation))),
        Effect.map(Option.some),
        Effect.mapError((cause) => new HarnessError({ code: "request.diverged", message: "accepted model input did not encode", cause })),
      )
      const recorded = yield* session.recordTail(tail, tools.views, step, run.ordinal)
      yield* Option.match(candidate, { onNone: () => Effect.void, onSome: (state) => Ref.set(observed, state) })
      return recorded
    }).pipe(
      Effect.provideService(CurrentAgentRun, Option.some(run)), Effect.provideService(CurrentAgentStep, Option.some(step)),
    ),
    onContextOverflow: Effect.fnUntraced(function* (step, evidence) {
      const known = (yield* Ref.get(recoveryClaims)).get(step)
      if (known !== undefined) return yield* recoveryOutcome(known)
      const failed = (yield* Ref.get(dispatched)).get(step)
      if (failed === undefined) return false
      return yield* Effect.uninterruptible(Effect.gen(function* () {
        const fresh = yield* Deferred.make<boolean, TurnError>()
        const previous = yield* Ref.modify(recoveryClaims, (all) => [Option.fromNullishOr(all.get(step)), all.has(step) ? all : new Map([...all, [step, fresh]])] as const)
        if (Option.isSome(previous)) return yield* recoveryOutcome(previous.value)
        const operation = inRun(harnessDefectsAsFailures(Effect.gen(function* () {
          const facts = yield* Option.match(Option.fromNullishOr(evidence), {
            onNone: () => Effect.succeed(Option.none<ModelOverflowEvidence>()),
            onSome: (fact) => Schema.encodeEffect(Schema.fromJsonString(ModelOverflowEvidence))(fact).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ModelOverflowEvidence))), Effect.map(Option.some),
              Effect.mapError((cause) => new HarnessError({ code: "request.diverged", message: "overflow evidence did not encode", cause })),
            ),
          })
          yield* memory.requestSnapshot
          const identity = Option.orElse(Option.map(facts, (fact) => fact.model), () => failed.identity)
          const catalog = yield* Option.match(Context.getOption(runServices, ModelCatalog), { onNone: () => Effect.succeed([]), onSome: (service) => service.list })
          const limits = Option.flatMap(identity, (selection) => Option.fromNullishOr(catalog.find((entry) => entry.selection === formatModelSelection(selection))?.limits))
          const contextWindow = Option.orElse(Option.flatMap(facts, (fact) => Option.fromNullishOr(fact.limits.contextWindow)), () => Option.flatMap(limits, (value) => Option.fromNullishOr(value.contextWindow)))
          // A missing attempted cap is unknown, even if a catalog lists a maximum.
          const output = Option.flatMap(facts, (fact) => Option.fromNullishOr(fact.limits.maxOutputTokens))
          const bounds: ModelLimits = {
            ...Option.match(contextWindow, { onNone: () => ({}), onSome: (contextWindow) => ({ contextWindow }) }),
            ...Option.match(output, { onNone: () => ({}), onSome: (maxOutputTokens) => ({ maxOutputTokens }) }),
          }
          const sameObservation = freezeModelRequest(matchingObservation(identity, (yield* Ref.get(observed)).observed))
          const failedComparable = scaledTokens(failed.estimatedTokens, sameObservation)
          const tighter = tighterOverflowBudget(yield* Ref.get(inputCeiling), failed.reservedTokens, failedComparable, bounds)
          if (Option.isNone(tighter)) return false
          yield* Ref.update(inputCeiling, (previous) => Math.min(previous, tighter.value.inputCeiling))
          yield* session.maintain({
            phase: "overflow", lastUsage: (yield* Ref.get(observed)).usage, budgetTokens: tighter.value.messageBudget,
            views: tools.views, render: { run: run.ordinal, stepContext: failed.render.stepContext },
            ...Option.match(sameObservation, { onNone: () => ({}), onSome: (observed) => ({ observed }) }),
          })
          const built = yield* session.build({ run: run.ordinal, stepContext: failed.render.stepContext })
          const comparable = scaledTokens(built.estimatedTokens, sameObservation)
          const ceiling = yield* Ref.get(inputCeiling)
          if (comparable >= failedComparable || comparable > Math.min(tighter.value.messageBudget, ceiling - failed.reservedTokens)) return false
          const render = yield* session.renderRecipe(failed.render.stepContext, run.ordinal)
          const header: ModelRequestHeader = { ...failed.header, render, through: built.through, contextFingerprint: built.fingerprint, stableMessages: built.stableMessages }
          const outgoing: StepPlan = { ...failed.outgoing, messages: freezeModelRequest(markVolatileContext(built.messages, built.stableMessages)) }
          const candidate: PlannedStep = { ...failed, through: built.through, render, fingerprint: built.fingerprint, estimatedTokens: built.estimatedTokens, header, outgoing }
          yield* events.publish({
            _tag: "context.built", step, turn: run.turn, run: run.ordinal, strategy: session.strategy.id, strategyVersion: session.strategy.version,
            fingerprint: built.fingerprint, systemFingerprint: fingerprintOf(failed.decision.system), estimatedTokens: built.estimatedTokens,
            reservedTokens: failed.reservedTokens, budgetTokens: ceiling, compactions: built.compactions.length, activeTools: failed.header.tools.map((tool) => tool.name),
          })
          yield* memory.prepareRequest(header)
          yield* Ref.update(privatePlans, (all) => new Map([...all, [canonicalJson(header), candidate]]))
          yield* Ref.set(planned, Option.some(candidate))
          yield* Ref.set(recovery, Option.some(candidate))
          return true
        })), Option.some(step))
        const terminal = yield* operation.pipe(Effect.interruptible, Effect.exit)
        yield* Deferred.done(fresh, terminal)
        return yield* terminal
      }))
    }),
    pendingSteers: memory.pendingSteers,
    steer: (step) => memory.steer(step, run.ordinal),
    recorded: (step) => memory.requestSnapshot.pipe(Effect.map(({ entries }) => entries.filter((entry) =>
      entry.runId === run.id && entry.turn === run.turn && entry.step === step
      && (entry.body._tag === "Message" || entry.body._tag === "ToolResult") && entry.body.run === run.ordinal))),
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
    completion: (info) => policy.completion === undefined ? Effect.succeed(incomplete) : inRun(policy.completion(info), Option.some(info.stepIndex)).pipe(Effect.map(normalVerdict)),
    steering: options.steering ?? Effect.succeed(Option.none()),
    correctives: Option.fromNullishOr(policy.correctives),
    events,
    tasks,
    cacheKey,
    callPolicy,
    captureTraceContent: policy.captureTraceContent ?? options.captureTraceContent ?? (yield* Effect.service(CurrentTraceContent)),
  }
  const maintenance = inRun(harnessDefectsAsFailures(Effect.gen(function* () {
    // The existing fresh snapshot flushes queued step metadata before a helper.
    yield* memory.requestSnapshot
    const last = yield* Ref.get(planned)
    const accepted = yield* Ref.get(observed)
    const evidence = accepted.observed
    const reserve = Option.orElse(accepted.baseReservedTokens, () => Option.map(last, (plan) => plan.baseReservedTokens))
    const remaining = (yield* Ref.get(inputCeiling)) - Option.getOrElse(reserve, () => 0)
    yield* session.maintain({
      phase: "turn-end", lastUsage: accepted.usage, budgetTokens: Math.max(1, remaining), views: tools.views,
      render: { run: run.ordinal, stepContext: "none" },
      ...Option.match(evidence, { onNone: () => ({}), onSome: (observed) => ({ observed }) }),
    })
  })))
  // Effect.cached deliberately retries interruptions. This turn-owned terminal
  // latch retains every exit, while arbitrary maintenance remains interruptible.
  const terminal = yield* Ref.make(Option.none<Deferred.Deferred<void, TurnError>>())
  const afterRun = Effect.uninterruptible(Effect.gen(function* () {
    const fresh = yield* Deferred.make<void, TurnError>()
    const previous = yield* Ref.modify(terminal, (existing) => [existing, Option.orElse(existing, () => Option.some(fresh))] as const)
    if (Option.isSome(previous)) return yield* Deferred.await(previous.value).pipe(Effect.interruptible)
    const exit = yield* maintenance.pipe(Effect.interruptible, Effect.exit)
    yield* Deferred.done(fresh, exit)
    return yield* exit
  }))
  return { request, afterRun }
})

/** Prepare a request only; manual hosts use prepareRun for its afterRun lifecycle. @public */
export const stepRequestOf = <P = never>(policy: TurnPolicy<P>, options: TurnRunOptions = {}): Effect.Effect<StepRequest, TurnError, P | TurnRunServices> =>
  prepareRun(policy, options).pipe(Effect.map((prepared) => prepared.request))

/**
 * One run of the turn: prepare, StepLoop, then cached maintenance on success.
 *
 * @public
 */
export const runTurnLoop = <P = never>(policy: TurnPolicy<P>, options: TurnRunOptions = {}): Effect.Effect<RunResult, TurnError, P | TurnRunServices | StepLoop> =>
  prepareRun(policy, options).pipe(Effect.flatMap(({ request, afterRun }) => StepLoop.pipe(Effect.flatMap((loop) => loop.run(request).pipe(Effect.tap(() => afterRun))))))
