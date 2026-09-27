import { Context, Effect, Exit, JSONSchema, Layer, Option, Ref, Schema, Scope } from "effect"
import {
  canonicalJson,
  ConversationMemory,
  Contributions,
  definePlugin,
  estimateTokens,
  fingerprintOf,
  harnessDefectsAsFailures,
  HarnessError,
  journalBodyOf,
  makeTurnEvents,
  makeTurnTasks,
  RunContext,
  SessionEnvironment,
  StepLoop,
  ToolRegistry,
  TurnEvents,
  TurnTasks,
} from "@xandreed/core"
import type {
  CompletionVerdict,
  Contribution,
  HarnessConfig,
  LogEntry,
  LoopLimits,
  MemoryReader,
  MemorySession,
  Plugin,
  PromptContext,
  PromptSection,
  RunResult,
  RunTools,
  StepDirective,
  StepInfo,
  StepPlan,
  Turn,
  TurnInput,
  TurnOutcome,
  TurnPolicy,
} from "@xandreed/core"
import { activateGraph, graphFingerprint, resolveGraph } from "@xandreed/runtime"

/** One plugin instance of an agent: the definition, its options and (optionally) an instance id. */
export interface AgentPluginEntry {
  readonly plugin: Plugin
  /** Defaults to the plugin id. */
  readonly id?: string
  readonly options?: Readonly<Record<string, unknown>>
}

/** Everything an agent is made of. Swapping a strategy is swapping one entry. */
export interface AgentConfig {
  /** Memory log and strategy, tool registry, step loop, and any capability plugins. */
  readonly plugins: ReadonlyArray<Plugin | AgentPluginEntry>
  /** Which instance provides a service several plugins provide. */
  readonly bindings?: Readonly<Record<string, string>>
  /** The host's own tools, views, skills and prompt sections. */
  readonly contributions?: ReadonlyArray<Contribution>
  /** Process-lifetime host services plugins may require. */
  readonly services?: Context.Context<never>
  /** Keys every turn's services must carry; session plugins may require them. */
  readonly turnServices?: ReadonlyArray<{ readonly key: string }>
  /** The system prompt prefix, before the contributed sections. */
  readonly system?: string
  /** The prompt-cache key is `<prefix>:<conversation>`; none is sent without a prefix. */
  readonly cacheKeyPrefix?: string
  readonly workspace?: string
  /** Defaults for every run; a turn's policy overrides them. */
  readonly limits?: Partial<LoopLimits>
  /** Input tokens one request may use (system, tool schemas and messages). */
  readonly budgetTokens?: number
  /** How deep event reactions may nest before the bus fails the publisher. */
  readonly maxEventDepth?: number
}

/** A defined agent: its graph is built; each turn is composed by the host. */
export interface Agent {
  readonly fingerprint: string
  /**
   * Run one admitted turn. The turn is scoped: its subscriptions and tasks
   * end with it. Tasks are joined before `turn.ended`, which is recorded
   * exactly once — with a failed outcome when `use` fails or is interrupted.
   * `use` runs in the turn's scope, so its subscriptions need no scope of their own.
   */
  readonly turn: <R>(
    input: TurnInput,
    use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>,
  ) => Effect.Effect<TurnOutcome, HarnessError, Exclude<R, Scope.Scope>>
}

const defaultLimits: LoopLimits = { maxSteps: 50, toolConcurrency: 1, streaming: true, requireCompletion: false }
const incomplete: CompletionVerdict = { complete: false, awaiting: [], facts: {} }
const noDirective: StepDirective = { context: Option.none(), toolChoice: Option.none() }
const failed: TurnOutcome = { outcome: "failed", reply: Option.none() }

const failure = (code: string, message: string) => new HarnessError({ code, message })
const missing = (key: string) => failure("service.missing", `The agent's plugins do not provide ${key}`)

const entryOf = (item: Plugin | AgentPluginEntry): AgentPluginEntry => "plugin" in item ? item : { plugin: item }

const required = <I, S>(context: Context.Context<never>, tag: Context.Tag<I, S>): Effect.Effect<S, HarnessError> =>
  Option.match(Context.getOption(context, tag), { onNone: () => Effect.fail(missing(tag.key)), onSome: Effect.succeed })

