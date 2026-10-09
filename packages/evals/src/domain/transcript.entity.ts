import { Schema } from "effect"
import { EvalId } from "./identity.entity.js"

export const TranscriptEvent = Schema.Struct({ id: EvalId, sequence: Schema.Int, at: Schema.Number, kind: Schema.NonEmptyString, data: Schema.Unknown })
export type TranscriptEvent = typeof TranscriptEvent.Type
export const Transcript = Schema.Array(TranscriptEvent)
export type Transcript = typeof Transcript.Type
