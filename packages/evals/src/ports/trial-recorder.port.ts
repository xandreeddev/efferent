import { Context } from "effect"
import type { Effect } from "effect"
import type { EvaluationError } from "../domain/identity.entity.js"

/** The durable writer for one active trial. Settlement drains writes; late callbacks are ignored. */
export class TrialRecorder extends Context.Service<
  TrialRecorder,
  {
    readonly record: (
      kind: string,
      data: unknown
    ) => Effect.Effect<void, EvaluationError>
  }
>()("efferent/evals/TrialRecorder") {}
