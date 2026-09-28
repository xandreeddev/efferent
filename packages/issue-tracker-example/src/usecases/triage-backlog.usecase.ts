import { Schema } from "effect"
import { Issue } from "../domain/issue.entity.js"

export const TriageBacklogInput = Schema.Struct({ concurrency: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 16 }))) })
export type TriageBacklogInput = typeof TriageBacklogInput.Type

export const TriageBacklogOutput = Schema.Array(Issue)
export type TriageBacklogOutput = typeof TriageBacklogOutput.Type
