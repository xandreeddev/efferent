import { Clock, Context, Duration, Effect, Exit, Metric, Option, Schema } from "effect"
import type { Layer, Scope } from "effect"
import {
  cacheKeyOf,
  CurrentTraceContent,
  CapabilitiesLive,
  Capabilities,
  ConversationMemory,
  definePlugin,
  guardTurn,
  harnessDefectsAsFailures,
  HarnessError,
  isBudgetTokens,
  isHarnessError,
  normalizeUserMessage,
  openTurnTools,
  processActivity,
  replayableContext,
  SessionEnvironment,
  Sessions,
  StepLoop,
  TaskActivity,
  ToolRegistry,
  RunContext,
  settleTurn,
  TurnActivity,
  TurnEvents,
  TurnTasks,
  TurnLive,
  TurnMemory,
  TurnPrompt,
  TurnToolbox,
  traceTurn,
  turnEndingOf,
  turnOf,
} from "@xandreed/core"
import type {
  AdmittedTurn,
  Capability,
  HarnessConfig,
  LoopLimits,
  NewTurn,
  Plugin,
  ProcessActivity,
  Turn,
  TurnInput,
  TurnLiveInput,
  TurnOutcome,
  TurnResult,
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
  /**
   * Process-lifetime host services plugins may require. Their trace state
   * is not replayed into turns (`replayableContext`): a parent span, span
   * annotations or `CurrentTraceContent` among them are ignored.
   */
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
  /**
   * Every run's token budget unless its policy gives one; 64 000 by default.
   * An integer of at least 1, checked here (`config.budget`). It is the
   * target memory compaction keeps each request under (system prompt, tool
   * schemas and messages, estimated), not a provider limit. Memory is given
   * the whole budget at the turn's start, and at each step what the system
   * prompt and tool schemas leave of it (`context.budget` when they leave
   * nothing). The window strategy compacts, spills and drops older turns to
   * fit the budget it is given, and fails with `context.budget` when the
   * current turn alone does not; the summary strategy summarizes once the
   * messages pass its `triggerRatio` of it; the digester ignores it. Each
   * step's `context.built` records it.
   */
  readonly budgetTokens?: number
  /** How deep event reactions may nest before the bus fails the publisher. */
  readonly maxEventDepth?: number
  /**
   * Whether runs' spans may carry prompt and response content
   * (`engine.step.input`, `engine.step.output`, the models plugin's
   * `llm.reasoning`) when a policy does not say (`TurnPolicy.captureTraceContent`).
   * Off by default, unless `CurrentTraceContent` is provided where a run
   * starts: around `Agent.turn`, inside `use`, or in the turn's
   * `TurnInput.services` (one in `services` is ignored: set this instead).
   * Hosts own consent, masking and exporter retention.
   */
  readonly captureTraceContent?: boolean
  /**
   * The keys of a turn's metadata (`NewTurn.meta`, `AdmittedTurn.meta`) its
   * `agent.turn` span carries, as `efferent.meta.<key>`; none by default
   * (see `TurnTraceOptions`).
   */
  readonly spanMeta?: ReadonlyArray<string>
}

