import { Option } from "effect"
import type { Spec } from "@xandreed/foundry"
import type { SpecDoc } from "@xandreed/sdk-core"

const OPERATING_RULES = `## Operating rules
- Work directly in this workspace and implement the task fully.
- After you finish, DETERMINISTIC quality gates verify the whole workspace (typecheck, tests, static rules). Leaving it green is part of the task — run what you can locally before declaring done.
- You are unattended: never ask questions. Make reasonable decisions and note them in your summary.
- Finish with a short summary of what changed and why.`

const bulletSection = (header: string, items: ReadonlyArray<string>): string =>
  items.length === 0 ? "" : `\n\n## ${header}\n${items.map((item) => `- ${item}`).join("\n")}`

/**
 * Attempt 1's brief: the spec, verbatim, plus the operating rules that make a
 * gate-verified run different from a chat turn — the coder works to a
 * mechanical acceptance bar, unattended.
 */
export const renderTaskBrief = (spec: Spec): string =>
  `${spec.goal}${bulletSection("Acceptance criteria", spec.acceptance)}

${OPERATING_RULES}`

/**
 * The FULL SpecDoc brief — the human-refined contract: acceptance criteria
 * (with their machine checks named so the coder knows exactly what will run),
 * constraints, and non-goals. Foundry's `Spec` never carries the latter two;
 * the brief is where they reach the implementor.
 */
export const renderSpecBrief = (doc: SpecDoc): string => {
  const checks =
    doc.checks.length === 0
      ? ""
      : `\n\n## Machine checks (these commands MUST exit 0 — they run as gates)\n${doc.checks
          .map((check) => `- ${check.name}: \`${check.command}\``)
          .join("\n")}`
  return `${doc.goal}${bulletSection("Acceptance criteria", doc.acceptance)}${checks}${bulletSection(
    "Constraints (do NOT violate)",
    doc.constraints,
  )}${bulletSection("Non-goals (do NOT do these)", doc.nonGoals)}

${OPERATING_RULES}`
}

/** The attempt-1 brief: the full SpecDoc when the run is spec-driven. */
export const renderBrief = (spec: Spec, doc: Option.Option<SpecDoc>): string =>
  Option.match(doc, {
    onNone: () => renderTaskBrief(spec),
    onSome: renderSpecBrief,
  })

/**
 * A retry attempt's brief: the gate pipeline's rendered feedback, framed so the
 * model fixes root causes in the SAME conversation (it still has its own
 * context from the previous attempt).
 */
export const renderRetryBrief = (feedback: string): string =>
  `The quality gates REJECTED your previous attempt. Fix ALL of the findings below, then re-verify locally where you can.

${feedback}

Remember: the gates re-run over the WHOLE workspace after you finish — fix root causes, not symptoms, and keep unrelated code untouched.`
