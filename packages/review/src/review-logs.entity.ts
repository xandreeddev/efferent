import { Schema } from "effect"

/** A log could not be written where the review keeps its logs. */
export class LogsUnavailable extends Schema.TaggedError<LogsUnavailable>()("LogsUnavailable", {
  name: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