/** A defined agent: its graph is built; each turn is composed by the host. */
export interface Agent {
  readonly fingerprint: string
  /**
   * What this process is busy with (`processActivity`), as the agent's
   * runtime services see it: the `TurnActivity` of a runtime-scoped
   * sessions plugin in its graph (or one in `services`), and the
   * `TaskActivity` of a task runner in `services` (`InProcessTaskRunnerLive`
   * built into them). A probe that is not there counts nothing: a Sessions
   * the host passes only in a turn's services is not seen here (read
   * `processActivity` with the host's own services instead).
   */
  readonly activity: Effect.Effect<ProcessActivity>
  /**
   * Run one turn: one the host began (its `TurnWriter`; the host ends it),
   * or one begun and ended here through the `Sessions` in the turn's
   * services. The turn is scoped: its subscriptions and tasks end with it.
   * On success, tasks and background subscriptions settle as the scopes
   * close in dependency order, before the reply is recorded exactly once.
   * Failures and interruptions record a failed reply and cancel remaining
   * scoped work; recorded events are stored before the turn returns. A turn
   * begun here ends with `turnEndingOf` its exit: its outcome, or failed
   * with the error's code (`turn.failed` for an error without one,
   * `turn.defect`), or interrupted (`turn.interrupted`); on success, a
   * failure to store that end fails the turn, and on failure one is logged.
   * A turn closed
   * elsewhere (cancelled, reaped) fails with `turn.closed`. `use` runs in
   * the turn's scope with the turn's services (RunContext, TurnEvents,
   * TurnTasks and the input's `layer`) provided: the same instances the
   * tools, policy and subscriptions see. It returns `use`'s outcome with
   * the turn's usage (every run's provider calls, summed) and, for a turn
   * begun here, `pending`: the inbox items its end left waiting (results
   * delivered while it ran), which the caller drains (`Sessions.drain`).
   * From the moment
   * the turn is admitted it runs under its `agent.turn` span (`traceTurn`),
   * and is counted in the `efferent.turns` and `efferent.turn.duration`
   * metrics by its `efferent.outcome`.
   */
  readonly turn: <A = never, E = never, R = never>(
    input: TurnInput<A, E>,
    use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>,
  ) => Effect.Effect<TurnResult, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>>
}

const failure = (code: string, message: string) => new HarnessError({ code, message })
const missing = (key: string) => failure("service.missing", `The agent's plugins do not provide ${key}`)

/**
 * The turns `Agent.turn` ran, once each was admitted, by how they ended
 * (`efferent.outcome`: the `TurnEnding` reason of the turn's exit,
 * completed, partial, failed or interrupted; a turn cancelled or reaped
 * while it ran shows as failed, `turn.closed`), and how long each took:
 * from its admission to its end, or, for a turn the host began (its
 * `TurnWriter` passed in), from when `Agent.turn` took it to when
 * `Agent.turn` returned, before the host ends it. A turn that could not
 * begin is in neither.
 */
const turnCount = Metric.counter("efferent.turns", {
  description: "turns run by Agent.turn, by outcome",
  incremental: true,
})
const turnDuration = Metric.timer("efferent.turn.duration", {
  description: "how long each turn Agent.turn ran took, by outcome",
})

/** Count the turn and time it, by how it ended. */
const measureTurn = <A extends TurnResult, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Clock.currentTimeMillis.pipe(Effect.flatMap((started) => effect.pipe(Effect.onExit((exit) => Effect.gen(function* () {
    const outcome = { "efferent.outcome": turnEndingOf(exit).reason }
    const ended = yield* Clock.currentTimeMillis
    yield* Metric.update(Metric.withAttributes(turnCount, outcome), 1)
    yield* Metric.update(Metric.withAttributes(turnDuration, outcome), Duration.millis(ended - started))
  })))))

const entryOf = (item: Plugin | AgentPluginEntry): AgentPluginEntry => "plugin" in item ? item : { plugin: item }

const isWriter = (turn: TurnWriter | NewTurn): turn is TurnWriter => "admitted" in turn

/** The ids a log line about a turn carries, under the names its spans give them. */
const turnIdsOf = (admitted: AdmittedTurn): Record<string, unknown> => ({
  "efferent.session.id": admitted.session.id,
  "efferent.run.id": admitted.runId,
  "efferent.turn": admitted.turn,
})

/**
 * Why a turn could not begin (`Sessions.begin` failed, or, for
 * `AttachmentRejected`, the attachments' check before it), as the code of
 * the `HarnessError` `Agent.turn` fails with: keyed by the begin error's
 * tag. An `AttachmentRejected`'s `reason` is in the message only; a host
 * that branches on it runs `normalizeUserMessage` itself before the turn.
 */
export const turnBeginCodes = {
  AttachmentRejected: "turn.attachment-rejected",
  SessionBusy: "session.busy",
  TurnDuplicate: "turn.duplicate",
  KeyConflict: "turn.key-conflict",
  NothingPending: "session.nothing-pending",
  NotResumable: "turn.not-resumable",
  TurnRefused: "turn.refused",
  SessionMissing: "session.missing",
  SessionLogError: "session.log",
} as const

