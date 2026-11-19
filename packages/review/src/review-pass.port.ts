import { Context } from "effect"
import type { Effect } from "effect"
import type { PassOptions, PassResult } from "./review-pass.entity.js"
import type { ReviewPrompt } from "./review-prompt.entity.js"
import type { Reviewed } from "./review-tools.entity.js"

/**
 * What one pass is given: its prompt, what its tools read, where its journal is kept (`journalAt`: a place the
 * passes' journal reads, for the stock passes a folder made for it), and its options.
 */
export interface PassInput {
  readonly prompt: ReviewPrompt
  readonly reviewed: Reviewed
  readonly journalAt: string
  readonly options: PassOptions
}

/**
 * The model's passes over a prepared review. `run` runs one pass: a session of its own in a journal kept at
 * `journalAt`, the model asked step by step with the review's tools until it answers without a call, or the pass
 * stops (its step cap, a refused or failed call, an answer cut at the output cap, a journal that fails) with the
 * findings so far. It never fails: how it ended is in its result.
 */
export class ReviewPasses extends Context.Service<ReviewPasses, {
  readonly run: (input: PassInput) => Effect.Effect<PassResult>
}>()("@xandreed/review/ReviewPasses") {}
