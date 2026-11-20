import { Schema } from "effect"
import { CallPrice, DEFAULT_GROUP_BOUNDS, DEFAULT_GROUP_RESERVE, DEFAULT_GROUP_STEPS, Focus, GroupBounds, GroupOrder } from "./file-group.entity.js"
import { PrepareOptions } from "./prepare-review.entity.js"
import { Effort } from "./review-model.entity.js"
import { TurnOptions } from "./review-turn.entity.js"
import { Finder } from "./review-prompt.entity.js"
import { ReviewBudget } from "./stage-spend.entity.js"

const AtLeastOne = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * How many finder turns a whole review runs by default: one, until an evaluation shows more find more (on #645 three
 * turns mostly read the same files, at three times the cost).
 */
export const DEFAULT_TURNS = 1

/**
 * What a turn keeps back by default for its closing call, in USD: about what the longest live turn's last request
 * held ($0.09 for 300 KB at 1 byte a token, and 4,096 tokens of output). The review keeps at most half its find
 * stage back across its turns.
 */
export const DEFAULT_CLOSING_RESERVE = 0.1

/** The most model calls one check makes by default: at 6, checks that read four or five files reached it (2026-11-20). */
export const DEFAULT_VERIFY_STEPS = 12

/** How many checks run at once by default. */
export const DEFAULT_VERIFY_CONCURRENCY = 3

/**
 * How a focused review groups and runs: each group's bounds, the most calls a group's turn makes (`steps`), what each
 * keeps back for its closing call (`reserve`, USD, at most half the find stage), the order the groups run in (`order`),
 * and whether the files outside every group but docs get a turn of their own (`config`).
 */
export const GroupOptions = Schema.Struct({ bounds: GroupBounds, steps: AtLeastOne, reserve: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)), order: GroupOrder, config: Schema.Boolean })
export type GroupOptions = typeof GroupOptions.Type

/**
 * The stock focused review: `DEFAULT_GROUP_BOUNDS`, `DEFAULT_GROUP_STEPS` calls a turn, `DEFAULT_GROUP_RESERVE` kept
 * back, riskiest first among the source groups, then the tests' (on the 36 tuning gold cases the first group holding a
 * gold file came at 5.2 on average, against 8.4 in git's order, and within the first seven in 28 against 26), no
 * config turn.
 */
export const DEFAULT_GROUP_OPTIONS: GroupOptions = { bounds: DEFAULT_GROUP_BOUNDS, steps: DEFAULT_GROUP_STEPS, reserve: DEFAULT_GROUP_RESERVE, order: "risk", config: false }

/**
 * What a review is asked: how to prepare the pull request; how its finder turns read it (`focus`: `whole`, `turns`
 * turns over the whole of it, each run as `turn` says; or `groups`, one turn a group of changed files as `groups`
 * says), how they find (`finder`); whether the vote filters the buckets (`vote`, off by default: every bucket goes to
 * the checks); whether the kept buckets are checked (`verify`), how many checks run at once and the most calls one
 * makes; what each stage may spend (`budget`); how hard the model reasons in each stage (`effort`, kept with the
 * record, the host's model layers built from it); the model's id, kept with its record; and what its calls are held at
 * (`price`), from which a focused review sizes each group's first call before it starts it.
 */
export const ReviewOptions = Schema.Struct({
  prepare: PrepareOptions,
  focus: Focus,
  turns: AtLeastOne,
  turn: TurnOptions,
  groups: GroupOptions,
  finder: Finder,
  vote: Schema.Boolean,
  verify: Schema.Boolean,
  verifyConcurrency: AtLeastOne,
  verifySteps: AtLeastOne,
  budget: ReviewBudget,
  effort: Schema.Struct({ find: Effort, check: Effort }),
  model: Schema.String,
  price: CallPrice,
})
export type ReviewOptions = typeof ReviewOptions.Type
