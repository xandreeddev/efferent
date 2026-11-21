import { Array as Arr, Match, Option, Order } from "effect"
import { clipTo } from "@xandreed/sdk"
import { shownPath } from "./diff.entity.functions.js"
import { SEVERITY_RANK } from "./finding.entity.js"
import type { Finding, FindingReport } from "./finding.entity.js"
import { plainText } from "./log-digest.entity.functions.js"
import { AT_SOURCE_WORDS } from "./prepare-review.entity.js"
import type { FailingRun, PreparedReview } from "./prepare-review.entity.js"
import { FINISHED, INCOMPLETE_BECAUSE } from "./review-turn.entity.js"
import type { TurnEnded, TurnResult } from "./review-turn.entity.js"
import type { Focus, GroupRun, UngroupedFile } from "./file-group.entity.js"
import type { Effort } from "./review-model.entity.js"
import type { Finder } from "./review-prompt.entity.js"
import { EVIDENCE_SHOWN, FINDINGS_SHOWN, UNSETTLED_HEAD } from "./review-report.entity.js"
import type { BucketCheck, ReportedFinding, ReviewReport, ReviewUsage } from "./review-report.entity.js"
import type { Bucket } from "./vote.entity.js"

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
export const FINDING_ORDER: Order.Order<FindingReport> = Order.combine(
  Order.combine(Order.mapInput(Order.Number, (finding: FindingReport) => SEVERITY_RANK[finding.severity]), Order.mapInput(Order.String, (finding: FindingReport) => finding.path)),
  Order.mapInput(Order.Number, (finding: FindingReport) => finding.line),
)

/** A run's name, from when it started: its UTC time with `-` for each `:` and `.`, such as `2026-11-19T22-01-51-123Z`. */
export const runNameOf = (startedMillis: number): string => new Date(startedMillis).toISOString().replace(/[:.]/g, "-")

/**
 * What a review is built from: its run, the prepared review, how it found (`finder`, `vote`, `verify`), how many finder
 * turns it asked for and those that ran, its checks, every finding, every bucket, every check of a bucket, the versions, the
 * model and the wall time.
 */
export interface ReportInput {
  readonly run: string
  readonly prepared: PreparedReview
  readonly focus: Focus
  readonly effort: { readonly find: Effort; readonly check: Effort }
  readonly groups: ReadonlyArray<GroupRun>
  readonly ungrouped: ReadonlyArray<UngroupedFile>
  readonly notes: ReadonlyArray<string>
  readonly finder: Finder
  readonly vote: boolean
  readonly verify: boolean
  readonly complete: boolean
  readonly turnsAsked: number
  readonly turns: ReadonlyArray<TurnResult>
  readonly checks: ReadonlyArray<TurnResult>
  readonly findings: ReadonlyArray<Finding>
  readonly buckets: ReadonlyArray<Bucket>
  readonly verdicts: ReadonlyArray<BucketCheck>
  readonly promptVersion: string
  readonly toolsVersion: string
  readonly hostTools: ReadonlyArray<string>
  readonly model: string
  readonly wallMs: number
}

/** What the calls of some turns used together. */
export const usageOf = (results: ReadonlyArray<TurnResult>): ReviewUsage => {
  const calls = results.flatMap((result) => result.calls)
  const tokens = calls.flatMap((call) => Option.toArray(call.tokens))
  return {
    input: tokens.reduce((sum, one) => sum + one.input, 0),
    cached: tokens.reduce((sum, one) => sum + one.cached, 0),
    output: tokens.reduce((sum, one) => sum + one.output, 0),
    cost: Math.round(calls.reduce((sum, one) => sum + one.cost, 0) * 1e12) / 1e12,
    calls: calls.length,
  }
}

/**
 * A review's report: the findings shown (each confirmed bucket's best finding with the check's reason; with no check,
 * each kept bucket's), sorted and marked, with everything they came from kept beside them, and what each stage's calls
 * and all of them used.
 */
