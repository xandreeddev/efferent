import { Deferred, Effect, FiberRef, Layer, Ref } from "effect"
import {
  Approval,
  judgeApproval,
  RunContextRef,
  SettingsStore,
  UtilityLlm,
  type ApprovalDecision,
  type ApprovalRequest,
  type Settings,
  type TokenUsage,
} from "@xandreed/sdk-core"
import type { AgentEvent } from "../events.js"

/**
 * The **server-side** approval — the daemon's counterpart of the TUI's
 * `makeTuiApproval`. The agent fiber parks in the daemon exactly the same way;
 * the only difference is the surface: instead of opening a local modal, it
 * **publishes an `approval_needed` event** so every attached client renders the
 * sheet, and instead of a key handler it's answered by `resolve` (wired to
 * `Workspace.approve` / `POST /approve`). The judge + the session/project
 * rule/folder ledger stay here, server-side — clients only trigger (the event)
 * and answer (the call). `approval_resolved` clears stale sheets on other
 * clients.
 *
 * A single global gate serializes the human prompt (one sheet at a time across
 * the daemon), so there is at most one pending request — kept in `pending` for
 * `getState.pendingApproval` and resolved by `resolve`.
 */
export interface ServerApproval {
  readonly layer: Layer.Layer<Approval, never, SettingsStore | UtilityLlm>
  /** Answer the current pending request (from a client's `approve`). */
  readonly resolve: (decision: ApprovalDecision) => Effect.Effect<void>
  /** The pending request for `sessionKey`, or undefined — for `getState`. */
  readonly pendingFor: (sessionKey: string) => ApprovalRequest | undefined
}

export const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/**
 * The shared "would the auto-approval judge wave this through?" decision, factored
 * out so the interactive server approval AND the unattended headless approval reuse
 * the SAME judge + permitted-folder logic (never two divergent copies of the
 * security-relevant classification). Returns:
 *  - `{ allow: true }`            — an already-covered rule/folder, or the judge said allow;
 *  - `{ allow: false, hint }`     — the judge said prompt (hint carries its reason/folder),
 *                                   so the caller decides whether to park (interactive) or
 *                                   record-and-deny (headless).
 * `usage`, when present, is the FAST-tier spend the judge billed (publish it as
 * `helper_usage`). Total: any judge failure already degrades to `{ verdict: "prompt" }`
 * inside `judgeApproval`, so this never throws.
 */
export interface JudgeGateResult {
  readonly allow: boolean
  readonly hint?: { readonly reason?: string; readonly folder?: string }
  readonly usage?: TokenUsage
}

export const judgeGate = (
  req: ApprovalRequest,
  input: {
    readonly settings: Settings
    /** Extra session-granted folders (interactive only; headless passes none). */
    readonly sessionFolders?: ReadonlyArray<string>
    /** Extra session-granted rules (interactive only). */
    readonly sessionRules?: ReadonlyArray<string>
  },
): Effect.Effect<JudgeGateResult, never, UtilityLlm> =>
  Effect.gen(function* () {
    const { settings } = input
    // Already-blessed rule/folder → allow with no judge call.
    if (settings.approvedBashRules?.includes(req.ruleKey) === true) return { allow: true }
    if (input.sessionRules?.includes(req.ruleKey) === true) return { allow: true }

    // autoApprove off → the judge is disabled; everything unmatched needs a human.
    if (settings.autoApprove === false) return { allow: false, hint: {} }

    const permitted = [
      req.cwd,
      ...(settings.approvedFolders ?? []),
      ...(input.sessionFolders ?? []),
    ]
    const utility = yield* UtilityLlm
    const outcome = yield* judgeApproval(req, permitted).pipe(
      Effect.provideService(UtilityLlm, utility),
    )
    if (outcome.verdict === "allow") {
      return { allow: true, ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}) }
    }
    return {
      allow: false,
      hint: {
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        ...(outcome.folder !== undefined ? { folder: outcome.folder } : {}),
      },
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    }
  })

interface Pending {
  readonly req: ApprovalRequest
  readonly hint: { readonly reason?: string; readonly folder?: string }
  readonly sessionKey: string
  readonly grantedFolder: string | undefined
  readonly deferred: Deferred.Deferred<ApprovalDecision>
}

