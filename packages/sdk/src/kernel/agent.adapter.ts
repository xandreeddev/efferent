import { Context, Effect, Exit, Layer, Ref, Result, Schema, Scope } from "effect"
import { Core, CoreLive, inspectionOf, Loop, NewSession, Sessions, Settings } from "@xandreed/core/kernel"
import type { Plugin, PluginFailure } from "@xandreed/core/kernel"
import { admitTurn, isDrained, leaveTurn, replaceAgent, stillLive } from "./agent.entity.functions.js"
import { AgentRefused } from "./agent.entity.js"
import type { AgentChanges, AgentConfig, AgentHandle, AgentPhase, NewSessionInput, RebuiltParts, SharedParts } from "./agent.entity.js"
import { TurnsAround } from "./agent.port.js"
import { stepLoop } from "./plugins/loop/step-loop.adapter.js"
import { sessions } from "./plugins/session/sessions.adapter.js"

/** What lives as long as the agent: core, then storage, then sessions. */
const sharedLayer = (config: AgentConfig) =>
  (config.sessions ?? sessions()).layer.pipe(
    Layer.provideMerge(config.storage.layer),
    Layer.provideMerge(CoreLive(config.core)),
  )

/** The extra plugins, one after another in the order given, so their listeners register in that order. */
const extras = (plugins: ReadonlyArray<Plugin<never, PluginFailure, SharedParts | RebuiltParts>>) =>
  plugins.reduce<Layer.Layer<never, PluginFailure, SharedParts | RebuiltParts>>((built, plugin) => Layer.provideMerge(plugin.layer, built), Layer.empty)

/** What `with` builds again: the settings and the model, then memory, then the loop, then the extras. */
const rebuiltLayer = (config: AgentConfig) =>
  extras(config.plugins ?? []).pipe(
    Layer.provideMerge((config.loop ?? stepLoop()).layer),
    Layer.provideMerge(config.memory.layer),
    Layer.provideMerge(Layer.merge(config.model, Layer.succeed(Settings, { system: config.system }))),
  )

/** Build a layer on its own memo map, so nothing built before is reused, into `scope`. */
const build = <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>, scope: Scope.Scope) =>
  Effect.flatMap(Layer.makeMemoMap, (memo) => Layer.buildWithMemoMap(layer, memo, scope))

const decodeSession = Schema.decodeUnknownEffect(NewSession)

/** What a handle is made over: the parts it shares, and its own parts in a scope of their own. */
interface Parts {
  readonly config: AgentConfig
  readonly shared: Context.Context<SharedParts>
  readonly own: Scope.Closeable
  readonly rebuilt: Context.Context<RebuiltParts>
}

/** The rebuilt parts of `config`, in a scope of their own under `parent`; closed again if they cannot be built. */
const rebuild = (config: AgentConfig, shared: Context.Context<SharedParts>, parent: Scope.Scope) =>
  Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const own = yield* Scope.fork(parent)
    const rebuilt = yield* restore(build(rebuiltLayer(config), own).pipe(Effect.provide(shared))).pipe(
      Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(own, exit) : Effect.void),
    )
    const parts: Parts = { config, shared, own, rebuilt }
    return parts
  }))

/** The handle over built parts. */
const handleOf = ({ config, shared, own, rebuilt }: Parts): Effect.Effect<AgentHandle> => Effect.gen(function* () {
  const sessionsOf = Context.get(shared, Sessions)
  const loop = Context.get(rebuilt, Loop)
  const self = yield* Effect.sync((): object => ({}))
  const phase = yield* Ref.make<AgentPhase>({ _tag: "Live", running: 0 })

  /** Move the handle's phase by one transition, or fail with its refusal. */
  const move = (transition: (phase: AgentPhase) => Result.Result<AgentPhase, AgentRefused>) =>
    Ref.modify(phase, (now) => Result.match(transition(now), {
      onFailure: (refusal): readonly [Effect.Effect<AgentPhase, AgentRefused>, AgentPhase] => [Effect.fail(refusal), now],
      onSuccess: (next): readonly [Effect.Effect<AgentPhase, AgentRefused>, AgentPhase] => [Effect.succeed(next), next],
    })).pipe(Effect.flatten)

  /** Close this handle's own parts once it is replaced and its last turn is over: their listeners go with them. */
  const retire = (after: AgentPhase) => isDrained(after) ? Scope.close(own, Exit.void) : Effect.void

  return {
    createSession: (input: NewSessionInput) => decodeSession(input).pipe(
      Effect.mapError(() => new AgentRefused({ reason: "InvalidSession", message: "a session needs an owner that is not empty, and a parent that is a session id" })),
      Effect.flatMap((decoded) => sessionsOf.create(decoded)),
    ),
    send: (session, message) => message.trim().length === 0
      ? Effect.fail(new AgentRefused({ reason: "EmptyMessage", message: "a turn needs a message that is not empty" }))
      : Effect.acquireUseRelease(
          move(admitTurn),
          () => Effect.flatMap(TurnsAround, (around) => Effect.provideService(loop.run({ session, message }), TurnsAround, [...around, self])),
          () => Effect.flatMap(Effect.orDie(move((now) => Result.succeed(leaveTurn(now)))), retire),
        ),
    inspect: (session) => Effect.flatMap(sessionsOf.read(session), (journal) => Effect.fromResult(inspectionOf(journal))),
    events: Context.get(shared, Core).events,
    with: Effect.fn("kernel.agent.with")(function* (changes: AgentChanges) {
      if ((yield* TurnsAround).includes(self)) {
        return yield* Effect.fail(new AgentRefused({ reason: "InsideTurn", message: "`with` was called from inside a turn of the agent it would replace; call it between turns" }))
      }
      yield* move(stillLive)                                    // a handle replaced before refuses, before anything is built
      const parent = yield* Effect.scope
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        // The successor first, while this handle goes on working: interrupted or failed here, nothing has changed.
        const next = yield* restore(rebuild({ ...config, ...changes }, shared, parent))
        const successor = yield* handleOf(next)
        // The switch, in one step: this handle takes no more turns, the successor is the agent.
        const after = yield* move(replaceAgent).pipe(Effect.tapError(() => Scope.close(next.own, Exit.void)))
        // This handle's parts close when its last turn is over: now, or as that turn ends.
        yield* retire(after)
        return successor
      }))
    }),
  }
})

/**
 * Define an agent: `Core` and every plugin, built in dependency order in
 * the scope `define` is called in. A plugin that cannot be built (a memory
 * given no usable budget, for instance) fails the definition with its own
 * error.
 */
const define = Effect.fn("kernel.agent.define")(function* (config: AgentConfig) {
  const home = yield* Effect.scope
  const shared = yield* build(sharedLayer(config), home)
  return yield* handleOf(yield* rebuild(config, shared, home))
})

/**
 * The kernel's wiring: `Agent.define(config)` gives the handle a host works with.
 *
 * @public
 */
export const Agent = { define }
