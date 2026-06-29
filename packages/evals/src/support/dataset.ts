import { Effect, Schema } from "effect"
import type { EvalCase } from "../framework/Eval.js"

/**
 * Versioned dataset files — the data-engineering half of evals. Cases live as
 * committed JSON (`src/suites/data/<name>.dataset.json`) instead of inline
 * literals, so a dataset can be reviewed, grown, and stratified independently of
 * the suite code. Each case may carry `tags` + `difficulty` for sliced analysis.
 *
 * A suite opts in by importing the JSON and passing it through `loadDataset`:
 *
 *   import raw from "./data/toolSelection.dataset.json"
 *   export const toolSelectionEval = defineEval({ …, data: loadDataset(raw) })
 *
 * The envelope is Schema-validated; a malformed COMMITTED dataset is a hard
 * error (a defect), never a silently-skipped case.
 */
const Difficulty = Schema.Literal("easy", "medium", "hard")

const RawCase = Schema.Struct({
  name: Schema.String,
  input: Schema.Unknown,
  expected: Schema.Unknown,
  tags: Schema.optional(Schema.Array(Schema.String)),
  difficulty: Schema.optional(Difficulty),
})

const RawDataset = Schema.Struct({
  /** Bump when the case shape changes (lets a loader migrate old files). */
  version: Schema.optional(Schema.Number),
  cases: Schema.Array(RawCase),
})

/** Validate + type a raw imported dataset into `EvalCase`s. `I`/`T` are asserted
 *  (the JSON can't be statically typed); the suite's scorers are the real check. */
export const loadDataset = <I, T>(
  raw: unknown,
): Effect.Effect<ReadonlyArray<EvalCase<I, T>>> =>
  Schema.decodeUnknown(RawDataset)(raw).pipe(
    Effect.map((d) =>
      d.cases.map((c) => ({
        name: c.name,
        input: c.input as I,
        expected: c.expected as T,
        ...(c.tags !== undefined ? { tags: c.tags } : {}),
        ...(c.difficulty !== undefined ? { difficulty: c.difficulty } : {}),
      })),
    ),
    Effect.orDie,
  )
