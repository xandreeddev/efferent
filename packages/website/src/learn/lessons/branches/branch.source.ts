// The one source of truth for lesson 15's branch.ts: one function the page
// calls when "Branch after turn N" is pressed, which asks the sessions for a
// branch of the conversation shown. A file of statements, as tools.ts is: the
// page runs the text as written, and program.test.ts compiles it with its two
// parameters typed (`branchModuleOf`) and runs it on the kernel.

/** Read-only: where each name branch.ts uses comes from. */
export const BRANCH_IMPORTS = `import { Effect } from "effect"
import { Sessions, TurnNumber } from "@xandreed/core/kernel"`

/** The call branch.ts makes, as it starts: a cut at the end of the turn the page names. */
export const FORK_AT_TURN = `    // A turn's number is a TurnNumber: a whole number from 1, which make checks.
    return yield* sessions.fork(conversation, { through: TurnNumber.make(turn) })
`

/** What the learner edits: the function the page calls. */
export const DEFAULT_BRANCH = `// A branch of a conversation: a new session whose journal starts as a copy of the conversation's,
// up to the end of turn \`turn\`. The store copies the records in one step, each as it was stored:
// its place, its turn, its time. Nothing is announced. The conversation is left as it was and
// goes on, and a turn still open in it is not copied.
// The page calls this when you press "Branch after turn N", with the chat shown and N.
const branchFrom = (conversation, turn) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
${FORK_AT_TURN}  })`

/** Everything before the editable function. */
export const BRANCH_HEADER = `${BRANCH_IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const branchDocumentOf = (branch: string): string => `${BRANCH_HEADER}${branch}\n`

/** What the typed module replaces in the learner's text, as `[from, to]`: the function exported, its parameters typed. */
export const TYPED: ReadonlyArray<readonly [string, string]> = [
  ["const branchFrom = (conversation, turn) =>", "export const branchFrom = (conversation: SessionId, turn: number) =>"],
]

/**
 * The same file as a module a test can compile and run: the learner's text with `branchFrom` exported and its
 * parameters typed, the conversation's id and the turn's number the page gives.
 */
export const branchModuleOf = (branch: string): string =>
  `${BRANCH_IMPORTS}\nimport type { SessionId } from "@xandreed/core/kernel"\n\n${TYPED.reduce((text, [from, to]) => text.replace(from, to), branch)}\n`
