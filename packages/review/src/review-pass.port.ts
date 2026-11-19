import { Context } from "effect"
import type { Effect } from "effect"
import type { ModelSpend } from "@xandreed/core"
import type { PassOptions, PassResult } from "./review-pass.entity.js"
import type { ReviewPrompt } from "./review-prompt.entity.js"
import type { Reviewed } from "./review-tools.entity.js"

/**
 * What one pass or check is given: its prompt, what its tools read and the stage its calls are made in, where its
 * journal is kept (`journalAt`: a place the passes' journal reads, for the stock passes a folder made for it), its
 * options, the ledger of its stage, which every call it makes is charged to (`spend`), and what to do once its first
 * model call returns, answered or failed (`onFirstAnswer`: the review starts its other passes then, once the first has
 * written the provider's cache).
 */
export interface PassInput {
  readonly prompt: ReviewPrompt
  readonly reviewed: Reviewed
  readonly journalAt: string
  readonly options: PassOptions
  readonly spend: Context.Service.Shape<typeof ModelSpend>
  readonly onFirstAnswer?: Effect.Effect<void>
}

/**
 * The model's passes and checks over a prepared review. `run` runs one: a session of its own in a journal kept at
 * `journalAt`, the model asked step by step with the review's tools until it answers without a call, a check gives its
 * verdict, or it stops (its step cap, after one call that may only report; a refused or failed call, an answer cut at
 * the output cap, a journal that fails) with the findings so far. It never fails: how it ended is in its result. Each
 * call it makes is charged to its stage's ledger and costed alone, so passes and checks may run at once.
 */
export class ReviewPasses extends Context.Service<ReviewPasses, {
  readonly run: (input: PassInput) => Effect.Effect<PassResult>
}>()("@xandreed/review/ReviewPasses") {}
