import { Schema } from "effect"
import { EvalPath } from "./identity.entity.js"

/** @public */
export const TranscriptEvent = Schema.Struct({ id: EvalPath, sequence: Schema.Int, at: Schema.Number, kind: Schema.NonEmptyString, data: Schema.Unknown })
export type TranscriptEvent = typeof TranscriptEvent.Type
/** @public */
export const Transcript = Schema.Array(TranscriptEvent)
export type Transcript = typeof Transcript.Type