/** Contributed requirements are erased; the turn's services provide them all. */
const closeWith = <A, E>(effect: Effect.Effect<A, E, unknown>, context: Context.Context<never>): Effect.Effect<A, E> =>
  effect.pipe(Effect.provide(context)) as Effect.Effect<A, E>

const hostContributions = (contributions: ReadonlyArray<Contribution>) => definePlugin({
  id: "@xandreed/sdk/host-contributions", version: "1", scope: "runtime",
  config: Schema.Struct({}), defaults: {},
  provides: [], contributes: [Contributions],
  layer: () => Layer.succeed(Contributions, contributions),
})

const tierRank = (section: PromptSection): number => section.tier === "static" ? 0 : section.tier === "session" ? 1 : 2

/** Static sections first (the cacheable prefix), then session ones; each tier by order, then id. */
export const orderSections = (sections: ReadonlyArray<PromptSection>): ReadonlyArray<PromptSection> =>
  [...sections].sort((left, right) => tierRank(left) - tierRank(right) || left.order - right.order || left.id.localeCompare(right.id))

const renderSections = (sections: ReadonlyArray<PromptSection>, context: PromptContext) =>
  Effect.forEach(orderSections(sections), (section) => section.render(context).pipe(
    Effect.map((text) => Option.map(text, (value) => ({ section, text: value }))),
  )).pipe(Effect.map((rendered) => rendered.flatMap(Option.toArray)))

const schemaTokens = (tools: RunTools, active: ReadonlyArray<string>): number =>
  active.reduce((sum, name) => {
    const tool = tools.toolkit.tools[name]
    return tool === undefined ? sum : sum + estimateTokens(`${tool.description ?? ""}${canonicalJson(JSONSchema.make(tool.parametersSchema))}`)
  }, 0)

const readerOf = (session: MemorySession): MemoryReader => ({
  turn: session.turn,
  entries: session.entries,
  query: session.query,
  subjects: session.subjects,
  resolve: session.resolve,
  transcript: session.transcript,
})

/**
 * Build the agent's plugin graph once. Runtime plugins are activated here,
 * in the caller's scope; session plugins (if any) are activated per turn with
 * that turn's services. Host contributions join the graph as one more
 * contributor.
 */
