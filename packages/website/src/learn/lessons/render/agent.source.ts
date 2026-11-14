// The one source of truth for lesson 6's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool), with a system text that
// names the show tool. Its loop runs each call with callTool, which gives the
// call its turn (`CurrentTurn`), so a tool can show a view. The page shows
// IMPORTS (read-only, folded) above the code the learner edits;
// program.test.ts compiles and runs this exact text.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

const SYSTEM = 'const system =\n  "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."'
const OUR_SYSTEM = 'const system =\n  "You are a helpful assistant. To show the user a table, use show. Answer in one short sentence."'

/** What this lesson replaces in the base's program, as `[from, to]`: the system text. lesson.test.ts fails when the base no longer holds it. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [[SYSTEM, OUR_SYSTEM]]

/** Read-only: what the program imports, which is what the base imports. */
export const IMPORTS = BASE_IMPORTS

/** What the learner edits: the base program, told about the show tool. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/** The same file as a module a test can compile and run, as the base's. */
export const moduleOf = (agent: string): string => typedModule(IMPORTS, agent)
