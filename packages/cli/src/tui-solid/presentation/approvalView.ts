import type { ApprovalRequest } from "@efferent/core"

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
}

export const openApproval = (request: ApprovalRequest): ApprovalState => ({
  request,
  mode: "choose",
  reason: "",
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
