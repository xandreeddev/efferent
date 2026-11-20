import { Array as Arr, Order } from "effect"
import type { FileDiff } from "./diff.entity.js"
import { SEVERITY_RANK } from "./finding.entity.js"
import type { Finding } from "./finding.entity.js"
import { BucketNumber, CHANGED_SLACK, CITED_SLACK, NEAR_LINES, QUOTE_LINE_CHARS, QUOTE_SLACK, SPAN_COUNTED } from "./vote.entity.js"
import type { Bucket, BucketWhy, CheckTarget, MergeOptions } from "./vote.entity.js"

/**
 * A quoted line as compared: the number and marker a tool's answer puts before a line (`  42| `, `  42 + `,
 * `  42   `) taken off, and every run of white space made one space, trimmed.
 */
export const normalizedLine = (line: string): string =>
  line.replace(/^\s*\d+\| ?/, "").replace(/^\s*\d+ [+ ] /, "").replace(/\s+/g, " ").trim()

/** A quote's lines as compared: each normalized, empty ones left out. */
const quotedLines = (quote: string): ReadonlyArray<string> => quote.split("\n").map(normalizedLine).filter((line) => line.length > 0)

/**
 * The lines of a file's diff that count as changed: each added line, and for removed lines the new-side line that
 * now stands where they were (the next one the hunk shows, else the last before them).
 */
export const changedLinesOf = (file: FileDiff): ReadonlySet<number> => {
  const changed = new Set<number>()
  for (const hunk of file.hunks) {
    let last = Math.max(1, hunk.newStart - 1)
    let removed = false
    for (const line of hunk.lines) {
      if (line._tag === "Added" || line._tag === "Context") {
        if (line._tag === "Added" || removed) changed.add(line.line)
        last = line.line
        removed = false
      } else if (line._tag === "Removed") removed = true
    }
    if (removed) changed.add(last)
  }
  return changed
}

/** Whether lines `line` to `endLine` come within `CHANGED_SLACK` of a changed line. */
const onChanged = (changed: ReadonlySet<number>, line: number, endLine: number): boolean =>
  [...changed].some((at) => at >= line - CHANGED_SLACK && at <= endLine + CHANGED_SLACK)

/** Whether every line a finding quotes is in (part of) a line its file's diff shows on the new side. */
export const evidenceMatches = (evidence: string, file: FileDiff | undefined): boolean => {
  const quoted = quotedLines(evidence)
  if (quoted.length === 0 || file === undefined) return false
  const shown = file.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => (line._tag === "Added" || line._tag === "Context" ? [normalizedLine(line.text)] : [])))
  return quoted.every((line) => shown.some((text) => text.includes(line)))
}

/** Whether a normalized line stands for code: `QUOTE_LINE_CHARS` characters or more other than white space, a name of three or more among them. */
const telling = (line: string): boolean => line.replace(/\s/g, "").length >= QUOTE_LINE_CHARS && /[A-Za-z_$][\w$]{2,}/.test(line)

/**
 * Whether a verdict's quote is in the head's file at the lines the check was shown. The finding's own lines are
 * `line` to `endLine`, at most `SPAN_COUNTED` whatever `endLine` says. The quote's lines, normalized (`normalizedLine`)
 * and joined by a space, must be held by those lines and `QUOTE_SLACK` around them, normalized and joined the same
 * way; and one of them must be a whole line of the finding's own lines (`CITED_SLACK` either side, for a numbering off
 * by one) that stands for code (`telling`): a brace, a `return`, an empty quote, or a line from around the cited
 * ones is not one.
 */
export const quoteWithin = (text: string, quote: string, line: number, endLine: number): boolean => {
  const quoted = quotedLines(quote)
  if (quoted.length === 0) return false
  const last = Math.min(Math.max(line, endLine), line + SPAN_COUNTED - 1)
  const lines = text.split("\n").map(normalizedLine)
  /** The normalized, non-empty lines `from` to `to`, numbered from 1. */
  const between = (from: number, to: number) => lines.slice(Math.max(0, from - 1), Math.min(lines.length, to)).filter((one) => one.length > 0)
  const window = between(line - QUOTE_SLACK, last + QUOTE_SLACK)
  const cited = between(line - CITED_SLACK, last + CITED_SLACK)
  return window.join(" ").includes(quoted.join(" ")) && quoted.some((one) => telling(one) && cited.includes(one))
}

