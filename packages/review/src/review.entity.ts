import { Schema } from "effect"
import { PrepareOptions } from "./prepare-review.entity.js"
import { PassOptions } from "./review-pass.entity.js"

/** What a review is asked: how to prepare the pull request, how a pass runs, and the model's id, kept with its record. */
export const ReviewOptions = Schema.Struct({
  prepare: PrepareOptions,
  pass: PassOptions,
  model: Schema.String,
})
export type ReviewOptions = typeof ReviewOptions.Type
