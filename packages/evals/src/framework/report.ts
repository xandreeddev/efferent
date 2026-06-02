import type { EvalReport } from "./Eval.js"

/* Inline ANSI — evals must not depend on @efferent/cli. */
const ESC = "\x1b["
const wrap = (code: number) => (s: string): string => `${ESC}${code}m${s}${ESC}0m`
const dim = wrap(2)
const bold = wrap(1)
const green = wrap(32)
const yellow = wrap(33)
const red = wrap(31)
const cyan = wrap(36)

const scoreColor = (n: number): string => {
  const s = n.toFixed(2)
  return n >= 0.8 ? green(s) : n >= 0.5 ? yellow(s) : red(s)
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))

/** A coloured, one-block-per-suite report for the terminal. */
export const formatReport = (r: EvalReport): string => {
  const lines: Array<string> = ["", bold(cyan(`▌ ${r.name}`)) + (r.description ? dim(`  ${r.description}`) : "")]

  if (r.skipped) {
    lines.push(yellow(`  ⚠ skipped — ${r.skipReason ?? "unknown reason"}`))
    return lines.join("\n")
  }

  const nameW = Math.max(4, ...r.cases.map((cs) => cs.name.length))
  for (const cs of r.cases) {
    const icon = !cs.ok ? red("✗") : cs.mean >= r.threshold ? green("✓") : yellow("~")
    const body = cs.ok
      ? cs.scores.map((s) => `${dim(s.name)}=${scoreColor(s.score)}`).join("  ")
      : red("ERROR")
    lines.push(
      `  ${icon} ${pad(cs.name, nameW)}  ${body}  ${dim("mean")} ${scoreColor(cs.mean)}  ${dim(`${cs.durationMs}ms`)}`,
    )
    if (!cs.ok && cs.error !== undefined) {
      lines.push(dim(`      ${cs.error.split("\n")[0] ?? ""}`))
    } else if (cs.ok) {
      for (const s of cs.scores) {
        if (s.detail !== undefined) lines.push(dim(`      ${s.name}: ${s.detail}`))
      }
    }
  }

  const verdict = r.passed ? green("PASS") : red("FAIL")
  lines.push(
    `  ${bold(verdict)}  ${dim("mean")} ${scoreColor(r.mean)} ${dim(`(threshold ${r.threshold.toFixed(2)})`)}` +
      `  ${dim(`· ${r.cases.length} cases · ${(r.durationMs / 1000).toFixed(1)}s`)}`,
  )
  return lines.join("\n")
}
