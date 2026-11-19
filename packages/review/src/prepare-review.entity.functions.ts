import { Match, Option } from "effect"
import type { LogDigest } from "./log-digest.entity.js"
import { shownPath } from "./diff.entity.functions.js"
import { droppedLines } from "./packed-diff.entity.functions.js"
import { AT_SOURCE_WORDS, SKIPPED_BECAUSE } from "./prepare-review.entity.js"
import type { FailingRun, PreparedReview } from "./prepare-review.entity.js"

const short = (sha: string): string => sha.slice(0, 12)

/** The folder a review's logs and records go in, under the repository's: the pull request and the first twelve digits of the commit under review. */
export const reviewFolderOf = (number: number, sha: string): string => `${number}-${short(sha)}`

/** How many files left out the summary names one by one; the rest are counted by reason. */
const SUMMARY_DROPPED_SHOWN = 5

/** A digest's lines for a person: how it ended, the summary, the failures counted, the first few, and the log's path. */
const digestLines = (name: string, log: LogDigest): ReadonlyArray<string> => [
  `  ${name}: ${log.ended}${Option.match(log.digest.summary, { onNone: () => "", onSome: (summary) => `; ${summary}` })}`,
  `    failures: ${log.digest.failures.length}${log.digest.onChangedPath ? ", some on changed paths" : ""}; log: ${log.logPath}`,
  ...log.digest.failures.slice(0, 3).map((failure) => `    - ${shownPath(failure.text.slice(0, 160))}${failure.count > 1 ? ` (seen ${failure.count} times)` : ""}`),
]

const failingLines = (failing: FailingRun): ReadonlyArray<string> => Match.valueTags(failing.log, {
  Digested: ({ digest }) => digestLines(`${failing.run.name} (${failing.run.workflowPath})`, digest),
  NoLog: ({ reason }) => [`  ${failing.run.name} (${failing.run.workflowPath}): ${Option.getOrElse(failing.run.conclusion, () => "unknown")}, no log: ${reason}`],
  Unavailable: ({ reason }) => [`  ${failing.run.name} (${failing.run.workflowPath}): ${Option.getOrElse(failing.run.conclusion, () => "unknown")}, log unavailable: ${reason}`],
})

/**
 * A short summary of a prepared review for a person at a terminal: the pull request, its author and ends, the diff's
 * files kept and dropped (each dropped one with its reason) and tokens, the rules found, the CI runs and their
 * failures, and the commands asked for.
 */
export const summaryText = (prepared: PreparedReview): string => {
  const pull = prepared.pullRequest
  const kept = prepared.diff.kept.length
  const ci = prepared.ci.map((run) => `${run.name}: ${Option.getOrElse(run.conclusion, () => run.status)}`)
  return [
    `Pull request #${pull.number} in ${pull.repo}: ${shownPath(pull.title)}`,
    `Author: ${pull.author}${pull.authorIsBot ? " (a bot)" : ""}, permission ${pull.permission}; head ${pull.head.ref} at ${short(pull.head.sha)}${pull.sameRepo ? " (same repository)" : " (a fork)"}; base ${pull.base.ref} at ${short(pull.base.sha)}`,
    `Reviewed: ${short(prepared.at.sha)}, ${AT_SOURCE_WORDS[prepared.at.source]}; base ${short(prepared.at.base)}`,
    `Commits: ${pull.commits.length}${pull.commits[0] === undefined ? "" : `, first ${short(pull.commits[0].sha)} at ${pull.commits[0].committedAt}`}`,
    `Diff: ${prepared.verdicts.length} files, ${kept} kept, ${prepared.diff.dropped.length} left out; about ${prepared.diff.tokens} tokens`,
    ...droppedLines(prepared.diff.dropped, prepared.verdicts.map((verdict) => verdict.path), SUMMARY_DROPPED_SHOWN).map((line) => `  left out: ${line.slice(2)}`),
    `Rules: ${prepared.rules.length === 0 ? "none found" : prepared.rules.map((rule) => shownPath(rule.path)).join(", ")}`,
    `CI: ${ci.length === 0 ? "no runs for the head" : ci.join(", ")}`,
    `Failing checks: ${prepared.failing.length === 0 ? "none" : prepared.failing.length}`,
    ...prepared.failing.flatMap(failingLines),
    ...Match.valueTags(prepared.validation, {
      NotAsked: () => ["Commands: none asked"],
      Skipped: ({ reason }) => [`Commands: skipped, ${SKIPPED_BECAUSE[reason]}`],
      Ran: ({ digests }) => ["Commands:", ...digests.flatMap((digest) => digestLines(digest.source._tag === "Command" ? digest.source.command : digest.source.name, digest))],
    }),
  ].join("\n")
}