/** A new turn's idempotency key: the host's, else `resume:<n>` for a resume of turn `n`, else the run id. */
const keyOf = (turn: NewTurn): string => turn.key ?? (turn.resumes === undefined ? turn.runId : `resume:${turn.resumes}`)

/**
 * Begin a turn with the Sessions of the turn's services; its writer lives in
 * the turn's scope. The message's attachments are checked first
 * (`normalizeUserMessage`), whatever Sessions the turn's services hold, and
 * the normalised message is the one begun.
 */
const beginTurn = (context: Context.Context<never>, turn: NewTurn): Effect.Effect<TurnWriter, HarnessError, Scope.Scope> => Effect.gen(function* () {
  const sessions = yield* required(context, Sessions)
  const userMessage = yield* normalizeUserMessage(turn.userMessage)
  return yield* sessions.begin(turn.session, {
    _tag: "User", userMessage, runId: turn.runId, key: keyOf(turn), command: turn.command ?? {},
    ...(turn.meta === undefined ? {} : { meta: turn.meta }),
    ...(turn.resumes === undefined ? {} : { resumes: turn.resumes }),
  })
}).pipe(Effect.mapError((error) => isHarnessError(error) ? error
  : failure(turnBeginCodes[error._tag], error._tag === "NotResumable"
    ? `turn ${error.turn} of session ${turn.session.id} cannot be resumed (${error.reason})`
    : error._tag === "AttachmentRejected"
    ? `the turn could not begin (AttachmentRejected, ${error.reason}: ${error.message}) in session ${turn.session.id}`
    : `the turn could not begin (${error._tag}) in session ${turn.session.id}`)))

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

/** What every turn runs on: its memory, its tool registry and its step loop. */
const turnPorts: ReadonlyArray<string> = [ConversationMemory, ToolRegistry, StepLoop].map((tag) => tag.key)

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
 * contributor. An agent whose turns would have no ConversationMemory,
 * ToolRegistry or StepLoop (none provided by a plugin, none in `services`,
 * none declared in `turnServices`) fails here with `config.graph`, naming
 * it, rather than at its first turn.
 */
