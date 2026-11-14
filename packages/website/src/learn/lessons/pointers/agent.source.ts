// The one source of truth for lesson 8's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool). Nothing in its loop
// changes: what is new is in memory.ts, which sends a long result as a
// pointer, and in tools.ts, which offers the tool that reads on. One
// comment of main says so. The page shows IMPORTS (read-only, folded) above
// the code the learner edits; program.test.ts compiles and runs this exact
// text.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

const FLAT_LINE = "  Effect.provide(flatMemory), // what of the journal the model sees\n"
const OUR_LINE = "  Effect.provide(flatMemory), // what of the journal the model sees: a long result as a pointer\n"

/** What this lesson replaces in the base's program, as `[from, to]`: what main says of its memory. program.test.ts fails when the base no longer holds it. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [[FLAT_LINE, OUR_LINE]]

/** Read-only: what the program imports, which is what the base imports. */
export const IMPORTS = BASE_IMPORTS

/** What the learner edits: the base program, over this lesson's memory and tools. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/** The same file as a module a test can compile and run, as the base's. */
export const moduleOf = (agent: string): string => typedModule(IMPORTS, agent)
