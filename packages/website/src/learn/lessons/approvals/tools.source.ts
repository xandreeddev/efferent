// Lesson 9's tools.ts: lesson 2's three tools and one more, `forget`, which
// deletes every note and asks a person first. Everything is lesson 2's text
// with named pieces replaced: its imports gain the three names a tool that
// asks uses, the toolkit gains the tool, and the handlers gain its handler,
// whose first line is the question. program.test.ts checks lesson 2's text
// still holds each piece, compiles this text and runs it.
import { replaced } from "../base/agent.source.ts"
import { DEFAULT_TOOLS as FIRST_TOOLS, TOOLS_IMPORTS as FIRST_IMPORTS } from "../tools/tools.source.ts"

const FIRST_AI = 'import { Tool, Toolkit } from "effect/ai"'

/** What this lesson replaces in lesson 2's imports, as `[from, to]`: the contract, the function that asks, and the turn. */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  [FIRST_AI, `${FIRST_AI}\nimport { Approval, approve, CurrentTurn } from "@xandreed/sdk"`],
]

/** Read-only: what the tools import. */
export const TOOLS_IMPORTS = replaced(FIRST_IMPORTS, REPLACED_IMPORTS)

/** Everything before the editable part. */
export const TOOLS_HEADER = `${TOOLS_IMPORTS}\n\n`

const FIRST_TOOLKIT = "export const tools = Toolkit.make(calculator, remember, recall)\n"

/** The tool this lesson adds, and the toolkit with it. */
export const FORGET = `// forget deletes every note. That should not happen on a model's word alone, so it asks first.
const forget = Tool.make("forget", {
  description: "Delete every note saved with remember.",
  success: Schema.String,
  failure: Schema.String,
  // A refusal goes back to the model as the tool's answer.
  failureMode: "return",
  // A tool that asks declares who it asks, and the turn it asks in.
  dependencies: [Approval, CurrentTurn],
})

export const tools = Toolkit.make(calculator, remember, recall, forget)
`

const FIRST_LAST_HANDLER = "  recall: () => Effect.sync(() => [...notes]),\n})"

/** The comment and the line that ask: what the `no-ask` experiment takes out. */
export const ASK = `      // Nothing below this line runs unless the answer is yes.
      yield* approve({ action: "notes.forget", detail: \`Delete all \${notes.length} notes.\` })
`

/** The handler of `forget`: the question first, then the work. */
export const FORGET_HANDLER = `  forget: () =>
    Effect.gen(function* () {
${ASK}      const count = notes.splice(0).length
      return \`Deleted \${count} notes.\`
    }),
`

/** What this lesson replaces in lesson 2's tools, as `[from, to]`: the tool with the toolkit, and its handler. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [FIRST_TOOLKIT, FORGET],
  [FIRST_LAST_HANDLER, `  recall: () => Effect.sync(() => [...notes]),\n${FORGET_HANDLER}})`],
]

/** What the learner edits: lesson 2's tools and handlers, and `forget`. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_TOOLS = replaced(FIRST_TOOLS, REPLACED)

/** The whole file as the learner reads it. */
export const toolsDocumentOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The same file as a module a test can compile: the notes typed, as lesson 2's are. */
export const toolsModuleOf = (tools: string): string =>
  `${TOOLS_HEADER}${tools.replace("const notes = []", "const notes: Array<string> = []")}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const toolsBodyOf = (tools: string): string => tools.replace(/^export /gm, "")
