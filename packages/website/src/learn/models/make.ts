// The one place a browser model is built from its adapter's own generate and
// stream code. Each answer it streams starts by naming the model, as a
// provider's does, so the kernel's modelAnswer stores which model answered. What the model was sent is not recorded here: the page wraps
// the model it hands the learner's program (learn/runtime.ts) and sees each
// prompt there, so nothing derived is stored in the journal. Offered tools
// reach a model that has no tool calling of its own through the text
// protocol (tool-protocol.ts); Echo handles them itself.
import { Effect, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import { withToolProtocol } from "./tool-protocol.ts"

type Implementation = Parameters<typeof LanguageModel.make>[0]

/** The part a model's answer starts with: the model's name, as `modelAnswer` reads it into the stored answer. */
export const namePart = (name: string): Response.StreamPartEncoded => ({ type: "response-metadata", id: undefined, modelId: name, timestamp: undefined })

/** A model named `name`, from its implementation; offered tools reach it by the text protocol unless it calls them `"native"`ly. */
export const makeBrowserModel = (name: string, impl: Implementation, tools: "text" | "native" = "text"): LanguageModel.LanguageModel => {
  const offered = tools === "text" ? withToolProtocol(impl) : impl
  return Effect.runSync(LanguageModel.make({
    ...offered,
    streamText: (options) => Stream.concat(Stream.make(namePart(name)), offered.streamText(options)),
  }))
}
