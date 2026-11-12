import { Context, Effect, Exit, Layer, Option, Ref, Result, Schema, Scope } from "effect"
import { LanguageModel } from "effect/ai"
import { Core, CoreLive, inspectionOf, Loop, NewSession, PluginName, PluginRefused, Sessions, Settings } from "@xandreed/core/kernel"
import type { PluginOf } from "@xandreed/core/kernel"
import { admitTurn, isDrained, leaveTurn, planAgent, planRebuilt, providedBy, replaceAgent, stillLive } from "./agent.entity.functions.js"
import { AgentRefused } from "./agent.entity.js"
import type { AgentChanges, AgentConfig, AgentHandle, AgentPhase, NewSessionInput } from "./agent.entity.js"
import { TurnsAround } from "./agent.port.js"
import { stepLoop } from "./plugins/loop/step-loop.adapter.js"
import { sessions } from "./plugins/session/sessions.adapter.js"

/** What is there before the shared parts are built: `Core`, which the wiring builds itself. */
const GIVEN_SHARED = [Core.key]
/** What is there, besides, before the rebuilt parts are built: the settings and the model, which the wiring builds from the config. */
const GIVEN_REBUILT = [Settings.key, LanguageModel.LanguageModel.key]
/** What the agent itself takes from its plugins to run a turn. */
const NEEDS = [Sessions.key, Loop.key]

/** A config with its defaults filled in, so the plugins planned are the plugins built. */
type Resolved = AgentConfig & Required<Pick<AgentConfig, "sessions" | "loop">>

/** The parts built once and shared, in the order they are listed. */
const sharedOf = (config: Resolved): ReadonlyArray<PluginOf> => [config.storage, config.sessions]
/** The parts `with` builds again, in the order they are listed: memory, the loop, then the extras. */
const rebuiltOf = (config: Resolved): ReadonlyArray<PluginOf> => [config.memory, config.loop, ...(config.plugins ?? [])]
/** What the rebuilt parts are planned over: everything given, and what the shared parts provide. */
const overShared = (config: Resolved) => [...GIVEN_SHARED, ...GIVEN_REBUILT, ...providedBy(sharedOf(config))]

/** Build a layer of the wiring's own on its own memo map, so nothing built before is reused, into `scope`. */
const build = <ROut, E>(layer: Layer.Layer<ROut, E>, scope: Scope.Scope) =>
  Effect.flatMap(Layer.makeMemoMap, (memo) => Layer.buildWithMemoMap(layer, memo, scope))

/**
 * Build plugins one after another, in the order planned, into `scope`:
 * each over what was there and what the ones before it provided, so its
 * listeners register after theirs.
 */
const buildInOrder = (plugins: ReadonlyArray<PluginOf>, over: Context.Context<never>, scope: Scope.Scope) =>
  Effect.reduce(plugins, () => over, (services, plugin) =>
    plugin.build(services).pipe(Scope.provide(scope), Effect.map((built): Context.Context<never> => Context.merge(services, built))))

/** A contract the agent takes from what was built; the plan made sure a plugin provides it. */
const need = <I, S>(services: Context.Context<never>, contract: Context.Key<I, S> & { readonly key: string }) =>
  Option.match(Context.getOption(services, contract), {
    onSome: (service) => Effect.succeed(service),
    onNone: () => Effect.fail(new PluginRefused({
      reason: "MissingProvider",
      plugin: PluginName.make("host"),
      contract: contract.key,
      message: `the agent requires ${contract.key}, which the plugin that declares it did not provide`,
    })),
  })

const decodeSession = Schema.decodeUnknownEffect(NewSession)

/** What a handle is made over: its config, the parts it shares, and its own parts in a scope of their own. */
interface Parts {
  readonly config: Resolved
  /** `Core` and what the shared parts provide. */
  readonly shared: Context.Context<never>
  readonly own: Scope.Closeable
  /** Everything a turn runs on: the shared parts, the settings, the model and what the rebuilt parts provide. */
  readonly all: Context.Context<never>
}

