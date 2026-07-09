import { Option } from "effect"
import type { Spec } from "@xandreed/foundry"
import type { SpecDoc } from "@xandreed/engine"

/** Bump when the coder system prompt or the brief framing changes — the
 *  smith-spec live battery records it. */
export const SMITH_CODER_PROMPT_VERSION = "1.0.0"

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

/** The optional context blocks that ride the attempt-1 brief, in authority
 *  order: the human's RULES file first, then the deterministic gate LESSONS,
 *  then the curated workspace MEMORY (weakest — "verify before relying"). */
export interface BriefExtras {
  readonly rules?: Option.Option<string>
  readonly lessons?: Option.Option<string>
  readonly memory?: Option.Option<string>
}

/** The attempt-1 brief: the full SpecDoc when the run is spec-driven, plus
 *  the workspace's standing extras (see {@link BriefExtras}). */
export const renderBrief = (
  spec: Spec,
  doc: Option.Option<SpecDoc>,
  extras: BriefExtras = {},
): string => {
  const base = Option.match(doc, {
    onNone: () => renderTaskBrief(spec),
    onSome: renderSpecBrief,
  })
  return [
    base,
    ...Option.toArray(extras.rules ?? Option.none()),
    ...Option.toArray(extras.lessons ?? Option.none()),
    ...Option.toArray(extras.memory ?? Option.none()),
  ].join("\n\n")
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

/**
 * The direct coder's system prompt on the new line — a capable single agent,
 * no fleet, no delegation: refine happened upstream (the spec IS the refined
 * prompt), the gates run downstream. Lean by design; the brief carries the
 * task. `skillsBlock` (progressive disclosure, tier 1) lists workspace
 * skills by name+description only — the model pulls full instructions with
 * load_skill when a task matches.
 */
export const smithCoderSystemPrompt = (cwd: string, skillsBlock: string = ""): string =>
  `You are an expert software engineer working UNATTENDED in the workspace at ${cwd}.

# Tools
read_file · write_file · edit_file (exact-match replace; include enough context to be unique) · Bash (runs in the workspace; non-zero exits come back as data — read stderr and adapt) · grep · glob · ls · load_skill (pull a listed skill's full instructions)${
    skillsBlock.length > 0 ? `\n\n${skillsBlock}` : ""
  }

# How you work
- Explore before you change: read the files you will touch and their tests first.
- Make focused changes with edit_file/write_file; keep unrelated code untouched.
- Verify as you go: run the project's own commands (typecheck, tests) with Bash before declaring done.
- Deterministic gates re-check the WHOLE workspace after you finish — they are the judge of done, not your narration.
- Never ask questions; decide and note the decision in your final summary.
- Finish with a short summary of what changed and why.`
