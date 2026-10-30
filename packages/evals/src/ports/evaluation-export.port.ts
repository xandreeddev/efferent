import { Context, Schema } from "effect"
import type { Effect } from "effect"
import type { EvaluationRun } from "../domain/evaluation-run.entity.js"
import type { EvaluationError } from "../domain/identity.entity.js"

export const ExportReceipt = Schema.Struct({ provider: Schema.String, runId: Schema.String, url: Schema.String, exported: Schema.Int, at: Schema.Number, mappings: Schema.Record(Schema.String, Schema.String) })
export type ExportReceipt = typeof ExportReceipt.Type
/**
 * Sends a saved run to an outside service. An export is bounded in time:
 * past its bound (the adapter's `timeoutMs`) it fails as `provider`. It is
 * interruptible: interrupted, it returns at once, aborting the requests in
 * flight where the client takes a signal (Langfuse) and otherwise no longer
 * waiting for them (LangSmith).
 */
export class EvaluationExport extends Context.Service<EvaluationExport, {
  readonly exportRun: (run: EvaluationRun) => Effect.Effect<ExportReceipt, EvaluationError>
}>()("efferent/evals/EvaluationExport") {}
