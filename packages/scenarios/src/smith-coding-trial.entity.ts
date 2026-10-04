import { Schema } from "effect"

export const SMITH_CODING_EVAL_VERSION = "1"
export const SmithTrialCheck = Schema.Struct({ name: Schema.String, pass: Schema.Boolean, stdout: Schema.String, stderr: Schema.String, exitCode: Schema.Int })
export type SmithTrialCheck = typeof SmithTrialCheck.Type
export const SmithTrialDiff = Schema.Struct({ path: Schema.String, before: Schema.NullOr(Schema.String), after: Schema.NullOr(Schema.String) })
export const SmithCodingEvidence = Schema.Struct({
  version: Schema.Literal("1"), candidate: Schema.String, caseId: Schema.String, sample: Schema.Int,
  transport: Schema.Literals(["scripted", "live"]), driverModel: Schema.String, editorModel: Schema.String,
  outerGraphFingerprint: Schema.String, versions: Schema.Record(Schema.String, Schema.String),
  resolvedConfig: Schema.Unknown,
  modules: Schema.Array(Schema.String), outcome: Schema.String, error: Schema.NullOr(Schema.String), latencyMs: Schema.Number,
  usage: Schema.Record(Schema.String, Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number, totalTokens: Schema.Number, cacheReadTokens: Schema.Number })),
  roleUsage: Schema.Struct({
    controller: Schema.Record(Schema.String, Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number, totalTokens: Schema.Number, cacheReadTokens: Schema.Number })),
    editor: Schema.Record(Schema.String, Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number, totalTokens: Schema.Number, cacheReadTokens: Schema.Number })),
    escalation: Schema.Record(Schema.String, Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number, totalTokens: Schema.Number, cacheReadTokens: Schema.Number })),
  }),
  checks: Schema.Array(SmithTrialCheck), diff: Schema.Array(SmithTrialDiff),
  parentEvents: Schema.Array(Schema.Unknown), editorEvents: Schema.Array(Schema.Unknown), transportRequests: Schema.Array(Schema.Unknown),
})
export type SmithCodingEvidence = typeof SmithCodingEvidence.Type
