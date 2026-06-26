import { Effect, FiberRef, Layer } from "effect"
import {
  Approval,
  RunContextRef,
  SettingsStore,
  UtilityLlm,
} from "@xandreed/sdk-core"
import type { AgentEvent } from "../events.js"
import { clip, judgeGate } from "./serverApproval.js"

/**
 * The **headless parking approval** — the unattended-run counterpart of
 * {@link makeServerApproval}. A scheduled cron job runs with NO human watching,
 * so the old `ApprovalAllowAllLive` was a real hole: it silently allowed
 * EVERYTHING an unattended agent tried, including reaching outside the workspace
 * / installing software / touching the network — exactly the set a human is
 * supposed to see.
 *
 * This closes that hole without ever blocking forever (no human is there to
 * answer): it runs the SAME fast-tier judge + permitted-folder logic the
 * interactive approval uses (via the shared {@link judgeGate}), so ordinary
 * in-scope development work is still waved through silently. For anything the
 * judge would NOT auto-allow, it:
 *   1. emits a `needs_human` event (`parked: true`) recording the need — tool /
 *      summary / reason / folder / sessionId — so a human reviews it later;
 *   2. returns a DENY, with a reason the model reads as an ordinary tool failure
 *      and adapts to in the same turn.
 *
 * So it can only ever DENY more than allow-all did — it never silently allows
 * something the judge wouldn't, and never parks a fiber on an absent human. Any
 * judge failure already degrades to "prompt" inside `judgeGate`, which here
 * means "deny + record" — fail-closed, the safe direction for an unattended run.
 */
export const makeHeadlessApproval = (
  publish: (event: AgentEvent) => Effect.Effect<void>,
): Layer.Layer<Approval, never, SettingsStore | UtilityLlm> =>
  Layer.effect(
    Approval,
    Effect.gen(function* () {
      const settingsStore = yield* SettingsStore
      const utility = yield* UtilityLlm

      return Approval.of({
        request: (req) =>
          Effect.gen(function* () {
            const settings = yield* settingsStore.get()
            const rc = yield* FiberRef.get(RunContextRef)
            const sessionKey = String(rc.parentNodeId ?? rc.rootConversationId ?? "root")

            // The shared judge gate (no session grants — an unattended run can't
            // grow its own permitted set). Allow ⇒ wave through silently.
            const gate = yield* judgeGate(req, { settings }).pipe(
              Effect.provideService(UtilityLlm, utility),
            )
            if (gate.usage !== undefined) {
              yield* publish({ type: "helper_usage", role: "fast", usage: gate.usage })
            }
            if (gate.allow) return { kind: "allow", scope: "once" } as const

            // Not auto-allowed + nobody watching → record the need and DENY.
            const reason =
              gate.hint?.reason ??
              "the auto-approval judge wouldn't allow this and no human is available to ask"
            yield* publish({
              type: "needs_human",
              sessionId: sessionKey,
              ...(rc.parentNodeId !== null ? { nodeId: String(rc.parentNodeId) } : {}),
              tool: req.tool,
              summary: clip(req.summary, 400),
              reason,
              ...(gate.hint?.folder !== undefined ? { folder: gate.hint.folder } : {}),
              parked: true,
            })
            return {
              kind: "deny",
              reason: `parked — needs human approval (this was an unattended run): ${reason}`,
            } as const
          }),
      })
    }),
  )
