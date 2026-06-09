import { Effect, Layer, Ref } from "effect"
import {
  Approval,
  SettingsStore,
  type ApprovalDecision,
  type ApprovalRequest,
} from "@efferent/core"
import { openApproval } from "./presentation/approvalView.js"
import type { TuiStore } from "./state/store.js"

/**
 * The TUI's interactive `Approval` implementation — the inverse bridge to
 * `ctx.run`: the *agent fiber* asks the *UI* a question and suspends until a
 * keystroke answers. `request` checks the rule ledgers first (project rules
 * from settings, session rules from a Ref), and only an unmatched request
 * opens the modal — so the prompt rate decays toward commands never blessed
 * before.
 *
 * Mechanics: `Effect.async` parks the handler fiber and stashes its resume in
 * `pending`; the overlay key handler calls {@link TuiApproval.resolve} with
 * the human's decision. Interruption (Esc on the turn) runs the cleanup —
 * the modal closes and nothing dangles. A 1-permit semaphore serializes
 * concurrent requests (parallel fan-out can have several sub-agents wanting
 * bash at once); each waiter re-checks the ledgers when its turn comes, so
 * one "allow for session" answers the whole queue.
 *
 * Session rules + the gate live OUTSIDE the layer build (the layer is built
 * per agent-run provide; the ledger must outlive a turn).
 */
export interface TuiApproval {
  readonly layer: Layer.Layer<Approval, never, SettingsStore>
  /** Resolve the pending request — called by the overlay key handler. */
  readonly resolve: (decision: ApprovalDecision) => void
}

export const makeTuiApproval = (store: TuiStore): TuiApproval => {
  let pending: ((d: ApprovalDecision) => void) | undefined
  const sessionRules = Ref.unsafeMake<ReadonlySet<string>>(new Set())
  const gate = Effect.unsafeMakeSemaphore(1)

  const ask = (req: ApprovalRequest) =>
    Effect.async<ApprovalDecision>((resume) => {
      pending = (d) => {
        pending = undefined
        resume(Effect.succeed(d))
      }
      store.setOverlay({ kind: "approval", state: openApproval(req) })
      // Interruption (Esc kills the turn): drop the request + close the modal.
      return Effect.sync(() => {
        pending = undefined
        if (store.overlay().kind === "approval") store.closeOverlay()
      })
    })

  const layer = Layer.effect(
    Approval,
    Effect.gen(function* () {
      const settingsStore = yield* SettingsStore
      return Approval.of({
        request: (req) =>
          gate.withPermits(1)(
            Effect.gen(function* () {
              const settings = yield* settingsStore.get()
              if (settings.approvedBashRules?.includes(req.ruleKey) === true) {
                return { kind: "allow", scope: "once" } as const
              }
              if ((yield* Ref.get(sessionRules)).has(req.ruleKey)) {
                return { kind: "allow", scope: "once" } as const
              }
              const decision = yield* ask(req)
              if (decision.kind === "allow" && decision.scope === "session") {
                yield* Ref.update(sessionRules, (s) => new Set([...s, req.ruleKey]))
              }
              if (decision.kind === "allow" && decision.scope === "project") {
                yield* settingsStore.update((curr) => ({
                  ...curr,
                  approvedBashRules: [...(curr.approvedBashRules ?? []), req.ruleKey],
                }))
              }
              return decision
            }),
          ),
      })
    }),
  )

  return {
    layer,
    resolve: (decision) => {
      const p = pending
      // Only close OUR modal — if interruption already swapped the overlay
      // (or none is pending), closing whatever else is showing would eat an
      // unrelated picker/login flow.
      if (store.overlay().kind === "approval") store.closeOverlay()
      p?.(decision)
    },
  }
}
