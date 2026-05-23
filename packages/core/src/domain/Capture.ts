import { Schema } from "effect"

export const CaptureId = Schema.UUID.pipe(Schema.brand("CaptureId"))
export type CaptureId = typeof CaptureId.Type

export const Capture = Schema.Struct({
  id: CaptureId,
  title: Schema.String,
  body: Schema.String,
  source: Schema.NullOr(Schema.String),
  createdAt: Schema.DateFromNumber,
})
export type Capture = typeof Capture.Type

export const NewCapture = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  source: Schema.NullOr(Schema.String),
})
export type NewCapture = typeof NewCapture.Type