/** The last line of a finding that counts: its `endLine`, at most `SPAN_COUNTED` lines from its first, never before it. */
const lastOf = (finding: Finding): number => Math.min(Math.max(finding.line, finding.endLine ?? finding.line), finding.line + SPAN_COUNTED - 1)

const BY_PLACE: Order.Order<Finding> = Order.combineAll([
  Order.mapInput(Order.String, (finding: Finding) => finding.path),
  Order.mapInput(Order.Number, (finding: Finding) => finding.line),
  Order.mapInput(Order.Number, (finding: Finding) => finding.pass),
  Order.mapInput(Order.Number, (finding: Finding) => finding.number),
])

/**
 * Findings in place order, grouped around anchors: a finding joins the first group of its file whose anchor (its
 * first finding, its lines counted by `lastOf`) it starts within `NEAR_LINES` of and that holds no finding of its
 * pass; else it anchors a group of its own. An anchor never moves, so groups do not chain, and kinds do not split them.
 */
const grouped = (findings: ReadonlyArray<Finding>): ReadonlyArray<Arr.NonEmptyReadonlyArray<Finding>> => {
  const groups: Array<Arr.NonEmptyArray<Finding>> = []
  for (const finding of Arr.sort(findings, BY_PLACE)) {
    const joins = groups.find((group) => group[0].path === finding.path
      && finding.line >= group[0].line - NEAR_LINES && finding.line <= lastOf(group[0]) + NEAR_LINES
      && !group.some((member) => member.pass === finding.pass))
    if (joins === undefined) groups.push([finding])
    else joins.push(finding)
  }
  return groups
}

/**
 * The finding whose words stand for a group, the one its check is shown: the most severe (two passes may name two
 * mechanisms on the same lines, and the check should try the more harmful: on #644 a medium finding of the gold leak
 * shared a bucket with a low one of another reading, and only the low one, chosen for its longer evidence, was
 * checked); among those, one whose evidence its file's diff holds, the longest; else the first found.
 */
const bestOf = (group: Arr.NonEmptyReadonlyArray<Finding>, file: FileDiff | undefined): Finding => {
  const first = Arr.sort(group, Order.combine(Order.mapInput(Order.Number, (finding: Finding) => finding.pass), Order.mapInput(Order.Number, (finding: Finding) => finding.number)))
  const rank = Math.min(...first.map((finding) => SEVERITY_RANK[finding.severity]))
  const severest = Arr.filter(first, (finding) => SEVERITY_RANK[finding.severity] === rank)
  const matching = severest.filter((finding) => evidenceMatches(finding.evidence, file))
  return matching.reduce((best, finding) => (finding.evidence.length > best.evidence.length ? finding : best), matching[0] ?? severest[0] ?? first[0])
}

/**
 * Merge the findings of a review's passes into buckets (`Bucket`), pure. A finding off the pull request's changed
 * lines (`changedLinesOf`, within `CHANGED_SLACK`, its lines counted by `lastOf`) is bucketed apart and not kept
 * (`off-changed-lines`); the others are grouped by place (`grouped`: one file, near an anchor, one finding a pass,
 * kinds together), each bucket's votes its findings. With the vote off, every bucket on changed lines is kept; on,
 * one with at least two votes or with a finding of kind `security` (`one-vote` otherwise). Buckets are numbered from 1
 * in file and line order.
 */
