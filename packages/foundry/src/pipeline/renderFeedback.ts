import { Array as Arr, Match, Option, Order } from "effect"
import type { AttemptNumber } from "../domain/Brands.js"
import type { Finding } from "../domain/Finding.js"
import type { GateReport } from "../domain/Verdict.js"

/** Bounded prompt growth with exact counts — the compaction-marker discipline. */
const MAX_FINDINGS_PER_GATE = 20

const byLocation: Order.Order<Finding> = Order.combineAll([
  Order.mapInput(Order.string, (f: Finding) =>
    Option.match(f.location, { onNone: () => "", onSome: (l) => l.file }),
  ),
  Order.mapInput(Order.number, (f: Finding) =>
    Option.match(f.location, { onNone: () => 0, onSome: (l) => l.line }),
  ),
  Order.mapInput(Order.string, (f: Finding) => f.rule),
])

const renderFinding = (finding: Finding): string => {
  const where = Option.match(finding.location, {
    onNone: () => "",
    onSome: (l) => ` ${l.file}:${l.line}:${l.column}`,
  })
  const fix = Option.match(finding.fixHint, {
    onNone: () => "",
    onSome: (hint) => ` Fix: ${hint}`,
  })
  const period = finding.message.endsWith(".") ? "" : "."
  return `- [${finding.rule}]${where} — ${finding.message}${period}${fix}`
}

/**
 * `GateReport` → the model-readable brief fed into the next attempt. Pure and
 * DETERMINISTIC (stable sort, exact overflow counts) — golden-testable, and
 * two identical reports always produce byte-identical feedback.
 */
export const renderFeedback = (report: GateReport, attempt: AttemptNumber): string => {
  const failures = report.failures
  const sections = failures.map((verdict) => {
    const sorted = Arr.sort(verdict.findings, byLocation)
    const shown = sorted.slice(0, MAX_FINDINGS_PER_GATE)
    const omitted = sorted.length - shown.length
    const tail =
      omitted > 0 ? [`…and ${omitted} more from this gate (fix the above first).`] : []
    return [
      `## gate: ${verdict.gate} — ${verdict.findings.length} error${verdict.findings.length === 1 ? "" : "s"}`,
      ...shown.map(renderFinding),
      ...tail,
    ].join("\n")
  })

  const skipped = report.verdicts.flatMap((v) =>
    Match.value(v).pipe(
      Match.tag("skip", (s) => [s.gate as string]),
      Match.orElse(() => []),
    ),
  )
  const skippedNote =
    skipped.length > 0
      ? [`Not yet run (blocked by the failures above): ${skipped.join(", ")}.`]
      : []

  return [
    `The deterministic gate pipeline rejected attempt ${attempt}. Fix every item below; the work will be re-checked.`,
    ...sections,
    ...skippedNote,
  ].join("\n\n")
}
