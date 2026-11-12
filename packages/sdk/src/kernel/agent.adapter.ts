import { Context, Deferred, Effect, Exit, Layer, Ref, Result, Schema, Scope } from "effect"
import { Core, CoreLive, inspectionOf, Loop, NewSession, Sessions, Settings } from "@xandreed/core/kernel"
import type { Plugin } from "@xandreed/core/kernel"
import { admitTurn, isDrained, leaveTurn, replaceAgent } from "./agent.entity.functions.js"
import { AgentRefused } from "./agent.entity.js"
import type { AgentChanges, AgentConfig, AgentHandle, AgentPhase, NewSessionInput, RebuiltParts, SharedParts } from "./agent.entity.js"
import { stepLoop } from "./plugins/loop/step-loop.adapter.js"
import { sessions } from "./plugins/session/sessions.adapter.js"

/** What lives as long as the agent: core, then storage, then sessions. */
const sharedLayer = (config: AgentConfig) =>
  (config.sessions ?? sessions()).layer.pipe(
    Layer.provideMerge(config.storage.layer),
    Layer.provideMerge(CoreLive(config.core)),
  )

/** The extra plugins, one after another in the order given, so their listeners register in that order. */
const extras = (plugins: ReadonlyArray<Plugin<never, never, SharedParts | RebuiltParts>>) =>
  plugins.reduce<Layer.Layer<never, never, SharedParts | RebuiltParts>>((built, plugin) => Layer.provideMerge(plugin.layer, built), Layer.empty)

/** What `with` builds again: the settings and the model, then memory, then the loop, then the extras. */
const rebuiltLayer = (config: AgentConfig) =>
  extras(config.plugins ?? []).pipe(
    Layer.provideMerge((config.loop ?? stepLoop()).layer),
    Layer.provideMerge(config.memory.layer),
    Layer.provideMerge(Layer.merge(config.model, Layer.succeed(Settings, { system: config.system }))),
  )

/** Build a layer on its own memo map, so nothing built before is reused, into `scope`. */
const build = <ROut, RIn>(layer: Layer.Layer<ROut, never, RIn>, scope: Scope.Scope) =>
  Effect.flatMap(Layer.makeMemoMap, (memo) => Layer.buildWithMemoMap(layer, memo, scope))

const decodeSession = Schema.decodeUnknownEffect(NewSession)

/** An agent over parts already shared: its own rebuilt parts in a scope of their own, and the handle. */
const assemble = (config: AgentConfig, shared: Context.Context<SharedParts>): Effect.Effect<AgentHandle, never, Scope.Scope> => Effect.gen(function* () {
  const own = yield* Scope.fork(yield* Effect.scope)
  const rebuilt = yield* build(rebuiltLayer(config), own).pipe(Effect.provide(shared))
  const sessionsOf = Context.get(shared, Sessions)
  const loop = Context.get(rebuilt, Loop)
  const phase = yield* Ref.make<AgentPhase>({ _tag: "Live", running: 0 })
  const drained = yield* Deferred.make<void>()

  /** Move the handle's phase; when that leaves it replaced with no turn running, say so. */
  const move = (transition: (phase: AgentPhase) => Result.Result<AgentPhase, AgentRefused>) =>
    Ref.modify(phase, (now) => Result.match(transition(now), {
      onFailure: (refusal): readonly [Effect.Effect<void, AgentRefused>, AgentPhase] => [Effect.fail(refusal), now],
      onSuccess: (next): readonly [Effect.Effect<void, AgentRefused>, AgentPhase] => [isDrained(next) ? Effect.asVoid(Deferred.succeed(drained, undefined)) : Effect.void, next],
    })).pipe(Effect.flatten)

  return {
    createSession: (input: NewSessionInput) => decodeSession(input).pipe(
      Effect.mapError(() => new AgentRefused({ reason: "InvalidSession", message: "a session needs an owner that is not empty, and a parent that is a session id" })),
      Effect.flatMap((decoded) => sessionsOf.create(decoded)),
    ),
    send: (session, message) => Effect.acquireUseRelease(
      move(admitTurn),
      () => loop.run({ session, message }),
      () => Effect.orDie(move((now) => Result.succeed(leaveTurn(now)))),
    ),
    inspect: (session) => Effect.flatMap(sessionsOf.read(session), (journal) => Effect.fromResult(inspectionOf(journal))),
    events: Context.get(shared, Core).events,
    with: Effect.fn("kernel.agent.with")(function* (changes: AgentChanges) {
      yield* move(replaceAgent)                       // no more turns here; a handle replaced before refuses
      yield* Deferred.await(drained)                  // the turns it was running finish
      yield* Scope.close(own, Exit.void)              // its parts close, their listeners with them
      return yield* assemble({ ...config, ...changes }, shared)
    }),
  }
})

/**
 * Define an agent: `Core` and every plugin, built in dependency order in
 * the scope `define` is called in.
 */
const define = Effect.fn("kernel.agent.define")(function* (config: AgentConfig) {
  const shared = yield* build(sharedLayer(config), yield* Effect.scope)
  return yield* assemble(config, shared)
})

/**
 * The kernel's wiring: `Agent.define(config)` gives the handle a host works with.
 *
 * @public
 */
export const Agent = { define }
