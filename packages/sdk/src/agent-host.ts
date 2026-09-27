import { Context, Effect, Option } from "effect"
import { AgentLoop, HarnessError, SessionEnvironment, TurnHooks } from "@xandreed/core"
import type { EventBody, HarnessConfig, LoopInput, Plugin, RunIO, SessionRecord } from "@xandreed/core"
import { activateGraph, graphFingerprint, resolveGraph } from "@xandreed/runtime"

const missing = (key: string) => new HarnessError({ code: "service.missing", message: `The profile does not provide ${key}` })

/** One turn the host has already admitted (its own queue, lease and journal). */
export interface HostTurn {
  readonly session: SessionRecord
  readonly runId: string
  readonly prompt: string
  readonly io: RunIO & {
    readonly transient: (event: EventBody) => Effect.Effect<void>
    readonly steering: Effect.Effect<Option.Option<string>, HarnessError>
  }
  /** Services for this turn only (e.g. a model with the turn's budget). */
  readonly services: Context.Context<never>
}

/**
 * The plugin graph for a host that owns its own run lifecycle — queueing,
 * leases, journal and delivery — and only wants Efferent to run the agent.
 * The runtime graph is activated once; the session graph is activated per
 * turn, so every turn sees fresh session plugins and the turn's services.
 * Host services are the graph's external keys: plugins may require them.
 */
export const makeAgentHost = (options: {
  readonly config: HarnessConfig
  readonly plugins: ReadonlyArray<Plugin>
  readonly workspace: string
  /** Process-lifetime host services (stores, data ports). */
  readonly services: Context.Context<never>
  /** Keys of the services every turn supplies. */
  readonly turnServices: ReadonlyArray<{ readonly key: string }>
}) => Effect.gen(function* () {
  const parent = yield* Effect.scope
  const external = [SessionEnvironment.key, ...options.services.unsafeMap.keys(), ...options.turnServices.map((tag) => tag.key)]
  const graph = yield* resolveGraph(options.config, options.plugins, external)
  const seed = Context.add(options.services, SessionEnvironment, { workspace: options.workspace })
  const runtime = yield* activateGraph(graph, "runtime", Context.unsafeMake<never>(seed.unsafeMap), parent)
  const run = (turn: HostTurn) => Effect.scoped(Effect.gen(function* () {
    const scope = yield* Effect.scope
    const absent = options.turnServices.map((tag) => tag.key).filter((key) => !turn.services.unsafeMap.has(key))
    if (absent.length > 0) return yield* Effect.fail(missing(absent.join(", ")))
    const sessionSeed = Context.add(Context.merge(runtime, turn.services), SessionEnvironment, { workspace: options.workspace, session: turn.session })
    const context = yield* activateGraph(graph, "session", Context.unsafeMake<never>(sessionSeed.unsafeMap), scope)
    const loop = yield* Option.match(Context.getOption(context, AgentLoop), { onNone: () => Effect.fail(missing(AgentLoop.key)), onSome: Effect.succeed })
    const hooks = Context.getOption(context, TurnHooks)
    const input: LoopInput = {
      session: turn.session, runId: turn.runId, prompt: turn.prompt, system: options.config.system ?? "",
      publish: turn.io.publish, transient: turn.io.transient, steering: turn.io.steering, history: turn.io.history,
      services: Context.merge(options.services, turn.services),
    }
    const prepared = Option.isSome(hooks) ? yield* hooks.value.before(input) : input
    const result = yield* loop.run(prepared)
    if (Option.isSome(hooks)) yield* hooks.value.after(prepared)
    return result
  }))
  return { run, graph, fingerprint: graphFingerprint(graph) }
})

export const AgentHost = { make: makeAgentHost }
export type AgentHost = Effect.Effect.Success<ReturnType<typeof makeAgentHost>>
