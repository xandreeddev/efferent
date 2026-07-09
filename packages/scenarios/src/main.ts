import { join } from "node:path"
import { Effect, Option } from "effect"
import type { ScenarioMode } from "./framework/model.js"
import { runPack } from "./framework/run.js"
import {
  compareBaseline,
  DEFAULT_TOLERANCE,
  readBaseline,
  writeBaseline,
} from "./framework/baseline.js"
import type { Baseline } from "./framework/baseline.js"
import { defaultExtras, renderReport } from "./framework/report.js"
import { mathPack } from "./packs/math.js"
import { smithSpecPack } from "./packs/smithSpec.js"
import { tuiPack } from "./packs/tui.js"

/**
 * `bun run scenarios [pack …] [--mode scripted|live] [--json] [--update-baselines] [--no-check]`
 *
 * Standing baselines (the regression ratchet, foundry's UX): when
 * `baselines/<pack>.json` exists it is compared BY DEFAULT — a mean drop
 * beyond the tolerance exits non-zero. `--update-baselines` rewrites the
 * committed files (reviewed in the PR diff like any ratchet update).
 * The keyed live batteries have their own entry: `bun run evals:live`.
 */

const PACKS = { math: mathPack, "smith-spec": smithSpecPack, tui: tuiPack } as const

export const BASELINE_DIR = join(import.meta.dir, "..", "baselines")

export const parseArgs = (argv: ReadonlyArray<string>, packNames: ReadonlyArray<string>) => {
  const mode: ScenarioMode = argv.includes("--mode")
    ? ((argv[argv.indexOf("--mode") + 1] ?? "scripted") as ScenarioMode)
    : "scripted"
  const names = argv.filter(
    (a, i) => !a.startsWith("--") && argv[i - 1] !== "--mode",
  )
  return {
    mode,
    names: names.length > 0 ? names : packNames,
    json: argv.includes("--json"),
    update: argv.includes("--update-baselines"),
    noCheck: argv.includes("--no-check"),
  }
}

const program = Effect.gen(function* () {
  const args = parseArgs(process.argv.slice(2), Object.keys(PACKS))
  const selected = args.names.flatMap((name) => {
    const pack = PACKS[name as keyof typeof PACKS]
    if (pack === undefined) {
      console.error(`scenarios: unknown pack "${name}" (have: ${Object.keys(PACKS).join(", ")})`)
      return []
    }
    return [pack]
  })
  if (selected.length === 0) return 2

  const outcomes = yield* Effect.forEach(selected, (pack) =>
    runPack(pack, args.mode).pipe(
      Effect.map((report) => {
        const baseline = args.noCheck
          ? Option.none<Baseline>()
          : readBaseline(BASELINE_DIR, report.pack, report.mode)
        const regression = Option.flatMap(baseline, (b) =>
          compareBaseline(report, b, pack.tolerance ?? DEFAULT_TOLERANCE),
        )
        if (args.update) writeBaseline(BASELINE_DIR, report, pack)
        return { pack, report, regression }
      }),
    ),
  )

  if (args.json) {
    console.log(JSON.stringify(outcomes.map((o) => o.report), null, 2))
  } else {
    outcomes.forEach((o) => {
      console.log(renderReport(o.report, o.pack, { ...defaultExtras, regression: o.regression }))
    })
    if (args.update) console.log(`baselines updated under ${BASELINE_DIR}`)
  }
  const failed = outcomes.some((o) => !o.report.passed || Option.isSome(o.regression))
  return failed ? 1 : 0
})

const isDirectRun = process.argv[1]?.endsWith("main.ts") === true
if (isDirectRun) {
  process.exit(await Effect.runPromise(program as Effect.Effect<number>))
}
