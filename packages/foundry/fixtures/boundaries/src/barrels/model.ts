import { pipe } from "effect/Function"
import { LanguageModel } from "effect/ai"

export const service = pipe(LanguageModel.LanguageModel, (key) => key)
