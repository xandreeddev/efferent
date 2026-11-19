// Lesson 15's agent.ts is lesson 7's, unchanged: the base program over the
// learner's store. Only its typed module differs, since this lesson's chat.ts
// takes `chosen`, the chat the page asks for, as a parameter of `chatOn`:
// `run` takes it too, and hands it on.
import { replaced } from "../base/agent.source.ts"
import { DEFAULT_AGENT, documentOf, HEADER, IMPORTS, moduleOf as keepModuleOf } from "../keep-the-conversation/agent.source.ts"

export { DEFAULT_AGENT, documentOf, HEADER, IMPORTS }

/** What the typed module replaces in lesson 7's, as `[from, to]`: `chosen` is a parameter of `run`, handed to `chatOn`. */
export const TYPED: ReadonlyArray<readonly [string, string]> = [
  ['import type { Layer } from "effect"', 'import type { Layer, Option } from "effect"\nimport type { SessionId } from "@xandreed/core"'],
  [
    "model: Layer.Layer<LanguageModel.LanguageModel>): Effect.Effect<unknown, unknown> => {",
    "model: Layer.Layer<LanguageModel.LanguageModel>, chosen: Option.Option<SessionId>): Effect.Effect<unknown, unknown> => {",
  ],
  ["  Effect.provide(chatOn(pane)), // the chat pane", "  Effect.provide(chatOn(pane, chosen)), // the chat pane"],
]

/** The same file as a module a test can compile and run: lesson 7's, with `chosen` a parameter of `run`. */
export const moduleOf = (agent: string): string => replaced(keepModuleOf(agent), TYPED)
