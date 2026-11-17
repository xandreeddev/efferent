// The one source of truth for lesson 18's agent.ts: lesson 11's program,
// which is the base program with three changes, none of them in the loop,
// made for the graph in place of the facts. main provides the kernel's
// handlers for the graph's three tools beside the calculator's. The memory
// it provides is memory.ts's, the flat memory wrapped with the graph. And
// the boot hook names only the conversation's turns: a linkThings or
// unlinkThings call opens a turn of its own, on the graph session. The text
// is lesson 11's with named pieces replaced; program.test.ts checks lesson
// 11's text still holds each, and that the base's differs from this one by
// these three changes alone. It compiles and runs this exact text.
import { replaced, typedModule } from "../base/agent.source.ts"
import { CHAT_HOOK as FACTS_HOOK, DEFAULT_AGENT as FACTS_AGENT, FACTS_LINE, IMPORTS as FACTS_IMPORTS, MEMORY_LINE as FACTS_MEMORY_LINE } from "../remember/agent.source.ts"

/** What this lesson replaces in lesson 11's imports, as `[from, to]`: the graph's handlers in place of the facts'. */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  [
    'import { callTool, factHandlers, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
    'import { callTool, graphHandlers, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
  ],
]

/** This lesson's boot hook: it names the conversation's turns, and passes over a turn on the graph session. */
export const CHAT_HOOK = `    // On boot: hook an event, to run code when it fires. Here, the chat's status line names each
    // turn of the conversation. A linkThings or unlinkThings call opens a turn too, on the graph
    // session: the hook passes that one over.
    yield* core.on(
      turnStartedEvent,
      (event) =>
        event.session === chat.session ? chat.status(\`turn \${event.data.turn}\`) : Effect.void,
      { name: "boot", wait: true },
    )
`

/** main's line for the kernel's handlers. */
export const GRAPH_LINE = "  Effect.provide(graphHandlers), // the kernel's three tools: a link stored is a turn on the graph session\n"

/** main's line for memory.ts's memory. */
export const MEMORY_LINE = "  Effect.provide(memory), // what the model sees: the conversation, then the links near the question\n"

/** What this lesson replaces in lesson 11's program, as `[from, to]`. program.test.ts fails when lesson 11's text no longer holds one. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [FACTS_HOOK, CHAT_HOOK],
  [FACTS_LINE, GRAPH_LINE],
  [FACTS_MEMORY_LINE, MEMORY_LINE],
]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(FACTS_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the base program, over this lesson's memory and tools. */
export const DEFAULT_AGENT = replaced(FACTS_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run, as the base's: `run` states that its program needs nothing
 * more, so a program that leaves out the kernel's handlers does not compile.
 */
export const moduleOf = (agent: string): string => typedModule(IMPORTS, agent)
