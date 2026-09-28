import { Context, Effect, Option, Schema } from "effect"
import type { Layer, Scope } from "effect"
import {
  cacheKeyOf,
  ContributionsLive,
  Contributions,
  ConversationMemory,
  definePlugin,
  guardTurn,
  harnessDefectsAsFailures,
  HarnessError,
  openTurnTools,
  SessionEnvironment,
  StepLoop,
  ToolRegistry,
  TurnLive,
  TurnMemory,
  turnOf,
} from "@xandreed/core"
import type {
  Contribution,
  HarnessConfig,
  LoopLimits,
  Plugin,
  Turn,
  TurnInput,
  TurnLiveInput,
  TurnOutcome,
  TurnRunOptions,
  TurnServices,
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
  /** The write-behind journal: queued items before appends wait, and items written per batch. */
  readonly journal?: { readonly capacity?: number; readonly batch?: number }
}

/** A defined agent: its graph is built; each turn is composed by the host. */
export interface Agent {
  readonly fingerprint: string
  /**
   * Run one admitted turn. The turn is scoped: its subscriptions and tasks
   * end with it. Tasks and background subscriptions are drained before
   * `turn.ended`, which is recorded exactly once — with a failed outcome
   * when `use` fails or is interrupted — and the journal is flushed before
   * the turn returns. `use` runs in the turn's scope with the turn's
   * services (RunContext, TurnEvents, TurnTasks and the input's `layer`)
   * provided: the same instances the tools, policy and subscriptions see.
   */
  readonly turn: <A = never, E = never, R = never>(
    input: TurnInput<A, E>,
    use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>,
  ) => Effect.Effect<TurnOutcome, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>>
}

const failure = (code: string, message: string) => new HarnessError({ code, message })
const missing = (key: string) => failure("service.missing", `The agent's plugins do not provide ${key}`)

const entryOf = (item: Plugin | AgentPluginEntry): AgentPluginEntry => "plugin" in item ? item : { plugin: item }

const required = <I, S>(context: Context.Context<never>, tag: Context.Tag<I, S>): Effect.Effect<S, HarnessError> =>
  Option.match(Context.getOption(context, tag), { onNone: () => Effect.fail(missing(tag.key)), onSome: Effect.succeed })

/** The host's per-turn layer, when it has one. Its requirements are erased: the turn's services meet them. */
const provideHostLayer = <A, E>(layer: Option.Option<Layer.Layer<A, E, unknown>>) =>
  <B, F, R>(effect: Effect.Effect<B, F, R>): Effect.Effect<B, F | E, unknown> =>
    Option.match(layer, { onNone: () => effect, onSome: (hostLayer) => effect.pipe(Effect.provide(hostLayer)) })

const hostContributions = (contributions: ReadonlyArray<Contribution>) => definePlugin({
  id: "@xandreed/sdk/host-contributions", version: "1", scope: "runtime",
  config: Schema.Struct({}), defaults: {},
  provides: [], contributes: [Contributions],
  layer: () => ContributionsLive(...contributions),
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

  /**
   * One turn composed from the public pieces (`TurnLive`, `persistMessage`,
   * `openTurnTools`, `turnOf`, `guardTurn`), in this order:
   * 1. TurnLive: the bus, tasks and journal writer, with the journal as the
   *    first subscriber, then memory and RunContext;
   * 2. the host's layer, provided between TurnLive and the body: built after
   *    RunContext and before TurnStarted, so it sees only earlier turns;
   * 3. the user's message persisted (TurnStarted, turn.started);
   * 4. the tools opened inside the host's layer, so its services reach them;
   * 5. `use`.
   */
  const turn = <A = never, E = never, R = never>(
    input: TurnInput<A, E>,
    use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>,
  ): Effect.Effect<TurnOutcome, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>> => harnessDefectsAsFailures(Effect.scoped(Effect.gen(function* () {
    const scope = yield* Effect.scope
    const absent = turnKeys.filter((key) => !input.services.unsafeMap.has(key))
    if (absent.length > 0) return yield* Effect.fail(failure("service.missing", `The turn does not provide ${absent.join(", ")}`))
    const merged = Context.merge(runtime, input.services)
    const context = perTurn ? yield* activateGraph(graph, "session", merged, scope) : merged
    const memory = yield* required(context, ConversationMemory)
    const registry = yield* required(context, ToolRegistry)
    const loop = yield* required(context, StepLoop)

    const system = input.system ?? config.system
    const live: TurnLiveInput = {
      conversation: input.conversation,
      runId: input.runId,
      userMessage: input.userMessage,
      journal: input.journal,
      ...(system === undefined ? {} : { system }),
      ...(config.journal === undefined ? {} : { writer: config.journal }),
      ...(config.maxEventDepth === undefined ? {} : { maxEventDepth: config.maxEventDepth }),
    }
    const runOptions: TurnRunOptions = {
      ...(config.limits === undefined ? {} : { limits: config.limits }),
      ...(config.budgetTokens === undefined ? {} : { budgetTokens: config.budgetTokens }),
      cacheKey: Option.orElse(Option.fromNullable(input.cacheKey), () => cacheKeyOf(config.cacheKeyPrefix ?? "", input.conversation)),
      ...(input.steering === undefined ? {} : { steering: input.steering }),
    }

    const body = Effect.gen(function* () {
      yield* (yield* TurnMemory).persistMessage
      yield* openTurnTools
      // Everything `use` does sees the turn's services: `yield* SomeHostTag` gets the per-turn instance.
      return yield* use(yield* turnOf(runOptions))
    })
    return yield* body.pipe(
      guardTurn,
      Effect.scoped,
      provideHostLayer(Option.fromNullable(input.layer)),
      Effect.provide(TurnLive(live)),
      Effect.provideService(ConversationMemory, memory),
      Effect.provideService(ToolRegistry, registry),
      Effect.provideService(StepLoop, loop),
      Effect.provide(context),
    )
  }))) as Effect.Effect<TurnOutcome, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>>

  return { fingerprint: graphFingerprint(graph), turn }
})

export const Agent = { define: makeAgent }
