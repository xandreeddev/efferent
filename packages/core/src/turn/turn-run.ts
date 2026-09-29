import { Context, Effect, Option } from "effect"
import { toolParametersSchema } from "../loop/toolSchema.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import { canonicalJson, estimateTokens, fingerprintOf } from "../memory/memory-log.entity.functions.js"
import type { StepDirective, StepInfo } from "../ports/capability.port.js"
import { StepLoop } from "../ports/step-loop.port.js"
import type { LoopLimits, RunResult, StepPlan, StepRequest } from "../ports/step-loop.port.js"
import type { RunTools } from "../ports/tool-registry.port.js"
import { TurnEvents, TurnTasks } from "../ports/turn-events.port.js"
import type { TurnPolicy } from "../ports/turn.port.js"
import { TurnMemory, TurnPrompt, TurnToolbox } from "../ports/turn-scope.port.js"
import type { TurnRunOptions } from "../ports/turn-scope.port.js"
import type { CompletionVerdict } from "./turn-event.entity.js"

/** The turn services one run reads. */
export type TurnRunServices = TurnMemory | TurnToolbox | TurnPrompt | TurnEvents | TurnTasks

const defaultLimits: LoopLimits = { maxSteps: 50, toolConcurrency: 1, streaming: true, requireCompletion: false }
const defaultBudgetTokens = 64_000
const incomplete: CompletionVerdict = { complete: false, awaiting: [], facts: {} }
const noDirective: StepDirective = { context: Option.none(), toolChoice: Option.none() }

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
 * order: the policy's planned skills are activated, the turn-tier sections
 * are recorded, and memory is maintained for the turn's start. Everything
 * where this runs (the policy's services, the turn's, a host layer's) is
 * captured: the policy callbacks, the prompt sections and the tool handlers
 * run with it.
 */
export const stepRequestOf = <P>(policy: TurnPolicy<P>, options: TurnRunOptions = {}): Effect.Effect<StepRequest, HarnessError, P | TurnRunServices> =>
  Effect.gen(function* () {
    const runServices = yield* Effect.context<P>()
    const inRun = <A>(effect: Effect.Effect<A, HarnessError, P>): Effect.Effect<A, HarnessError> => effect.pipe(Effect.provide(runServices))
    const memory = yield* TurnMemory
    const prompt = yield* TurnPrompt
    const events = yield* TurnEvents
    const tasks = yield* TurnTasks
    const tools = yield* (yield* TurnToolbox).tools
    const session = memory.session
    const number = yield* memory.number
    const limits: LoopLimits = { ...defaultLimits, ...options.limits, ...policy.limits }
    const budget = policy.budgetTokens ?? options.budgetTokens ?? defaultBudgetTokens
    const stepContext = policy.stepContext ?? "tail"
    yield* Option.match(Option.fromNullishOr(policy.initial), {
      onNone: () => Effect.void,
      onSome: (batch) => batch.skills.length === 0 ? Effect.void : tools.activate(batch.skills, "host").pipe(Effect.asVoid),
    })
    yield* inRun(prompt.turnSections)
    yield* session.maintain({ phase: "turn-start", lastUsage: Option.none(), budgetTokens: budget, views: tools.views })

    const plan = (info: StepInfo): Effect.Effect<StepPlan, HarnessError> => Effect.gen(function* () {
      const choice = policy.model === undefined ? Option.none() : yield* inRun(policy.model(info))
      const system = yield* inRun(prompt.system(Option.flatMap(choice, (value) => value.variant)))
      const directive = policy.step === undefined ? noDirective : yield* inRun(policy.step(info))
      yield* Option.match(directive.context, {
        onNone: () => Effect.void,
        onSome: (text) => session.record([{ _tag: "StepContext", step: info.stepIndex, text }], info.stepIndex).pipe(Effect.asVoid),
      })
      const reserved = estimateTokens(system) + schemaTokens(tools, info.activeTools)
      yield* session.maintain({ phase: "step", lastUsage: info.lastUsage, budgetTokens: Math.max(1, budget - reserved), views: tools.views })
      const built = yield* session.build({ stepContext: stepContext === "tail" ? "tail" : "none" })
      yield* events.publish({
        _tag: "context.built", step: info.stepIndex, turn: number,
        strategy: session.strategy.id, strategyVersion: session.strategy.version,
        fingerprint: built.fingerprint, systemFingerprint: fingerprintOf(system),
        estimatedTokens: built.estimatedTokens, reservedTokens: reserved,
        compactions: built.compactions.length, activeTools: info.activeTools,
      })
      const stepText = stepContext === "system" ? Option.getOrElse(directive.context, () => "") : ""
      return {
        model: Option.map(choice, (value) => value.model),
        system: [system, stepText].filter((part) => part.length > 0).join("\n\n"),
        messages: built.messages,
        toolChoice: directive.toolChoice,
      }
    })

    return {
      tools,
      handlers: Context.merge(runServices, tools.handlers),
      limits,
      initial: Option.fromNullishOr(policy.initial),
      plan,
      record: (step, tail) => session.recordTail(tail, tools.views, step),
      completion: (info) => policy.completion === undefined ? Effect.succeed(incomplete) : inRun(policy.completion(info)),
      steering: options.steering ?? Effect.succeed(Option.none()),
      correctives: Option.fromNullishOr(policy.correctives),
      events,
      tasks,
      cacheKey: options.cacheKey ?? Option.none(),
    } satisfies StepRequest
  })

/** One run of the turn: `stepRequestOf`, then the StepLoop. */
export const runTurnLoop = <P>(policy: TurnPolicy<P>, options: TurnRunOptions = {}): Effect.Effect<RunResult, HarnessError, P | TurnRunServices | StepLoop> =>
  stepRequestOf(policy, options).pipe(Effect.flatMap((request) => StepLoop.pipe(Effect.flatMap((loop) => loop.run(request)))))
