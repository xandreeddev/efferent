import { Context, Schema } from "effect"
import type { Effect } from "effect"
import type { EvaluationRun } from "../domain/evaluation-run.entity.js"
import type { EvaluationError } from "../domain/identity.entity.js"

export const ExportReceipt = Schema.Struct({ provider: Schema.String, runId: Schema.String, url: Schema.String, exported: Schema.Int, at: Schema.Number, mappings: Schema.Record(Schema.String, Schema.String) })
export type ExportReceipt = typeof ExportReceipt.Type
export class EvaluationExport extends Context.Service<EvaluationExport, {
  readonly exportRun: (run: EvaluationRun) => Effect.Effect<ExportReceipt, EvaluationError>
}>()("efferent/evals/EvaluationExport") {}
