// The one source of truth for lesson 20's agent.ts: lesson 18's program, with
// two changes, none of them in the loop. The memory memory.ts makes needs an
// embedder and a store of vectors: main gives it the page's, which the page
// builds once and hands over as values, as it hands over the model, and the
// comment on what the page gives says so. The text is lesson 18's with named
// pieces replaced; program.test.ts checks lesson 18's text still holds each,
// and compiles and runs this exact text.
import { replaced, typedModule } from "../base/agent.source.ts"
import { DEFAULT_AGENT as WORDS_AGENT, IMPORTS, MEMORY_LINE, PAGE_GIVES_CURATOR } from "../connected-memory/agent.source.ts"

export { IMPORTS }

/** This lesson's comment on what the page gives: the embedder and its store too. */
export const PAGE_GIVES_MEANING = `${PAGE_GIVES_CURATOR}// So do \`embedder\`, the model that turns a text into numbers, loaded by its button, and
// \`vectors\`, where the numbers of each memory are kept.
`

/** main's line for memory.ts's memory, and the two lines that give it what it needs. */
export const MEMORY_LINES = `${MEMORY_LINE}  Effect.provide(embedder), // a text to numbers: the page's model, once its button has loaded it
  Effect.provide(vectors), // the numbers of each memory: an index of the knowledge session
`

/** What this lesson replaces in lesson 18's program, as `[from, to]`. program.test.ts fails when lesson 18's text no longer holds one. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [PAGE_GIVES_CURATOR, PAGE_GIVES_MEANING],
  [MEMORY_LINE, MEMORY_LINES],
]

/** What the learner edits: lesson 18's program, its memory given the page's embedder and vectors. */
export const DEFAULT_AGENT = replaced(WORDS_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run, as lesson 18's: `run` states that its program needs nothing
 * more, so a program that leaves out the embedder or the store does not compile. The curator's model, the embedder
 * and the store are the page's, parameters of `run` beside the model picked.
 */
export const moduleOf = (agent: string): string =>
  typedModule(IMPORTS, agent).replace(
    "export const run = (pane: ChatPane, model: Layer.Layer<LanguageModel.LanguageModel>): Effect.Effect<unknown, unknown> => {",
    "import type { Embedder, VectorStore } from \"@xandreed/sdk\"\n\nexport const run = (pane: ChatPane, model: Layer.Layer<LanguageModel.LanguageModel>, curatorModel: Layer.Layer<LanguageModel.LanguageModel>, embedder: Layer.Layer<Embedder>, vectors: Layer.Layer<VectorStore>): Effect.Effect<unknown, unknown> => {",
  )
