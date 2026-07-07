import { Match, Option } from "effect"
import type { Finding } from "../domain/Finding.js"
import type { GateReport, GateVerdict } from "../domain/Verdict.js"

const RESET = "[0m"
const green = (s: string): string => `[32m${s}${RESET}`
const red = (s: string): string => `[31m${s}${RESET}`
const yellow = (s: string): string => `[33m${s}${RESET}`
const dim = (s: string): string => `[2m${s}${RESET}`

const MAX_SHOWN = 50

export const renderFindingLine = (finding: Finding): string => {
  const where = Option.match(finding.location, {
    onNone: () => "",
    onSome: (l) => `${l.file}:${l.line}:${l.column} `,
  })
  return `${dim(`[${finding.rule}]`)} ${where}${finding.message}`
}

const renderVerdict = (verdict: GateVerdict): string =>
  Match.value(verdict).pipe(
    Match.tag("pass", (v) => {
      const advisory = v.findings.length > 0 ? `${v.findings.length} advisory · ` : ""
      return `${green("✓")} ${v.gate} ${dim(`${advisory}${Math.round(v.durationMs)}ms`)}`
    }),
    Match.tag("fail", (v) =>
      [
        `${red("✗")} ${v.gate} — ${v.findings.length} error${v.findings.length === 1 ? "" : "s"} ${dim(`${Math.round(v.durationMs)}ms`)}`,
        ...v.findings.slice(0, MAX_SHOWN).map((f) => `    ${renderFindingLine(f)}`),
        ...(v.findings.length > MAX_SHOWN
          ? [`    ${dim(`…and ${v.findings.length - MAX_SHOWN} more`)}`]
          : []),
      ].join("\n"),
    ),
    Match.tag("skip", (v) => `${yellow("○")} ${v.gate} ${dim(`skipped — ${v.reason}`)}`),
    Match.exhaustive,
  )

export const renderReport = (report: GateReport): string =>
  [
    ...report.verdicts.map(renderVerdict),
    report.ok ? green("gates: PASS") : red("gates: FAIL"),
  ].join("\n")
