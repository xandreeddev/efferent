// Lesson 17's helper.ts: the work of one background task, a `TaskRun` (ADR
// 0018). The kernel's tasks plugin runs it in a session of its own, a child of
// the chat's, on a fiber of the plugin's, while the conversation goes on. It
// is lesson 4's helper agent: a small loop over tools.ts's tools, on the
// kernel's modelAnswer and callTool as the base loop is, a few steps at
// most. Its model is sent only the task's text, the first message of its own
// session; its tools share tools.ts's notes with the chat. Its answer is the
// task's report. As it starts it takes a few seconds first, so a report never lands
// right behind the turn that started it on Echo, which answers at once; the
// `instant` experiment takes the wait out. The page runs the editable text as
// JavaScript; program.test.ts compiles and runs it.

/** Read-only: what the file imports. */
export const HELPER_IMPORTS = `import { Effect } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { userMessage } from "@xandreed/core/kernel"
import { callTool, Memory, modelAnswer } from "@xandreed/sdk/kernel"
import { tools } from "./tools.ts"`

/** Everything before the editable part. */
export const HELPER_HEADER = `${HELPER_IMPORTS}\n\n`

/** The line that declares the helper: the one line its typed module gives types. */
export const DECLARATION = "export const helper = (session, task) =>"

/** The helper's wait, with its comment: the two lines the `instant` experiment takes out. */
export const WAIT = `    // It takes its time, so you can go on chatting while it works.
    yield* Effect.sleep("3 seconds")
`

/** What the learner edits: the helper's system text and its work. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_HELPER = `// The helper's system text: code, sent first in every prompt, never stored.
const helperSystem =
  "You are a helper. Do the task you are given, using a tool when it helps, then answer in one short sentence."

// How many times the helper may call the model for one task before it gives up.
const HELPER_STEPS = 3

// The work of one task. The tasks plugin runs it in a session of its own, a child of the chat's,
// while the conversation goes on. Its model is sent only the task's text, never the conversation:
// the task is the first message of its own session. It uses tools.ts's tools, as the chat's loop
// does, so it shares their notes with the chat. Its answer is the task's report.
${DECLARATION}
  Effect.gen(function* () {
    const memory = yield* Memory
    const model = yield* LanguageModel.LanguageModel
    const toolkit = yield* tools
    yield* session.append(userMessage(task))
${WAIT}    for (let step = 1; step <= HELPER_STEPS; step++) {
      const history = yield* memory.context(session)
      const prompt = Prompt.make([{ role: "system", content: helperSystem }, ...history])
      // modelAnswer reads the stream for the task's turn, and stores the answer in its session.
      const answer = yield* modelAnswer(
        model.streamText({
          prompt,
          toolkit,
          disableToolCallResolution: true,
          toolCallValidation: "deferred",
        }),
        session,
      )
      // No call: the task is done, and this is its answer.
      if (answer.toolCalls.length === 0) return answer.text
      // callTool runs each call in the task's turn and stores its result in the task's session.
      for (const call of answer.toolCalls) {
        yield* callTool(toolkit, call, session)
      }
    }
    return \`I stopped after \${HELPER_STEPS} steps.\`
  })`

/** The whole file as the learner reads it. */
export const helperDocumentOf = (helper: string): string => `${HELPER_HEADER}${helper}\n`

/** The same file as a module a test can compile: the task's session and text typed as a `TaskRun`'s are. */
export const helperModuleOf = (helper: string): string =>
  `${HELPER_IMPORTS}\nimport type { OpenSession } from "@xandreed/core/kernel"\n\n${helper.replace(DECLARATION, "export const helper = (session: OpenSession, task: string) =>")}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const helperBodyOf = (helper: string): string => helper.replace(/^export /gm, "")
