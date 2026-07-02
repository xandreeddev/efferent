import { Effect, Ref } from "effect"
import type { ContextNodeId } from "../entities/AgentContext.js"
import type { AgentHooks } from "../entities/AgentHooks.js"
import { outcomeOk, type RunOutcome } from "../entities/Outcome.js"
import type { ContextTreeStore } from "../ports/ContextTreeStore.js"
import type { AgentBus } from "./agentBus.js"

/**
 * THE one terminal path for a spawned agent run. Every exit shape — normal
 * completion, tool/LLM failure, budget or step-cap stop, watchdog stall,
 * interrupt, defect — computes a {@link RunOutcome} and funnels through here,
 * which performs, in order:
 *
 *   1. `store.recordReturn` — the durable record (status + summary + typed
 *      stopReason + files + usage). The store is terminal-once (`WHERE status =
 *      'running'`), so a racing sweeper can't overwrite the first outcome.
 *   2. `bus.complete` — wakes a parent's `wait_for_agents`, delivers/buffers the
 *      completion in the parent's inbox + the blackboard.
 *   3. `hooks.onSubAgentEnd` — the terminal EVENT, carrying outcome + reason.
 *      Emitted on EVERY path (the old finalizer skipped it on abnormal exits,
 *      which is why dead agents looked alive in every UI surface).
 *
 * **Idempotent**: the `once` Ref is check-and-set atomically — the first caller
 * wins, later callers only tear the mailbox down. **Infallible**: every step is
 * failure-guarded, so teardown can never throw out of a finalizer.
 *
 * This replaced three divergent copies of the record/complete/emit sequence
 * (the ok path, the error path, and the exit finalizer — which disagreed on
 * what to preserve and whether to emit at all).
 */
export const finalizeRun = <R>(args: {
  readonly nodeId: ContextNodeId
  /** Display label for the terminal event (the spawn title / folder basename). */
  readonly label: string
  readonly store: ContextTreeStore["Type"]
  readonly bus: AgentBus
  readonly hooks: AgentHooks<R> | undefined
  /** The one-shot guard — first finalize wins, the rest no-op. */
  readonly once: Ref.Ref<boolean>
  readonly outcome: RunOutcome
  /** Staleness stamp (workspace git HEAD at finish), when known. */
  readonly workspaceRef?: string
}): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const already = yield* Ref.getAndSet(args.once, true)
    if (already) {
      // A prior finalize recorded everything — just make sure the mailbox is
      // gone (no-op when `complete` already removed it).
      yield* args.bus.markDone(args.nodeId).pipe(Effect.ignore)
      return
    }
    const { outcome } = args
    // Loud annotations (failovers, gate degradation) ride the summary so they
    // survive into the durable record AND the parent's inbox line.
    const summary =
      outcome.notes !== undefined && outcome.notes.length > 0
        ? `${outcome.summary}\n\n${outcome.notes.join("\n")}`.trim()
        : outcome.summary
    // catchAllCause (not Effect.ignore): a DEFECT in a store/bus impl must not
    // break teardown either — finalize always completes.
    yield* args.store
      .recordReturn(args.nodeId, {
        status: outcome.status,
        summary,
        filesChanged: outcome.filesChanged,
        stopReason: outcome.reason,
        ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
        ...(args.workspaceRef !== undefined
          ? { workspaceRef: args.workspaceRef }
          : {}),
      })
      .pipe(Effect.catchAllCause(() => Effect.void))
    // Bus BEFORE the event: `subagent_end` triggers the daemon's auto-resume,
    // which drains the parent's inbox — deliver first or the resume races an
    // empty inbox.
    yield* args.bus
      .complete(args.nodeId, {
        status: outcome.status,
        summary,
        filesChanged: outcome.filesChanged,
      })
      .pipe(Effect.catchAllCause(() => Effect.void))
    if (args.hooks?.onSubAgentEnd) {
      yield* args.hooks
        .onSubAgentEnd({
          name: args.label,
          nodeId: args.nodeId,
          ok: outcomeOk(outcome.status),
          outcome: outcome.status,
          reason: outcome.reason.kind,
          summary,
          filesChanged: outcome.filesChanged,
          ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
        })
        .pipe(Effect.catchAllCause(() => Effect.void))
    }
  })
