import { Context } from "effect"
import type { Effect } from "effect"
import type { JournalOpenFailed } from "@xandreed/sdk/node"
import type { PassOptions, PassResult } from "./review-pass.entity.js"
import type { ReviewPrompt } from "./review-prompt.entity.js"
import type { Reviewed } from "./review-tools.entity.js"

/** What one pass is given: its prompt, what its tools read, the folder its journal is kept in, and its options. */
export interface PassInput {
  readonly prompt: ReviewPrompt
  readonly reviewed: Reviewed
  readonly journalDir: string
  readonly options: PassOptions
}

/**
 * The model's passes over a prepared review. `run` runs one pass: a session of its own in a journal kept in
 * `journalDir`, the model asked step by step with the review's tools until it answers without a call, or the pass
 * stops (its step cap, a refused or failed call, an answer cut at the output cap) with the findings so far.
 */
export class ReviewPasses extends Context.Service<ReviewPasses, {
  readonly run: (input: PassInput) => Effect.Effect<PassResult, JournalOpenFailed>
}>()("@xandreed/review/ReviewPasses") {}
