import { Context, Effect, Option, Schema } from "effect"
import type { Layer, Scope } from "effect"
import {
  cacheKeyOf,
  CapabilitiesLive,
  Capabilities,
  ConversationMemory,
  definePlugin,
  guardTurn,
  harnessDefectsAsFailures,
  HarnessError,
  openTurnTools,
  SessionEnvironment,
  Sessions,
  StepLoop,
  ToolRegistry,
  RunContext,
  settleTurn,
  TurnEvents,
  TurnTasks,
  TurnLive,
  TurnMemory,
  TurnPrompt,
  TurnToolbox,
  turnOf,
} from "@xandreed/core"
import type {
  Capability,
  HarnessConfig,
  LoopLimits,
  NewTurn,
  Plugin,
  Turn,
  TurnInput,
  TurnLiveInput,
  TurnOutcome,
  TurnRunOptions,
  TurnServices,
  TurnWriter,
} from "@xandreed/core"
import { activateGraph, graphFingerprint, resolveGraph } from "@xandreed/runtime"
import type { PluginGraph, PluginNode } from "@xandreed/runtime"

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
  readonly capabilities?: ReadonlyArray<Capability>
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
   * Run one turn: one the host began (its `TurnWriter`; the host ends it),
   * or one begun and ended here through the `Sessions` in the turn's
   * services. The turn is scoped: its subscriptions and tasks end with it.
   * Tasks and background subscriptions are drained before the reply is
   * recorded, exactly once — failed when `use` fails or is interrupted —
   * and everything is stored before the turn returns. A turn closed
   * elsewhere (cancelled, reaped) fails with `turn.closed`. `use` runs in
   * the turn's scope with the turn's services (RunContext, TurnEvents,
   * TurnTasks and the input's `layer`) provided: the same instances the
   * tools, policy and subscriptions see.
   */
  readonly turn: <A = never, E = never, R = never>(
    input: TurnInput<A, E>,
    use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>,
  ) => Effect.Effect<TurnOutcome, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>>
}

const failure = (code: string, message: string) => new HarnessError({ code, message })
const missing = (key: string) => failure("service.missing", `The agent's plugins do not provide ${key}`)

const entryOf = (item: Plugin | AgentPluginEntry): AgentPluginEntry => "plugin" in item ? item : { plugin: item }

const isWriter = (turn: TurnWriter | NewTurn): turn is TurnWriter => "admitted" in turn

/** Why a turn could not begin, as the turn's error codes. */
const beginCodes = {
  SessionBusy: "session.busy",
  TurnDuplicate: "turn.duplicate",
  KeyConflict: "turn.key-conflict",
  NothingPending: "session.nothing-pending",
  TurnRefused: "turn.refused",
  SessionMissing: "session.missing",
  SessionLogError: "session.log",
} as const

/** Begin a turn with the Sessions of the turn's services; its writer lives in the turn's scope. */
const beginTurn = (context: Context.Context<never>, turn: NewTurn): Effect.Effect<TurnWriter, HarnessError, Scope.Scope> =>
  required(context, Sessions).pipe(Effect.flatMap((sessions) => sessions.begin(turn.session, {
    _tag: "User", userMessage: turn.userMessage, runId: turn.runId, key: turn.key ?? turn.runId, command: turn.command ?? {},
  })), Effect.mapError((error) => error instanceof HarnessError ? error : failure(beginCodes[error._tag], `the turn could not begin (${error._tag}) in session ${turn.session.id}`)))

/** The turn's body, until someone else closes the turn: then the body is interrupted and the turn fails. */
const untilClosed = (writer: TurnWriter) => <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E | HarnessError, R> =>
  Effect.raceFirst(body, writer.closed.pipe(Effect.flatMap((closed) => Effect.fail(failure("turn.closed", `turn ${closed.turn} was ${closed.reason}`)))))

const required = <I, S>(context: Context.Context<never>, tag: Context.Service<I, S>): Effect.Effect<S, HarnessError> =>
  Option.match(Context.getOption(context, tag), { onNone: () => Effect.fail(missing(tag.key)), onSome: Effect.succeed })

/**
 * The host's per-turn layer, when it has one, built afresh for the turn
 * (`local`: nothing memoized outside the turn is reused). Its requirements
 * are erased: the turn's services meet them.
 */
const provideHostLayer = <A, E>(layer: Option.Option<Layer.Layer<A, E, unknown>>) =>
  <B, F, R>(effect: Effect.Effect<B, F, R>): Effect.Effect<B, F | E, unknown> =>
    Option.match(layer, { onNone: () => effect, onSome: (hostLayer) => effect.pipe(Effect.provide(hostLayer, { local: true })) })

