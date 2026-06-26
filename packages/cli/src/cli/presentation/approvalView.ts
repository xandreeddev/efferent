import type { ApprovalRequest } from "@xandreed/sdk-core"

/**
 * What the auto-approval judge knew when it escalated: its one-line reason,
 * and — when the command reached outside the permitted folders — WHICH
 * folder. A folder hint changes what `s`/`p` grant: the folder itself, not
 * the command rule (permission is path-based; see core `autoApproval.ts`).
 */
export interface ApprovalHint {
  readonly reason?: string
  readonly folder?: string
}

/**
 * Pure state for the bash-approval modal (L1 — no Solid/OpenTUI). Two modes:
 * `choose` offers the four answers (allow once / session / project / deny);
 * `deny` collects an optional reason — the part that turns a denial from a
 * dead-end into steering, since the model reads it as the tool failure.
 */
export interface ApprovalState {
  readonly request: ApprovalRequest
  readonly mode: "choose" | "deny"
  readonly reason: string
  /** Present when the fast judge escalated this request (see {@link ApprovalHint}). */
  readonly hint?: ApprovalHint
}

export const openApproval = (request: ApprovalRequest, hint?: ApprovalHint): ApprovalState => ({
  request,
  mode: "choose",
  reason: "",
  ...(hint !== undefined ? { hint } : {}),
})

export const beginDenyReason = (s: ApprovalState): ApprovalState => ({
  ...s,
  mode: "deny",
})

export const backToChoose = (s: ApprovalState): ApprovalState => ({
  ...s,
  mode: "choose",
  reason: "",
})

export const reasonAppend = (s: ApprovalState, ch: string): ApprovalState =>
  s.mode === "deny" ? { ...s, reason: s.reason + ch } : s

export const reasonBackspace = (s: ApprovalState): ApprovalState =>
  s.mode === "deny" ? { ...s, reason: s.reason.slice(0, -1) } : s

/** The human-readable form of the rule a session/project allow would create. */
export const describeRule = (ruleKey: string): string =>
  ruleKey.startsWith("cmd:")
    ? `${ruleKey.slice(4)} …`
    : ruleKey.startsWith("exact:")
      ? `exactly this command`
      : ruleKey

/**
 * What a session/project allow grants for this state: the out-of-bounds
 * FOLDER when the judge named one (path-based permission — future commands
 * inside it pass the judge), else the command rule as before.
 */
export const describeGrant = (s: ApprovalState): string =>
  s.hint?.folder !== undefined ? s.hint.folder : describeRule(s.request.ruleKey)
