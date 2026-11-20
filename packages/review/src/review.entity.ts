import { Schema } from "effect"
import { DEFAULT_GROUP_BOUNDS, DEFAULT_GROUP_STEPS, Focus, GroupBounds } from "./file-group.entity.js"
import { PrepareOptions } from "./prepare-review.entity.js"
import { Effort } from "./review-model.entity.js"
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
 * How a focused review groups and runs: each group's bounds, the most calls a group's pass makes (`steps`), and whether
 * the files outside every group but pages and docs get a pass of their own (`config`).
 */
export const GroupOptions = Schema.Struct({ bounds: GroupBounds, steps: AtLeastOne, config: Schema.Boolean })
export type GroupOptions = typeof GroupOptions.Type

/** The stock focused review: `DEFAULT_GROUP_BOUNDS`, `DEFAULT_GROUP_STEPS` calls a pass, no config pass. */
export const DEFAULT_GROUP_OPTIONS: GroupOptions = { bounds: DEFAULT_GROUP_BOUNDS, steps: DEFAULT_GROUP_STEPS, config: false }

/**
 * What a review is asked: how to prepare the pull request; how its passes read it (`focus`: `whole`, `passes` passes
 * over the whole of it, each run as `pass` says; or `groups`, one pass a group of changed files as `groups` says),
 * how they find (`finder`); whether the vote filters the buckets (`vote`, off by default: every bucket goes to the
 * checks); whether the kept buckets are checked (`verify`), how many checks run at once and the most calls one makes;
 * what each stage may spend (`budget`); how hard the model reasons in each stage (`effort`, kept with the record, the
 * host's model layers built from it); and the model's id, kept with its record.
 */
export const ReviewOptions = Schema.Struct({
  prepare: PrepareOptions,
  focus: Focus,
  passes: AtLeastOne,
  pass: PassOptions,
  groups: GroupOptions,
  finder: Finder,
  vote: Schema.Boolean,
  verify: Schema.Boolean,
  verifyConcurrency: AtLeastOne,
  verifySteps: AtLeastOne,
  budget: ReviewBudget,
  effort: Schema.Struct({ find: Effort, check: Effort }),
  model: Schema.String,
})
export type ReviewOptions = typeof ReviewOptions.Type