export const makeServerApproval = (
  publish: (event: AgentEvent) => Effect.Effect<void>,
): ServerApproval => {
  let pending: Pending | undefined
  const sessionRules = Ref.unsafeMake<ReadonlySet<string>>(new Set())
  const sessionFolders = Ref.unsafeMake<ReadonlySet<string>>(new Set())
  const gate = Effect.unsafeMakeSemaphore(1)

  const layer = Layer.effect(
    Approval,
    Effect.gen(function* () {
      const settingsStore = yield* SettingsStore
      const utility = yield* UtilityLlm

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
        request: (req) =>
          Effect.gen(function* () {
            const settings = yield* settingsStore.get()
            const rc = yield* FiberRef.get(RunContextRef)
            const sessionKey = String(rc.parentNodeId ?? rc.rootConversationId ?? "root")
            if (yield* coveredNow(req, undefined)) return { kind: "allow", scope: "once" } as const

            // The fast judge (default ON) — allow silently inside permitted
            // folders. Shared with the headless approval via `judgeGate` (one
            // copy of the security-relevant classification, never two).
            const gateResult = yield* judgeGate(req, {
              settings,
              sessionFolders: [...(yield* Ref.get(sessionFolders))],
              sessionRules: [...(yield* Ref.get(sessionRules))],
            }).pipe(Effect.provideService(UtilityLlm, utility))
            if (gateResult.usage !== undefined) {
              yield* publish({ type: "helper_usage", role: "fast", usage: gateResult.usage })
            }
            if (gateResult.allow) return { kind: "allow", scope: "once" } as const
            const hint = gateResult.hint

            const grantedFolder = hint?.folder
            // One sheet at a time across the daemon; a waiter re-checks the
            // ledgers (a grant by the one ahead answers this one silently).
            return yield* gate.withPermits(1)(
              Effect.gen(function* () {
                if (yield* coveredNow(req, grantedFolder)) {
                  return { kind: "allow", scope: "once" } as const
                }
                const deferred = yield* Deferred.make<ApprovalDecision>()
                pending = { req, hint: hint ?? {}, sessionKey, grantedFolder, deferred }
                yield* publish({
                  type: "approval_needed",
                  sessionId: sessionKey,
                  tool: req.tool,
                  summary: clip(req.summary, 400),
                  cwd: req.cwd,
                  ruleKey: req.ruleKey,
                  ...(hint?.reason !== undefined ? { reason: hint.reason } : {}),
                  ...(hint?.folder !== undefined ? { folder: hint.folder } : {}),
                })
                // Also emit a `needs_human` (parked: false — an interactive
                // prompt is open, not an unattended denial) so a future
                // top-level "decisions" list can surface it alongside the sheet.
                yield* publish({
                  type: "needs_human",
                  sessionId: sessionKey,
                  tool: req.tool,
                  summary: clip(req.summary, 400),
                  reason: hint?.reason ?? "a command needs your approval",
                  ...(hint?.folder !== undefined ? { folder: hint.folder } : {}),
                  parked: false,
                })
                const decision = yield* Deferred.await(deferred).pipe(
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      if (pending?.deferred === deferred) pending = undefined
                    }),
                  ),
                )
                if (decision.kind === "allow" && decision.scope === "session") {
                  yield* grantedFolder !== undefined
                    ? Ref.update(sessionFolders, (s) => new Set([...s, grantedFolder]))
                    : Ref.update(sessionRules, (s) => new Set([...s, req.ruleKey]))
                }
                if (decision.kind === "allow" && decision.scope === "project") {
                  yield* settingsStore.update((curr) =>
                    grantedFolder !== undefined
                      ? { ...curr, approvedFolders: [...(curr.approvedFolders ?? []), grantedFolder] }
                      : { ...curr, approvedBashRules: [...(curr.approvedBashRules ?? []), req.ruleKey] },
                  )
                }
                return decision
              }),
            )
          }),
      })
    }),
  )

  return {
    layer,
    resolve: (decision) =>
      Effect.gen(function* () {
        const p = pending
        if (p === undefined) return
        yield* publish({ type: "approval_resolved", sessionId: p.sessionKey })
        pending = undefined
        yield* Deferred.succeed(p.deferred, decision)
      }),
    pendingFor: (sessionKey) =>
      pending !== undefined && pending.sessionKey === sessionKey ? pending.req : undefined,
  }
}
