// The one place a browser model is built: it records each request (see
// capture.ts) and then hands it to the adapter's own generate/stream code.
import { Effect } from "effect"
import { LanguageModel } from "effect/ai"
import { record } from "../capture.ts"

type Implementation = Parameters<typeof LanguageModel.make>[0]

export const makeBrowserModel = (impl: Implementation): LanguageModel.LanguageModel =>
  Effect.runSync(LanguageModel.make({
    ...impl,
    generateText: (options) => { record(options.prompt, options.tools); return impl.generateText(options) },
    streamText: (options) => { record(options.prompt, options.tools); return impl.streamText(options) },
  }))
