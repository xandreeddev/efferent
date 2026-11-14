// The one source of truth for lesson 5's agent.ts: lesson 2's program, with
// the summary memory of memory.ts and the summarizer of summarizer.ts
// provided in main. The page shows IMPORTS (read-only, folded) above the code
// the learner edits, and runs that text as written; program.test.ts compiles
// and runs this exact text on the kernel.
import { DEFAULT_AGENT as TOOLS_AGENT, IMPORTS as TOOLS_IMPORTS, moduleOf as toolsModuleOf } from "../tools/agent.source.ts"

const FLAT_IMPORT = 'import { flatMemory } from "./memory.ts"'
const OUR_IMPORTS = 'import { memory } from "./memory.ts"\nimport { summarizerLive } from "./summarizer.ts"'
const FLAT_LINE = "  Effect.provide(flatMemory), // what of the journal the model sees\n"
const OUR_LINES = `  Effect.provide(memory), // what of the journal the model sees: a summary of old turns, then the rest
  Effect.provide(summarizerLive), // what memory asks to shorten old turns, over the model you picked
`

/** Lesson 2's text with one piece replaced; lesson.test.ts fails when lesson 2's text no longer holds the piece. */
const replaced = (text: string, from: string, to: string): string => text.replace(from, to)

/** Read-only: what the program imports. */
export const IMPORTS = replaced(TOOLS_IMPORTS, FLAT_IMPORT, OUR_IMPORTS)

/** What the learner edits: lesson 2's program, with this lesson's memory and its summarizer in main. */
export const DEFAULT_AGENT = replaced(TOOLS_AGENT, FLAT_LINE, OUR_LINES)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/** The same file as a module a test can compile and run, as lesson 2's, with this lesson's imports. */
export const moduleOf = (agent: string): string => replaced(toolsModuleOf(agent), FLAT_IMPORT, OUR_IMPORTS)
