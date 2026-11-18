import { Schema } from "effect"

/**
 * A host's reorder gave scores that make no order for what was found: not one score for each item, or a score that
 * is no finite number. `message` says which, in words. The context fails with it: a request is never sent in an
 * order nobody gave.
 *
 * @public
 */
export class ReorderInvalid extends Schema.TaggedError<ReorderInvalid>()("ReorderInvalid", {
  message: Schema.String,
}) {}