export const reviewReport = (input: ReportInput): ReviewReport => {
  const byBucket = new Map(input.buckets.map((bucket) => [bucket.number, bucket]))
  const byMember = new Map(input.findings.map((finding) => [`${finding.turn}/${finding.number}`, finding]))
  /** The first check of each bucket that ended `outcome`, in check order. */
  const firstOf = (outcome: BucketCheck["outcome"]) => Arr.dedupeWith(
    Arr.sort(input.verdicts.filter((check) => check.outcome === outcome), Order.mapInput(Order.Number, (check: BucketCheck) => check.check)),
    (one: BucketCheck, other: BucketCheck) => one.bucket === other.bucket,
  )
  const asReported = (checks: ReadonlyArray<BucketCheck>) => checks.flatMap((check): ReadonlyArray<ReportedFinding> => {
    const bucket = byBucket.get(check.bucket)
    const finding = byMember.get(`${check.finding.turn}/${check.finding.number}`)
    if (bucket === undefined || finding === undefined) return []
    // A verdict counted unsure by the host (its quote not found) says so before the check's own reason.
    const reason = Option.match(check.verdict, { onNone: () => "", onSome: (verdict) => verdict.reason })
    const checked = check.why.length > 0 ? `${check.why}: ${reason}` : reason
    return [{ ...finding, bucket: bucket.number, votes: bucket.votes, checked, restatesCi: restatesCi(finding, input.prepared.failing) }]
  })
  // A bucket is shown once: with the first of its findings a check confirmed; else, apart, its first a check was unsure of.
  const confirmed = firstOf("confirmed")
  const settled = new Set(confirmed.map((check) => check.bucket))
  const reported = input.verify
    ? asReported(confirmed)
    : input.buckets.filter((bucket) => bucket.kept).map((bucket): ReportedFinding => ({
      ...bucket.best, bucket: bucket.number, votes: bucket.votes, checked: "", restatesCi: restatesCi(bucket.best, input.prepared.failing),
    }))
  const unsettled = asReported(firstOf("unsure").filter((check) => !settled.has(check.bucket)))
  const find = usageOf(input.turns)
  const verify = usageOf(input.checks)
  return {
    run: input.run,
    repo: input.prepared.pullRequest.repo,
    number: input.prepared.pullRequest.number,
    at: input.prepared.at,
    promptVersion: input.promptVersion,
    toolsVersion: input.toolsVersion,
    hostTools: input.hostTools,
    model: input.model,
    focus: input.focus,
    effort: input.effort,
    groups: input.groups,
    ungrouped: input.ungrouped,
    notes: input.notes,
    finder: input.finder,
    vote: input.vote,
    verify: input.verify,
    complete: input.complete,
    turnsAsked: input.turnsAsked,
    turns: input.turns,
    checks: input.checks,
    findings: input.findings,
    buckets: input.buckets,
    verdicts: input.verdicts,
    reported: Arr.sort(reported, FINDING_ORDER),
    unsettled: Arr.sort(unsettled, FINDING_ORDER),
    packedFiles: input.prepared.diff.kept.length,
    changedFiles: input.prepared.files.length,
    usage: usageOf([...input.turns, ...input.checks]),
    stages: { find, verify },
    wallMs: Math.max(0, Math.round(input.wallMs)),
  }
}

/**
 * A text the model or a provider wrote, as a terminal shows it: escape sequences and control characters stripped
 * (`plainText`), so a claim cannot move the cursor, recolour or hide a line; line breaks made spaces.
 */
const printable = (text: string): string => plainText(text.replaceAll("\n", " "))

/** Why a turn is incomplete, in words, with the failure's own words when it has them; none for a turn that answered. */
const incompleteOf = (ended: TurnEnded): Option.Option<string> => Match.valueTags(ended, {
  Answered: () => Option.none(),
  Judged: () => Option.none(),
  StepCap: ({ steps, summary, why }) => Option.some(`${INCOMPLETE_BECAUSE.StepCap} (${steps})${why.length > 0 ? `; its closing call failed: ${printable(clipTo(why, 300))}` : ""}${summary.length > 0 ? `; ${printable(summary)}` : ""}`),
  Failed: ({ message }) => Option.some(`${INCOMPLETE_BECAUSE.Failed}: ${printable(clipTo(message, 300))}`),
  SpendRefused: ({ message }) => Option.some(`${INCOMPLETE_BECAUSE.SpendRefused}: ${printable(clipTo(message, 300))}`),
  ModelFailed: ({ message }) => Option.some(`${INCOMPLETE_BECAUSE.ModelFailed}: ${printable(clipTo(message, 300))}`),
  OutputCut: () => Option.some(INCOMPLETE_BECAUSE.OutputCut),
  JournalFailed: ({ message }) => Option.some(`${INCOMPLETE_BECAUSE.JournalFailed}: ${printable(clipTo(message, 300))}`),
})

/**
 * One finding as the report shows it: `path:line severity kind — claim (V/K turns)`, then its quoted evidence,
 * indented, and the check's reason; the model's words made plain.
 */