/** Run `use` over a scope of its own under `parent`; the scope is closed again if `use` fails or is interrupted. */
const inOwnScope = <A, E>(parent: Scope.Scope, use: (own: Scope.Closeable) => Effect.Effect<A, E>) =>
  Effect.uninterruptibleMask((restore) => Effect.flatMap(Scope.fork(parent), (own) =>
    restore(use(own)).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(own, exit) : Effect.void))))

/**
 * The rebuilt parts of `config`, in the order planned, in a scope of their
 * own under `parent`: the settings and the model, then the plugins. What
 * was built is released again if one of them cannot be built.
 */
const rebuild = (config: Resolved, order: ReadonlyArray<PluginOf>, shared: Context.Context<never>, parent: Scope.Scope) =>
  inOwnScope(parent, (own) => Effect.gen(function* () {
    const given = yield* build(Layer.merge(config.model, Layer.succeed(Settings, { system: config.system })), own)
    const all = yield* buildInOrder(order, Context.merge(shared, given), own)
    const parts: Parts = { config, shared, own, all }
    return parts
  }))

/** The handle over built parts. */
const handleOf = ({ config, shared, own, all }: Parts): Effect.Effect<AgentHandle, PluginRefused> => Effect.gen(function* () {
  const core = yield* need(shared, Core)
  const sessionsOf = yield* need(shared, Sessions)
  const loop = yield* need(all, Loop)
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
    events: core.events,
    with: Effect.fn("kernel.agent.with")(function* (changes: AgentChanges) {
      if ((yield* TurnsAround).includes(self)) {
        return yield* Effect.fail(new AgentRefused({ reason: "InsideTurn", message: "`with` was called from inside a turn of the agent it would replace; call it between turns" }))
      }
      yield* move(stillLive)                                    // a handle replaced before refuses, before anything is built
      const next: Resolved = { ...config, ...changes, sessions: config.sessions, loop: changes.loop ?? config.loop }
      // What the changed plugins declare, checked before anything is built: refused here, nothing has changed.
      const order = yield* Effect.fromResult(planRebuilt(rebuiltOf(next), overShared(next), NEEDS))
      const parent = yield* Effect.scope
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        // The successor first, while this handle goes on working: interrupted or failed here, nothing has changed.
        const built = yield* restore(rebuild(next, order, shared, parent))
        const successor = yield* handleOf(built).pipe(Effect.tapError(() => Scope.close(built.own, Exit.void)))
        // The switch, in one step: this handle takes no more turns, the successor is the agent.
        const after = yield* move(replaceAgent).pipe(Effect.tapError(() => Scope.close(built.own, Exit.void)))
        // This handle's parts close when its last turn is over: now, or as that turn ends.
        yield* retire(after)
        return successor
      }))
    }),
  }
})

/**
 * Define an agent. What every plugin declares is read first, and the set is
 * refused (`PluginRefused`, naming the plugin and the contract) before
 * anything is built when a plugin needs a contract nothing provides, two
 * provide the same one, plugins need each other in a circle, or a shared
 * part needs a part `with` rebuilds. Then `Core` and the plugins are built
 * in the order planned, in the scope `define` is called in. A plugin that
 * cannot be built (a memory given no usable budget, for instance) fails the
 * definition with its own error, and what was built before it is released.
 */
const define = Effect.fn("kernel.agent.define")(function* (config: AgentConfig) {
  const resolved: Resolved = { ...config, sessions: config.sessions ?? sessions(), loop: config.loop ?? stepLoop() }
  const order = yield* Effect.fromResult(planAgent({
    shared: sharedOf(resolved),
    rebuilt: rebuiltOf(resolved),
    given: { shared: GIVEN_SHARED, rebuilt: GIVEN_REBUILT },
    needs: NEEDS,
  }))
  const home = yield* Effect.scope
  return yield* inOwnScope(home, (base) => Effect.gen(function* () {
    const core = yield* build(CoreLive(resolved.core), base)
    const shared = yield* buildInOrder(order.shared, core, base)
    return yield* handleOf(yield* rebuild(resolved, order.rebuilt, shared, base))
  }))
})

/**
 * The kernel's wiring: `Agent.define(config)` gives the handle a host works with.
 *
 * @public
 */
export const Agent = { define }
