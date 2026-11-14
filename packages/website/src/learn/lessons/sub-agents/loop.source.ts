// The one source of truth for lesson 4's loop.ts: lesson 2's loop on the
// kernel's two functions (modelAnswer, callTool), as a function of the agent
// it runs (its system text, its tools, its hooks) and the session it runs
// in, so the chat and its helper run the same loop. Its shape differs from
// the base program's, so it is a text of its own, not derived. The page
// shows the imports (read-only) above the code, and runs it as written;
// program.test.ts compiles and runs this exact text.

/** Read-only: what the loop imports. */
export const LOOP_IMPORTS = `import { Effect } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { userMessage } from "@xandreed/core/kernel"
import { callTool, Memory, modelAnswer } from "@xandreed/sdk/kernel"`

/** Everything before the editable part. */
export const LOOP_HEADER = `${LOOP_IMPORTS}\n\n`

/** What the learner edits: the loop. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_LOOP = `// How many times one turn may call the model before it gives up.
const MAX_STEPS = 5

// One turn of an agent, in the session it is given: lesson 2's loop.
// The agent is its system text, its tools, and its hooks: where its words go, its status, its steers.
export const runAgent = (agent) => (session, messages) =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const model = yield* LanguageModel.LanguageModel
    for (const text of messages) {
      yield* session.append(userMessage(text))
    }

    for (let step = 1; step <= MAX_STEPS; step++) {
      const history = yield* memory.context(session)
      const prompt = Prompt.make([{ role: "system", content: agent.system }, ...history])

      // modelAnswer reads the model's stream for this turn: each piece goes where the agent's
      // hooks send it, and the answer is stored with the calls it made.
      const answer = yield* modelAnswer(
        model.streamText({
          prompt,
          toolkit: agent.toolkit,
          disableToolCallResolution: true,
          toolCallValidation: "deferred",
        }),
        session,
        { onText: agent.hooks.stream },
      )
      if (answer.toolCalls.length === 0) return answer.text

      // callTool runs each call in this turn and stores its result. A failure, or a call the
      // model got wrong, is an answer too.
      for (const call of answer.toolCalls) {
        yield* agent.hooks.status(\`step \${step}: \${call.name}\`)
        yield* callTool(agent.toolkit, call, session)
      }

      // Messages sent meanwhile steer it, if its hooks have any to give.
      if (step < MAX_STEPS) {
        for (const steer of yield* agent.hooks.drain) {
          yield* session.append(userMessage(steer))
        }
      }
    }
    return \`I stopped after \${MAX_STEPS} steps.\`
  })`

/** The whole file as the learner reads it. */
export const loopDocumentOf = (loop: string): string => `${LOOP_HEADER}${loop}\n`

/** The same file as a module a test can compile: what the page leaves untyped is typed. */
export const loopModuleOf = (loop: string): string => `${LOOP_IMPORTS}
import type { Tool, Toolkit } from "effect/ai"
import type { OpenSession } from "@xandreed/core/kernel"

/** Where an agent's words, status and steers go: the chat's for the chat, quiet ones for a helper. */
export interface Hooks {
  readonly stream: (piece: string) => Effect.Effect<void>
  readonly status: (text: string) => Effect.Effect<void>
  readonly drain: Effect.Effect<ReadonlyArray<string>>
}

${loop
  .replace("export const runAgent = (agent) => (session, messages) =>", "export const runAgent = <Tools extends Record<string, Tool.Any>>(agent: { readonly system: string; readonly toolkit: Toolkit.WithHandler<Tools>; readonly hooks: Hooks }) => (session: OpenSession, messages: ReadonlyArray<string>) =>")}
`

/** The editable part as the page runs it: statements, without `export`. */
export const loopBodyOf = (loop: string): string => loop.replace(/^export /gm, "")