const findingLines = (finding: ReportedFinding, turns: number): ReadonlyArray<string> => {
  const lines = finding.endLine !== undefined && finding.endLine > finding.line ? `${finding.line}-${finding.endLine}` : `${finding.line}`
  const evidence = clipTo(finding.evidence.trimEnd(), EVIDENCE_SHOWN).split("\n").map(plainText).filter((line) => line.trim().length > 0)
  return [
    `${shownPath(finding.path)}:${lines} ${finding.severity} ${finding.kind} — ${printable(finding.claim)} (${finding.votes}/${turns} ${turns === 1 ? "turn" : "turns"})${finding.restatesCi ? " (restates a CI failure)" : ""}`,
    ...evidence.map((line) => `    > ${line}`),
    ...(finding.checked.length > 0 ? [`    checked: ${printable(finding.checked)}`] : []),
  ]
}

const percent = (part: number, whole: number): string => (whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`)

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/**
 * The finder turns that did not start, in words, when the find stage stopped after the first turn ended before its
 * first call answered: `Turn 2 did not start: …` or `Turns 2 to K did not start: …`; none when every turn asked for ran.
 */
const notStarted = (report: ReviewReport): ReadonlyArray<string> => {
  const ran = report.turns.length
  if (ran === 0 || report.turnsAsked <= ran) return []
  const which = report.turnsAsked === ran + 1 ? `Turn ${ran + 1}` : `Turns ${ran + 1} to ${report.turnsAsked}`
  return [`${which} did not start: the find stage stopped because turn 1 ended before its first call answered.`]
}

/**
 * A focused review's groups, one a line: `Group N (<package>, F files): turn T, $C, K findings`, or `…: not reviewed:
 * <why>`; none for a whole review.
 */
const groupLines = (report: ReviewReport): ReadonlyArray<string> => [
  ...report.groups.map((run) => {
    const head = `Group ${run.group.number} (${shownPath(run.group.package)}, ${plural(run.group.paths.length, "file", "files")})`
    return Option.match(run.turn, {
      onNone: () => `${head}: not reviewed: ${run.notReviewed}`,
      onSome: (turn) => {
        if (run.notReviewed.length > 0) return `${head}: turn ${turn}, not reviewed: ${run.notReviewed}`
        const ran = report.turns.filter((result) => Match.valueTags(result.stage, { Find: (stage) => stage.turn === turn, Verify: () => false }))
        const found = report.findings.filter((finding) => finding.turn === turn).length
        return `${head}: turn ${turn}, $${usageOf(ran).cost.toFixed(4)}, ${plural(found, "finding", "findings")}`
      },
    })
  }),
  ...report.ungrouped.slice(0, UNGROUPED_SHOWN).map((file) => `In no group: ${shownPath(file.path)} (${file.why})`),
  ...(report.ungrouped.length > UNGROUPED_SHOWN ? [`${report.ungrouped.length - UNGROUPED_SHOWN} more files in no group.`] : []),
  ...report.notes.map((note) => `Note: ${note}`),
]

/** The most files in no group the report names; the rest are counted. */
const UNGROUPED_SHOWN = 10

/** The efforts asked, when either is not the model's default: `; effort: find <e>, check <e>`. */
const effortText = (report: ReviewReport): string =>
  report.effort.find === "default" && report.effort.check === "default" ? "" : `; effort: find ${report.effort.find}, check ${report.effort.check}`

/** What a stage's calls used, in words: calls, tokens with the cached share, output and cost. */
const usageText = (usage: ReviewUsage): string =>
  `${plural(usage.calls, "call", "calls")}, ${usage.input} tokens in (${percent(usage.cached, usage.input)} cached), ${usage.output} out, $${usage.cost.toFixed(4)}`

/** How many buckets and checks ended each way: `N kept, N left out by the vote, N off the changed lines`, and the checks' outcomes. */
const tallies = (report: ReviewReport): ReadonlyArray<string> => {
  const count = (why: Bucket["why"]) => report.buckets.filter((bucket) => bucket.why === why).length
  const outcome = (which: BucketCheck["outcome"]) => report.verdicts.filter((check) => check.outcome === which).length
  return [
    `Turns: ${report.turns.length}, finding ${report.finder === "strict" ? "strictly" : "candidates"}; buckets: ${count("kept")} kept, ${count("one-vote")} left out by the vote, ${count("off-changed-lines")} off the changed lines`,
    ...(report.verify ? [`Checks: ${outcome("confirmed")} confirmed, ${outcome("refuted")} refuted, ${outcome("unsure")} unsure, ${outcome("unchecked")} unchecked`] : ["Checks: none run"]),
  ]
}

/**
 * The report a person reads: the pull request and the commit reviewed; at most `FINDINGS_SHOWN` findings in their
 * order, each with its evidence, how many finder turns found it and the check's reason, and how many more there are, or
 * `No findings.` (`No confirmed findings.` when some are unsettled; `Incomplete: no turn finished.` when no finder turn answered or reached its step cap); then, apart under `UNSETTLED_HEAD`, at most `FINDINGS_SHOWN` findings no check settled, as the confirmed are shown, and how many more; each kept bucket no check gave a verdict on (`Not checked (<why>): …`, at most `FINDINGS_SHOWN`),
 * so an unchecked finding is never read as none; `incomplete: <why>` for each finder turn that stopped before it answered, else its summary;
 * the finder turns that did not start because the first ended before its first call answered (`notStarted`); the turns
 * and how the buckets and checks came out; the files in the pack against those changed and the files the turns opened;
 * each stage's calls, tokens (the cached share) and cost, the total and the wall time.
 */
export const reportText = (report: ReviewReport): string => {
  const shown = report.reported.slice(0, FINDINGS_SHOWN)
  const more = report.reported.length - shown.length
  const unsettled = report.unsettled.slice(0, FINDINGS_SHOWN)
  const opened = Arr.dedupe(report.turns.flatMap((turn) => turn.opened))
  const byMember = new Map(report.findings.map((finding) => [`${finding.turn}/${finding.number}`, finding]))
  const unchecked = report.verdicts.flatMap((check) => {
    const finding = byMember.get(`${check.finding.turn}/${check.finding.number}`)
    return check.outcome === "unchecked" && finding !== undefined ? [`Not checked (${check.why}): ${shownPath(finding.path)}:${finding.line} ${finding.severity} ${finding.kind} — ${printable(finding.claim)}`] : []
  })
  return [
    `Review of #${report.number} in ${report.repo} at ${report.at.sha.slice(0, 12)}, ${AT_SOURCE_WORDS[report.at.source]}`,
    "",
    ...(shown.length > 0 ? shown.flatMap((finding) => findingLines(finding, report.turns.length))
      : !report.turns.some((turn) => FINISHED.includes(turn.ended._tag)) ? ["Incomplete: no turn finished."]
      : unsettled.length > 0 ? ["No confirmed findings."] : ["No findings."]),
    ...(more > 0 ? [`${more} more ${more === 1 ? "finding" : "findings"} not shown.`] : []),
    ...(unsettled.length > 0 ? ["", UNSETTLED_HEAD, ...unsettled.flatMap((finding) => findingLines(finding, report.turns.length))] : []),
    ...(report.unsettled.length > unsettled.length ? [`${report.unsettled.length - unsettled.length} more unsettled not shown.`] : []),
    ...unchecked.slice(0, FINDINGS_SHOWN),
    ...(unchecked.length > FINDINGS_SHOWN ? [`${unchecked.length - FINDINGS_SHOWN} more not checked.`] : []),
    "",
    ...report.turns.map((turn, index) => Option.match(incompleteOf(turn.ended), {
      onSome: (why) => `Turn ${index + 1}: incomplete: ${why}`,
      onNone: () => `Turn ${index + 1}: ${turn.ended._tag === "Answered" && turn.ended.summary.length > 0 ? printable(turn.ended.summary) : "answered"}`,
    })),
    ...notStarted(report),
    ...groupLines(report),
    ...tallies(report),
    report.focus === "groups"
      ? `Files: ${report.groups.reduce((sum, run) => sum + run.group.paths.length, 0)} in ${plural(report.groups.length, "group", "groups")} of ${report.changedFiles} changed; opened ${opened.length}${opened.length === 0 ? "" : `: ${opened.map(shownPath).join(", ")}`}`
      : `Files: ${report.packedFiles} in the pack of ${report.changedFiles} changed; opened ${opened.length}${opened.length === 0 ? "" : `: ${opened.map(shownPath).join(", ")}`}`,
    `Find: ${usageText(report.stages.find)}; verify: ${usageText(report.stages.verify)}`,
    `Model: ${report.model}${effortText(report)}; ${usageText(report.usage)}; wall ${(report.wallMs / 1000).toFixed(1)} s`,
  ].join("\n")
}
