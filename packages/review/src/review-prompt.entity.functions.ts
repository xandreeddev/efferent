import { Array as Arr, Match, Option, Order } from "effect"
import { clipTo, framed, hostNote } from "@xandreed/sdk"
import type { FileDiff } from "./diff.entity.js"
import { shownPath } from "./diff.entity.functions.js"
import type { Finding } from "./finding.entity.js"
import { droppedLines, fileKind, isTestPath, packDiff } from "./packed-diff.entity.functions.js"
import type { FailingRun, PreparedReview } from "./prepare-review.entity.js"
import { BODY_SHOWN, CI_INTRO, CI_SHOWN, DIFF_INTRO, FILES_INTRO, FILES_SHOWN, FIND_TAIL, FOCUS_TAIL, GROUP_INTRO, HARVEST_NOTE, HEADINGS_NOTE, IN_THE_DIFF, LEFT_OUT, PULL_INTRO, REVIEW_SYSTEM, RULE_HEADINGS_SHOWN, RULES_INTRO, RULES_SHOWN, RULES_WHOLE, STEP_CAP_NOTE, TAIL_ORDER, TITLE_SHOWN, VERIFY_TAIL } from "./review-prompt.entity.js"
import type { Finder, FindTailOptions, PromptPart, ReviewPrompt, WalkedFile } from "./review-prompt.entity.js"
import type { RepoRules } from "./repo-rules.entity.js"
import type { ReviewStage } from "./review-tools.entity.js"

/** The folder an instruction file sits in, `""` at the root. */
const folderOf = (path: string): string => path.split("/").slice(0, -1).join("/")

/** Whether a changed path sits in `folder` or under it. */
const under = (folder: string, path: string): boolean => folder === "" || path.startsWith(`${folder}/`)

/**
 * The instruction files nearest to the changed paths first: the deepest folder first, then the folder holding more of
 * the changed paths, then in the order found.
 */
export const nearestFirst = (rules: ReadonlyArray<RepoRules>, changedPaths: ReadonlyArray<string>): ReadonlyArray<RepoRules> => {
  const depth = (rule: RepoRules) => (folderOf(rule.path) === "" ? 0 : folderOf(rule.path).split("/").length)
  const held = (rule: RepoRules) => changedPaths.filter((path) => under(folderOf(rule.path), path)).length
  const found = new Map(rules.map((rule, index) => [rule, index]))
  return Arr.sort(rules, Order.combineAll([
    Order.mapInput(Order.flip(Order.Number), depth),
    Order.mapInput(Order.flip(Order.Number), held),
    Order.mapInput(Order.Number, (rule: RepoRules) => found.get(rule) ?? 0),
  ]))
}

