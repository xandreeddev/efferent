import { Clock, Effect, Ref } from "effect"
import type { AgentContextNode } from "../entities/AgentContext.js"
import type { AgentHooks } from "../entities/AgentHooks.js"
import type { ConversationId } from "../entities/Conversation.js"
import type { ContextTreeStore } from "../ports/ContextTreeStore.js"
import type { AgentBus } from "./agentBus.js"
import { finalizeRun } from "./finalizeRun.js"

/** How often the crash-recovery sweeper wakes to look for stranded nodes. */
export const SWEEP_INTERVAL_MS = 30_000

/** Age a `running` node must reach (with its fiber off the bus) before the
 *  sweeper flips it — so a just-spawned node isn't killed mid-registration. */
export const SWEEP_GRACE_MS = 120_000

/**
 * The PURE sweep decision for one node — unit-testable without a daemon. A node
 * is stranded iff it's still `running` in the DB, the orchestration bus does
 * NOT know it as running (its fiber wedged or died, taking its mailbox with
 * it), AND it's older than the grace window.
 */
export const shouldSweepNode = (input: {
  readonly status: AgentContextNode["status"]
  readonly isRunningOnBus: boolean
  readonly createdAt: number
  readonly now: number
  readonly graceMs?: number
}): boolean =>
  input.status === "running" &&
  !input.isRunningOnBus &&
  input.now - input.createdAt >= (input.graceMs ?? SWEEP_GRACE_MS)

/**
 * ONE crash-recovery sweep pass over the given conversation roots — the shared
 * backstop BOTH drivers fork (the in-process TUI previously had NO sweeper at
 * all; the daemon had its own copy with a hand-rolled record/notify dance).
 * With supervised fleet fibers this should rarely fire: every live exit path
 * finalizes itself. What remains is recovery from a fiber that vanished
 * WITHOUT exiting (a runtime bug, a hard crash mid-registration) — swept
 * through the SAME one terminal path as every other exit (`finalizeRun`), so
 * the node records `killed(stall)`, the parent is notified, and the terminal
 * `subagent_end` event reaches the UI.
 */
export const sweepStrandedRuns = <R>(args: {
  readonly store: ContextTreeStore["Type"]
  readonly bus: AgentBus
  readonly hooks: AgentHooks<R> | undefined
  readonly roots: ReadonlyArray<ConversationId | null>
  readonly graceMs?: number
}): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    for (const root of args.roots) {
      const nodes = yield* args.store
        .listTree(root)
        .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<AgentContextNode>)))
      for (const node of nodes) {
        if (node.status !== "running") continue
        // Re-check liveness right before acting — the snapshot may have gone
        // stale (a node could have started since the pass began).
        const live = yield* args.bus.isRunning(node.id as string)
        const now = yield* Clock.currentTimeMillis
        if (
          !shouldSweepNode({
            status: node.status,
            isRunningOnBus: live,
            createdAt: node.createdAt,
            now,
            ...(args.graceMs !== undefined ? { graceMs: args.graceMs } : {}),
          })
        ) {
          continue
        }
        // Register the (bus-absent) node under its parent first so `complete`
        // has an entry to deliver from — the same re-register the old sweeper
        // did, now followed by the ONE terminal path instead of a bespoke copy.
        const parentKey = (node.parentId ?? node.rootConversationId ?? null) as
          | string
          | null
        const label = node.title ?? node.folder
        yield* args.bus.markRunning(node.id as string, label, { parentKey })
        yield* finalizeRun({
          nodeId: node.id,
          label,
          store: args.store,
          bus: args.bus,
          hooks: args.hooks,
          once: Ref.unsafeMake(false),
          outcome: {
            status: "killed",
            summary: "[stalled — no longer running]",
            filesChanged: [],
            reason: { kind: "stall" },
          },
        })
      }
    }
  }).pipe(Effect.catchAllCause(() => Effect.void))
