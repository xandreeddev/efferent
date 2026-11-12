import { Match, Result } from "effect"
import { planPlugins, PluginName, PluginRefused } from "@xandreed/core/kernel"
import type { PluginNode } from "@xandreed/core/kernel"
import { AgentRefused } from "./agent.entity.js"
import type { AgentPhase } from "./agent.entity.js"

/** The keys of the contracts a list of plugins provides. */
export const providedBy = (plugins: ReadonlyArray<PluginNode>): ReadonlyArray<string> =>
  plugins.flatMap((plugin) => plugin.provides === undefined ? [] : [plugin.provides])

/**
 * The order to build the parts `with` rebuilds in (memory, the loop, then
 * the extras as listed), or their refusal, before any of them is built.
 * `given` are the keys of what is there already: `Core`, the settings, the
 * model and what the shared parts provide. `needs` are the keys the agent
 * itself takes from its plugins to run a turn.
 */
export const planRebuilt = <P extends PluginNode>(rebuilt: ReadonlyArray<P>, given: ReadonlyArray<string>, needs: ReadonlyArray<string>): Result.Result<ReadonlyArray<P>, PluginRefused> => {
  const order = planPlugins({ plugins: rebuilt, given })
  const there = new Set([...given, ...providedBy(rebuilt)])
  const lacking = needs.find((contract) => !there.has(contract))
  return Result.isFailure(order) || lacking === undefined ? order : Result.fail(new PluginRefused({
    reason: "MissingProvider",
    plugin: PluginName.make("host"),
    contract: lacking,
    message: `the agent requires ${lacking}, which no plugin provides: add a plugin that provides it`,
  }))
}

/**
 * The order to build an agent's plugins in, stage by stage, or the refusal
 * of the whole set, before anything is built. The shared parts (storage,
 * sessions) may need what is given them and each other, and nothing of
 * what `with` rebuilds: that is `LaterContract`. The rebuilt parts may
 * need all of it.
 */
export const planAgent = <P extends PluginNode>(parts: {
  readonly shared: ReadonlyArray<P>
  readonly rebuilt: ReadonlyArray<P>
  /** The keys there before each stage: `Core` for the shared parts; the settings and the model, besides, for the rebuilt ones. */
  readonly given: { readonly shared: ReadonlyArray<string>; readonly rebuilt: ReadonlyArray<string> }
  readonly needs: ReadonlyArray<string>
}): Result.Result<{ readonly shared: ReadonlyArray<P>; readonly rebuilt: ReadonlyArray<P> }, PluginRefused> => {
  // The settings and the model are the wiring's to provide, whichever stage a plugin is in.
  const taken = parts.shared.find((plugin) => plugin.provides !== undefined && parts.given.rebuilt.includes(plugin.provides))
  if (taken?.provides !== undefined) {
    return Result.fail(new PluginRefused({ reason: "DuplicateProvider", plugin: taken.name, contract: taken.provides, message: `plugin ${taken.name} provides ${taken.provides}, which is provided already: it is not a plugin's to provide here` }))
  }
  const shared = planPlugins({ plugins: parts.shared, given: parts.given.shared, later: [...parts.given.rebuilt, ...providedBy(parts.rebuilt)] })
  if (Result.isFailure(shared)) return Result.fail(shared.failure)
  const rebuilt = planRebuilt(parts.rebuilt, [...parts.given.shared, ...parts.given.rebuilt, ...providedBy(parts.shared)], parts.needs)
  return Result.isFailure(rebuilt) ? Result.fail(rebuilt.failure) : Result.succeed({ shared: shared.success, rebuilt: rebuilt.success })
}

const replaced = () => new AgentRefused({ reason: "Replaced", message: "this agent was replaced by `with`; send to the agent it returned" })
const replacing = () => new AgentRefused({ reason: "Replacing", message: "this agent is being replaced by `with`; send to the agent it returns, or to this one again if it is given up" })

/** A turn starts on the handle: one more running. Refused while the handle is being replaced, and once it was. */
export const admitTurn = (phase: AgentPhase): Result.Result<AgentPhase, AgentRefused> =>
  Match.valueTags(phase, {
    Live: ({ running }): Result.Result<AgentPhase, AgentRefused> => Result.succeed({ _tag: "Live", running: running + 1 }),
    Replacing: () => Result.fail(replacing()),
    Replaced: () => Result.fail(replaced()),
  })

/** A turn of the handle ended: one fewer running. */
export const leaveTurn = (phase: AgentPhase): AgentPhase =>
  Match.valueTags(phase, {
    Live: ({ running }): AgentPhase => ({ _tag: "Live", running: Math.max(0, running - 1) }),
    Replacing: ({ running }): AgentPhase => ({ _tag: "Replacing", running: Math.max(0, running - 1) }),
    Replaced: (same): AgentPhase => same,
  })

/** `with` starts to replace the handle: it keeps the turns it runs and takes no more. One `with` at a time, and none once replaced. */
export const beginReplace = (phase: AgentPhase): Result.Result<AgentPhase, AgentRefused> =>
  Match.valueTags(phase, {
    Live: ({ running }): Result.Result<AgentPhase, AgentRefused> => Result.succeed({ _tag: "Replacing", running }),
    Replacing: () => Result.fail(replacing()),
    Replaced: () => Result.fail(replaced()),
  })

/** `with` gave up before the switch: the handle is the agent again, as if it had not been called. */
export const cancelReplace = (phase: AgentPhase): AgentPhase =>
  Match.valueTags(phase, {
    Live: (same): AgentPhase => same,
    Replacing: ({ running }): AgentPhase => ({ _tag: "Live", running }),
    Replaced: (same): AgentPhase => same,
  })

/** The switch: a handle that was being replaced is replaced. */
export const finishReplace = (phase: AgentPhase): AgentPhase =>
  Match.valueTags(phase, {
    Live: (same): AgentPhase => same,
    Replacing: (): AgentPhase => ({ _tag: "Replaced" }),
    Replaced: (same): AgentPhase => same,
  })

/** Whether the handle runs no turn. */
export const isIdle = (phase: AgentPhase): boolean =>
  Match.valueTags(phase, { Live: ({ running }) => running === 0, Replacing: ({ running }) => running === 0, Replaced: () => true })
