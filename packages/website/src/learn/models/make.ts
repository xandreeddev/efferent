// The one place a browser model is built from its adapter's own generate and
// stream code. What the model was sent is not recorded here: the journal
// holds every request (`plugin.loop.request.sent`), and the context pane
// reads it from there.
import { Effect } from "effect"
import { LanguageModel } from "effect/ai"

type Implementation = Parameters<typeof LanguageModel.make>[0]

export const makeBrowserModel = (impl: Implementation): LanguageModel.LanguageModel =>
  Effect.runSync(LanguageModel.make(impl))
