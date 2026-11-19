// Lesson 18's memory.ts: the kernel's flat memory, wrapped with the kernel's
// `withKnowledge`, as lesson 11's is wrapped with `withFacts`. The file is
// statements: the wrapper is made as the file runs, so options
// `withKnowledge` refuses refuse the build. `flatMemory` is the name the page
// hands a watched memory under, so the Context tab shows what the wrapper
// added after it as the code's. The speaker's words and the stop words are
// written out here, in the file: the kernel holds no words of a language, and
// ADR 0023's counts were measured with these. The page's controls edit the
// `limit` and `walk` lines (config-edit.ts). The learner edits all of it;
// the page runs it as written, and program.test.ts compiles and runs it.
import { INTRO } from "../remember/memory.source.ts"

/** Read-only: where each name the memory uses comes from. */
export const MEMORY_IMPORTS = `import { flatMemory, withKnowledge } from "@xandreed/sdk/kernel"`

/** Everything before the editable part. */
export const MEMORY_HEADER = `${MEMORY_IMPORTS}\n\n`

export { INTRO }

/** The words a memory is not ranked by, with their comment: ADR 0023's English stop words. */
export const STOP_WORDS = `// Words too common to rank a memory by: a memory that shares only these with your message is
// not reached by its words. English, as the lesson's messages are: the kernel holds no language.
const common = \`a an and are as at be by do does for from has have how i in is it its me my of on or
that the their they this to was what when where which who whose will with you your did s\``

/** The `limit` option with its comment: how many memories ranked first a request is sent. */
export const LIMIT_LINE = `  // How many memories a request is sent, the best ranked first, from 1 to 50.
  limit: 8,`

/** The `walk` option with its comment: how many more places the walk by subject adds. */
export const WALK_LINE = `  // How many more memories the walk by subject may add, from 0 to 10: memories whose subject is
  // an entity the best of them name, such as Acme in "Ana Silva works at Acme.".
  walk: 3,`

/** The `speaker` option with its comment: the words that name the person. */
export const SPEAKER_LINE = `  // The words that name the person you talk with: "Where do I live?" is about the user.
  speaker: ["i", "me", "my", "mine", "myself"],`

/** The \`stopWords\` option with its comment: the common words above, one by one. */
export const STOP_LINE = `  // The common words above, one by one.
  stopWords: common.split(/\\s+/),`

/** The comment over the one statement. */
export const WRAPPED_HEAD = `// The memory a conversation reads with, wrapped: each request is sent the conversation, then
// what is kept about what it names. withKnowledge reads the knowledge session and chooses by
// the words of your messages: no model is asked, and nothing is embedded. It adds what it chose
// last, framed as data, and stores nothing. Options it does not take are refused here, as the
// file runs.`

/** The one call, with its comment: the memory agent.ts provides. Options `withKnowledge` refuses are refused here, as the file runs. */
export const WRAPPED = `${WRAPPED_HEAD}
export const memory = withKnowledge({
${LIMIT_LINE}
${WALK_LINE}
${SPEAKER_LINE}
${STOP_LINE}
})(flatMemory)`

/** What the learner edits. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_MEMORY = `${INTRO}\n${STOP_WORDS}\n\n${WRAPPED}`

/** The whole file as the learner reads it. */
export const memoryDocumentOf = (memory: string): string => `${MEMORY_HEADER}${memory}\n`

/** The same file as a module a test can compile: nothing in it needs a type. */
export const memoryModuleOf = (memory: string): string => `${MEMORY_HEADER}${memory}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const memoryBodyOf = (memory: string): string => memory.replace(/^export /gm, "")
