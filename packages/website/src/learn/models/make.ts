// The one place a browser model is built from its adapter's own generate and
// stream code. What the model was sent is not recorded here: the page wraps
// the model it hands the learner's program (learn/runtime.ts) and sees each
// prompt there, so nothing derived is stored in the journal. Offered tools
// reach a model that has no tool calling of its own through the text
// protocol (tool-protocol.ts); Echo handles them itself.
import { Effect } from "effect"
import { LanguageModel } from "effect/ai"
import { withToolProtocol } from "./tool-protocol.ts"

type Implementation = Parameters<typeof LanguageModel.make>[0]

export const makeBrowserModel = (impl: Implementation, tools: "text" | "native" = "text"): LanguageModel.LanguageModel =>
  Effect.runSync(LanguageModel.make(tools === "text" ? withToolProtocol(impl) : impl))
