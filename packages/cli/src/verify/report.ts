/**
 * The `efferent verify` report — a graded battery result. Each check declares
 * its TIER (A = deterministic/no-key, B = LLM-as-agent/objective, C =
 * LLM-as-judge/semantic) and a STATUS; the binary exit code fails iff a *hard*
 * check failed (a `fail`), never on a `skip` (n/a, e.g. no key) or a `soft`
 * (best-effort, e.g. a semantic smoke). Styled after the evals report.
 */

export type Tier = "A" | "B" | "C"
export type CheckStatus = "pass" | "fail" | "skip" | "soft"

export interface CheckResult {
  readonly name: string
  readonly tier: Tier
  readonly status: CheckStatus
  readonly detail?: string | undefined
  readonly ms: number
}

export interface VerifyReport {
  readonly target: string
  readonly model: string
  readonly checks: ReadonlyArray<CheckResult>
}

const TIER_LABEL: Record<Tier, string> = {
  A: "deterministic",
  B: "agent · objective",
  C: "judge · semantic",
}

// Minimal ANSI — matches the run.sh / evals palette without pulling a dep.
const c = (code: number, s: string): string => `\x1b[${code}m${s}\x1b[0m`
const green = (s: string) => c(32, s)
const red = (s: string) => c(31, s)
const yellow = (s: string) => c(33, s)
const dim = (s: string) => c(2, s)
const bold = (s: string) => c(1, s)

const glyph: Record<CheckStatus, string> = {
  pass: green("ok  "),
  fail: red("FAIL"),
  skip: dim("skip"),
  soft: yellow("soft"),
}

/** A hard check failed ⇒ the whole run failed. Skips and softs never fail. */
export const reportPassed = (r: VerifyReport): boolean =>
  !r.checks.some((ch) => ch.status === "fail")

export const exitCodeFor = (r: VerifyReport): number => (reportPassed(r) ? 0 : 1)

const countBy = (checks: ReadonlyArray<CheckResult>, s: CheckStatus): number =>
  checks.filter((ch) => ch.status === s).length

/** A coloured, tier-grouped table. */
export const formatReport = (r: VerifyReport): string => {
  const lines: string[] = []
  lines.push("")
  lines.push(bold(`efferent verify — ${r.target}  ${dim(`(${r.model})`)}`))
  for (const tier of ["A", "B", "C"] as const) {
    const inTier = r.checks.filter((ch) => ch.tier === tier)
    if (inTier.length === 0) continue
    lines.push("")
    lines.push(dim(`── Tier ${tier} · ${TIER_LABEL[tier]} ──`))
    for (const ch of inTier) {
      const dur = dim(`${ch.ms}ms`)
      const detail = ch.detail ? `  ${dim(ch.detail)}` : ""
      lines.push(`  ${glyph[ch.status]}  ${ch.name.padEnd(22)} ${dur}${detail}`)
    }
  }
  lines.push("")
  const passed = reportPassed(r)
  const summary =
    `${countBy(r.checks, "pass")} ok · ` +
    `${countBy(r.checks, "fail")} fail · ` +
    `${countBy(r.checks, "soft")} soft · ` +
    `${countBy(r.checks, "skip")} skip`
  lines.push(`${passed ? green("PASSED") : red("FAILED")}  ${dim(summary)}`)
  lines.push("")
  return lines.join("\n")
}