const makeAgent = (config: AgentConfig): Effect.Effect<Agent, HarnessError, Scope.Scope> => Effect.gen(function* () {
  if (config.budgetTokens !== undefined && !isBudgetTokens(config.budgetTokens)) {
    return yield* Effect.fail(failure("config.budget", `budgetTokens must be an integer of at least 1, not ${config.budgetTokens}`))
  }
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
  const invalidLate = late.find((node) => node.plugin.scope === "runtime" || node.plugin.provides.some((key) => turnPorts.includes(key)))
  if (invalidLate !== undefined) return yield* Effect.fail(failure("config.graph", `${invalidLate.entry.id}: a plugin requiring turn services must be session-scoped and cannot supply the turn's memory, registry or loop`))
  // Every turn needs a memory, a registry and a loop: from a plugin, the host's services, or each turn's (declared in turnServices).
  const unprovided = turnPorts.filter((key) => graph.providers[key] === undefined && !services.mapUnsafe.has(key) && !turnKeys.includes(key))
  if (unprovided.length > 0) {
    return yield* Effect.fail(failure("config.graph", `the agent has no ${unprovided.join(", ")}: no plugin provides it, and neither services nor turnServices carry it`))
  }
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
   * 6. `use`, then on success its tasks and background reactions settled;
   * 7. the host's layer, then the plugins of 2 closed, while TurnLive is
   *    still open: on success, what their finalizers publish or fork is
   *    settled and stored before TurnLive closes;
   * 8. on success finalizer work settled, then the final reply recorded (failed when
   *    the body or its finalizer work failed) and the turn's usage read,
   *    before TurnLive closes;
   * 9. a turn begun here is ended here, with `turnEndingOf` the turn's exit:
   *    on success its outcome (a failed end fails the turn; the inbox items
   *    the end counts waiting are returned as `pending`), on failure the
   *    error's code (the end's own failure is logged, the turn's cause kept);
   *    an end not stored is tried again, the same, when the turn's scope closes.
   * 1 to 9 run under the turn's `agent.turn` span (`traceTurn`), opened once
   * the turn is admitted (after 0), and are counted and timed by outcome.
   */
  const turn = <A = never, E = never, R = never>(
    input: TurnInput<A, E>,
    use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>,
  ): Effect.Effect<TurnResult, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>> => harnessDefectsAsFailures(Effect.scoped(Effect.gen(function* () {
    const scope = yield* Effect.scope
    const absent = turnKeys.filter((key) => !input.services.mapUnsafe.has(key))
    if (absent.length > 0) return yield* Effect.fail(failure("service.missing", `The turn does not provide ${absent.join(", ")}`))
    // The host's services may be a captured context: spans nest under the turn's, not where it was captured.
    // A trace content switch among the turn's own services is where its runs start, under the agent's and the policy's.
    const merged = Context.merge(replayableContext(Context.merge(runtime, input.services)), Context.pick(CurrentTraceContent)(input.services))
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
      ...(config.captureTraceContent === undefined ? {} : { captureTraceContent: config.captureTraceContent }),
    }

    const body = Effect.gen(function* () {
      yield* (yield* TurnMemory).persistMessage
      yield* openTurnTools
      // Everything `use` does sees the turn's services: `yield* SomeHostTag` gets the per-turn instance.
      return yield* use(yield* turnOf(runOptions))
    })
    // The turn-dependent plugins finalize before TurnLive closes. On success, the outer guard
    // settles their finalizer work, then records the final outcome while the writer is open.
    const provideTurnPlugins = <B, F, T>(effect: Effect.Effect<B, F, T>): Effect.Effect<B, F | HarnessError, unknown> => late.length === 0 ? effect : Effect.gen(function* () {
      const liveContext = yield* Effect.context<never>()
      return yield* Effect.scoped(Effect.gen(function* () {
        const activated = yield* activateGraph(afterTurn, "session", Context.merge(context, liveContext), yield* Effect.scope)
        return yield* effect.pipe(Effect.provide(activated))
      }))
    })
    const admitted = Effect.gen(function* () {
      const exit = yield* body.pipe(
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
        // A HarnessError carried as a defect is stored with its own code, not as `turn.defect`.
        harnessDefectsAsFailures,
        Effect.exit,
      )
      if (!own) return yield* exit
      // On failure the turn's own cause wins: an end not stored is logged (the scope's end tries it again).
      if (Exit.isFailure(exit)) {
        yield* writer.end(turnEndingOf(exit)).pipe(
          Effect.catch((error) => (error.code === "turn.closed" ? Effect.logDebug : Effect.logWarning)(
            `the failed turn's end was not stored: ${error.code}: ${error.message}`)),
          Effect.annotateLogs(turnIdsOf(writer.admitted)),
        )
        return yield* Effect.failCause(exit.cause)
      }
      // On success a failed end fails the turn; the inbox items it leaves waiting are the caller's to drain.
      const { pending } = yield* writer.end(turnEndingOf(exit))
      return { ...exit.value, pending } satisfies TurnResult
    })
    // From admission to the end: the turn's span encloses its plugins, layer, tools, `use`, reply and end.
    return yield* admitted.pipe(measureTurn, traceTurn(writer, { spanMeta: config.spanMeta ?? [] }))
  }))) as Effect.Effect<TurnResult, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>>

  // The probes are the runtime's alone, wherever this is read (a turn's own services hold others).
  const activity = processActivity.pipe(Effect.updateContext((current: Context.Context<never>) =>
    Context.merge(Context.omit(TurnActivity, TaskActivity)(current), Context.pick(TurnActivity, TaskActivity)(runtime))))

  return { fingerprint: graphFingerprint(graph), activity, turn }
})

export const Agent = { define: makeAgent }
