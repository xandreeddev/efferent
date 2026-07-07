import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import type { PackReport, ScenarioMode } from "./framework/model.js"
import { runPack } from "./framework/run.js"
import { smithSpecPack } from "./packs/smithSpec.js"

/**
 * `bun run scenarios [pack …] [--mode scripted|live] [--json] [--update-baselines] [--no-check]`
 *
 * Standing baselines (the regression ratchet, foundry's UX): when
 * `baselines/<pack>.json` exists it is compared BY DEFAULT — a mean drop
 * beyond the tolerance exits non-zero. `--update-baselines` rewrites the
 * committed files (reviewed in the PR diff like any ratchet update).
 */

const PACKS = { "smith-spec": smithSpecPack } as const

const BASELINE_DIR = join(import.meta.dir, "..", "baselines")
/** A mean may wobble; a drop beyond this against the committed baseline fails. */
const BASELINE_TOLERANCE = 0.05

interface Baseline {
  readonly mode: ScenarioMode
  readonly mean: number
  readonly scenarios: Record<string, number>
}

const baselinePath = (pack: string, mode: ScenarioMode): string =>
  join(BASELINE_DIR, `${pack}.${mode}.json`)

const readBaseline = (pack: string, mode: ScenarioMode): Baseline | null => {
  const path = baselinePath(pack, mode)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf-8")) as Baseline
}

const toBaseline = (report: PackReport): Baseline => ({
  mode: report.mode,
  mean: report.mean,
  scenarios: Object.fromEntries(
    report.scenarios
      .filter((s) => s.status === "ran")
      .map((s) => [s.name, Number(s.combined.toFixed(4))]),
  ),
})

const renderReport = (report: PackReport, regression: string | null): string => {
  const lines = report.scenarios.flatMap((s) => {
    const head = `  ${s.status === "ran" ? (s.combined >= 1 ? "✓" : s.combined > 0 ? "◐" : "✗") : "·"} ${s.name} — ${s.status === "ran" ? s.combined.toFixed(2) : s.status}${s.detail !== undefined ? ` (${s.detail})` : ""}`
    const failing = s.checks
      .filter((c) => !c.pass)
      .map((c) => `      ✗ [${c.severity}] ${c.step} › ${c.check}${c.detail !== undefined ? ` — ${c.detail}` : ""}`)
    return [head, ...failing]
  })
  const verdict = report.passed && regression === null ? "PASS" : "FAIL"
  return [
    `pack ${report.pack} (${report.mode}) — mean ${report.mean.toFixed(3)} / threshold ${report.threshold} — ${verdict}`,
    ...lines,
    ...(regression !== null ? [`  ⚠ ${regression}`] : []),
  ].join("\n")
}

const parseArgs = (argv: ReadonlyArray<string>) => {
  const mode: ScenarioMode = argv.includes("--mode")
    ? ((argv[argv.indexOf("--mode") + 1] ?? "scripted") as ScenarioMode)
    : "scripted"
  const names = argv.filter(
    (a, i) => !a.startsWith("--") && argv[i - 1] !== "--mode",
  )
  return {
    mode,
    names: names.length > 0 ? names : Object.keys(PACKS),
    json: argv.includes("--json"),
    update: argv.includes("--update-baselines"),
    noCheck: argv.includes("--no-check"),
  }
}

const program = Effect.gen(function* () {
  const args = parseArgs(process.argv.slice(2))
  const selected = args.names.flatMap((name) => {
    const pack = PACKS[name as keyof typeof PACKS]
    if (pack === undefined) {
      console.error(`scenarios: unknown pack "${name}" (have: ${Object.keys(PACKS).join(", ")})`)
      return []
    }
    return [pack]
  })
  if (selected.length === 0) return 2

  const reports = yield* Effect.forEach(selected, (pack) => runPack(pack, args.mode))
  const outcomes = reports.map((report) => {
    const baseline = args.noCheck ? null : readBaseline(report.pack, report.mode)
    const regression =
      baseline !== null && report.mean < baseline.mean - BASELINE_TOLERANCE
        ? `REGRESSION vs committed baseline: mean ${report.mean.toFixed(3)} < ${baseline.mean.toFixed(3)} − ${BASELINE_TOLERANCE}`
        : null
    if (args.update) {
      mkdirSync(dirname(baselinePath(report.pack, report.mode)), { recursive: true })
      writeFileSync(
        baselinePath(report.pack, report.mode),
        JSON.stringify(toBaseline(report), null, 2) + "\n",
      )
    }
    return { report, regression }
  })

  if (args.json) {
    console.log(JSON.stringify(outcomes.map((o) => o.report), null, 2))
  } else {
    outcomes.forEach((o) => {
      console.log(renderReport(o.report, o.regression))
    })
    if (args.update) console.log(`baselines updated under ${BASELINE_DIR}`)
  }
  const failed = outcomes.some((o) => !o.report.passed || o.regression !== null)
  return failed ? 1 : 0
})

const isDirectRun = process.argv[1]?.endsWith("main.ts") === true
if (isDirectRun) {
  process.exit(await Effect.runPromise(program as Effect.Effect<number>))
}
