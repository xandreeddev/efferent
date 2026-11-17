// Lesson 18's tools.ts: lesson 2's calculator, and the kernel's three tools
// of the graph, as lesson 11's tools.ts merges the two that remember. The
// text is lesson 11's with named pieces replaced: its toolkit becomes the
// calculator's merged with the kernel's `graphTools`, and the comment over
// its handlers names the graph's handlers (`graphHandlers`, which agent.ts
// provides). program.test.ts checks lesson 11's text still holds each piece,
// compiles this text, and runs it.
import { replaced } from "../base/agent.source.ts"
import { DEFAULT_TOOLS as FACT_TOOLS, HANDLERS_START as FACT_HANDLERS_START, TOOLKIT as FACT_TOOLKIT } from "../remember/tools.source.ts"
import { TOOLS_IMPORTS as NOTE_IMPORTS } from "../tools/tools.source.ts"

/** Read-only: what the tools import. Lesson 2's, and the kernel's three tools of the graph. */
export const TOOLS_IMPORTS = `${NOTE_IMPORTS}
import { graphTools } from "@xandreed/sdk/kernel"`

/** Everything before the editable part. */
export const TOOLS_HEADER = `${TOOLS_IMPORTS}\n\n`

/** This lesson's toolkit: the agent's own tool merged with the kernel's three. */
export const TOOLKIT = `// The agent's own tool, and the kernel's three of the graph: one toolkit, each tool with its own
// type. linkThings stores a link between two things in the graph session, unlinkThings says that
// one no longer stands, and followThings reads the links of one thing.
export const tools = Toolkit.merge(Toolkit.make(calculator), graphTools)
`

/** The start of this lesson's handlers: the calculator's alone. */
export const HANDLERS_START = `// What the agent's own tool does when it is called. It runs here, in your browser.
// What the kernel's three tools do is the kernel's: agent.ts provides it, as graphHandlers.
export const toolsLive = Toolkit.make(calculator).toLayer({
`

/** What this lesson replaces in lesson 11's tools.ts, as `[from, to]`. program.test.ts fails when lesson 11's text no longer holds one. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [FACT_TOOLKIT, TOOLKIT],
  [FACT_HANDLERS_START, HANDLERS_START],
]

/** What the learner edits: the calculator, the one toolkit, and the calculator's handler. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_TOOLS = replaced(FACT_TOOLS, REPLACED)

/** The whole file as the learner reads it. */
export const toolsDocumentOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The same file as a module a test can compile: nothing in it needs a type. */
export const toolsModuleOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const toolsBodyOf = (tools: string): string => tools.replace(/^export /gm, "")
