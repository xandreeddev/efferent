import { LanguageModel, Prompt } from "@effect/ai"
import { Context, Effect, JSONSchema, Layer, Option, Ref, Schema } from "effect"
import {
  AgentLoop,
  canonicalJson,
  ConversationMemory,
  Contributions,
  CurrentPromptCacheKey,
  definePlugin,
  estimateTokens,
  fingerprintOf,
  HarnessError,
  RunContext,
  ToolRegistry,
} from "@xandreed/core"
import type {
  AgentMessage,
  Contribution,
  LogEntry,
  MemorySession,
  PromptContext,
  PromptSection,
  RunHooks,
  RunTools,
  StepDirective,
  StepInfo,
} from "@xandreed/core"
import { runLoop } from "./loop.js"
import type { LoopToolChoice, StepView } from "./loop.js"

const Config = Schema.Struct({
  maxSteps: Schema.Int.pipe(Schema.between(1, 1000)),
  toolConcurrency: Schema.Int.pipe(Schema.between(1, 32)),
  streaming: Schema.Boolean,
  requireCompletion: Schema.Boolean,
  /** Prefix of the per-conversation prompt-cache key; empty sends none. */
  cacheKeyPrefix: Schema.String,
  /** Input tokens available to one request (system, tool schemas and messages). */
  budgetTokens: Schema.Int.pipe(Schema.between(1_000, 2_000_000)),
  /** Where the per-step context goes: closing the messages, or appended to the system prompt. */
  stepContext: Schema.Literal("tail", "system"),
  captureTraceContent: Schema.Boolean,
})

const defaults: typeof Config.Type = {
  maxSteps: 50, toolConcurrency: 1, streaming: true, requireCompletion: false, cacheKeyPrefix: "",
  budgetTokens: 64_000, stepContext: "tail", captureTraceContent: false,
}

const failure = (code: string, message: string) => new HarnessError({ code, message })

/** Contributed requirements are erased; the run context provides them all. */
const closeWith = <A, E>(effect: Effect.Effect<A, E, unknown>, context: Context.Context<never>): Effect.Effect<A, E> =>
  effect.pipe(Effect.provide(context)) as Effect.Effect<A, E>

/** Hooks, merged in graph order. */
const hooksOf = (contributions: ReadonlyArray<Contribution>): ReadonlyArray<RunHooks> => contributions.map((contribution) => contribution.hooks)

/** The first Some wins; later hooks are not consulted. */
const firstSome = <A, E, R>(effects: ReadonlyArray<Effect.Effect<Option.Option<A>, E, R>>): Effect.Effect<Option.Option<A>, E, R> =>
  Effect.reduce(effects, Option.none<A>(), (found, next) => Option.isSome(found) ? Effect.succeed(found) : next)

const sortSections = (sections: ReadonlyArray<PromptSection>): ReadonlyArray<PromptSection> =>
  [...sections].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))

const renderSections = (sections: ReadonlyArray<PromptSection>, context: PromptContext) =>
  Effect.forEach(sortSections(sections), (section) => section.render(context).pipe(
    Effect.map((text) => Option.map(text, (value) => ({ section, text: value }))),
  )).pipe(Effect.map((rendered) => rendered.flatMap(Option.toArray)))

const schemaTokens = (tools: RunTools, active: ReadonlyArray<string>): number =>
  active.reduce((sum, name) => {
    const tool = tools.toolkit.tools[name]
    return tool === undefined ? sum : sum + estimateTokens(`${tool.description ?? ""}${canonicalJson(JSONSchema.make(tool.parametersSchema))}`)
  }, 0)

/**
 * The composable agent loop. It owns no memory and no tools of its own:
 * the ConversationMemory plugin stores and rebuilds every request, the
 * ToolRegistry plugin owns the tool set and discovery, and contributions
 * supply prompt sections and run policy. Swapping any of those is a plugin
 * entry in the agent config, never a change here.
 */
