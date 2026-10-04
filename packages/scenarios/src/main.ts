import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { AssessmentError, CalibrationReport, calibrationMarkdown } from "@xandreed/evals"
import type { ScenarioMode } from "./legacy/model.js"
import { runPack } from "./legacy/run.js"
import {
  compareBaseline,
  DEFAULT_TOLERANCE,
  orphanedEntries,
  readBaseline,
  unbaselinedEntries,
  versionDrift,
  writeBaseline,
} from "./legacy/baseline.js"
import { defaultExtras, renderReport } from "./legacy/report.js"
import { canvasPack } from "./packs/canvas.js"
import { mathPack } from "./packs/math.js"
import { profilePack } from "./packs/profile.js"
import { runSmithCalibration } from "./smith-calibration.adapter.js"
import { smithSpecPack } from "./packs/smithSpec.js"
import { socialPack } from "./packs/social.js"
import { tuiPack } from "./packs/tui.js"
import { issueTrackerPack } from "./packs/issueTracker.js"

/**
 * `bun run scenarios [pack …] [--mode scripted|live] [--json] [--update-baselines] [--no-check]`
 *
 * Smith names execute native, key-free calibrations with blocking gates.
 * Existing legacy packs retain standing baselines (the regression ratchet): when
 * `baselines/<pack>.json` exists it is compared BY DEFAULT — a mean drop
 * beyond the tolerance exits non-zero. `--update-baselines` rewrites the
 * committed files (reviewed in the PR diff like any ratchet update).
 * The keyed live batteries have their own entry: `bun run evals:live`.
 */

const PACKS = {
  canvas: canvasPack,
  "issue-tracker": issueTrackerPack,
  math: mathPack,
  profile: profilePack,
  "smith-spec": smithSpecPack,
  social: socialPack,
  tui: tuiPack,
} as const
const SMITH_CALIBRATIONS = ["smith-coding", "smith-interaction"] as const

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
  const args = parseArgs(process.argv.slice(2), [...Object.keys(PACKS), ...SMITH_CALIBRATIONS])
  const nativeNames = args.names.filter((name): name is typeof SMITH_CALIBRATIONS[number] => SMITH_CALIBRATIONS.some((candidate) => candidate === name))
  if (nativeNames.length > 0 && args.mode !== "scripted") {
    console.error("scenarios: Smith calibrations here are key-free. Use evals:smith --live with explicit --main and --fast for admitted live trials; no requests sent")
    return 2
  }
  const selected = args.names.flatMap((name) => {
    if (SMITH_CALIBRATIONS.some((candidate) => candidate === name)) return []
    const pack = PACKS[name as keyof typeof PACKS]
    if (pack === undefined) {
      console.error(`scenarios: unknown evaluation "${name}" (have: ${[...Object.keys(PACKS), ...SMITH_CALIBRATIONS].join(", ")})`)
      return []
    }
    return [pack]
  })
  if (selected.length === 0 && nativeNames.length === 0) return 2

  const outcomes = yield* Effect.forEach(selected, (pack) =>
    runPack(pack, args.mode).pipe(
      Effect.map((report) => {
        // Read BEFORE any update — comparisons and warnings are always
        // run-vs-committed.
        const prior = readBaseline(BASELINE_DIR, report.pack, report.mode)
        const regression = args.noCheck
          ? Option.none<string>()
          : Option.flatMap(prior, (b) =>
              compareBaseline(
                report,
                b,
                pack.tolerance ?? DEFAULT_TOLERANCE,
                pack.perScenarioRatchet === true,
                pack.perScenarioTolerance ?? pack.tolerance ?? DEFAULT_TOLERANCE,
              ),
            )
        const orphans = args.noCheck ? [] : Option.match(prior, {
          onNone: () => [] as ReadonlyArray<string>,
          onSome: (b) => orphanedEntries(report, b),
        })
        const unbaselined = args.noCheck ? [] : Option.match(prior, {
          onNone: () => [`missing committed baseline for ${report.pack}.${report.mode}`],
          onSome: (b) => unbaselinedEntries(report, b),
        })
        const drift = args.noCheck
          ? Option.none<string>()
          : Option.flatMap(prior, (b) => versionDrift(pack, b))
        if (args.update) writeBaseline(BASELINE_DIR, report, pack)
        return { pack, report, regression, orphans, unbaselined, drift }
      }),
    ),
  )
  const calibrations = yield* Effect.forEach(nativeNames, (name) => runSmithCalibration(name)).pipe(Effect.map((reports) => reports.flat()))

  if (args.json) {
    const encoded = yield* Schema.encodeEffect(Schema.Array(CalibrationReport))(calibrations)
    yield* Effect.callback<void, AssessmentError>((resume) => {
      process.stdout.write(`${JSON.stringify([...outcomes.map((o) => o.report), ...encoded], null, 2)}\n`, (error) => resume(error
        ? Effect.fail(new AssessmentError({ code: "persistence", message: "Unable to write evaluation JSON" }))
        : Effect.void))
    })
  } else {
    outcomes.forEach((o) => {
      console.log(renderReport(o.report, o.pack, { ...defaultExtras, regression: o.regression, drift: o.drift }))
      o.orphans.forEach((warning) => console.log(`  ⚠ ${warning}`))
      o.unbaselined.forEach((warning) => console.log(`  ⚠ ${warning}`))
    })
    calibrations.forEach((report) => console.log(calibrationMarkdown(report)))
    if (args.update) console.log(`baselines updated under ${BASELINE_DIR}`)
  }
  const failed = outcomes.some(
    (o) =>
      !o.report.passed ||
      Option.isSome(o.regression) ||
      Option.isSome(o.drift) ||
      o.orphans.length > 0 ||
      o.unbaselined.length > 0,
  )
  const nativeFailed = calibrations.some((report) => !report.reviewed || report.failures.length > 0 || report.candidates.length === 0 || report.candidates.some((candidate) => !candidate.passed))
  return failed || nativeFailed ? 1 : 0
})

const isDirectRun = process.argv[1]?.endsWith("main.ts") === true
if (isDirectRun) {
  process.exit(await Effect.runPromise(program as Effect.Effect<number>))
}
