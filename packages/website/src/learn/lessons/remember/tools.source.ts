// Lesson 11's tools.ts: lesson 2's calculator, and the kernel's two tools
// that remember in place of lesson 2's `remember` and `recall` and their
// `notes` array. The text is lesson 2's with named pieces replaced: its two
// note tools go, its toolkit becomes the calculator's merged with the
// kernel's `factTools`, and its handlers are the calculator's alone, since
// what the kernel's two tools do is the kernel's (`factHandlers`, which
// agent.ts provides). program.test.ts checks lesson 2's text still holds each
// piece, compiles this text, and runs it.
import { replaced } from "../base/agent.source.ts"
import { DEFAULT_TOOLS as NOTE_TOOLS, TOOLS_IMPORTS as NOTE_IMPORTS } from "../tools/tools.source.ts"

/**
 * Read-only: what the tools import. `Sessions` and `rememberedFacts` are named in no line as the file starts: the
 * `recall-tool` experiment writes a tool over them, and an experiment edits only the code under the imports.
 */
export const TOOLS_IMPORTS = `${NOTE_IMPORTS}
import { Sessions } from "@xandreed/core/kernel"
import { factTools, rememberedFacts } from "@xandreed/sdk/kernel"`

/** Everything before the editable part. */
export const TOOLS_HEADER = `${TOOLS_IMPORTS}\n\n`

/** Lesson 2's two note tools. */
const NOTE_TOOL_PAIR = `const remember = Tool.make("remember", {
  description: "Save a note, to read later with recall.",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.String,
})

const recall = Tool.make("recall", {
  description: "Read every note saved with remember.",
  success: Schema.Array(Schema.String),
})

`

/** Lesson 2's toolkit. */
const NOTE_TOOLKIT = "export const tools = Toolkit.make(calculator, remember, recall)\n"

/** This lesson's toolkit: the agent's own tool merged with the kernel's two. */
export const TOOLKIT = `// The agent's own tool, and the kernel's two that remember: one toolkit, each tool with its own
// type. rememberFact stores a fact in the memory session, and forgetFact says that one no longer
// stands.
export const tools = Toolkit.merge(Toolkit.make(calculator), factTools)
`

/** Lesson 2's notes, and the start of its handlers. */
const NOTE_HANDLERS_START = `// What each tool does when it is called. It runs here, in your browser.
// The notes live in this file, not in the journal: Rebuild runs it again, and they are gone.
const notes = []

export const toolsLive = tools.toLayer({
`

/** The start of this lesson's handlers: the calculator's alone. */
export const HANDLERS_START = `// What the agent's own tool does when it is called. It runs here, in your browser.
// What the kernel's two tools do is the kernel's: agent.ts provides it, as factHandlers.
export const toolsLive = Toolkit.make(calculator).toLayer({
`

/** Lesson 2's two note handlers. */
const NOTE_HANDLERS = `  remember: ({ note }) =>
    Effect.sync(() => {
      notes.push(note)
      return \`Saved. \${notes.length} notes so far.\`
    }),
  recall: () => Effect.sync(() => [...notes]),
`

/** What this lesson replaces in lesson 2's tools.ts, as `[from, to]`. program.test.ts fails when lesson 2's text no longer holds one. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [NOTE_TOOL_PAIR, ""],
  [NOTE_TOOLKIT, TOOLKIT],
  [NOTE_HANDLERS_START, HANDLERS_START],
  [NOTE_HANDLERS, ""],
]

/** What the learner edits: the calculator, the one toolkit, and the calculator's handler. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_TOOLS = replaced(NOTE_TOOLS, REPLACED)

/** The whole file as the learner reads it. */
export const toolsDocumentOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The same file as a module a test can compile: nothing in it needs a type. */
export const toolsModuleOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const toolsBodyOf = (tools: string): string => tools.replace(/^export /gm, "")
