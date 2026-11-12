import { Context, Effect, Exit, Layer, Option, Queue, Ref, Result, Schema, Scope } from "effect"
import { LanguageModel } from "effect/ai"
import { Core, CoreIdle, CoreLive, inspectionOf, Loop, NewSession, PluginName, PluginRefused, Sessions, Settings } from "@xandreed/core/kernel"
import type { PluginOf } from "@xandreed/core/kernel"
import { admitTurn, beginReplace, cancelReplace, finishReplace, isIdle, leaveTurn, planAgent, planRebuilt, providedBy } from "./agent.entity.functions.js"
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

/** A config with the changes `with` was given; a change given as `undefined` is no change. */
const changed = (config: Resolved, changes: AgentChanges): Resolved => ({
  ...config,
  model: changes.model ?? config.model,
  system: changes.system ?? config.system,
  memory: changes.memory ?? config.memory,
  loop: changes.loop ?? config.loop,
  ...(changes.plugins === undefined ? {} : { plugins: changes.plugins }),
})

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

/** A part the agent takes from what was built; the plan made sure something provides it. */
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
  /** `Core`, its wait, and what the shared parts provide. */
  readonly shared: Context.Context<never>
  readonly own: Scope.Closeable
  /** Everything a turn runs on: the shared parts, the settings, the model and what the rebuilt parts provide. */
  readonly all: Context.Context<never>
}

/** What undoes a mask for the work inside it, as `Effect.uninterruptibleMask` hands it over. */
type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

/**
 * Run `use` over a scope of its own under `parent`, where interrupts are
 * masked: `use` itself runs as `restore` lets it, and its scope is closed
 * again if it fails or is interrupted, so nothing it built is left behind.
 */
const intoOwnScope = <A, E>(parent: Scope.Scope, restore: Restore, use: (own: Scope.Closeable) => Effect.Effect<A, E>) =>
  Effect.flatMap(Scope.fork(parent), (own) =>
    restore(use(own)).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(own, exit) : Effect.void)))

/**
 * The rebuilt parts of `config`, in the order planned, in a scope of their
 * own under `parent`: the settings and the model, then the plugins. What
 * was built is released again if one of them cannot be built.
 */
const rebuild = (config: Resolved, order: ReadonlyArray<PluginOf>, shared: Context.Context<never>, parent: Scope.Scope, restore: Restore) =>
  intoOwnScope(parent, restore, (own) => Effect.gen(function* () {
    const given = yield* build(Layer.merge(config.model, Layer.succeed(Settings, { system: config.system })), own)
    const all = yield* buildInOrder(order, Context.merge(shared, given), own)
    const parts: Parts = { config, shared, own, all }
    return parts
  }))

/** The handle over built parts. */
const handleOf = ({ config, shared, own, all }: Parts): Effect.Effect<AgentHandle, PluginRefused> => Effect.gen(function* () {
  const core = yield* need(shared, Core)
  const idle = yield* need(shared, CoreIdle)
  const sessionsOf = yield* need(shared, Sessions)
  const loop = yield* need(all, Loop)
  const self = yield* Effect.sync((): object => ({}))
  const phase = yield* Ref.make<AgentPhase>({ _tag: "Live", running: 0 })
  /** A turn of this handle ended: a signal that never loses the last one. */
  const left = yield* Queue.sliding<void>(1)

  /** Move the handle's phase by one transition, or fail with its refusal. */
  const move = (transition: (phase: AgentPhase) => Result.Result<AgentPhase, AgentRefused>) =>
    Ref.modify(phase, (now) => Result.match(transition(now), {
      onFailure: (refusal): readonly [Effect.Effect<AgentPhase, AgentRefused>, AgentPhase] => [Effect.fail(refusal), now],
      onSuccess: (next): readonly [Effect.Effect<AgentPhase, AgentRefused>, AgentPhase] => [Effect.succeed(next), next],
    })).pipe(Effect.flatten)

  /** The turns this handle is running are over. A turn that leaves between the look and the wait is not missed: its signal is kept. */
  const turnsOver: Effect.Effect<void> = Effect.flatMap(Ref.get(phase), (now) =>
    isIdle(now) ? Effect.void : Effect.andThen(Queue.take(left), Effect.suspend(() => turnsOver)))

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
          () => Effect.andThen(Ref.update(phase, leaveTurn), Queue.offer(left, undefined)),
        ),
    inspect: (session) => Effect.flatMap(sessionsOf.read(session), (journal) => Effect.fromResult(inspectionOf(journal))),
    events: core.events,
    with: Effect.fn("kernel.agent.with")(function* (changes: AgentChanges) {
      if ((yield* TurnsAround).includes(self)) {
        return yield* Effect.fail(new AgentRefused({ reason: "InsideTurn", message: "`with` was called from inside a turn of the agent it would replace; call it between turns" }))
      }
      const parent = yield* Effect.scope
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        yield* move(beginReplace)                               // from here a send, and a second `with`, are refused: Replacing
        // Up to the switch, a failure or an interrupt gives the handle back as it was, with nothing built left behind.
        const successor = yield* Effect.gen(function* () {
          const next = changed(config, changes)
          const order = yield* Effect.fromResult(planRebuilt(rebuiltOf(next), overShared(next), NEEDS))   // what the plugins declare, before any wait
          yield* restore(turnsOver)                             // the turns it is running finish
          yield* restore(idle.wait)                             // and every listener has handled what they published
          const built = yield* rebuild(next, order, shared, parent, restore)   // with nothing running: the successor's parts
          return yield* handleOf(built).pipe(Effect.onError(() => Scope.close(built.own, Exit.void)))
        }).pipe(Effect.onError(() => Ref.update(phase, cancelReplace)))
        yield* Scope.close(own, Exit.void)                      // this agent's own parts go, their listeners with them
        yield* Ref.update(phase, finishReplace)                 // and the successor is the agent
        return successor
      }))
    }),
  }
})

/**
 * Define an agent. What every plugin declares is read first, and the set is
 * refused (`PluginRefused`, naming the plugin and the contract) before
 * anything is built when a plugin needs a contract nothing provides, two
 * provide the same one, a plugin is listed twice, plugins need each other
 * in a circle, or a shared part needs a part `with` rebuilds. Then `Core`
 * and the plugins are built in the order planned, in the scope `define` is
 * called in. A plugin that cannot be built (a memory given no usable
 * budget, for instance) fails the definition with its own error, and what
 * was built before it is released.
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
  return yield* Effect.uninterruptibleMask((restore) => intoOwnScope(home, restore, (base) => Effect.gen(function* () {
    const core = yield* build(CoreLive(resolved.core), base)
    const shared = yield* buildInOrder(order.shared, core, base)
    return yield* handleOf(yield* Effect.uninterruptibleMask((again) => rebuild(resolved, order.rebuilt, shared, base, again)))
  })))
})

/**
 * The kernel's wiring: `Agent.define(config)` gives the handle a host works with.
 *
 * @public
 */
export const Agent = { define }
