// Lesson 2's tools.ts: the tools, declared with Effect AI's Tool and
// Toolkit, and what each does when it is called. The learner edits all of
// it; the page runs it as written, and program.test.ts compiles and runs it.

/** Read-only: what the tools import. */
export const TOOLS_IMPORTS = `import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"`

/** Everything before the editable part. */
export const TOOLS_HEADER = `${TOOLS_IMPORTS}\n\n`

/** What the learner edits: the tools and their handlers. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_TOOLS = `// The tools: what each is called, what it does, what it takes and returns.
// Code, like the system text: offered to the model in every call, never stored.
const calculator = Tool.make("calculator", {
  description: "Work out a op b, where op is +, -, * or /.",
  parameters: Schema.Struct({ a: Schema.Number, op: Schema.Literals(["+", "-", "*", "/"]), b: Schema.Number }),
  success: Schema.Number,
  failure: Schema.String,
  // A failure goes back to the model as the tool's answer.
  failureMode: "return",
})

const remember = Tool.make("remember", {
  description: "Save a note, to read later with recall.",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.String,
})

const recall = Tool.make("recall", {
  description: "Read every note saved with remember.",
  success: Schema.Array(Schema.String),
})

export const tools = Toolkit.make(calculator, remember, recall)

// What each tool does when it is called. It runs here, in your browser.
// The notes live in this file, not in the journal: Rebuild runs it again, and they are gone.
const notes = []

export const toolsLive = tools.toLayer({
  calculator: ({ a, op, b }) =>
    op === "/" && b === 0
      ? Effect.fail("cannot divide by zero")
      : Effect.succeed({ "+": a + b, "-": a - b, "*": a * b, "/": a / b }[op]),
  remember: ({ note }) =>
    Effect.sync(() => {
      notes.push(note)
      return \`Saved. \${notes.length} notes so far.\`
    }),
  recall: () => Effect.sync(() => [...notes]),
})`

/** The whole file as the learner reads it. */
export const toolsDocumentOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The same file as a module a test can compile: the notes typed. */
export const toolsModuleOf = (tools: string): string =>
  `${TOOLS_HEADER}${tools.replace("const notes = []", "const notes: Array<string> = []")}\n`

/** The editable part as the page runs it: statements, without \`export\`. */
export const toolsBodyOf = (tools: string): string => tools.replace(/^export /gm, "")
