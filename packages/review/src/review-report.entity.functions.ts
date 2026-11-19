import { Array as Arr, Match, Option, Order } from "effect"
import { clipTo } from "@xandreed/sdk"
import { shownPath } from "./diff.entity.functions.js"
import { SEVERITY_RANK } from "./finding.entity.js"
import type { Finding } from "./finding.entity.js"
import { AT_SOURCE_WORDS } from "./prepare-review.entity.js"
import type { FailingRun, PreparedReview } from "./prepare-review.entity.js"
import { INCOMPLETE_BECAUSE } from "./review-pass.entity.js"
import type { PassEnded, PassResult } from "./review-pass.entity.js"
import { EVIDENCE_SHOWN, FINDINGS_SHOWN } from "./review-report.entity.js"
import type { ReportedFinding, ReviewReport } from "./review-report.entity.js"

/** Whether `text` names `path` at `line`: `path:line` or `path(line,` with no digit after the number. */
const names = (text: string, path: string, line: number): boolean =>
  [`${path}:${line}`, `${path}(${line},`].some((place) => {
    let at = text.indexOf(place)
    while (at >= 0) {
      const after = text[at + place.length] ?? ""
      if (place.endsWith(",") || !/\d/.test(after)) return true
      at = text.indexOf(place, at + 1)
    }
    return false
  })

/**
 * Whether a finding only restates a failure the CI's digest names: a failure's line or one of its location lines
 * names the finding's path at one of its lines (`path:line` or tsc's `path(line,`).
 */
export const restatesCi = (finding: Finding, failing: ReadonlyArray<FailingRun>): boolean => {
  const texts = failing.flatMap((run) => Match.valueTags(run.log, {
    Digested: ({ digest }) => digest.digest.failures.flatMap((failure) => [failure.text, ...failure.detail]),
    NoLog: () => [],
    Unavailable: () => [],
  }))
  const last = finding.endLine ?? finding.line
  return texts.some((text) => Arr.range(finding.line, Math.max(finding.line, last)).some((line) => names(text, finding.path, line)))
}

/** The order findings are shown in: by severity, `high` first, then by path in code-unit order, then by line. */
export const FINDING_ORDER: Order.Order<Finding> = Order.combine(
  Order.combine(Order.mapInput(Order.Number, (finding: Finding) => SEVERITY_RANK[finding.severity]), Order.mapInput(Order.String, (finding: Finding) => finding.path)),
  Order.mapInput(Order.Number, (finding: Finding) => finding.line),
)

/** What a review is built from: the prepared review, its passes, its findings, the model and the wall time. */
export interface ReportInput {
  readonly prepared: PreparedReview
  readonly passes: ReadonlyArray<PassResult>
  readonly findings: ReadonlyArray<Finding>
  readonly promptVersion: string
  readonly toolsVersion: string
  readonly model: string
  readonly wallMs: number
}

/** A review's report: its findings sorted and marked, its passes, and what their calls used together. */
export const reviewReport = (input: ReportInput): ReviewReport => {
  const calls = input.passes.flatMap((pass) => pass.calls)
  const tokens = calls.flatMap((call) => Option.toArray(call.tokens))
  return {
    repo: input.prepared.pullRequest.repo,
    number: input.prepared.pullRequest.number,
    at: input.prepared.at,
    promptVersion: input.promptVersion,
    toolsVersion: input.toolsVersion,
    model: input.model,
    passes: input.passes,
    findings: Arr.sort(input.findings, FINDING_ORDER).map((finding): ReportedFinding => ({ ...finding, restatesCi: restatesCi(finding, input.prepared.failing) })),
    packedFiles: input.prepared.diff.kept.length,
    changedFiles: input.prepared.files.length,
    usage: {
      input: tokens.reduce((sum, one) => sum + one.input, 0),
      cached: tokens.reduce((sum, one) => sum + one.cached, 0),
      output: tokens.reduce((sum, one) => sum + one.output, 0),
      cost: calls.reduce((sum, one) => sum + one.cost, 0),
    },
    wallMs: Math.max(0, Math.round(input.wallMs)),
  }
}

