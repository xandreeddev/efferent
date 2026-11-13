// The one place a browser model is built from its adapter's own generate and
// stream code. What the model was sent is not recorded here: the page wraps
// the model it hands the learner's program (learn/runtime.ts) and sees each
// prompt there, so nothing derived is stored in the journal.
import { Effect } from "effect"
import { LanguageModel } from "effect/ai"

type Implementation = Parameters<typeof LanguageModel.make>[0]

export const makeBrowserModel = (impl: Implementation): LanguageModel.LanguageModel =>
  Effect.runSync(LanguageModel.make(impl))
