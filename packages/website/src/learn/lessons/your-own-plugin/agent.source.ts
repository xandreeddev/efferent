// The one source of truth for lesson 3's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool), with two plugins of the
// learner's own from plugin.ts provided in main, and the boot hook gone: the
// meter does that job. The page shows IMPORTS (read-only, folded) above the
// code the learner edits, and runs that text as written; program.test.ts
// compiles this exact text, and checks the base still holds each piece
// replaced here.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

/** The base's boot hook, which named each turn on the status line. */
const BOOT_HOOK = `    const chat = yield* Chat
    const core = yield* Core

    // On boot: hook an event, as a Neovim autocmd would. Here, the chat's status line names each turn.
    yield* core.on(turnStartedEvent, ({ data }) => chat.status(\`turn \${data.turn}\`), {
      name: "boot",
      wait: true,
    })

`

/** What is left of it: one line saying where the hooks went. */
const NO_HOOK = `    const chat = yield* Chat

    // On boot, the plugins main provides set up: the meter hooks its events there, not here.
`

const FLAT_LINE = "  Effect.provide(flatMemory), // what of the journal the model sees\n"
const PLUGIN_LINES = `  Effect.provide(meter), // your event plugin: it counts what each turn cost
  Effect.provide(withClock(flatMemory)), // your wrapper: the flat memory, with the time after it
`

/** What this lesson replaces in the base's imports, as `[from, to]`: no `Core` or `turnStartedEvent`, and plugin.ts. */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  [
    'import { Core, kernel, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"',
    'import { kernel, Sessions, userMessage } from "@xandreed/core/kernel"',
  ],
  [
    'import { flatMemory } from "./memory.ts"',
    'import { flatMemory } from "./memory.ts"\nimport { meter, withClock } from "./plugin.ts"',
  ],
]

/** What this lesson replaces in the base's program, as `[from, to]`: the boot hook, and the memory main provides. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [BOOT_HOOK, NO_HOOK],
  [FLAT_LINE, PLUGIN_LINES],
]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(BASE_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the system text, the step limit, one turn, the program and main. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/** The same file as a module a test can compile and run, as the base's, with this lesson's imports. */
export const moduleOf = (agent: string): string => typedModule(IMPORTS, agent)