/** Why a pass is incomplete, in words, with the failure's own words when it has them; none for a pass that answered. */
const incompleteOf = (ended: PassEnded): Option.Option<string> => Match.valueTags(ended, {
  Answered: () => Option.none(),
  StepCap: ({ steps }) => Option.some(`${INCOMPLETE_BECAUSE.StepCap} (${steps})`),
  SpendRefused: ({ message }) => Option.some(`${INCOMPLETE_BECAUSE.SpendRefused}: ${clipTo(message, 300).replaceAll("\n", " ")}`),
  ModelFailed: ({ message }) => Option.some(`${INCOMPLETE_BECAUSE.ModelFailed}: ${clipTo(message, 300).replaceAll("\n", " ")}`),
  OutputCut: () => Option.some(INCOMPLETE_BECAUSE.OutputCut),
})

/** One finding as the report shows it: `path:line severity kind — claim`, then its quoted evidence, indented. */
const findingLines = (finding: ReportedFinding): ReadonlyArray<string> => {
  const lines = finding.endLine !== undefined && finding.endLine > finding.line ? `${finding.line}-${finding.endLine}` : `${finding.line}`
  const evidence = clipTo(finding.evidence.trimEnd(), EVIDENCE_SHOWN).split("\n").filter((line) => line.trim().length > 0)
  return [
    `${shownPath(finding.path)}:${lines} ${finding.severity} ${finding.kind} — ${finding.claim.replaceAll("\n", " ")}${finding.restatesCi ? " (restates a CI failure)" : ""}`,
    ...evidence.map((line) => `    > ${line}`),
  ]
}

const percent = (part: number, whole: number): string => (whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`)

/**
 * The report a person reads: the pull request and the commit reviewed; at most `FINDINGS_SHOWN` findings in their
 * order, each with its evidence, and how many more there are, or `No findings.`; `incomplete: <why>` for each pass
 * that stopped before it answered, else its summary; then the files in the pack against those changed, the files the
 * model opened, the model calls, their tokens (the cached share), their cost and the wall time.
 */
export const reportText = (report: ReviewReport): string => {
  const shown = report.findings.slice(0, FINDINGS_SHOWN)
  const more = report.findings.length - shown.length
  const opened = Arr.dedupe(report.passes.flatMap((pass) => pass.opened))
  const steps = report.passes.reduce((sum, pass) => sum + pass.calls.length, 0)
  return [
    `Review of #${report.number} in ${report.repo} at ${report.at.sha.slice(0, 12)}, ${AT_SOURCE_WORDS[report.at.source]}`,
    "",
    ...(shown.length === 0 ? ["No findings."] : shown.flatMap(findingLines)),
    ...(more > 0 ? [`${more} more ${more === 1 ? "finding" : "findings"} not shown.`] : []),
    "",
    ...report.passes.map((pass) => Option.match(incompleteOf(pass.ended), {
      onSome: (why) => `Pass ${pass.pass}: incomplete: ${why}`,
      onNone: () => `Pass ${pass.pass}: ${pass.ended._tag === "Answered" && pass.ended.summary.length > 0 ? pass.ended.summary.replaceAll("\n", " ") : "answered"}`,
    })),
    `Files: ${report.packedFiles} in the pack of ${report.changedFiles} changed; opened ${opened.length}${opened.length === 0 ? "" : `: ${opened.map(shownPath).join(", ")}`}`,
    `Model: ${report.model}; ${steps} ${steps === 1 ? "call" : "calls"}; tokens ${report.usage.input} in (${report.usage.cached} cached, ${percent(report.usage.cached, report.usage.input)}), ${report.usage.output} out; cost $${report.usage.cost.toFixed(4)}; wall ${(report.wallMs / 1000).toFixed(1)} s`,
  ].join("\n")
}
