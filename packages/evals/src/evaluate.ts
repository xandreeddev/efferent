import { Effect, Schema } from "effect"
import type { Pack, PackReport, ScenarioMode } from "./model.js"
import { runPack } from "./run.js"

export class EvalError extends Schema.TaggedError<EvalError>()("EvalError", { message: Schema.String }) {}
export interface Reporter {
  readonly name: string
  readonly write: (report: PackReport) => Effect.Effect<void, EvalError>
}
/** Applications supply packs, fixtures, checks, judges and reporters; no global registry. */
export const evaluate = (options: {
  readonly packs: ReadonlyArray<Pack>
  readonly mode: ScenarioMode
  readonly select?: ReadonlyArray<string>
  readonly reporters?: ReadonlyArray<Reporter>
}) => Effect.gen(function* () {
  const names = options.packs.map((pack) => pack.name)
  if (new Set(names).size !== names.length) return yield* Effect.fail(new EvalError({ message: "Duplicate eval pack names" }))
  const selected = options.select ?? names
  const missing = selected.filter((name) => !names.includes(name))
  if (missing.length > 0) return yield* Effect.fail(new EvalError({ message: `Unknown eval packs: ${missing.join(", ")}` }))
  if (selected.length === 0) return yield* Effect.fail(new EvalError({ message: "Select at least one eval pack" }))
  return yield* Effect.forEach(options.packs.filter((pack) => selected.includes(pack.name)), (pack) => runPack(pack, options.mode).pipe(
    Effect.tap((report) => Effect.forEach(options.reporters ?? [], (reporter) => reporter.write(report), { discard: true })),
  ))
})
