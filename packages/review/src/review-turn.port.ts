import { Context } from "effect"
import type { Effect } from "effect"
import type { StageLedger } from "./stage-spend.port.js"
import type { TurnOptions, TurnResult } from "./review-turn.entity.js"
import type { ReviewPrompt } from "./review-prompt.entity.js"
import type { Reviewed } from "./review-tools.entity.js"

/**
 * What one turn, a finder's or a check's, is given: its prompt, what its tools read and the stage its calls are made
 * in, where its journal is kept (`journalAt`: a place the turns' journal reads, for the stock turns a folder made for
 * it), its options, the ledger of its stage, which every call it makes is charged to (`spend`), and what to do once its
 * first model call returns (`onFirstAnswer`, given whether it answered, once: also with `false` when the turn ends
 * before any call returned; the review starts its other turns on an answer, once the first has written the provider's
 * cache, and none on a failure), and whether its first call is asked once more after a failure worth another try
 * (`retryFirstCall`; always so when `onFirstAnswer` is given): a focused group's turn, whose group is lost on one blip.
 */
export interface TurnInput {
  readonly prompt: ReviewPrompt
  readonly reviewed: Reviewed
  readonly journalAt: string
  readonly options: TurnOptions
  readonly spend: StageLedger
  readonly onFirstAnswer?: (answered: boolean) => Effect.Effect<void>
  readonly retryFirstCall?: boolean
}

/**
 * The tools a host adds to the review's six, offered after them in every request: their names in the order offered,
 * which a review keeps in its record, and the bytes their declarations add to a request as the reviewer's wire sends
 * them, which a group's first call must have room for. A host that adds none: no names and 0.
 */
export interface HostToolsOffered {
  readonly names: ReadonlyArray<string>
  readonly declarationBytes: number
}

/**
 * The model's turns over a prepared review, the finder's and the checks'. `hostTools` is what each request offers
 * beyond the six (`HostToolsOffered`). `run` runs one: a session of its own in a
 * journal kept at `journalAt`, the model asked step by step with the review's tools until it answers without a call, a
 * check gives its verdict, or it stops (its step cap, after one call that may only report; a refused or failed call, an
 * answer cut at the output cap, a journal that fails) with the findings so far. It never fails: how it ended is in its
 * result. Each call it makes is charged to its stage's ledger and costed alone, so turns may run at once.
 */
export class ReviewTurns extends Context.Service<ReviewTurns, {
  readonly run: (input: TurnInput) => Effect.Effect<TurnResult>
  readonly hostTools: HostToolsOffered
}>()("@xandreed/review/ReviewTurns") {}
