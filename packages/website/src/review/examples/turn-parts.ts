import type { Layer, Redacted } from "effect"
import type { LanguageModel } from "effect/ai"
import type { ModelSpend } from "@xandreed/core"
import { flatMemory, inProcessJournal } from "@xandreed/sdk"
import { DEFAULT_REVIEW_MODEL, kernelTurns, reviewModel, reviewToolHandlers } from "@xandreed/review"

declare const apiKey: Redacted.Redacted<string>
declare const maxCost: number
// Any LanguageModel layer that charges the ledger it is given: another provider's, a scripted one for tests.
declare const checksModel: Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend>

// The stock turn with three of its parts swapped: the checks ask a model of their own, the memory and tools are the
// stock ones named out loud, and each turn's journal is kept in the process instead of a folder on disk.
export const turns = kernelTurns({
  model: reviewModel(DEFAULT_REVIEW_MODEL, apiKey, maxCost),
  verifyModel: checksModel,
  memory: flatMemory,
  tools: reviewToolHandlers,
  journal: () => inProcessJournal(),
})
