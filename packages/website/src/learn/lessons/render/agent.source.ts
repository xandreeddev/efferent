// The one source of truth for lesson 6's agent.ts: lesson 2's program, whose
// loop runs each tool call in the turn it belongs to (`CurrentTurn`), so a
// tool can show a view. The page shows IMPORTS (read-only, folded) above the
// code the learner edits; program.test.ts compiles and runs this exact text.
import { DEFAULT_AGENT as TOOLS_AGENT, IMPORTS as TOOLS_IMPORTS, moduleOf as toolsModuleOf } from "../tools/agent.source.ts"

const SDK_IMPORT = 'import { inProcessJournal, Memory, sessions } from "@xandreed/sdk/kernel"'
const OUR_SDK_IMPORT = 'import { CurrentTurn, inProcessJournal, Memory, sessions } from "@xandreed/sdk/kernel"'
const CALL = "          const result = yield* runTool(toolkit, call)\n"
const OUR_CALL = `          // The call runs in this turn: a tool that declares CurrentTurn reaches the session from its handler.
          const result = yield* runTool(toolkit, call).pipe(Effect.provideService(CurrentTurn, session))
`
const SYSTEM = 'const system = "You are a helpful assistant. Use a tool when it helps, then answer in one short sentence."'
const OUR_SYSTEM = 'const system = "You are a helpful assistant. To show the user a table, use show. Answer in one short sentence."'

/** Lesson 2's text with pieces replaced; lesson.test.ts fails when lesson 2's text no longer holds one. */
export const REPLACED = [[SDK_IMPORT, OUR_SDK_IMPORT], [CALL, OUR_CALL], [SYSTEM, OUR_SYSTEM]] as const
const replaced = (text: string, pairs: ReadonlyArray<readonly [string, string]>): string => pairs.reduce((all, [from, to]) => all.replace(from, to), text)

/** Read-only: what the program imports. */
export const IMPORTS = replaced(TOOLS_IMPORTS, [REPLACED[0]])

/** What the learner edits: lesson 2's program, the calls run in their turn. */
export const DEFAULT_AGENT = replaced(TOOLS_AGENT, REPLACED.slice(1))

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/** The same file as a module a test can compile and run, as lesson 2's, with this lesson's imports. */
export const moduleOf = (agent: string): string => replaced(toolsModuleOf(agent), [REPLACED[0]])

/** The loop no longer gives a call its turn: a tool that needs it fails (the "no turn" experiment). */
export const withoutTurn = (agent: string): string => agent.replace(".pipe(Effect.provideService(CurrentTurn, session))", "")
