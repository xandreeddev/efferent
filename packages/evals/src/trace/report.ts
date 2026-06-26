import type { SavedReport } from "../storage.js"
import type { CaseAgg, RunAgg, SuiteAgg } from "./process.js"
import { pairedDeltaCI } from "./significance.js"

/* Inline ANSI — evals must not depend on @xandreed/code. */
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
const ktok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
const usd = (n: number | undefined): string => (n === undefined ? "n/a" : `$${n.toFixed(4)}`)

const meanCell = (c: CaseAgg): string =>
  c.samples > 1 ? `${scoreColor(c.mean)} ${dim(`±${c.stdev.toFixed(2)}`)}` : scoreColor(c.mean)

const caseLine = (c: CaseAgg, nameW: number): string => {
  const icon = !c.ok ? red("✗") : c.mean >= 0.6 ? green("✓") : yellow("~")
  const scores = c.scores.map((s) => `${dim(s.name)}=${scoreColor(s.score)}`).join(" ")
  const cost = c.costUsd !== undefined ? ` · ${usd(c.costUsd)}` : ""
  const n = c.samples > 1 ? `${c.samples}× · ` : ""
  // pass^k marker only when sampled (k>1): did EVERY attempt pass the gate?
  const consist = c.samples > 1 ? `  ${dim("pass^k")} ${c.passHatK ? green("✓") : red("✗")}` : ""
  const tools = c.toolCalls > 0 ? `${c.toolCalls} tool${c.toolCalls === 1 ? "" : "s"} · ` : ""
  return (
    `  ${icon} ${pad(c.name, nameW)}  ${dim("mean")} ${meanCell(c)}  ${scores}${consist}` +
    `  ${dim(`${n}${c.steps} step${c.steps === 1 ? "" : "s"} · ${tools}${ktok(c.inputTokens)}→${ktok(c.outputTokens)} tok${cost} · ${(c.wallMs / 1000).toFixed(1)}s`)}`
  )
}

/** Align two suites' cases by name → paired per-case means (baseline, candidate). */
const pairByName = (
  baseCases: ReadonlyArray<CaseAgg>,
  candCases: ReadonlyArray<CaseAgg>,
): { base: Array<number>; cand: Array<number> } => {
  const bm = new Map(baseCases.map((c) => [c.name, c.mean]))
  const base: Array<number> = []
  const cand: Array<number> = []
  for (const c of candCases) {
    const b = bm.get(c.name)
    if (b !== undefined) {
      base.push(b)
      cand.push(c.mean)
    }
  }
  return { base, cand }
}

const suiteBlock = (s: SuiteAgg): string => {
  const nameW = Math.max(4, ...s.cases.map((c) => c.name.length))
  // Show pass^k (consistency) only when the suite was sampled (k>1).
  const sampled = s.cases.some((c) => c.samples > 1)
  const consist = sampled ? dim(` · pass^k ${(s.passHatKRate * 100).toFixed(0)}%`) : ""
  const cps = s.costPerPass !== undefined ? dim(` · ${usd(s.costPerPass)}/pass`) : ""
  const head = `${bold(cyan(`▌ ${s.suite}`))}  ${dim("mean")} ${scoreColor(s.mean)} ${dim(`· pass ${(s.passRate * 100).toFixed(0)}% · ${s.cases.length} cases`)}${consist}${cps}`
  return [head, ...s.cases.map((c) => caseLine(c, nameW))].join("\n")
}

/** Per-config report built entirely from the collected spans. */
export const renderRuns = (runs: ReadonlyArray<RunAgg>): string => {
  const blocks: Array<string> = []
  for (const run of runs) {
    blocks.push("", bold(`━━ config: ${run.configName} ━━`))
    for (const s of run.suites) blocks.push("", suiteBlock(s))
  }
  if (runs.length >= 2) blocks.push("", renderComparison(runs))
  return blocks.join("\n")
}

const suiteTokens = (s: SuiteAgg): number =>
  s.cases.reduce((a, c) => a + c.inputTokens + c.outputTokens, 0)
const suiteCost = (s: SuiteAgg): number | undefined => {
  const priced = s.cases.filter((c) => c.costUsd !== undefined)
  return priced.length === 0 ? undefined : priced.reduce((a, c) => a + (c.costUsd ?? 0), 0)
}
const delta = (n: number): string => (n >= 0 ? green(`+${n.toFixed(2)}`) : red(n.toFixed(2)))

const effectSizeLabel = (d: number): string => {
  const a = Math.abs(d)
  if (a >= 0.8) return "large"
  if (a >= 0.5) return "medium"
  if (a >= 0.2) return "small"
  return "negligible"
}

