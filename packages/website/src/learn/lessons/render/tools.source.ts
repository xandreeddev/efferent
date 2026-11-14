// Lesson 6's tools.ts: lesson 2's calculator, and `show`, a tool that shows
// the user a table. Its handler appends a view in the turn its call runs in
// and publishes progress through it; what it returns to the model is a few words.

/** Read-only: what the tools import. */
export const TOOLS_IMPORTS = `import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { CurrentTurn, progressEvent, showView, ViewData, ViewId } from "@xandreed/sdk/kernel"`

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
  description: "Show the user a table: the squares or cubes from 1 to n, or the times table of n. Give it an id: showing again under that id replaces it.",
  parameters: Schema.Struct({
    id: ViewId,
    table: Schema.Literals(["squares", "cubes", "times"]),
    n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
  // What its handler needs: the turn its call runs in, to store the view and to publish progress.
  dependencies: [CurrentTurn],
})

// What each kind of table holds: its title, its columns, and its row for i.
const kinds = {
  squares: (n) => ({ title: \`Squares to \${n}\`, columns: ["n", "n²"], row: (i) => [String(i), String(i * i)], rows: n }),
  cubes: (n) => ({ title: \`Cubes to \${n}\`, columns: ["n", "n³"], row: (i) => [String(i), String(i ** 3)], rows: n }),
  times: (n) => ({ title: \`The times table of \${n}\`, columns: ["sum", "answer"], row: (i) => [\`\${i} × \${n}\`, String(i * n)], rows: 10 }),
}

export const tools = Toolkit.make(calculator, show)

export const toolsLive = tools.toLayer({
  calculator: ({ a, op, b }) =>
    op === "/" && b === 0
      ? Effect.fail("cannot divide by zero")
      : Effect.succeed({ "+": a + b, "-": a - b, "*": a * b, "/": a / b }[op]),
  show: ({ id, table, n }) =>
    Effect.gen(function* () {
      const session = yield* CurrentTurn
      const { title, columns, row, rows: count } = kinds[table](n)
      // The model asked in a few words; the rows are this tool's own work, and the model never sees them.
      const rows = []
      for (let i = 1; i <= count; i++) {
        rows.push(row(i))
        // How far it got: live, for whoever watches, never stored.
        yield* Effect.orDie(session.publish(progressEvent, { id, done: i, total: count }))
      }
      // The view is checked as it is built, then stored in the journal, tagged ui. No memory sends it.
      const shown = yield* Schema.decodeUnknownEffect(ViewData)({ id, view: { _tag: "Table", title, columns, rows } }).pipe(
        Effect.mapError((error) => error.message),
      )
      yield* Effect.orDie(session.append(showView(shown.id, shown.view)))
      // What the model reads: a few words.
      return \`shown as \${id}\`
    }),
})`

/** The whole file as the learner reads it. */
export const toolsDocumentOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The same file as a module a test can compile: the table kinds and the rows typed. */
export const toolsModuleOf = (tools: string): string => `${TOOLS_HEADER}${tools
  .replace("const kinds = {", "type Kind = { title: string; columns: Array<string>; row: (i: number) => Array<string>; rows: number }\nconst kinds: Record<\"squares\" | \"cubes\" | \"times\", (n: number) => Kind> = {")
  .replace("(n) => ({", "(n: number) => ({").replace("(n) => ({", "(n: number) => ({").replace("(n) => ({", "(n: number) => ({")
  .replace("row: (i) =>", "row: (i: number) =>").replace("row: (i) =>", "row: (i: number) =>").replace("row: (i) =>", "row: (i: number) =>")
  .replace("const rows = []", "const rows: Array<Array<string>> = []")}\n`

/** The file as the page runs it: its statements, without `export`. */
export const toolsBodyOf = (tools: string): string => tools.replace(/^export /gm, "")
