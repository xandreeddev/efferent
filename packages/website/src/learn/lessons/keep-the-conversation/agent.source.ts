// The one source of truth for lesson 7's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool) with one line of main
// replaced: the journal is kept by the learner's store, in the browser's
// storage, where the base kept it in the process. Everything else is the
// base's: the turn still opens `chat.session`, which chat.ts now finds
// again after a reload.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

/** What this lesson replaces in the base's imports, as `[from, to]`: store.ts for the in-process journal. */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  [
    'import { callTool, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
    'import { callTool, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
  ],
  ['import { flatMemory } from "./memory.ts"', 'import { flatMemory } from "./memory.ts"\nimport { store } from "./store.ts"'],
]

/** What this lesson replaces in the base's program, as `[from, to]`: where every record is kept. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [
    "  Effect.provide(inProcessJournal()), // where every record is kept\n",
    '  Effect.provide(store(localStorage, { prefix: "agent:" })), // where every record is kept: your store\n',
  ],
]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(BASE_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the base program, over the learner's store. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run, as the base's, with this lesson's imports. `localStorage`
 * is a parameter of `run` there, as `pane` and `model` are: a test hands it a storage of its own.
 */
export const moduleOf = (agent: string): string =>
  typedModule(IMPORTS, agent)
    .replace('import type { Layer } from "effect"', 'import type { Layer } from "effect"\nimport type { KeyValueStore } from "@xandreed/sdk/kernel"')
    .replace("export const run = (pane: ChatPane,", "export const run = (localStorage: KeyValueStore, pane: ChatPane,")
