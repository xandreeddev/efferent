import { Schema } from "effect"
import { EvalPath } from "./identity.entity.js"

export const TranscriptEvent = Schema.Struct({ id: EvalPath, sequence: Schema.Int, at: Schema.Number, kind: Schema.NonEmptyString, data: Schema.Unknown })
export type TranscriptEvent = typeof TranscriptEvent.Type
export const Transcript = Schema.Array(TranscriptEvent)
export type Transcript = typeof Transcript.Type
