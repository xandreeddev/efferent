// Lesson 6's tools.ts: lesson 2's calculator, and `show`, a tool that shows
// the user a table. Its handler appends a view in the turn its call runs in
// and publishes progress on Core; what it returns to the model is a few words.

/** Read-only: what the tools import. */
export const TOOLS_IMPORTS = `import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Core } from "@xandreed/core/kernel"
import { CurrentTurn, showView, ViewData, viewProgress } from "@xandreed/sdk/kernel"`

/** Everything before the editable part. */
export const TOOLS_HEADER = `${TOOLS_IMPORTS}\n\n`

/** What the learner edits: the tools and their handlers. */
export const DEFAULT_TOOLS = `// The tools: what each is called, what it does, what it takes and returns.
// Code, like the system text: offered to the model in every call, never stored.
const calculator = Tool.make("calculator", {
  description: "Work out a op b, where op is +, -, * or /.",
  parameters: Schema.Struct({ a: Schema.Number, op: Schema.Literals(["+", "-", "*", "/"]), b: Schema.Number }),
  success: Schema.Number,
  failure: Schema.String,
  failureMode: "return",
})

const show = Tool.make("show", {
  description: "Show the user a table. Give it an id: showing again under the same id replaces it.",
  parameters: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    columns: Schema.Array(Schema.String),
    rows: Schema.Array(Schema.Array(Schema.String)),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
  // What its handler needs: the turn its call runs in, to store the view, and Core, to publish progress.
  dependencies: [CurrentTurn, Core],
})

export const tools = Toolkit.make(calculator, show)

export const toolsLive = tools.toLayer({
  calculator: ({ a, op, b }) =>
    op === "/" && b === 0
      ? Effect.fail("cannot divide by zero")
      : Effect.succeed({ "+": a + b, "-": a - b, "*": a * b, "/": a / b }[op]),
  show: ({ id, title, columns, rows }) =>
    Effect.gen(function* () {
      const session = yield* CurrentTurn
      const core = yield* Core
      // The view is checked as it is built: a row with the wrong number of cells goes back to the model as a failure.
      const shown = yield* Schema.decodeUnknownEffect(ViewData)({ id, view: { _tag: "Table", title, columns, rows } }).pipe(
        Effect.mapError((error) => error.message),
      )
      // Fill it row by row, as slow work would, and say how far it got: live, for whoever watches, never stored.
      for (let done = 1; done <= rows.length; done++) {
        yield* Effect.orDie(core.publish(viewProgress(session, shown.id, done, rows.length)))
      }
      // Store the view in the journal, tagged ui. No memory sends it: the model never sees the table.
      yield* Effect.orDie(session.append(showView(shown.id, shown.view)))
      // What the model reads instead: a few words.
      return \`shown as \${id}\`
    }),
})`

/** The whole file as the learner reads it. */
export const toolsDocumentOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The same file as a module a test can compile. */
export const toolsModuleOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The file as the page runs it: its statements, without `export`. */
export const toolsBodyOf = (tools: string): string => tools.replace(/^export /gm, "")
