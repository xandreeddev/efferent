// The base program: lesson 2's agent.ts with its two hand-written blocks
// (reading the model's stream, running a tool call) replaced by the kernel's
// functions, `modelAnswer` and `callTool`. It is no lesson and has no page:
// lessons 3, 5 and 6 derive their agent.ts from this text by replacing named
// pieces, so each shows its own idea over the same short loop.
// program.test.ts checks that lesson 2's text still holds every piece
// replaced here, compiles this text, and runs it beside lesson 2's.
import { DEFAULT_AGENT as TOOLS_AGENT, IMPORTS as TOOLS_IMPORTS } from "../tools/agent.source.ts"

/** Lesson 2's own `runTool`, with its comment: the base has none, `callTool` does its work. */
const RUN_TOOL = `// Run one tool call. A tool that fails, or a call the model got wrong, is an answer too:
// the model reads it and goes on.
const runTool = (toolkit, call) =>
  toolkit.handle(call.name, call.params).pipe(
    Effect.flatMap(Stream.runLast),
    Effect.map(
      Option.match({
        onNone: () => toolResult(call, null),
        onSome: (last) => toolResult(call, last.encodedResult, last.isFailure),
      }),
    ),
    // A failure (the tool's own, an unknown tool, wrong parameters), or a bug in a tool: an answer marked failed.
    Effect.catch((error) => Effect.succeed(toolResult(call, error.message ?? error, true))),
    Effect.catchDefect((defect) => Effect.succeed(toolResult(call, String(defect), true))),
  )

`

/** Lesson 2's block that calls the model: it reads the stream, joins the text, keeps the calls and stores the answer. */
const READ_BY_HAND = `        // Offer the tools, but run none: this loop runs the calls. A call the model got wrong
        // comes through as it is ("deferred"), so it can be answered as a failure.
        const parts = yield* model
          .streamText({
            prompt,
            toolkit,
            disableToolCallResolution: true,
            toolCallValidation: "deferred",
          })
          .pipe(
            Stream.tap((part) => (part.type === "error" ? Effect.fail(part.error) : Effect.void)),
            Stream.tap((part) =>
              part.type === "text-delta" ? chat.stream(part.delta) : Effect.void,
            ),
            Stream.runCollect,
          )
        const text = parts
          .filter((part) => part.type === "text-delta")
          .map((part) => part.delta)
          .join("")
        const calls = parts.filter((part) => part.type === "tool-call")

        // Store the answer with the calls it made. No call: the turn is done.
        yield* session.append(assistantMessage(text, { toolCalls: calls }))
        if (calls.length === 0) return text
`

/** The same step with the kernel's function. */
const MODEL_ANSWER = `        // Ask the model, with the tools offered but not run: this loop runs the calls. A call the
        // model got wrong comes through as it is ("deferred"), so it can be answered as a failure.
        // modelAnswer reads the stream for this turn: it shows each piece as it arrives, and stores
        // the answer with the calls it made and what it cost.
        const answer = yield* modelAnswer(
          model.streamText({
            prompt,
            toolkit,
            disableToolCallResolution: true,
            toolCallValidation: "deferred",
          }),
          session,
          { onText: (piece) => chat.stream(piece) },
        )
        // No call: the turn is done.
        if (answer.toolCalls.length === 0) return answer.text
`

/** Lesson 2's block that runs each call through its own `runTool` and stores the result. */
const RUN_BY_HAND = `        // Run each call, and store its result.
        for (const call of calls) {
          yield* chat.status(\`step \${step}: \${call.name}\`)
          const result = yield* runTool(toolkit, call)
          yield* session.append(result)
        }
`

/** The same step with the kernel's function. */
const CALL_TOOL = `        // callTool runs each call in this turn and stores its result. A tool that fails, or a call
        // the model got wrong, is an answer too: the model reads it and goes on.
        for (const call of answer.toolCalls) {
          yield* chat.status(\`step \${step}: \${call.name}\`)
          yield* callTool(toolkit, call, session)
        }
`

/** What the kernel's two functions replace in lesson 2's program, as `[from, to]`: each `from` is in lesson 2's text once. */
export const KERNEL_FUNCTIONS: ReadonlyArray<readonly [string, string]> = [
  [RUN_TOOL, ""],
  [READ_BY_HAND, MODEL_ANSWER],
  [RUN_BY_HAND, CALL_TOOL],
]

/** What changes in lesson 2's imports, as `[from, to]`: the names the hand-written blocks used go, the two functions come. */
export const KERNEL_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  ['import { Effect, Option, Stream } from "effect"', 'import { Effect, Stream } from "effect"'],
  [
    'import { assistantMessage, Core, kernel, Sessions, toolResult, turnStartedEvent, userMessage } from "@xandreed/core/kernel"',
    'import { Core, kernel, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"',
  ],
  [
    'import { inProcessJournal, Memory, sessions } from "@xandreed/sdk/kernel"',
    'import { callTool, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
  ],
]

/**
 * A text with named pieces replaced, each `from` by its `to`, in order. A lesson that derives its text with this
 * has a test that the text it starts from holds every `from`: a piece that is missing would be left as it was,
 * and the lesson would show the wrong program.
 */
export const replaced = (text: string, pairs: ReadonlyArray<readonly [string, string]>): string =>
  pairs.reduce((all, [from, to]) => all.replace(from, to), text)

/** Lesson 2's program on the kernel's two functions. */
export const withKernelFunctions = (agent: string): string => replaced(agent, KERNEL_FUNCTIONS)

/** Read-only: what the base program imports. */
export const IMPORTS = replaced(TOOLS_IMPORTS, KERNEL_IMPORTS)

/** The base program: what lessons 3, 5 and 6 start from. */
export const BASE_AGENT = withKernelFunctions(TOOLS_AGENT)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as a learner would read it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * A program on the base as a module a test can compile and run, under the imports given: the turn's message is
 * typed, and `pane` and `model` are the parameters of `run`, which returns `main`. With the kernel's functions
 * nothing else needs a type: there is no call or toolkit to annotate, and no cast.
 */
export const typedModule = (imports: string, agent: string): string => `${imports.replace('import { Chat, chatOn } from "./chat.ts"', 'import { Chat, chatOn } from "./chat.ts"\nimport type { ChatPane } from "./chat.ts"')}
import type { Layer } from "effect"

export const run = (pane: ChatPane, model: Layer.Layer<LanguageModel.LanguageModel>) => {
${agent.replace("const turn = (message) =>", "const turn = (message: string) =>")}
  return main
}
`

/** The base program as a module a test can compile and run. */
export const moduleOf = (agent: string): string => typedModule(IMPORTS, agent)
