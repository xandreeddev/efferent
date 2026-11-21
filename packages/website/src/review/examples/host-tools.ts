import { Schema } from "effect"
import type { Effect, Layer } from "effect"
import { Tool, Toolkit } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import type { ModelSpend } from "@xandreed/core"
import { kernelTurns } from "@xandreed/review"
import type { HostTools } from "@xandreed/review"

declare const model: Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend>
// The host's own lookup, such as a language server's, at a commit of a repository.
declare const definitionOf: (repo: string, at: string, name: string) => Effect.Effect<string, string>

// The host's tool: its description and parameters are the host's words, which the model reads.
const FindDefinition = Tool.make("findDefinition", {
  description: "Find where a name is defined at the commit under review. Returns its file and line, or says none was found.",
  parameters: Schema.Struct({ name: Schema.String.annotate({ description: "The name to look up, such as reviewPullRequest." }) }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})
const definitionTools = Toolkit.make(FindDefinition)

// The toolkit and its handlers, typed together: handlers without findDefinition's do not compile.
const definitions: HostTools<typeof definitionTools.tools> = {
  toolkit: definitionTools,
  handlers: (reviewed) => definitionTools.toLayer({
    findDefinition: ({ name }) => definitionOf(reviewed.repo, reviewed.at, name),
  }),
}

// Every finder turn and check is offered the six tools, then findDefinition.
export const turns = kernelTurns({ model, hostTools: definitions })
