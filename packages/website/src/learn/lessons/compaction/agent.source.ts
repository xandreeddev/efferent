// The one source of truth for lesson 5's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool), with the summary memory of
// memory.ts and the summarizer of summarizer.ts provided in main. The page
// shows IMPORTS (read-only, folded) above the code the learner edits, and
// runs that text as written; program.test.ts compiles and runs this exact
// text on the kernel.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

const FLAT_IMPORT = 'import { flatMemory } from "./memory.ts"'
const OUR_IMPORTS = 'import { memory } from "./memory.ts"\nimport { summarizerLive } from "./summarizer.ts"'
const FLAT_LINE = "  Effect.provide(flatMemory), // what of the journal the model sees\n"
const OUR_LINES = `  Effect.provide(memory), // what of the journal the model sees: a summary of old turns, then the rest
  Effect.provide(summarizerLive), // what memory asks to shorten old turns, over the model you picked
`

/** What this lesson replaces in the base's imports, as `[from, to]`: its memory and its summarizer for the flat memory. */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [[FLAT_IMPORT, OUR_IMPORTS]]

/** What this lesson replaces in the base's program, as `[from, to]`: the memory main provides. lesson.test.ts fails when the base no longer holds a piece. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [[FLAT_LINE, OUR_LINES]]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(BASE_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the base program, with this lesson's memory and its summarizer in main. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/** The same file as a module a test can compile and run, as the base's, with this lesson's imports. */
export const moduleOf = (agent: string): string => typedModule(IMPORTS, agent)
