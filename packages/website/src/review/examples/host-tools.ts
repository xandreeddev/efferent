import { Context, Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import type { ModelSpend } from "@xandreed/core"
import { kernelTurns } from "@xandreed/review"
import type { HostTools } from "@xandreed/review"

// A language server, started once by the host and kept for the whole review. The tool declares it: the handlers are
// made again for every turn and check, so they hold nothing that lives longer.
class LanguageServer extends Context.Service<LanguageServer, {
  readonly definitionOf: (repo: string, at: string, name: string) => Effect.Effect<string, string>
}>()("example/LanguageServer") {}

declare const model: Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend>
declare const languageServer: Layer.Layer<LanguageServer>

// The host's tool: its description and parameters are the host's words, which the model reads. Its answer is one
// line, a file and a line number: a host's tool bounds its own answer, as the six do.
const FindDefinition = Tool.make("findDefinition", {
  description: "Find where a name is defined at the commit under review. Returns its file and line, or says none was found.",
  parameters: Schema.Struct({ name: Schema.String.annotate({ description: "The name to look up, such as reviewPullRequest." }) }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [LanguageServer],
})
const definitionTools = Toolkit.make(FindDefinition)

// The toolkit and its handlers, typed together: handlers without findDefinition's do not compile.
const definitions: HostTools<typeof definitionTools.tools> = {
  toolkit: definitionTools,
  handlers: (reviewed) => definitionTools.toLayer({
    findDefinition: ({ name }) => Effect.flatMap(LanguageServer, (server) => server.definitionOf(reviewed.repo, reviewed.at, name)),
  }),
}

// Every finder turn and check is offered the six tools, then findDefinition. The turns need the language server the
// tool declares, given once here.
export const turns = kernelTurns({ model, hostTools: definitions }).pipe(Layer.provide(languageServer))