export const composableLoopPlugin = definePlugin({
  id: "@xandreed/plugin-agent-loop/composable",
  version: "0.5.0",
  config: Config,
  defaults: defaults,
  requires: [LanguageModel.LanguageModel, ToolRegistry, ConversationMemory],
  optional: [Contributions],
  provides: [AgentLoop],
  layer: (config) => Layer.effect(AgentLoop, Effect.gen(function* () {
    const defaultModel = yield* LanguageModel.LanguageModel
    const registry = yield* ToolRegistry
    const memory = yield* ConversationMemory
    const contributions = Option.getOrElse(yield* Effect.serviceOption(Contributions), (): ReadonlyArray<Contribution> => [])
    const hooks = hooksOf(contributions)
    const sections = contributions.flatMap((contribution) => contribution.sections)
    return AgentLoop.of({ run: (input) => Effect.scoped(Effect.gen(function* () {
      const scope = yield* Effect.scope
      const session: MemorySession = yield* memory.open({ conversation: input.session.id, runId: input.runId, io: { publish: input.publish, history: input.history } })
      const toolsRef = yield* Ref.make(Option.none<RunTools>())
      const runContext = RunContext.of({
        conversation: input.session.id,
        runId: input.runId,
        prompt: input.prompt,
        publish: (event) => input.publish(event).pipe(Effect.asVoid),
        memory: session,
        activate: (skills) => Ref.get(toolsRef).pipe(Effect.flatMap(Option.match({
          onNone: () => Effect.fail(failure("tools.unavailable", "Tools are not open yet")),
          onSome: (tools) => tools.activate(skills, "host"),
        }))),
      })
      const base = Context.add(input.services, RunContext, runContext)
      const services = yield* Effect.reduce(contributions, base, (context, contribution) => Option.match(contribution.run, {
        onNone: () => Effect.succeed(context),
        onSome: (layer) => closeWith(Layer.buildWithScope(layer, scope), context).pipe(
          Effect.map((built) => Context.merge(context, built)),
        ),
      }))
      const inRun = <A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> => closeWith(effect, services)

      const turn = (yield* session.turn) + 1
      yield* session.record([{ _tag: "TurnStarted", prompt: input.prompt }], 0)
      const preflight = yield* inRun(firstSome(hooks.flatMap((hook) => Option.toArray(hook.preflight))))
      if (Option.isSome(preflight)) {
        yield* session.record([{ _tag: "TurnEnded", outcome: "completed", reply: preflight }], 0)
        return { text: preflight.value, outcome: "completed" as const }
      }

      const tools = yield* registry.open(session, services)
      yield* Ref.set(toolsRef, Option.some(tools))
      yield* tools.select(input.prompt)
      const planned = yield* inRun(firstSome(hooks.flatMap((hook) => Option.toArray(hook.initialStep))))
      yield* Option.match(planned, { onNone: () => Effect.void, onSome: (batch) => batch.skills.length === 0 ? Effect.void : tools.activate(batch.skills, "host").pipe(Effect.asVoid) })

      const promptContext = (variant: Option.Option<string>) => tools.active.pipe(Effect.map((active): PromptContext => ({ variant, active, skills: tools.skills })))
      const turnSections = yield* inRun(promptContext(Option.none()).pipe(Effect.flatMap((context) => renderSections(sections.filter((section) => section.tier === "turn"), context))))
      yield* turnSections.length === 0 ? Effect.void : session.record(turnSections.map(({ section, text }) => ({ _tag: "TurnContext" as const, sectionId: section.id, version: section.version, text })), 0)
      yield* session.maintain({ phase: "turn-start", lastUsage: Option.none(), budgetTokens: config.budgetTokens, views: tools.views })

      const lastSystem = yield* Ref.make(Option.fromNullable((yield* session.entries).flatMap((entry: LogEntry) => entry.body._tag === "SystemPrepared" ? [entry.body.fingerprint] : []).at(-1)))
      const systemFor = (variant: Option.Option<string>) => Effect.gen(function* () {
        const context = yield* promptContext(variant)
        const rendered = yield* inRun(renderSections(sections.filter((section) => section.tier !== "turn").sort((left, right) => Number(left.tier === "session") - Number(right.tier === "session")), context))
        const text = [input.system, ...rendered.map((part) => part.text)].filter((part) => part.trim().length > 0).join("\n\n")
        const fingerprint = fingerprintOf(text)
        const previous = yield* Ref.get(lastSystem)
        if (!Option.contains(previous, fingerprint)) {
          yield* session.record([{ _tag: "SystemPrepared", fingerprint, text, sections: rendered.map((part) => ({ id: part.section.id, version: part.section.version, fingerprint: fingerprintOf(part.text) })) }], 0)
          yield* Ref.set(lastSystem, Option.some(fingerprint))
        }
        return text
      })
      const defaultSystem = yield* systemFor(Option.none())

      const directives = yield* Ref.make(new Map<number, StepDirective>())
      const stepInfo = (view: StepView): StepInfo => ({ stepIndex: view.stepIndex, activeTools: view.activeTools, lastUsage: view.lastUsage })
      const directiveFor = (view: StepView) => Effect.gen(function* () {
        const cached = (yield* Ref.get(directives)).get(view.stepIndex)
        if (cached !== undefined) return cached
        const parts = yield* inRun(Effect.forEach(hooks.flatMap((hook) => Option.toArray(hook.step)), (step) => step(stepInfo(view))))
        const text = parts.flatMap((part) => Option.toArray(part.context)).join("\n\n")
        const directive: StepDirective = {
          context: text.length === 0 ? Option.none() : Option.some(text),
          toolChoice: Option.firstSomeOf(parts.map((part) => part.toolChoice)),
        }
        yield* Option.match(directive.context, {
          onNone: () => Effect.void,
          onSome: (context) => session.record([{ _tag: "StepContext", step: view.stepIndex, text: context }], view.stepIndex).pipe(Effect.asVoid),
        })
        yield* Ref.update(directives, (all) => new Map([...all, [view.stepIndex, directive]]))
        return directive
      })
      const latestView = yield* Ref.make<StepView>({ stepIndex: 0, activeTools: [], lastUsage: Option.none() })
      const currentStep = yield* Ref.make(0)
      const correctives = Option.firstSomeOf(hooks.map((hook) => hook.correctives))
      const completionHooks = hooks.flatMap((hook) => Option.toArray(hook.isComplete))
      const modelHooks = hooks.flatMap((hook) => Option.toArray(hook.model))

      const result = yield* closeWith(runLoop({
        system: defaultSystem,
        messages: [],
        toolkit: tools.toolkit,
        maxSteps: config.maxSteps,
        toolConcurrency: config.toolConcurrency,
        streaming: config.streaming,
        requireCompletion: config.requireCompletion,
        captureTraceContent: config.captureTraceContent,
        pollableTools: tools.pollable,
        ...Option.match(correctives, { onNone: () => ({}), onSome: (value) => ({ correctives: value }) }),
        ...Option.match(planned, { onNone: () => ({}), onSome: (batch) => ({ initialStep: batch.calls }) }),
        activeTools: () => tools.active,
        prepareModel: (step) => Effect.gen(function* () {
          const view: StepView = { stepIndex: step.stepIndex, activeTools: step.activeTools, lastUsage: (yield* Ref.get(latestView)).lastUsage }
          const choice = yield* inRun(firstSome(modelHooks.map((hook) => hook(stepInfo(view))))).pipe(Effect.orDie)
          const variant = Option.flatMap(choice, (value) => value.variant)
          const system = Option.isNone(variant) ? defaultSystem : yield* systemFor(variant).pipe(Effect.orDie)
          const stepText = config.stepContext === "system" ? Option.getOrElse((yield* directiveFor(view).pipe(Effect.orDie)).context, () => "") : ""
          return {
            model: Option.match(choice, { onNone: () => defaultModel, onSome: (value) => value.model }),
            system: Prompt.make([{ role: "system", content: [system, stepText].filter((part) => part.length > 0).join("\n\n") }]),
          }
        }),
        render: (view) => Effect.gen(function* () {
          yield* Ref.set(latestView, view)
          yield* Ref.set(currentStep, view.stepIndex)
          yield* directiveFor(view)
          const reserved = estimateTokens(defaultSystem) + schemaTokens(tools, view.activeTools)
          yield* session.maintain({ phase: "step", lastUsage: view.lastUsage, budgetTokens: Math.max(1, config.budgetTokens - reserved), views: tools.views })
          const built = yield* session.build
          yield* input.publish({ name: "context.built", runId: input.runId, data: {
            strategy: session.strategy.id, strategyVersion: session.strategy.version, step: view.stepIndex, turn,
            fingerprint: built.fingerprint, systemFingerprint: fingerprintOf(defaultSystem), estimatedTokens: built.estimatedTokens,
            reservedTokens: reserved, compactions: built.compactions.length, activeTools: view.activeTools,
          } })
          return built.messages
        }).pipe(Effect.orDie),
        stepDirective: (view) => directiveFor(view).pipe(
          Effect.map((directive) => ({ toolChoice: directive.toolChoice as Option.Option<LoopToolChoice> })),
          Effect.orDie,
        ),
        ...(completionHooks.length === 0 ? {} : {
          isComplete: () => Ref.get(latestView).pipe(Effect.flatMap((view) =>
            inRun(Effect.forEach(completionHooks, (hook) => hook(stepInfo(view)))).pipe(Effect.map((all) => all.every(Boolean))))),
        }),
        pendingInput: () => input.steering.pipe(Effect.orDie),
        onTail: (messages: ReadonlyArray<AgentMessage>) => Ref.get(currentStep).pipe(
          Effect.flatMap((step) => session.recordTail(messages, tools.views, step)),
          Effect.map((entries) => messages.map((_, index) => entries[Math.min(index, entries.length - 1)]?.seq ?? -1)),
          Effect.orDie,
        ),
        onEvent: (event) => event.type === "assistant_delta"
          ? input.transient({ name: "assistant.delta", runId: input.runId, data: { ...event } })
          : input.publish({ name: "loop.event", runId: input.runId, data: { ...event } }).pipe(Effect.asVoid, Effect.orDie),
      }).pipe(
        Effect.provideService(LanguageModel.LanguageModel, defaultModel),
        Effect.locally(CurrentPromptCacheKey, config.cacheKeyPrefix.length === 0 ? Option.none() : Option.some(`${config.cacheKeyPrefix}:${input.session.id}`)),
      ), Context.merge(services, tools.handlers))
      const outcome = result.outcome === "ok" ? "completed" as const : "partial" as const
      const reply = yield* inRun(firstSome(hooks.flatMap((hook) => Option.toArray(hook.reply))))
      const text = Option.getOrElse(reply, () => result.finalText)
      yield* session.record([{ _tag: "TurnEnded", outcome, reply: Option.some(text) }], yield* Ref.get(currentStep))
      yield* inRun(Effect.forEach(hooks.flatMap((hook) => Option.toArray(hook.settle)), (settle) => settle({ outcome, text })))
      return { text, outcome }
    }).pipe(Effect.mapError((error) => error instanceof HarnessError ? error : failure("loop.failed", String(error))))) })
  })),
})
