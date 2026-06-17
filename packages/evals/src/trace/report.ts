import type { CaseAgg, RunAgg, SuiteAgg } from "./process.js"

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

const caseLine = (c: CaseAgg, nameW: number): string => {
  const icon = !c.ok ? red("✗") : c.mean >= 0.6 ? green("✓") : yellow("~")
  const scores = c.scores.map((s) => `${dim(s.name)}=${scoreColor(s.score)}`).join(" ")
  const cost = c.costUsd !== undefined ? ` · ${usd(c.costUsd)}` : ""
  return (
    `  ${icon} ${pad(c.name, nameW)}  ${dim("mean")} ${scoreColor(c.mean)}  ${scores}` +
    `  ${dim(`${c.steps} step${c.steps === 1 ? "" : "s"} · ${ktok(c.inputTokens)}→${ktok(c.outputTokens)} tok${cost} · ${(c.wallMs / 1000).toFixed(1)}s`)}`
  )
}

const suiteBlock = (s: SuiteAgg): string => {
  const nameW = Math.max(4, ...s.cases.map((c) => c.name.length))
  const head = `${bold(cyan(`▌ ${s.suite}`))}  ${dim("mean")} ${scoreColor(s.mean)} ${dim(`· pass ${(s.passRate * 100).toFixed(0)}% · ${s.cases.length} cases`)}`
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

/** Baseline (first config) vs each candidate: mean / tokens / cost deltas per suite. */
const renderComparison = (runs: ReadonlyArray<RunAgg>): string => {
  const base = runs[0]
  if (base === undefined) return ""
  const lines: Array<string> = [bold(cyan(`▌ comparison (baseline: ${base.configName})`))]
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
      lines.push(
        `    ${pad(name, 16)} mean ${scoreColor(c.mean)} (${delta(c.mean - b.mean)})` +
          ` · tok ${ktok(suiteTokens(c))} (${delta(suiteTokens(c) - suiteTokens(b))})${costStr}`,
      )
    }
  }
  return lines.join("\n")
}
