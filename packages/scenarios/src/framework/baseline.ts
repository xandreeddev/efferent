import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Option } from "effect"
import type { Pack, PackReport, ScenarioMode } from "./model.js"

/**
 * The committed regression ratchet, shared by the scripted CI entry
 * (`main.ts`) and the live-battery entry (`evalsLive.ts`): one JSON file per
 * `<pack>.<mode>`, compared BY DEFAULT when present; `--update-baselines` is
 * the only write path (reviewed in the PR diff like any ratchet update).
 * The extended fields (`versions`/`samples`/`mintedAt`) are provenance —
 * old baseline files without them still read fine.
 */

export interface Baseline {
  readonly mode: ScenarioMode
  readonly mean: number
  readonly scenarios: Record<string, number>
  /** Prompt-version constants the pack declared when this baseline was
   *  minted — a drift against the current pack meta prints a loud warning. */
  readonly versions?: Record<string, string>
  readonly samples?: number
  readonly mintedAt?: string
}

export const baselinePath = (dir: string, pack: string, mode: ScenarioMode): string =>
  join(dir, `${pack}.${mode}.json`)

export const readBaseline = (
  dir: string,
  pack: string,
  mode: ScenarioMode,
): Option.Option<Baseline> => {
  const path = baselinePath(dir, pack, mode)
  if (!existsSync(path)) return Option.none()
  return Option.some(JSON.parse(readFileSync(path, "utf-8")) as Baseline)
}

export const toBaseline = (report: PackReport, pack: Pack): Baseline => ({
  mode: report.mode,
  mean: report.mean,
  scenarios: Object.fromEntries(
    report.scenarios
      .filter((s) => s.status === "ran")
      .map((s) => [s.name, Number(s.combined.toFixed(4))]),
  ),
  ...(pack.meta !== undefined ? { versions: pack.meta } : {}),
  ...(pack.samples !== undefined ? { samples: pack.samples } : {}),
  mintedAt: new Date().toISOString(),
})

export const writeBaseline = (
  dir: string,
  report: PackReport,
  pack: Pack,
): void => {
  const path = baselinePath(dir, report.pack, report.mode)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(toBaseline(report, pack), null, 2) + "\n")
}

/** The default wobble tolerance; a pack may declare its own (live batteries
 *  are noisier). */
export const DEFAULT_TOLERANCE = 0.05

/** `Some(message)` when the report regressed beyond the tolerance. With
 *  `perScenario`, EVERY scenario is a ratchet — a per-case drop past the
 *  tolerance fails even when the pack mean holds (one case can no longer
 *  pay for another's regression). */
export const compareBaseline = (
  report: PackReport,
  baseline: Baseline,
  tolerance: number,
  perScenario = false,
): Option.Option<string> => {
  const meanDrop =
    report.mean < baseline.mean - tolerance
      ? [
          `mean ${report.mean.toFixed(3)} < ${baseline.mean.toFixed(3)} − ${tolerance}`,
        ]
      : []
  const caseDrops = !perScenario
    ? []
    : report.scenarios.flatMap((result) => {
        const minted = baseline.scenarios[result.name]
        return result.status === "ran" && minted !== undefined && result.combined < minted - tolerance
          ? [`"${result.name}" ${result.combined.toFixed(3)} < ${minted.toFixed(3)} − ${tolerance}`]
          : []
      })
  const drops = [...meanDrop, ...caseDrops]
  return drops.length === 0
    ? Option.none()
    : Option.some(`REGRESSION vs committed baseline: ${drops.join(" · ")}`)
}

/** `Some(warning)` when the pack's current prompt versions differ from the
 *  ones the baseline was minted for — not a failure (the score gate is the
 *  enforcement), but the delta must be attributable. */
export const versionDrift = (
  pack: Pack,
  baseline: Baseline,
): Option.Option<string> => {
  const current = pack.meta ?? {}
  const minted = baseline.versions ?? {}
  const drifted = Object.keys({ ...current, ...minted }).filter(
    (key) => current[key] !== minted[key],
  )
  return drifted.length === 0
    ? Option.none()
    : Option.some(
        `baseline minted for ${drifted
          .map((key) => `${key} ${minted[key] ?? "(unset)"}`)
          .join(", ")} — current ${drifted
          .map((key) => `${key} ${current[key] ?? "(unset)"}`)
          .join(", ")}; review and --update-baselines`,
      )
}
