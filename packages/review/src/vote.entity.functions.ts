import { Array as Arr, Order } from "effect"
import type { FileDiff } from "./diff.entity.js"
import { SEVERITY_RANK } from "./finding.entity.js"
import type { Finding } from "./finding.entity.js"
import { BucketNumber, CHANGED_SLACK, NEAR_LINES, QUOTE_SLACK } from "./vote.entity.js"
import type { Bucket, BucketWhy, MergeOptions } from "./vote.entity.js"

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

/**
 * Whether a verdict's quote is in the head's file within the cited lines and `QUOTE_SLACK` around them: its lines,
 * normalized (`normalizedLine`) and joined by a space, held by those of the file's lines, normalized and joined the
 * same way. An empty quote is not.
 */
export const quoteWithin = (text: string, quote: string, line: number, endLine: number): boolean => {
  const quoted = quotedLines(quote).join(" ")
  if (quoted.length === 0) return false
  const lines = text.split("\n")
  const window = lines.slice(Math.max(0, line - 1 - QUOTE_SLACK), Math.min(lines.length, Math.max(line, endLine) + QUOTE_SLACK))
  return window.map(normalizedLine).filter((one) => one.length > 0).join(" ").includes(quoted)
}

/** The last line a finding cites. */
const lastOf = (finding: Finding): number => Math.max(finding.line, finding.endLine ?? finding.line)

const BY_PLACE: Order.Order<Finding> = Order.combineAll([
  Order.mapInput(Order.String, (finding: Finding) => finding.path),
  Order.mapInput(Order.String, (finding: Finding) => finding.kind),
  Order.mapInput(Order.Number, (finding: Finding) => finding.line),
  Order.mapInput(Order.Number, (finding: Finding) => finding.pass),
  Order.mapInput(Order.Number, (finding: Finding) => finding.number),
])

/** Findings in place order, grouped: one file, one kind, each starting within `NEAR_LINES` of the group's span so far. */
const grouped = (findings: ReadonlyArray<Finding>): ReadonlyArray<Arr.NonEmptyReadonlyArray<Finding>> => {
  const groups: Array<Arr.NonEmptyArray<Finding>> = []
  let end = 0
  for (const finding of Arr.sort(findings, BY_PLACE)) {
    const group = groups.at(-1)
    if (group !== undefined && group[0].path === finding.path && group[0].kind === finding.kind && finding.line <= end + NEAR_LINES) {
      group.push(finding)
      end = Math.max(end, lastOf(finding))
    } else {
      groups.push([finding])
      end = lastOf(finding)
    }
  }
  return groups
}

/** The finding whose words stand for a group: the longest evidence its file's diff holds, else the first found. */
const bestOf = (group: Arr.NonEmptyReadonlyArray<Finding>, file: FileDiff | undefined): Finding => {
  const first = Arr.sort(group, Order.combine(Order.mapInput(Order.Number, (finding: Finding) => finding.pass), Order.mapInput(Order.Number, (finding: Finding) => finding.number)))
  const matching = first.filter((finding) => evidenceMatches(finding.evidence, file))
  return matching.reduce((best, finding) => (finding.evidence.length > best.evidence.length ? finding : best), matching[0] ?? first[0])
}

/**
 * Merge the findings of a review's passes into buckets (`Bucket`), pure. A finding off the pull request's changed
 * lines (`changedLinesOf`, within `CHANGED_SLACK`) is bucketed apart and not kept (`off-changed-lines`); the others
 * are grouped by file, kind and near lines (`NEAR_LINES`), each bucket's votes its distinct passes. With the vote off,
 * every bucket on changed lines is kept; on, one with at least two votes or of kind `security` (`one-vote` otherwise).
 * Buckets are numbered from 1 in file, kind and line order.
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
    Order.mapInput(Order.String, (entry: Entry) => entry.group[0].kind),
    Order.mapInput(Order.Number, (entry: Entry) => entry.group[0].line),
  ]))
  return placed.map(({ group, on }, index): Bucket => {
    const best = bestOf(group, byPath.get(group[0].path))
    const votes = new Set(group.map((finding) => finding.pass)).size
    const why: BucketWhy = !on ? "off-changed-lines" : !options.vote || votes >= 2 || best.kind === "security" ? "kept" : "one-vote"
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