export const mergeFindings = (findings: ReadonlyArray<Finding>, files: ReadonlyArray<FileDiff>, options: MergeOptions): ReadonlyArray<Bucket> => {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const changed = new Map(files.map((file) => [file.path, changedLinesOf(file)]))
  const isOn = (finding: Finding) => onChanged(changed.get(finding.path) ?? new Set(), finding.line, lastOf(finding))
  const groups = [
    ...grouped(findings.filter(isOn)).map((group) => ({ group, on: true })),
    ...grouped(findings.filter((finding) => !isOn(finding))).map((group) => ({ group, on: false })),
  ]
  type Entry = { readonly group: Arr.NonEmptyReadonlyArray<Finding>; readonly on: boolean }
  const placed = Arr.sort(groups, Order.combineAll([
    Order.mapInput(Order.String, (entry: Entry) => entry.group[0].path),
    Order.mapInput(Order.Number, (entry: Entry) => entry.group[0].line),
    Order.mapInput(Order.Boolean, (entry: Entry) => !entry.on),
  ]))
  return placed.map(({ group, on }, index): Bucket => {
    const best = bestOf(group, byPath.get(group[0].path))
    const votes = new Set(group.map((finding) => finding.pass)).size
    const security = group.some((finding) => finding.kind === "security")
    const why: BucketWhy = !on ? "off-changed-lines" : !options.vote || votes >= 2 || security ? "kept" : "one-vote"
    return {
      number: BucketNumber.make(index + 1),
      path: best.path,
      kind: best.kind,
      line: Math.min(...group.map((finding) => finding.line)),
      endLine: Math.max(...group.map(lastOf)),
      members: group.map((finding) => ({ pass: finding.pass, number: finding.number })),
      votes,
      best,
      kept: why === "kept",
      why,
    }
  })
}

/** The order kept buckets are checked in, best first: more votes, then higher severity, then file and line. */
export const CHECK_ORDER: Order.Order<Bucket> = Order.combineAll([
  Order.mapInput(Order.flip(Order.Number), (bucket: Bucket) => bucket.votes),
  Order.mapInput(Order.Number, (bucket: Bucket) => SEVERITY_RANK[bucket.best.severity]),
  Order.mapInput(Order.String, (bucket: Bucket) => bucket.path),
  Order.mapInput(Order.Number, (bucket: Bucket) => bucket.line),
])

/** A bucket's findings in the order they are checked: its best first, then the more severe, then in pass and number order. */
const claimsOf = (bucket: Bucket, byMember: ReadonlyMap<string, Finding>): ReadonlyArray<Finding> => {
  const isBest = (finding: Finding) => finding.pass === bucket.best.pass && finding.number === bucket.best.number
  const members = bucket.members.flatMap((member) => {
    const finding = byMember.get(`${member.pass}/${member.number}`)
    return finding === undefined ? [] : [finding]
  })
  return Arr.sort(members, Order.combineAll([
    Order.mapInput(Order.Boolean, (finding: Finding) => !isBest(finding)),
    Order.mapInput(Order.Number, (finding: Finding) => SEVERITY_RANK[finding.severity]),
    Order.mapInput(Order.Number, (finding: Finding) => finding.pass),
    Order.mapInput(Order.Number, (finding: Finding) => finding.number),
  ]))
}

/**
 * The checks a review may run, in rounds, one per finding of a kept bucket and at most `perBucket` a bucket, so two
 * mechanisms on the same lines are each checked: round `r` holds the `r`-th claim of each kept bucket that has one (its
 * best first, the buckets in `CHECK_ORDER`), so a stage's budget reaches every bucket's first claim before any bucket's
 * second. The review runs a later round's check only for a bucket no check has confirmed yet.
 */
export const checkRounds = (buckets: ReadonlyArray<Bucket>, findings: ReadonlyArray<Finding>, perBucket: number): ReadonlyArray<ReadonlyArray<CheckTarget>> => {
  const byMember = new Map(findings.map((finding) => [`${finding.pass}/${finding.number}`, finding]))
  const kept = Arr.sort(buckets.filter((bucket) => bucket.kept), CHECK_ORDER).map((bucket) => ({ bucket, claims: claimsOf(bucket, byMember).slice(0, perBucket) }))
  const rounds: Array<ReadonlyArray<CheckTarget>> = []
  for (let round = 0; kept.some(({ claims }) => claims.length > round); round++) {
    rounds.push(kept.flatMap(({ bucket, claims }) => {
      const finding = claims[round]
      return finding === undefined ? [] : [{ bucket, finding }]
    }))
  }
  return rounds
}
