// The one source of truth for lesson 12's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool) with one change: `program`
// is exported, so a check runs the program `main` runs. Nothing in the loop,
// the boot hook or `main` changes, and the imports are the base's. The page
// shows IMPORTS (read-only, folded) above the code the learner edits;
// program.test.ts compiles and runs this exact text.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced } from "../base/agent.source.ts"

/** The base's declaration of the program, with its comment. */
const PROGRAM = `// The program: it runs as long as the page is open.
const program = Effect.scoped(
`

/** This lesson's: the same program, exported. */
export const EXPORTED = `// The program: it runs as long as the page is open. It is exported, so checks.ts runs the same
// program that main runs.
export const program = Effect.scoped(
`

/** What this lesson replaces in the base's program, as `[from, to]`. program.test.ts fails when the base no longer holds it. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [[PROGRAM, EXPORTED]]

/** Read-only: what the program imports. The base's, unchanged. */
export const IMPORTS = BASE_IMPORTS

/** What the learner edits: the base program, with `program` exported. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const agentBodyOf = (agent: string): string => agent.replace(/^export /gm, "")

/** Where `main` starts in the program's text: the comment above it. Everything before it is the program a check runs too. */
export const RUN_IT = "// Run it: give the program the modules it asks for."

/**
 * The same file as a module a test can compile and run. The base's typed module puts the whole text inside `run`,
 * where nothing can be exported; here everything above `main` stays at the module's top, so checks.ts imports
 * `program` from it, and `main` alone is inside `run`, whose parameters are `pane` and `model`. `run` states that
 * its program needs nothing more, as the base's does. The turn's message is the one line that takes a type. The
 * text is cut at the comment above `main` (`RUN_IT`), which the starter text and every experiment's text hold: a
 * text without it has no typed module.
 */
export const moduleOf = (agent: string): string => {
  const at = agent.indexOf(RUN_IT)
  return `${IMPORTS.replace('import { Chat, chatOn } from "./chat.ts"', 'import { Chat, chatOn } from "./chat.ts"\nimport type { ChatPane } from "./chat.ts"')}
import type { Layer } from "effect"

${agent.slice(0, at).replace("const turn = (message) =>", "const turn = (message: string) =>")}export const run = (pane: ChatPane, model: Layer.Layer<LanguageModel.LanguageModel>): Effect.Effect<unknown, unknown> => {
${agent.slice(at)}
  return main
}
`
}
