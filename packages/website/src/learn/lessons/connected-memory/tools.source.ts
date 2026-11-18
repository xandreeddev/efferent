// Lesson 18's tools.ts: lesson 2's calculator alone, with no tool that
// remembers. What the agent knows is kept by the curator after each turn
// (curator.ts) and sent with each request by memory.ts, so the model calls no
// tool to store or to read it. The text is lesson 11's with named pieces
// replaced: its toolkit is the calculator's alone, and so are its handlers.
// program.test.ts checks lesson 11's text still holds each piece, compiles
// this text, and runs it.
import { replaced } from "../base/agent.source.ts"
import { DEFAULT_TOOLS as FACT_TOOLS, HANDLERS_START as FACT_HANDLERS_START, TOOLKIT as FACT_TOOLKIT } from "../remember/tools.source.ts"
import { TOOLS_IMPORTS as NOTE_IMPORTS } from "../tools/tools.source.ts"

/** Read-only: what the tools import. Lesson 2's, and nothing of the kernel's. */
export const TOOLS_IMPORTS = NOTE_IMPORTS

/** Everything before the editable part. */
export const TOOLS_HEADER = `${TOOLS_IMPORTS}\n\n`

/** This lesson's toolkit: the agent's one tool. */
export const TOOLKIT = `// The agent's one tool. No tool remembers anything: what the agent knows is kept by the curator
// after each turn (curator.ts), and memory.ts sends it with each request.
export const tools = Toolkit.make(calculator)
`

/** The start of this lesson's handlers. */
export const HANDLERS_START = `// What the tool does when it is called. It runs here, in your browser.
export const toolsLive = tools.toLayer({
`

/** What this lesson replaces in lesson 11's tools.ts, as `[from, to]`. program.test.ts fails when lesson 11's text no longer holds one. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [FACT_TOOLKIT, TOOLKIT],
  [FACT_HANDLERS_START, HANDLERS_START],
]

/** What the learner edits: the calculator, its toolkit and its handler. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_TOOLS = replaced(FACT_TOOLS, REPLACED)

/** The whole file as the learner reads it. */
export const toolsDocumentOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The same file as a module a test can compile: nothing in it needs a type. */
export const toolsModuleOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const toolsBodyOf = (tools: string): string => tools.replace(/^export /gm, "")