const hostCapabilities = (capabilities: ReadonlyArray<Capability>) => definePlugin({
  id: "@xandreed/sdk/host-contributions", version: "1", scope: "runtime",
  config: Schema.Struct({}), defaults: {},
  provides: [], contributes: [Capabilities],
  layer: () => CapabilitiesLive(...capabilities),
})

/** Services that exist only after an admitted turn has its bus, memory and tools slot. */
const builtInTurnKeys: ReadonlyArray<string> = [RunContext, TurnEvents, TurnTasks, TurnMemory, TurnPrompt, TurnToolbox].map((tag) => tag.key)

/** Transitively defer subscribers and their dependants until TurnLive is built; strategy/registry plugins still build first. */
const turnDependentNodes = (graph: PluginGraph): ReadonlyArray<PluginNode> => graph.nodes.reduce((late: ReadonlyArray<PluginNode>, node) => {
  const dependencies = [...node.plugin.requires, ...(node.plugin.optional ?? [])]
  const afterTurn = dependencies.some((key) => builtInTurnKeys.includes(key) || late.some((source) =>
    source.plugin.provides.includes(key) || (source.plugin.contributes ?? []).includes(key)))
  return afterTurn ? [...late, node] : late
}, [])

/**
 * Build the agent's plugin graph once. Runtime plugins are activated here,
 * in the caller's scope; session plugins (if any) are activated per turn with
 * that turn's services. Host capabilities join the graph as its first
 * contributor.
 */
