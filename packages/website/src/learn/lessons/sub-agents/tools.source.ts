// The one source of truth for lesson 4's tools.ts: the helper's tools, and
// the chat's, which add delegate. delegate needs a helper, declared here as a
// contract (Helper) and provided by main, and the turn its call runs in
// (`CurrentTurn`), whose session it hands the helper as the one that asks
// (ADR 0006). The page runs this text as written; program.test.ts compiles
// and runs it.

/** Read-only: what the tools import. */
export const TOOLS_IMPORTS = `import { Context, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { CurrentTurn } from "@xandreed/sdk/kernel"`

/** Everything before the editable part. */
export const TOOLS_HEADER = `${TOOLS_IMPORTS}\n\n`

/** What the learner edits. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_TOOLS = `const calculator = Tool.make("calculator", {
  description: "Work out a op b, where op is +, -, * or /.",
  parameters: Schema.Struct({
    a: Schema.Number,
    op: Schema.Literals(["+", "-", "*", "/"]),
    b: Schema.Number,
  }),
  success: Schema.Number,
  failure: Schema.String,
  failureMode: "return",
})

// Hand a task to a helper. Its answer comes back with the session it worked in.
const delegate = Tool.make("delegate", {
  description:
    "Hand a task to a helper agent. It works in a session of its own and returns only its answer.",
  parameters: Schema.Struct({ task: Schema.String }),
  success: Schema.Struct({ answer: Schema.String, session: Schema.String }),
  failure: Schema.String,
  failureMode: "return",
  // What its handler needs: the turn its call runs in. The helper works under that turn's session.
  dependencies: [CurrentTurn],
})

// What delegate needs: a helper that takes a task, and the session that asks, and answers it.
// A contract: main provides one.
export class Helper extends Context.Service()("lesson/Helper") {}

// The helper's tools, and the chat's: the helper's, and delegate.
export const helperTools = Toolkit.make(calculator)
const delegating = Toolkit.make(delegate)
export const tools = Toolkit.merge(helperTools, delegating)

export const helperToolsLive = helperTools.toLayer({
  calculator: ({ a, op, b }) =>
    op === "/" && b === 0
      ? Effect.fail("cannot divide by zero")
      : Effect.succeed({ "+": a + b, "-": a - b, "*": a * b, "/": a / b }[op]),
})

// delegate asks the helper main provides, and tells it which session is asking.
export const delegateLive = delegating.toLayer(
  Effect.gen(function* () {
    const helper = yield* Helper
    return {
      delegate: ({ task }) =>
        Effect.gen(function* () {
          // The turn this call runs in: the loop's callTool gives it to the handler.
          const turn = yield* CurrentTurn
          return yield* helper.ask(task, turn.id)
        }),
    }
  }),
)`

/** The whole file as the learner reads it. */
export const toolsDocumentOf = (tools: string): string => `${TOOLS_HEADER}${tools}\n`

/** The same file as a module a test can compile: the contract's shape written out. */
export const toolsModuleOf = (tools: string): string => `${TOOLS_IMPORTS}\nimport type { SessionId } from "@xandreed/core/kernel"\n\n${tools.replace(
  'export class Helper extends Context.Service()("lesson/Helper") {}',
  'export class Helper extends Context.Service<Helper, {\n  readonly ask: (task: string, parent: SessionId) => Effect.Effect<{ readonly answer: string; readonly session: string }, string>\n}>()("lesson/Helper") {}',
)}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const toolsBodyOf = (tools: string): string => tools.replace(/^export /gm, "")
