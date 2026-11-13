import { Schema } from "effect"

/**
 * A summarizer could not summarize: the model it asks failed, or answered with nothing.
 *
 * @public
 */
export class SummaryFailed extends Schema.TaggedError<SummaryFailed>()("SummaryFailed", {
  message: Schema.String,
}) {}