const makeAgent = (config: AgentConfig): Effect.Effect<Agent, HarnessError, Scope.Scope> => Effect.gen(function* () {
  const parent = yield* Effect.scope
  const entries = config.plugins.map(entryOf)
  const hosted = config.capabilities ?? []
  const host = hostCapabilities(hosted)
  const withHost = hosted.length > 0
  // The host's capabilities are the graph's first contributor: the model sees the host's tools,
  // skills and sections before any plugin's, whatever round each plugin resolves in.
  const plugins = [...(withHost ? [host] : []), ...entries.map((entry) => entry.plugin)]
  const harness: HarnessConfig = {
    version: 1,
    plugins: [
      ...(withHost ? [{ id: host.id, use: host.id }] : []),
      ...entries.map((entry) => ({ id: entry.id ?? entry.plugin.id, use: entry.plugin.id, options: { ...entry.options } })),
    ],
    ...(config.bindings === undefined ? {} : { bindings: { ...config.bindings } }),
    system: config.system ?? "",
  }
  const services = config.services ?? Context.empty()
  const turnKeys = (config.turnServices ?? []).map((tag) => tag.key)
  const external = [SessionEnvironment.key, ...services.mapUnsafe.keys(), ...turnKeys, ...builtInTurnKeys]
  const graph = yield* resolveGraph(harness, plugins, external)
  const late = turnDependentNodes(graph)
  const invalidLate = late.find((node) => node.plugin.scope === "runtime" || node.plugin.provides.some((key) =>
    ([ConversationMemory.key, ToolRegistry.key, StepLoop.key] as ReadonlyArray<string>).includes(key)))
  if (invalidLate !== undefined) return yield* Effect.fail(failure("config.graph", `${invalidLate.entry.id}: a plugin requiring turn services must be session-scoped and cannot supply the turn's memory, registry or loop`))
  const beforeTurn: PluginGraph = { ...graph, nodes: graph.nodes.filter((node) => !late.includes(node)) }
  const afterTurn: PluginGraph = { ...graph, nodes: late }
  const workspace = config.workspace ?? "."
  const seed = Context.add(services, SessionEnvironment, { workspace })
  const runtime = yield* activateGraph(beforeTurn, "runtime", Context.makeUnsafe<never>(seed.mapUnsafe), parent)
  const perTurn = beforeTurn.nodes.some((node) => node.plugin.scope === "session")

  /**
   * One turn composed from the public pieces (`TurnLive`, `persistMessage`,
   * `openTurnTools`, `turnOf`, `guardTurn`), in this order:
   * 0. the turn: the host's writer, or one begun here (Sessions.begin);
   * 1. TurnLive: the bus and tasks, with the writer as the first
   *    subscriber, then memory (the session's earlier memory events) and
   *    RunContext;
   * 2. the turn-dependent plugins (those requiring the turn's services, and
   *    their dependants), activated over TurnLive in a scope of their own;
   * 3. the host's layer, built with their services, after RunContext and
   *    before memory takes the message, so it sees only earlier turns (a
   *    context entry recorded by 2 or 3 waits for the message);
   * 4. the user's message taken by memory (TurnStarted, turn.started);
   * 5. the tools opened inside the host's layer, so its services reach them;
   * 6. `use`, then its tasks and background reactions settled;
   * 7. the host's layer, then the plugins of 2 closed, while TurnLive is
   *    still open: what their finalizers publish or fork is settled and
   *    stored before TurnLive closes;
   * 8. finalizer work settled, then the final reply recorded (failed when
   *    the body or its finalizer work failed), before TurnLive closes;
   * 9. a turn begun here is ended here, with the outcome.
   */
  const turn = <A = never, E = never, R = never>(
    input: TurnInput<A, E>,
    use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>,
  ): Effect.Effect<TurnOutcome, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>> => harnessDefectsAsFailures(Effect.scoped(Effect.gen(function* () {
    const scope = yield* Effect.scope
    const absent = turnKeys.filter((key) => !input.services.mapUnsafe.has(key))
    if (absent.length > 0) return yield* Effect.fail(failure("service.missing", `The turn does not provide ${absent.join(", ")}`))
    const merged = Context.merge(runtime, input.services)
    const context = perTurn ? yield* activateGraph(beforeTurn, "session", merged, scope) : merged
    const memory = yield* required(context, ConversationMemory)
    const registry = yield* required(context, ToolRegistry)
    const loop = yield* required(context, StepLoop)

    const own = !isWriter(input.turn)
    const writer = isWriter(input.turn) ? input.turn : yield* beginTurn(context, input.turn)
    const system = input.system ?? config.system
    const live: TurnLiveInput = {
      turn: writer,
      ...(system === undefined ? {} : { system }),
      ...(config.maxEventDepth === undefined ? {} : { maxEventDepth: config.maxEventDepth }),
    }
    const runOptions: TurnRunOptions = {
      ...(config.limits === undefined ? {} : { limits: config.limits }),
      ...(config.budgetTokens === undefined ? {} : { budgetTokens: config.budgetTokens }),
      cacheKey: Option.orElse(Option.fromNullishOr(input.cacheKey), () => cacheKeyOf(config.cacheKeyPrefix ?? "", writer.admitted.session.id)),
      ...(input.steering === undefined ? {} : { steering: input.steering }),
    }

    const body = Effect.gen(function* () {
      yield* (yield* TurnMemory).persistMessage
      yield* openTurnTools
      // Everything `use` does sees the turn's services: `yield* SomeHostTag` gets the per-turn instance.
      return yield* use(yield* turnOf(runOptions))
    })
    // The turn-dependent plugins finalize before TurnLive closes. The outer guard settles their
    // finalizer work alongside the host's, then records the final outcome while the writer is open.
    const provideTurnPlugins = <B, F, T>(effect: Effect.Effect<B, F, T>): Effect.Effect<B, F | HarnessError, unknown> => late.length === 0 ? effect : Effect.gen(function* () {
      const liveContext = yield* Effect.context<never>()
      return yield* Effect.scoped(Effect.gen(function* () {
        const activated = yield* activateGraph(afterTurn, "session", Context.merge(context, liveContext), yield* Effect.scope)
        return yield* effect.pipe(Effect.provide(activated))
      }))
    })
    const outcome = yield* body.pipe(
      // Work using the body's scoped services finishes before those services are finalized.
      Effect.tap(() => settleTurn),
      Effect.scoped,
      // The body's finalizers may fork work that still needs the host's services.
      Effect.tap(() => settleTurn),
      provideHostLayer(Option.fromNullishOr(input.layer)),
      // The host's finalizer work finishes while its plugin dependencies remain open.
      Effect.tap(() => settleTurn),
      provideTurnPlugins,
      // Includes scope teardown even without turn-dependent plugins: a finalizer task's failure
      // must fail the final outcome rather than follow an already recorded completed reply.
      guardTurn,
      Effect.provide(TurnLive(live), { local: true }),
      Effect.provideService(ConversationMemory, memory),
      Effect.provideService(ToolRegistry, registry),
      Effect.provideService(StepLoop, loop),
      Effect.provide(context),
      untilClosed(writer),
    )
    if (own) yield* writer.end({ reason: outcome.outcome, failure: Option.none() })
    return outcome
  }))) as Effect.Effect<TurnOutcome, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>>

  return { fingerprint: graphFingerprint(graph), turn }
})

export const Agent = { define: makeAgent }
