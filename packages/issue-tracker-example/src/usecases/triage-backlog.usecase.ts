import { Schema } from "effect"
import { Issue } from "../domain/issue.entity.js"

export const TriageBacklogInput = Schema.Struct({ concurrency: Schema.Int.pipe(Schema.between(1, 16)) })
export type TriageBacklogInput = typeof TriageBacklogInput.Type

export const TriageBacklogOutput = Schema.Array(Issue)
export type TriageBacklogOutput = typeof TriageBacklogOutput.Type