/** A Markdown file's headings, one a line, clipped at `RULE_HEADINGS_SHOWN`. */
const headingsOf = (text: string): string => clipTo(text.split("\n").filter((line) => /^#{1,6} /.test(line)).join("\n"), RULE_HEADINGS_SHOWN)

/**
 * The instruction files as the prompt shows them, nearest to the changed paths first (`nearestFirst`): each under
 * `File: <path>`, whole while the files shown whole stay within `RULES_WHOLE` characters; a file that does not fit,
 * its headings and `HEADINGS_NOTE`; once `RULES_SHOWN` characters are used, the files left named on a last line.
 */
export const rulesText = (rules: ReadonlyArray<RepoRules>, changedPaths: ReadonlyArray<string>): string => {
  const shown: Array<string> = []
  const unshown: Array<string> = []
  let whole = RULES_WHOLE
  let room = RULES_SHOWN
  for (const rule of nearestFirst(rules, changedPaths)) {
    const text = rule.text.trimEnd()
    const fits = text.length <= whole
    const part = fits ? text : `${headingsOf(text)}\n${HEADINGS_NOTE}`.trimStart()
    if (part.length > room) unshown.push(shownPath(rule.path))
    else {
      shown.push(`File: ${shownPath(rule.path)}\n${part}`)
      room -= part.length
      if (fits) whole -= text.length
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
 * The prompt's prefix, a pure function of the prepared review and the same for every turn of it, finder's or check's: the system
 * text (`REVIEW_SYSTEM`), then one user message: the instruction files (`repo-rules`), the title and description
 * (`pull-request`, clipped), the packed diff with its left-out lines (`pull-request-diff`) and the CI's digest
 * (`ci-digest`), each framed, after the words that say what it is.
 */
export const reviewPrefix = (prepared: PreparedReview): ReadonlyArray<PromptPart> =>
  prefixWith(prepared, [DIFF_INTRO, framed("pull-request-diff", prepared.diff.text.length === 0 ? "(no file left to show)" : prepared.diff.text)])

/** The system text, then one user message: the rules, the title and description, `changes` (the diff or the file list), the CI's digest. */
const prefixWith = (prepared: PreparedReview, changes: ReadonlyArray<string>): ReadonlyArray<PromptPart> => {
  const pull = prepared.pullRequest
  const context = [
    RULES_INTRO,
    framed("repo-rules", rulesText(prepared.rules, prepared.files.map((file) => file.path))),
    PULL_INTRO,
    framed("pull-request", `Title: ${clipTo(pull.title, TITLE_SHOWN)}\n\n${clipTo(pull.body.trim().length === 0 ? "(no description)" : pull.body.trim(), BODY_SHOWN)}`),
    ...changes,
    CI_INTRO,
    framed("ci-digest", ciText(prepared)),
  ].join("\n\n")
  return [{ role: "system", content: REVIEW_SYSTEM }, { role: "user", content: context }]
}

/**
 * Every changed file as a focused review lists it: each file a review reads (`- <path> (+A -D)`, in git's order, the
 * first `FILES_SHOWN`, the rest `- N more files (+A -D)`), then `Left out of the review:` and the files the verdict
 * left out (`droppedLines`: each lockfile's line, then each file with its reason, itself bounded).
 */
export const filesText = (prepared: PreparedReview, shown: number = FILES_SHOWN): string => {
  const earlier = prepared.diff.dropped.filter((file) => file.reason !== "over-budget")
  const left = new Set(earlier.map((file) => file.path))
  const reads = prepared.files.filter((file) => !left.has(file.path))
  const rest = reads.slice(shown)
  const sum = (pick: (file: FileDiff) => number) => rest.reduce((total, file) => total + pick(file), 0)
  const read = [
    ...reads.slice(0, shown).map((file) => `- ${shownPath(file.path)} (+${file.additions} -${file.deletions})`),
    ...(rest.length > 0 ? [`- ${rest.length} more ${rest.length === 1 ? "file" : "files"} (+${sum((file) => file.additions)} -${sum((file) => file.deletions)})`] : []),
  ]
  return [
    ...(read.length > 0 ? [read.join("\n")] : ["(no file left to review)"]),
    ...(earlier.length > 0 ? [["Left out of the review:", ...droppedLines(earlier, prepared.files.map((file) => file.path))].join("\n")] : []),
  ].join("\n\n")
}

/**
 * A focused turn's prefix (`groups` focus), shared byte for byte by the checks of its group's findings: the system text;
 * one user message with the rules, the title and description, every changed file (`filesText`, framed
 * `pull-request-files`, in place of the packed diff, so this message is the same for every group) and the CI's digest;
 * then the group's message, `GROUP_INTRO` and the group's diffs packed under `budgetTokens` (`packDiff`; a file with no
 * room is named, for `readDiff`), framed `files-under-review`.
 */
export const focusPrefix = (prepared: PreparedReview, group: ReadonlyArray<FileDiff>, budgetTokens: number): ReadonlyArray<PromptPart> => [
  ...prefixWith(prepared, [FILES_INTRO, framed("pull-request-files", filesText(prepared))]),
  { role: "user", content: `${GROUP_INTRO}\n\n${framed("files-under-review", packDiff(group, budgetTokens).text)}` },
]

/** A focused turn's prompt: its group's prefix (`focusPrefix`) and its finder's focused words (`FOCUS_TAIL`), with no walk: its files are the group's. */
export const focusPrompt = (prefix: ReadonlyArray<PromptPart>, finder: Finder): ReviewPrompt => ({ prefix, tail: FOCUS_TAIL[finder] })

/**
 * A finder turn's prompt: the prefix (`reviewPrefix`) and the tail, what the turn is asked (`FIND_TAIL` of its finder), then
 * `TAIL_ORDER` and the files framed (`changed-files`), one a line, each marked shown (`IN_THE_DIFF`) or left out
 * (`LEFT_OUT`) before its path, as `shownPath` shows it.
 */
export const reviewPrompt = (prepared: PreparedReview, options: FindTailOptions): ReviewPrompt => {
  const lines = options.order.map((file) => `${file.inDiff ? IN_THE_DIFF : LEFT_OUT}${shownPath(file.path)}`)
  const order = lines.length === 0 ? "" : `\n\n${TAIL_ORDER}\n\n${framed("changed-files", lines.join("\n"))}`
  return { prefix: reviewPrefix(prepared), tail: `${FIND_TAIL[options.finder]}${order}` }
}

/**
 * A check's prompt: the same prefix as the finder turns', and the tail `VERIFY_TAIL`, then the finding framed
 * (`reported-problem`): its file, lines, kind, severity, claim and evidence, the model's words of another turn.
 */
export const verifyPrompt = (prefix: ReadonlyArray<PromptPart>, finding: Finding): ReviewPrompt => {
  const lines = finding.endLine !== undefined && finding.endLine > finding.line ? `${finding.line} to ${finding.endLine}` : `${finding.line}`
  const problem = [
    `File: ${shownPath(finding.path)}`,
    `Lines: ${lines}`,
    `Kind: ${finding.kind}`,
    `Severity: ${finding.severity}`,
    `Claim: ${finding.claim}`,
    "Evidence:",
    finding.evidence,
  ].join("\n")
  return { prefix, tail: `${VERIFY_TAIL}\n\n${framed("reported-problem", problem)}` }
}

/** The host's note after a finder turn's or a check's last allowed step: `STEP_CAP_NOTE` of its stage, as a host note. */
export const stepCapNote = (stage: ReviewStage): string => hostNote(STEP_CAP_NOTE[stage._tag])

/** The host's note after a finder turn answers in words, as a host note: report what was weighed and not reported (`HARVEST_NOTE`). */
export const harvestNote = (): string => hostNote(HARVEST_NOTE)

/** The group a changed file is walked in: code first, then tests, then manifests and config, then docs. */
const walkGroupOf = (path: string): number => {
  const kind = fileKind(path)
  if (kind === "code") return isTestPath(path) ? 1 : 0
  return kind === "docs" ? 3 : 2
}

/** A group dealt to `turns` turns from turn `turn`'s seat: its share (every `turns`-th item from `turn`), then the next turn's share, and so on around. */
const dealt = <A>(items: ReadonlyArray<A>, turn: number, turns: number): ReadonlyArray<A> =>
  Arr.range(0, turns - 1).flatMap((seat) => items.filter((_, index) => index % turns === (turn + seat) % turns))

/**
 * The order each of `turns` finder turns walks the changed files in: the files the model reads (those the packed diff
 * shows and those it left out for the budget alone), grouped code, tests, manifests and config, docs, each group
 * largest first, then by path; each group dealt out like cards (`dealt`), so turn `t` (from 0) walks every
 * `turns`-th file from the `t`-th first, then the others' shares: the turns begin in different files of every size
 * and together cover the pull request before any walks a file another started with.
 */
export const walkOrders = (prepared: PreparedReview, turns: number): ReadonlyArray<ReadonlyArray<WalkedFile>> => {
  const shown = new Set(prepared.diff.kept)
  const overBudget = new Set(prepared.diff.dropped.filter((file) => file.reason === "over-budget").map((file) => file.path))
  const walked = prepared.files.filter((file) => shown.has(file.path) || overBudget.has(file.path))
  const order = Order.combineAll([
    Order.mapInput(Order.Number, (file: FileDiff) => walkGroupOf(file.path)),
    Order.mapInput(Order.flip(Order.Number), (file: FileDiff) => file.additions + file.deletions),
    Order.mapInput(Order.String, (file: FileDiff) => file.path),
  ])
  const groups = [0, 1, 2, 3].map((group) => Arr.sort(walked, order).filter((file) => walkGroupOf(file.path) === group))
  const count = Math.max(1, turns)
  return Arr.range(0, count - 1).map((turn) =>
    groups.flatMap((group) => dealt(group, turn, count)).map((file) => ({ path: file.path, inDiff: shown.has(file.path) })))
}
