import { Option } from "effect"
import type { Pack, PackReport, ScenarioResult } from "./model.js"

/**
 * Report rendering, shared by both entries. The scripted CI output is
 * unchanged; the live entry additionally shows judge lines, the samples
 * column, the pack's prompt versions, and pack summary lines.
 */

const statusGlyph = (s: ScenarioResult): string =>
  s.status !== "ran" ? "·" : s.combined >= 1 ? "✓" : s.combined > 0 ? "◐" : "✗"

const samplesTag = (s: ScenarioResult): string =>
  s.samples === undefined
    ? ""
    : ` (${s.samples.scores.filter((x) => x >= 1).length}/${s.samples.count}${
        s.samples.passRate < 1 ? ` · hard-pass ${(s.samples.passRate * 100).toFixed(0)}%` : ""
      })`

const scenarioLines = (s: ScenarioResult, showJudges: boolean): ReadonlyArray<string> => {
  const head = `  ${statusGlyph(s)} ${s.name} — ${
    s.status === "ran" ? s.combined.toFixed(2) : s.status
  }${samplesTag(s)}${s.detail !== undefined ? ` (${s.detail})` : ""}`
  const failing = s.checks
    .filter((c) => !c.pass)
    .map(
      (c) =>
        `      ✗ [${c.severity}] ${c.step} › ${c.check}${c.detail !== undefined ? ` — ${c.detail}` : ""}`,
    )
  const judges = showJudges
    ? s.judges.map(
        (j) => `      ⚖ ${j.judge} ${j.score.toFixed(2)} — ${j.reason.slice(0, 160)}`,
      )
    : []
  return [head, ...failing, ...judges]
}

export interface ReportExtras {
  /** The regression message (from compareBaseline), if any. */
  readonly regression: Option.Option<string>
  /** The version-drift warning (from versionDrift), if any. */
  readonly drift: Option.Option<string>
  /** Show per-scenario judge outcome lines (the live entry). */
  readonly showJudges: boolean
  /** Pack summary lines (Pack.summary output). */
  readonly summary: ReadonlyArray<string>
}

export const defaultExtras: ReportExtras = {
  regression: Option.none(),
  drift: Option.none(),
  showJudges: false,
  summary: [],
}

export const renderReport = (
  report: PackReport,
  pack: Pack,
  extras: ReportExtras = defaultExtras,
): string => {
  const verdict = report.passed && Option.isNone(extras.regression) ? "PASS" : "FAIL"
  const meta =
    pack.meta === undefined
      ? ""
      : `   [${Object.entries(pack.meta)
          .map(([key, value]) => `${key} ${value}`)
          .join(" · ")}${pack.samples !== undefined && pack.samples > 1 ? ` · k=${pack.samples}` : ""}]`
  return [
    `pack ${report.pack} (${report.mode}) — mean ${report.mean.toFixed(3)} / threshold ${report.threshold} — ${verdict}${meta}`,
    ...report.scenarios.flatMap((s) => scenarioLines(s, extras.showJudges)),
    ...extras.summary.map((line) => `  ${line}`),
    ...Option.toArray(Option.map(extras.regression, (message) => `  ⚠ ${message}`)),
    ...Option.toArray(Option.map(extras.drift, (message) => `  ⚠ ${message}`)),
  ].join("\n")
}
