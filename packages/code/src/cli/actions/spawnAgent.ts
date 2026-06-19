import { Cause, Effect, Queue, type Layer } from "effect"
import {
  SettingsStore,
  type Approval,
  type UtilityLlm,
} from "@xandreed/sdk-core"
import type { buildScopeRuntime } from "../../usecases/buildScopeRuntime.js"
import type { AgentEvent } from "../../events.js"
import { refreshNav } from "./contextTree.js"
import type { FleetSupervisor } from "../state/fleet.js"
import type { AppServices, TuiStore } from "../state/store.js"

const firstLine = (s: string): string => {
  const i = s.indexOf("\n")
  return (i === -1 ? s : s.slice(0, i)).trim()
}

export interface SpawnAgentDeps {
  readonly store: TuiStore
  readonly scopeRuntime: ReturnType<typeof buildScopeRuntime>
  readonly eventQueue: Queue.Queue<AgentEvent>
  readonly approvalLayer: Layer.Layer<Approval, never, SettingsStore | UtilityLlm>
  readonly fleet: FleetSupervisor
}

/**
 * Fire a named agent ROLE from the live session — the human-driven counterpart
 * of the model's `run_agent`. Unlike `submit`/`submitToNode` (which own the
 * turn and flip `busy`), a fired agent runs DETACHED: it's `forkDaemon`'d so the
 * composer stays free, registered in the {@link FleetSupervisor} so `:stop` can
 * cancel it, and surfaces through the normal event pump (its `onSubAgentStart/
 * End` stamp `nodeId`, so the activity tree, `:tree`, and a node preview tail it
 * live). Budget/steps follow the session settings (sane defaults when unset).
 */
export const makeSpawnAgent =
  (deps: SpawnAgentDeps) =>
  (args: {
    readonly agent: string
    readonly folder: string
    readonly task: string
  }): Effect.Effect<void, never, AppServices> =>
    Effect.gen(function* () {
      const { store, scopeRuntime, eventQueue, approvalLayer, fleet } = deps
      const cid = store.run.getConversationId()
      store.pushBlock({
        kind: "info",
        text: `▸ firing agent ${args.agent} in ${args.folder}`,
      })
      store.convScroller.current?.scrollToBottom()

      const settings = yield* (yield* SettingsStore).get()
      const id = fleet.nextId()

      const runEffect = scopeRuntime
        .spawnAgent({
          rootConversationId: cid,
          folder: args.folder,
          task: args.task,
          title: args.agent,
          agent: args.agent,
          ...(settings.subAgentTokenBudget !== undefined
            ? { budget: settings.subAgentTokenBudget }
            : {}),
          ...(settings.subAgentMaxSteps !== undefined
            ? { maxSteps: settings.subAgentMaxSteps }
            : {}),
        })
        .pipe(
          Effect.provide(approvalLayer),
          Effect.matchCauseEffect({
            onFailure: (cause) => {
              const msg = `agent ${args.agent} (${args.folder}) failed: ${Cause.pretty(cause)}`
              return Effect.logError(msg).pipe(
                Effect.zipRight(Queue.offer(eventQueue, { type: "error", message: msg })),
              )
            },
            onSuccess: (r) =>
              Effect.sync(() =>
                store.pushBlock({
                  kind: "info",
                  text: `✓ agent ${args.agent} (${args.folder}) done — ${firstLine(r.summary)}`,
                }),
              ),
          }),
          // Deregister + refresh the navigator whichever way the run ends
          // (success, failure, or `:stop` interrupt).
          Effect.ensuring(
            Effect.sync(() => fleet.remove(id)).pipe(
              Effect.zipRight(refreshNav(store, cid).pipe(Effect.catchAll(() => Effect.void))),
            ),
          ),
          Effect.asVoid,
        )

      const fiber = yield* Effect.forkDaemon(runEffect)
      fleet.register(id, {
        fiber,
        title: args.agent,
        folder: args.folder,
        agent: args.agent,
      })
      store.setNote(`agent ${args.agent} running (:stop ${id} to cancel)`)
      // The fired agent may already have created its node — surface it now.
      yield* refreshNav(store, cid).pipe(Effect.catchAll(() => Effect.void))
    })
