import { Effect, Layer, Ref } from "effect"
import {
  Approval,
  judgeApproval,
  SettingsStore,
  UtilityLlm,
  type ApprovalDecision,
  type ApprovalRequest,
} from "@xandreed/sdk-core"
import { openApproval, type ApprovalHint } from "./presentation/approvalView.js"
import { accumulateRoleSpend } from "./presentation/sidePane.js"
import type { TuiStore } from "./state/store.js"

/**
 * The TUI's interactive `Approval` implementation — the inverse bridge to
 * `ctx.run`: the *agent fiber* asks the *UI* a question and suspends until a
 * keystroke answers. `request` checks the rule ledgers first (project rules
 * from settings, session rules from a Ref); an unmatched request then goes to
 * the **fast-tier judge** (`judgeApproval`, unless `:set autoApprove false`):
 * ordinary work inside the permitted folders — workspace root + every folder
 * granted before — is allowed silently, anything else opens the modal carrying
 * the judge's reason. So the prompt rate decays toward "commands that reach
 * somewhere new", which is exactly the set a human should be reading.
 *
 * Permission is **path-based**: when the judge names the out-of-bounds folder,
 * the modal's session/project answers grant THAT FOLDER (session Ref /
 * `Settings.approvedFolders`), and future commands inside it pass the judge.
 * Without a folder hint they grant the command rule, as before. The judge can
 * only ever *remove* prompts — a prompt verdict, a parse failure, or a
 * provider error all land in the modal, and a human deny is final for the
 * turn. Judge spend → `byRole.fast`.
 *
 * Mechanics: `Effect.async` parks the handler fiber and stashes its resume in
 * `pending`; the overlay key handler calls {@link TuiApproval.resolve} with
 * the human's decision. Interruption (Esc on the turn) runs the cleanup —
 * the modal closes and nothing dangles. A 1-permit semaphore serializes
 * concurrent requests (parallel fan-out can have several sub-agents wanting
 * bash at once); each waiter re-checks the ledgers when its turn comes, so
 * one "allow for session" answers the whole queue.
 *
 * Session rules/folders + the gate live OUTSIDE the layer build (the layer is
 * built per agent-run provide; the ledgers must outlive a turn).
 */
export interface TuiApproval {
  readonly layer: Layer.Layer<Approval, never, SettingsStore | UtilityLlm>
  /** Resolve the pending request — called by the overlay key handler. */
  readonly resolve: (decision: ApprovalDecision) => void
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

export const makeTuiApproval = (store: TuiStore): TuiApproval => {
  let pending: ((d: ApprovalDecision) => void) | undefined
  const sessionRules = Ref.unsafeMake<ReadonlySet<string>>(new Set())
  const sessionFolders = Ref.unsafeMake<ReadonlySet<string>>(new Set())
  const gate = Effect.unsafeMakeSemaphore(1)

  const ask = (req: ApprovalRequest, hint?: ApprovalHint) =>
    Effect.async<ApprovalDecision>((resume) => {
      pending = (d) => {
        pending = undefined
        resume(Effect.succeed(d))
      }
      store.setOverlay({ kind: "approval", state: openApproval(req, hint) })
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
      const utility = yield* UtilityLlm
      // Is this request already covered by a standing grant (a rule, or a
      // granted folder)? Checked up-front AND again once a queued waiter wins the
      // human-prompt permit — so one "allow for session/project" answer silently
      // clears every other agent queued behind it for the same rule/folder.
      const coveredNow = (req: ApprovalRequest, folder: string | undefined) =>
        Effect.gen(function* () {
          const settings = yield* settingsStore.get()
          if (settings.approvedBashRules?.includes(req.ruleKey) === true) return true
          if ((yield* Ref.get(sessionRules)).has(req.ruleKey)) return true
          if (folder !== undefined) {
            if (settings.approvedFolders?.includes(folder) === true) return true
            if ((yield* Ref.get(sessionFolders)).has(folder)) return true
          }
          return false
        })

      return Approval.of({
        // NOTE: the LLM judge runs OUTSIDE the semaphore — concurrent agents are
        // judged in parallel, and an auto-allowed command never waits on anyone.
        // Only the human modal serializes (one sheet at a time). This is what
        // stops a bash-heavy fleet from queueing every command behind one judge
        // call (the "hangs on permissions" symptom).
        request: (req) =>
          Effect.gen(function* () {
            const settings = yield* settingsStore.get()
            if (yield* coveredNow(req, undefined)) {
              return { kind: "allow", scope: "once" } as const
            }

            // The fast judge — default ON; opening efferent in a cwd is the
            // standing grant on that folder. Runs unserialized.
            let hint: ApprovalHint | undefined
            if (settings.autoApprove !== false) {
              const permitted = [
                req.cwd,
                ...(settings.approvedFolders ?? []),
                ...(yield* Ref.get(sessionFolders)),
              ]
              const outcome = yield* judgeApproval(req, permitted).pipe(
                Effect.provideService(UtilityLlm, utility),
              )
              if (outcome.usage !== undefined) {
                const billed = outcome.usage.inputTokens + outcome.usage.outputTokens
                store.setStats((s) => accumulateRoleSpend(s, "fast", billed))
              }
              if (outcome.verdict === "allow") {
                store.pushBlock({
                  kind: "info",
                  text: `fast approved: ${clip(req.summary, 80)}${
                    outcome.reason !== undefined ? ` — ${outcome.reason}` : ""
                  }`,
                })
                return { kind: "allow", scope: "once" } as const
              }
              hint = {
                ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
                ...(outcome.folder !== undefined ? { folder: outcome.folder } : {}),
              }
            }

            // Only the human prompt is serialized — one modal at a time. A waiter
            // that wins the permit re-checks the ledgers first, so a grant made
            // by the queue ahead of it answers this one without a second prompt.
            const grantedFolder = hint?.folder
            const decision = yield* gate.withPermits(1)(
              Effect.gen(function* () {
                if (yield* coveredNow(req, grantedFolder)) {
                  return { kind: "allow", scope: "once" } as const
                }
                return yield* ask(req, hint)
              }),
            )
              if (decision.kind === "allow" && decision.scope === "session") {
                yield* grantedFolder !== undefined
                  ? Ref.update(sessionFolders, (s) => new Set([...s, grantedFolder]))
                  : Ref.update(sessionRules, (s) => new Set([...s, req.ruleKey]))
              }
              if (decision.kind === "allow" && decision.scope === "project") {
                yield* settingsStore.update((curr) =>
                  grantedFolder !== undefined
                    ? {
                        ...curr,
                        approvedFolders: [...(curr.approvedFolders ?? []), grantedFolder],
                      }
                    : {
                        ...curr,
                        approvedBashRules: [...(curr.approvedBashRules ?? []), req.ruleKey],
                      },
                )
              }
              return decision
            }),
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