/** `d=<mag> <label>`, rendering a zero-variance ±∞ effect as `∞` not `Infinity`. */
const formatEffect = (d: number): string => {
  const mag = Number.isFinite(d) ? d.toFixed(2) : d > 0 ? "∞" : "-∞"
  return `d=${mag} ${effectSizeLabel(d)}`
}

/** The CI's actual confidence level — widened by Bonferroni when comparing
 *  against >1 candidate (alpha = 0.05 / comparisons), so the label isn't a lie. */
const ciLabel = (comparisons: number): string =>
  comparisons > 1 ? `${(100 * (1 - 0.05 / comparisons)).toFixed(1)}%CI` : "95%CI"

/**
 * Baseline (first config) vs each candidate: mean / tokens / cost deltas per suite.
 * Applies Bonferroni correction when comparing against multiple candidates.
 */
const renderComparison = (runs: ReadonlyArray<RunAgg>): string => {
  const base = runs[0]
  if (base === undefined) return ""
  const comparisons = runs.length - 1
  const corrected = comparisons > 1 ? dim(`  (Bonferroni-corrected for ${comparisons} comparisons)`) : ""
  const lines: Array<string> = [bold(cyan(`▌ comparison (baseline: ${base.configName})`)), corrected]
  const suiteNames = base.suites.map((s) => s.suite)
  for (let i = 1; i < runs.length; i++) {
    const cand = runs[i]
    if (cand === undefined) continue
    lines.push(dim(`  ${cand.configName} vs ${base.configName}:`))
    for (const name of suiteNames) {
      const b = base.suites.find((s) => s.suite === name)
      const c = cand.suites.find((s) => s.suite === name)
      if (b === undefined || c === undefined) continue
      const bc = suiteCost(b)
      const cc = suiteCost(c)
      const costStr = bc !== undefined && cc !== undefined ? ` · cost ${usd(cc)} (${delta(cc - bc)})` : ""
      const { base: bm, cand: cm } = pairByName(b.cases, c.cases)
      const ci = pairedDeltaCI(bm, cm, 2000, 0x5eed1e, comparisons)
      const verdict = ci.significant
        ? c.mean >= b.mean
          ? green(" ✔ sig.")
          : red(" ✘ sig.")
        : dim(" ~ noise")
      const es = formatEffect(ci.cohensD)
      lines.push(
        `    ${pad(name, 16)} mean ${scoreColor(c.mean)} (${delta(c.mean - b.mean)})` +
          ` · tok ${ktok(suiteTokens(c))} (${delta(suiteTokens(c) - suiteTokens(b))})${costStr}` +
          ` · ${ciLabel(comparisons)} [${ci.low.toFixed(2)},${ci.high.toFixed(2)}] · ${es}${verdict}`,
      )
    }
  }
  return lines.join("\n")
}

/**
 * Compare the current run against a committed BASELINE (`--compare`). For each
 * config + suite, pairs cases by name and bootstraps the 95% CI of the mean
 * delta — the answer to "is this change effective, or noise?". Cases the
 * baseline lacks are skipped (a new scenario can't regress what didn't exist).
 */
export const renderVsBaseline = (
  current: ReadonlyArray<RunAgg>,
  baseline: SavedReport,
): string => {
  const stamp = `${baseline.ts}${baseline.gitSha !== undefined ? ` · ${baseline.gitSha}` : ""}${baseline.label !== undefined ? ` · ${baseline.label}` : ""}`
  const lines: Array<string> = [bold(cyan(`▌ vs baseline (${stamp})`))]
  for (const run of current) {
    const baseRun =
      baseline.runs.find((r) => r.configName === run.configName) ?? baseline.runs[0]
    if (baseRun === undefined) continue
    lines.push(dim(`  ${run.configName}:`))
    for (const s of run.suites) {
      const bs = baseRun.suites.find((x) => x.suite === s.suite)
      if (bs === undefined) {
        lines.push(`    ${pad(s.suite, 16)} ${scoreColor(s.mean)} ${dim("(new — no baseline)")}`)
        continue
      }
      const { base, cand } = pairByName(bs.cases, s.cases)
      const ci = pairedDeltaCI(base, cand)
      const es = formatEffect(ci.cohensD)
      const verdict = ci.significant
        ? ci.delta >= 0
          ? green(" ✔ better")
          : red(" ✘ worse")
        : dim(" ~ noise")
      lines.push(
        `    ${pad(s.suite, 16)} ${scoreColor(s.mean)} vs ${scoreColor(bs.mean)}` +
          ` · Δ ${delta(ci.delta)} 95%CI [${ci.low.toFixed(2)},${ci.high.toFixed(2)}] (n=${ci.n}) · ${es}${verdict}`,
      )
    }
  }
  return lines.join("\n")
}
