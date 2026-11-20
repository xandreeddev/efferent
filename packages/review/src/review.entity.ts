import { Schema } from "effect"
import { PrepareOptions } from "./prepare-review.entity.js"
import { PassOptions } from "./review-pass.entity.js"
import { Finder } from "./review-prompt.entity.js"
import { ReviewBudget } from "./stage-spend.entity.js"

const AtLeastOne = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * How many passes a review runs by default: one, until an evaluation shows more find more (on #645 three passes
 * mostly read the same files, at three times the cost).
 */
export const DEFAULT_PASSES = 1

/**
 * What a pass keeps back by default for its closing call, in USD: about what the longest live pass's last request
 * held ($0.09 for 300 KB at 1 byte a token, and 4,096 tokens of output). The review keeps at most half its find
 * stage back across its passes.
 */
export const DEFAULT_CLOSING_RESERVE = 0.1

/** The most model calls one check makes by default. */
export const DEFAULT_VERIFY_STEPS = 6

/** How many checks run at once by default. */
export const DEFAULT_VERIFY_CONCURRENCY = 3

/**
 * What a review is asked: how to prepare the pull request; how many passes run (`passes`), how each runs (`pass`) and
 * finds (`finder`); whether the vote filters the buckets (`vote`, off by default: every bucket goes to the checks);
 * whether the kept buckets are checked (`verify`), how many checks run at once and the most calls one makes; what each
 * stage may spend (`budget`); and the model's id, kept with its record.
 */
export const ReviewOptions = Schema.Struct({
  prepare: PrepareOptions,
  passes: AtLeastOne,
  pass: PassOptions,
  finder: Finder,
  vote: Schema.Boolean,
  verify: Schema.Boolean,
  verifyConcurrency: AtLeastOne,
  verifySteps: AtLeastOne,
  budget: ReviewBudget,
  model: Schema.String,
})
export type ReviewOptions = typeof ReviewOptions.Type
