// The one source of truth for lesson 11's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool) with three changes, none of
// them in the loop. main provides the kernel's handlers for the two tools
// that remember, beside the calculator's. The memory it provides is
// memory.ts's, the flat memory wrapped with the facts. And the boot hook
// names only the conversation's turns: a rememberFact call opens a turn of
// its own, on the memory session, which the base's hook would name too. The
// page shows IMPORTS (read-only, folded) above the code the learner edits;
// program.test.ts compiles and runs this exact text.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

/** What this lesson replaces in the base's imports, as `[from, to]`: the kernel's handlers join them, and memory.ts gives `memory`. */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  [
    'import { callTool, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
    'import { callTool, factHandlers, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
  ],
  ['import { flatMemory } from "./memory.ts"', 'import { memory } from "./memory.ts"'],
]

/** The base's boot hook, which names every turn that starts, in any session. */
const BOOT_HOOK = `    // On boot: hook an event, to run code when it fires. Here, the chat's status line names each turn.
    yield* core.on(turnStartedEvent, ({ data }) => chat.status(\`turn \${data.turn}\`), {
      name: "boot",
      wait: true,
    })
`

/** This lesson's boot hook: it names the conversation's turns, and passes over a turn on the memory session. */
export const CHAT_HOOK = `    // On boot: hook an event, to run code when it fires. Here, the chat's status line names each
    // turn of the conversation. A rememberFact call opens a turn too, on the memory session: the
    // hook passes that one over.
    yield* core.on(
      turnStartedEvent,
      (event) =>
        event.session === chat.session ? chat.status(\`turn \${event.data.turn}\`) : Effect.void,
      { name: "boot", wait: true },
    )
`

const TOOLS_LINE = "  Effect.provide(toolsLive), // what each tool does when it is called\n"

/** main's line for the calculator's handler. */
export const OWN_LINE = "  Effect.provide(toolsLive), // what the agent's own tool does when it is called\n"

/** main's line for the kernel's handlers. */
export const FACTS_LINE = "  Effect.provide(factHandlers), // the kernel's two tools: each call is a turn on the memory session\n"

const FLAT_LINE = "  Effect.provide(flatMemory), // what of the journal the model sees\n"

/** main's line for memory.ts's memory. */
export const MEMORY_LINE = "  Effect.provide(memory), // what the model sees: the conversation, then the facts that stand\n"

/** What this lesson replaces in the base's program, as `[from, to]`: the boot hook, and two lines of main with one more. program.test.ts fails when the base no longer holds one. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [BOOT_HOOK, CHAT_HOOK],
  [TOOLS_LINE, `${OWN_LINE}${FACTS_LINE}`],
  [FLAT_LINE, MEMORY_LINE],
]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(BASE_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the base program, over this lesson's memory and tools. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run, as the base's: `run` states that its program needs nothing
 * more, so a program that leaves out the kernel's handlers does not compile.
 */
export const moduleOf = (agent: string): string => typedModule(IMPORTS, agent)
