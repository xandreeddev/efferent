import type { Spec } from "@xandreed/foundry"

/**
 * Attempt 1's brief: the spec, verbatim, plus the operating rules that make a
 * gate-verified run different from a chat turn — the coder works to a
 * mechanical acceptance bar, unattended.
 */
export const renderTaskBrief = (spec: Spec): string => {
  const acceptance =
    spec.acceptance.length === 0
      ? ""
      : `\n\n## Acceptance criteria\n${spec.acceptance.map((a) => `- ${a}`).join("\n")}`
  return `${spec.goal}${acceptance}

## Operating rules
- Work directly in this workspace and implement the task fully.
- After you finish, DETERMINISTIC quality gates verify the whole workspace (typecheck, tests, static rules). Leaving it green is part of the task — run what you can locally before declaring done.
- You are unattended: never ask questions. Make reasonable decisions and note them in your summary.
- Finish with a short summary of what changed and why.`
}

/**
 * A retry attempt's brief: the gate pipeline's rendered feedback, framed so the
 * model fixes root causes in the SAME conversation (it still has its own
 * context from the previous attempt).
 */
export const renderRetryBrief = (feedback: string): string =>
  `The quality gates REJECTED your previous attempt. Fix ALL of the findings below, then re-verify locally where you can.

${feedback}

Remember: the gates re-run over the WHOLE workspace after you finish — fix root causes, not symptoms, and keep unrelated code untouched.`
