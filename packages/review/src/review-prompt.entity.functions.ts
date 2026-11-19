import { Match, Option } from "effect"
import { clipTo, framed } from "@xandreed/sdk"
import { shownPath } from "./diff.entity.functions.js"
import type { FailingRun, PreparedReview } from "./prepare-review.entity.js"
import { BODY_SHOWN, CI_INTRO, CI_SHOWN, DIFF_INTRO, PULL_INTRO, REVIEW_SYSTEM, RULE_SHOWN, RULES_INTRO, RULES_SHOWN, TAIL_ORDER, TAIL_START, TITLE_SHOWN } from "./review-prompt.entity.js"
import type { ReviewPrompt, ReviewPromptOptions } from "./review-prompt.entity.js"
import type { RepoRules } from "./repo-rules.entity.js"

/**
 * The instruction files as the prompt shows them: each under `File: <path>`, clipped at `RULE_SHOWN`, in the order
 * found, until `RULES_SHOWN` characters are used; the files past it named on a last line.
 */
export const rulesText = (rules: ReadonlyArray<RepoRules>): string => {
  const shown: Array<string> = []
  const unshown: Array<string> = []
  let room = RULES_SHOWN
  for (const rule of rules) {
    const text = clipTo(rule.text.trimEnd(), Math.min(RULE_SHOWN, room))
    if (room < 200) unshown.push(shownPath(rule.path))
    else {
      shown.push(`File: ${shownPath(rule.path)}\n${text}`)
      room -= text.length
    }
  }
  if (shown.length === 0 && unshown.length === 0) return "No instruction file was found along the changed paths."
  return [...shown, ...(unshown.length > 0 ? [`Not shown, for room: ${unshown.join(", ")}`] : [])].join("\n\n")
}

/** One failed run as the digest shows it: its check, how it ended, and its failures, or why there is no log. */
const failingText = (failing: FailingRun): string => {
  const name = `${shownPath(failing.run.name)} (${shownPath(failing.run.workflowPath)})`
  const conclusion = Option.getOrElse(failing.run.conclusion, () => failing.run.status)
  return Match.valueTags(failing.log, {
    Digested: ({ digest }) => [`Check ${name}: ${digest.ended}`, ...digest.digest.lines.map((line) => `  ${line}`), ...(digest.digest.linesCut > 0 ? [`  [${digest.digest.linesCut} more lines of the digest not shown]`] : [])].join("\n"),
    NoLog: ({ reason }) => `Check ${name}: ${conclusion}, no log: ${reason}`,
    Unavailable: ({ reason }) => `Check ${name}: ${conclusion}, log unavailable: ${reason}`,
  })
}

/** The CI's digest as the prompt shows it: each failed check's, or that none failed, or that no run is known. */
export const ciText = (prepared: PreparedReview): string =>
  prepared.ci.length === 0 ? "No CI run is known for the commit under review."
    : prepared.failing.length === 0 ? `None of the ${prepared.ci.length} CI runs for the commit under review failed.`
      : clipTo(prepared.failing.map(failingText).join("\n\n"), CI_SHOWN)

/**
 * A pass's prompt, a pure function of the prepared review and the pass's options. The prefix is the system text
 * (`REVIEW_SYSTEM`), then one user message: the instruction files (`repo-rules`), the title and description
 * (`pull-request`, clipped), the packed diff with its left-out lines (`pull-request-diff`) and the CI's digest
 * (`ci-digest`), each framed, after the words that say what it is; the tail names the order to walk the files in.
 */
export const reviewPrompt = (prepared: PreparedReview, options: ReviewPromptOptions): ReviewPrompt => {
  const pull = prepared.pullRequest
  const context = [
    RULES_INTRO,
    framed("repo-rules", rulesText(prepared.rules)),
    PULL_INTRO,
    framed("pull-request", `Title: ${clipTo(pull.title, TITLE_SHOWN)}\n\n${clipTo(pull.body.trim().length === 0 ? "(no description)" : pull.body.trim(), BODY_SHOWN)}`),
    DIFF_INTRO,
    framed("pull-request-diff", prepared.diff.text.length === 0 ? "(no file left to show)" : prepared.diff.text),
    CI_INTRO,
    framed("ci-digest", ciText(prepared)),
  ].join("\n\n")
  // The paths are the pull request's text: framed, one a line, each shown as `shownPath` shows it.
  const order = options.order.length === 0 ? "" : `\n\n${TAIL_ORDER}\n\n${framed("changed-files", options.order.map(shownPath).join("\n"))}`
  return {
    prefix: [{ role: "system", content: REVIEW_SYSTEM }, { role: "user", content: context }],
    tail: `${TAIL_START}${order}`,
  }
}
