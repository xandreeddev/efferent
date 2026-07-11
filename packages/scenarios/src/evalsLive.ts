import { Effect, Option } from "effect"
import type { Pack } from "./framework/model.js"
import { runPack } from "./framework/run.js"
import {
  compareBaseline,
  DEFAULT_TOLERANCE,
  orphanedEntries,
  readBaseline,
  versionDrift,
  writeBaseline,
} from "./framework/baseline.js"
import { renderReport } from "./framework/report.js"
import { BASELINE_DIR } from "./main.js"
import { modelMeta, preflightAuth } from "./live/llm.js"
import { digestPack } from "./packs/digest.js"
import { judgeCalibrationPack } from "./packs/judgeCalibration.js"
import { memoryPack } from "./packs/memory.js"
import { profilePack } from "./packs/profile.js"
import { refinerPack } from "./packs/refiner.js"
import { smithSpecPack } from "./packs/smithSpec.js"

/**
 * `bun run evals:live [battery …] [--samples n] [--json] [--update-baselines] [--no-check]`
 *
 * THE pre-merge ritual for prompt changes: every KEYED battery — the judge
 * calibration set, the refiner/digest/memory golden sets, the scored live
 * smith run — through the same scenario runner and baseline ratchet CI uses
 * for the scripted packs. CI never runs this (key-free by design); a human
 * runs the battery their prompt change touches and commits the reviewed
 * baseline delta in the same PR.
 *
 * Exit: 0 = all pass, no regressions · 1 = fail/regression · 2 = no
 * credential / unknown battery.
 */

export const LIVE_PACKS: Record<string, Pack> = {
  "judge-calibration": judgeCalibrationPack,
  digest: digestPack,
  memory: memoryPack,
  profile: profilePack,
  refiner: refinerPack,
  /** The shared pack — its live-only scenario runs here; the scripted twin
   *  is CI's (main.ts). */
  "smith-spec": smithSpecPack,
}

export const parseLiveArgs = (
  argv: ReadonlyArray<string>,
  packNames: ReadonlyArray<string>,
) => {
  const names = argv.filter(
    (a, i) => !a.startsWith("--") && argv[i - 1] !== "--samples",
  )
  const samplesAt = argv.indexOf("--samples")
  /** A --samples override applies to EVERY selected pack (cheap smoke). */
  const samplesOverride = Option.fromNullable(
    samplesAt >= 0 ? argv[samplesAt + 1] : undefined,
  ).pipe(
    Option.map(Number),
    Option.filter((n) => Number.isFinite(n) && n >= 1),
    Option.map(Math.floor),
  )
  return {
    names: names.length > 0 ? names : packNames,
    samplesOverride,
    json: argv.includes("--json"),
    update: argv.includes("--update-baselines"),
    noCheck: argv.includes("--no-check"),
  }
}

const program = Effect.gen(function* () {
  const args = parseLiveArgs(process.argv.slice(2), Object.keys(LIVE_PACKS))

  const keyed = yield* preflightAuth(process.cwd())
  if (!keyed) {
    console.error(
      "evals:live: no credential in ~/.efferent/auth.json — run smith's :login first (these are the KEYED batteries; CI runs the scripted packs instead)",
    )
    return 2
  }

  const selected = args.names.flatMap((name) => {
    const pack = LIVE_PACKS[name]
    if (pack === undefined) {
      console.error(
        `evals:live: unknown battery "${name}" (have: ${Object.keys(LIVE_PACKS).join(", ") || "none yet — batteries land with E2/E3"})`,
      )
      return []
    }
    return [pack]
  })
  if (selected.length === 0) {
    if (args.names.length === 0) {
      console.error("evals:live: no live batteries registered yet (they land with E2/E3)")
    }
    return 2
  }

  // Resolved model ids ride every pack's meta: a model swap surfaces as
  // version drift, exactly like a prompt bump.
  const models = yield* modelMeta(process.cwd())

  const outcomes = yield* Effect.forEach(selected, (base) => {
    const withMeta = { ...base, meta: { ...base.meta, ...models } }
    const pack = Option.match(args.samplesOverride, {
      onNone: () => withMeta,
      onSome: (samples) => ({ ...withMeta, samples }),
    })
    return runPack(pack, "live").pipe(
      Effect.map((report) => {
        // The PRIOR baseline is read BEFORE any update — the printed delta
        // must be run-vs-committed, not run-vs-itself (Δ+0.00 exactly when
        // you updated hid the number the ritual exists to review).
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
        const drift = Option.flatMap(prior, (b) => versionDrift(pack, b))
        const orphans = Option.match(prior, {
          onNone: () => [] as ReadonlyArray<string>,
          onSome: (b) => orphanedEntries(report, b),
        })
        if (args.update) writeBaseline(BASELINE_DIR, report, pack)
        return { pack, report, regression, drift, orphans, prior }
      }),
    )
  })

  if (args.json) {
    console.log(JSON.stringify(outcomes.map((o) => o.report), null, 2))
  } else {
    console.log(`evals:live — ${outcomes.length} batter${outcomes.length === 1 ? "y" : "ies"}`)
    outcomes.forEach((o) => {
      console.log(
        renderReport(o.report, o.pack, {
          regression: o.regression,
          drift: o.drift,
          showJudges: true,
          summary: o.pack.summary?.(o.report) ?? [],
        }),
      )
      o.orphans.forEach((warning) => console.log(`  ⚠ ${warning}`))
    })
    const deltas = outcomes.flatMap((o) =>
      Option.match(o.prior, {
        onNone: () => [`${o.report.pack} (no baseline — mint with --update-baselines)`],
        onSome: (b) => [`${o.report.pack} Δ${(o.report.mean - b.mean >= 0 ? "+" : "") + (o.report.mean - b.mean).toFixed(2)}`],
      }),
    )
    console.log(`baselines: ${deltas.join(" · ")}`)
    if (args.update) console.log(`baselines updated under ${BASELINE_DIR}`)
  }
  const failed = outcomes.some((o) => !o.report.passed || Option.isSome(o.regression))
  return failed ? 1 : 0
})

const isDirectRun = process.argv[1]?.endsWith("evalsLive.ts") === true
if (isDirectRun) {
  process.exit(await Effect.runPromise(program as Effect.Effect<number>))
}