const makeAgent = (config: AgentConfig): Effect.Effect<Agent, HarnessError, Scope.Scope> => Effect.gen(function* () {
  const parent = yield* Effect.scope
  const entries = config.plugins.map(entryOf)
  const hosted = config.contributions ?? []
  const host = hostContributions(hosted)
  const withHost = hosted.length > 0
  const plugins = [...entries.map((entry) => entry.plugin), ...(withHost ? [host] : [])]
  const harness: HarnessConfig = {
    version: 1,
    plugins: [
      ...entries.map((entry) => ({ id: entry.id ?? entry.plugin.id, use: entry.plugin.id, options: { ...entry.options } })),
      ...(withHost ? [{ id: host.id, use: host.id }] : []),
    ],
    ...(config.bindings === undefined ? {} : { bindings: { ...config.bindings } }),
    system: config.system ?? "",
  }
  const services = config.services ?? Context.empty()
  const turnKeys = (config.turnServices ?? []).map((tag) => tag.key)
  const external = [SessionEnvironment.key, ...services.unsafeMap.keys(), ...turnKeys]
  const graph = yield* resolveGraph(harness, plugins, external)
  const workspace = config.workspace ?? "."
  const seed = Context.add(services, SessionEnvironment, { workspace })
  const runtime = yield* activateGraph(graph, "runtime", Context.unsafeMake<never>(seed.unsafeMap), parent)
  const perTurn = graph.nodes.some((node) => node.plugin.scope === "session")
  const maxDepth = config.maxEventDepth ?? 8

  const turn = <R>(input: TurnInput, use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>): Effect.Effect<TurnOutcome, HarnessError, Exclude<R, Scope.Scope>> => harnessDefectsAsFailures(Effect.scoped(Effect.gen(function* () {
    const scope = yield* Effect.scope
    const absent = turnKeys.filter((key) => !input.services.unsafeMap.has(key))
    if (absent.length > 0) return yield* Effect.fail(failure("service.missing", `The turn does not provide ${absent.join(", ")}`))
    const merged = Context.merge(runtime, input.services)
    const context = perTurn ? yield* activateGraph(graph, "session", merged, scope) : merged
    const memory = yield* required(context, ConversationMemory)
    const registry = yield* required(context, ToolRegistry)
    const loop = yield* required(context, StepLoop)
    const contributions = Option.getOrElse(Context.getOption(context, Contributions), (): ReadonlyArray<Contribution> => [])
    const sections = contributions.flatMap((contribution) => contribution.sections)

    const events = yield* makeTurnEvents({ maxDepth })
    const tasks = yield* makeTurnTasks(scope)
    // The journal is the first subscriber: every durable event is persisted before any reaction runs.
    yield* events.subscribe((event) => journalBodyOf(input.runId, event), input.journal.append)
    const session = yield* memory.open({ conversation: input.conversation, runId: input.runId, io: input.journal, services: context })
    const reader = readerOf(session)

    const toolsRef = yield* Ref.make(Option.none<RunTools>())
    const run = RunContext.of({
      conversation: input.conversation,
      runId: input.runId,
      prompt: input.prompt,
      memory: reader,
      events,
      tasks,
      activate: (skills) => Ref.get(toolsRef).pipe(Effect.flatMap(Option.match({
        onNone: () => Effect.fail(failure("tools.unavailable", "Tools are not open yet")),
        onSome: (tools) => tools.activate(skills, "host"),
      }))),
    })
    const base = Context.add(Context.add(Context.add(context, RunContext, run), TurnEvents, events), TurnTasks, tasks)
    const runServices = yield* Effect.reduce(contributions, base, (current, contribution) => Option.match(contribution.run, {
      onNone: () => Effect.succeed(current),
      onSome: (layer) => closeWith(Layer.buildWithScope(layer, scope), current).pipe(Effect.map((built) => Context.merge(current, built))),
    }))
    const inRun = <A, E>(effect: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> => closeWith(effect, runServices)

    const number = (yield* session.turn) + 1
    yield* session.record([{ _tag: "TurnStarted", prompt: input.prompt }], 0)
    yield* events.publish({ _tag: "turn.started", runId: input.runId, turn: number, prompt: input.prompt })
    const tools = yield* registry.open(session, runServices)
    yield* Ref.set(toolsRef, Option.some(tools))

    const promptContext = (variant: Option.Option<string>) =>
      tools.active.pipe(Effect.map((active): PromptContext => ({ variant, active, skills: tools.skills })))
    const lastSystem = yield* Ref.make(Option.fromNullable((yield* session.entries).flatMap((entry: LogEntry) =>
      entry.body._tag === "SystemPrepared" ? [entry.body.fingerprint] : []).at(-1)))
    const systems = yield* Ref.make(new Map<string, string>())
    /** The system prompt of one variant, rendered once per turn and recorded when it changes. */
    const systemFor = (variant: Option.Option<string>) => Effect.gen(function* () {
      const key = Option.getOrElse(variant, () => "")
      const known = (yield* Ref.get(systems)).get(key)
      if (known !== undefined) return known
      const rendered = yield* inRun(promptContext(variant).pipe(Effect.flatMap((prompt) =>
        renderSections(sections.filter((section) => section.tier !== "turn"), prompt))))
      const text = [input.system ?? config.system ?? "", ...rendered.map((part) => part.text)].filter((part) => part.trim().length > 0).join("\n\n")
      const fingerprint = fingerprintOf(text)
      if (!Option.contains(yield* Ref.get(lastSystem), fingerprint)) {
        yield* session.record([{
          _tag: "SystemPrepared", fingerprint, text,
          sections: rendered.map((part) => ({ id: part.section.id, version: part.section.version, fingerprint: fingerprintOf(part.text) })),
        }], 0)
        yield* Ref.set(lastSystem, Option.some(fingerprint))
      }
      yield* Ref.update(systems, (all) => new Map([...all, [key, text]]))
      return text
    })

    const turnSections = yield* Ref.make(false)
    /** Turn-tier sections render once, when the first run starts (the tools are selected by then). */
    const recordTurnSections = Effect.gen(function* () {
      if (yield* Ref.getAndSet(turnSections, true)) return
      const rendered = yield* inRun(promptContext(Option.none()).pipe(Effect.flatMap((prompt) =>
        renderSections(sections.filter((section) => section.tier === "turn"), prompt))))
      yield* rendered.length === 0 ? Effect.void : session.record(rendered.map(({ section, text }) => ({
        _tag: "TurnContext" as const, sectionId: section.id, version: section.version, text,
      })), 0)
    })

    const runWith = <P>(policy: TurnPolicy<P>): Effect.Effect<RunResult, HarnessError, P> => Effect.gen(function* () {
      const env = yield* Effect.context<P>()
      const withPolicy = <A>(effect: Effect.Effect<A, HarnessError, P>): Effect.Effect<A, HarnessError> => effect.pipe(Effect.provide(env))
      const limits: LoopLimits = { ...defaultLimits, ...config.limits, ...policy.limits }
      const budget = policy.budgetTokens ?? config.budgetTokens ?? 64_000
      const stepContext = policy.stepContext ?? "tail"
      yield* Option.match(Option.fromNullable(policy.initial), {
        onNone: () => Effect.void,
        onSome: (batch) => batch.skills.length === 0 ? Effect.void : tools.activate(batch.skills, "host").pipe(Effect.asVoid),
      })
      yield* recordTurnSections
      yield* session.maintain({ phase: "turn-start", lastUsage: Option.none(), budgetTokens: budget, views: tools.views })

      const plan = (info: StepInfo): Effect.Effect<StepPlan, HarnessError> => Effect.gen(function* () {
        const choice = policy.model === undefined ? Option.none() : yield* withPolicy(policy.model(info))
        const system = yield* systemFor(Option.flatMap(choice, (value) => value.variant))
        const directive = policy.step === undefined ? noDirective : yield* withPolicy(policy.step(info))
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

      const cacheKey = Option.orElse(
        Option.fromNullable(input.cacheKey),
        () => Option.map(Option.filter(Option.fromNullable(config.cacheKeyPrefix), (prefix) => prefix.length > 0), (prefix) => `${prefix}:${input.conversation}`),
      )
      return yield* loop.run({
        tools,
        handlers: Context.merge(runServices, tools.handlers),
        limits,
        initial: Option.fromNullable(policy.initial),
        plan,
        record: (step, tail) => session.recordTail(tail, tools.views, step),
        completion: (info) => policy.completion === undefined ? Effect.succeed(incomplete) : withPolicy(policy.completion(info)),
        steering: input.steering ?? Effect.succeed(Option.none()),
        correctives: Option.fromNullable(policy.correctives),
        events,
        tasks,
        cacheKey,
      })
    })

    const value: Turn = {
      conversation: input.conversation,
      runId: input.runId,
      turn: number,
      prompt: input.prompt,
      memory: reader,
      events,
      tasks,
      tools: {
        select: tools.select,
        activate: (skills) => tools.activate(skills, "host"),
        active: tools.active,
        skills: tools.skills,
      },
      services: runServices,
      context: (entry) => session.record([{ _tag: "TurnContext", sectionId: entry.id, version: entry.version, text: entry.text }], 0).pipe(Effect.asVoid),
      reply: (text) => Effect.succeed({ outcome: "completed", reply: Option.some(text) }),
      run: runWith,
    }

    const finish = (outcome: TurnOutcome) => Effect.gen(function* () {
      yield* session.record([{ _tag: "TurnEnded", outcome: outcome.outcome, reply: outcome.reply }], 0)
      yield* events.publish({ _tag: "turn.ended", runId: input.runId, turn: number, outcome: outcome.outcome, reply: outcome.reply })
    })
    const outcome = yield* harnessDefectsAsFailures(Scope.extend(use(value), scope).pipe(Effect.tap(() => tasks.await([])))).pipe(
      Effect.onExit(Exit.match({
        onSuccess: () => Effect.void,
        // The turn already failed; recording that must not replace its cause.
        onFailure: () => finish(failed).pipe(Effect.catchAllCause(() => Effect.void)),
      })),
    )
    yield* finish(outcome)
    return outcome
  })))

  return { fingerprint: graphFingerprint(graph), turn }
})

export const Agent = { define: makeAgent }
