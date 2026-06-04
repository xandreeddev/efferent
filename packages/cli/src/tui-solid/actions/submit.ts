import { Effect, Queue } from "effect"
import {
  AuthStore,
  buildScopeRuntime,
  coderAgentConfig,
  runAgent,
  type AgentHooks,
  type Scope,
} from "@efferent/core"
import type { AgentEvent } from "../../events.js"
import { formatFullError } from "../util/errorFormat.js"
import type { AppServices, TuiStore } from "../state/store.js"

export interface SubmitDeps {
  readonly store: TuiStore
  readonly scopeRuntime: ReturnType<typeof buildScopeRuntime>
  readonly baseHooks: AgentHooks<never>
  readonly eventQueue: Queue.Queue<AgentEvent>
  readonly rootScope: Scope
  readonly cwd: string
}

/**
 * The agent-run action, lifted from `tui.ts:1442` (`submit`). The Effect body is
 * unchanged in spirit — auth gate, busy→queue, fork `runAgent` with the scope's
 * handler layer, drain the queue in an `ensuring` `finishTurn` — but every UI
 * write goes through the Solid store instead of `Ref.update(stateRef)`. The
 * agent fiber stays Effect-owned (`store.run.runningFiber`), never a signal.
 *
 * Returns a recursive `submit` so a queued message resubmits on turn end.
 */
export const makeSubmit = (
  deps: SubmitDeps,
): ((text: string) => Effect.Effect<void, never, AppServices>) => {
  const { store, scopeRuntime, baseHooks, eventQueue, rootScope, cwd } = deps

  const submit = (text: string): Effect.Effect<void, never, AppServices> =>
    Effect.gen(function* () {
      // No provider configured → guide to :login instead of a deep 401.
      const authAll = yield* (yield* AuthStore).all
      if (Object.keys(authAll).length === 0) {
        store.pushBlock({ kind: "user", text })
        store.pushBlock({
          kind: "info",
          text: "no provider configured — run :login to add one (subscription or API key)",
        })
        store.setInput("")
        return
      }

      // Busy → queue it for after the current turn.
      if (store.busy()) {
        store.run.queue.push(text)
        store.pushBlock({ kind: "info", text: `queued: ${text}` })
        store.setInput("")
        return
      }

      store.pushBlock({ kind: "user", text })
      store.setInput("")
      store.setBusy(true)
      store.setNote("working…")
      store.run.turnStartedAt = Date.now()

      const cid = store.run.conversationId

      // Reset busy + drain one queued message. Runs on success, failure, AND
      // interruption (Esc) via `ensuring`, so the loop never gets stuck.
      const finishTurn = Effect.gen(function* () {
        const next = store.run.queue.shift()
        store.setBusy(false)
        store.setNote(undefined)
        store.run.runningFiber = undefined
        if (next !== undefined) yield* submit(next)
      })

      const runEffect = runAgent(
        coderAgentConfig(rootScope, scopeRuntime),
        cid,
        text,
        baseHooks,
        cwd,
      ).pipe(
        Effect.provide(scopeRuntime.handlerLayer),
        Effect.catchAll((err) => {
          const msg = formatFullError(err)
          return Effect.logError(msg).pipe(
            Effect.zipRight(Queue.offer(eventQueue, { type: "error", message: msg })),
          )
        }),
        Effect.asVoid,
        Effect.ensuring(finishTurn),
      )

      const fiber = yield* Effect.forkDaemon(runEffect)
      store.run.runningFiber = fiber
    })

  return submit
}
