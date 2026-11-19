// Lesson 20's memory.ts: lesson 18's, with the kernel's wrapper that adds a
// third list, by meaning: `withKnowledgeByMeaning` in place of
// `withKnowledge`, and two more options, `pool` and `weights`, which the
// page's controls edit. The stop words and the speaker's words are lesson
// 18's, written out as they are there. The text is lesson 18's with named
// pieces replaced; program.test.ts checks lesson 18's text still holds each,
// and compiles and runs this exact text.
import { replaced } from "../base/agent.source.ts"
import { DEFAULT_MEMORY as WORDS_MEMORY, MEMORY_IMPORTS as WORDS_IMPORTS, WALK_LINE, WRAPPED_HEAD as WORDS_HEAD } from "../connected-memory/memory.source.ts"

/** What this lesson replaces in lesson 18's imports, as `[from, to]`. */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  ["import { flatMemory, withKnowledge } from", "import { flatMemory, withKnowledgeByMeaning } from"],
]

/** Read-only: where each name the memory uses comes from. */
export const MEMORY_IMPORTS = replaced(WORDS_IMPORTS, REPLACED_IMPORTS)

/** Everything before the editable part. */
export const MEMORY_HEADER = `${MEMORY_IMPORTS}\n\n`

/** The comment over the one statement: what the wrapper does, with a list by meaning. */
export const WRAPPED_HEAD = `// The memory a conversation reads with, wrapped: each request is sent the conversation, then
// what is kept that it names or that is near it in meaning. withKnowledgeByMeaning makes three
// lists of memories: those about what your message names, those its words reach, and those
// nearest your last message in meaning, by the page's embedder. It puts the three in one order,
// adds what it chose last, framed as data, and stores nothing. Options it does not take are
// refused here, as the file runs.`

/** The `pool` option with its comment: how many memories the list by meaning ranks. */
export const POOL_LINE = `  // How many memories the list by meaning ranks, the nearest to your last message first, from 1
  // to 100.
  pool: 50,`

/** The `weights` option with its comment: how much each list counts when the three are put in one order. */
export const WEIGHTS_LINE = `  // How much each list counts when the three are put in one order, each from 0 to 10, 0 turning a
  // list off: a memory first in a list adds its weight / 10, second its weight / 11, and so on.
  weights: { seed: 1, words: 0.5, meaning: 1.5 },`

/** What this lesson replaces in lesson 18's memory.ts, as `[from, to]`. program.test.ts fails when lesson 18's text no longer holds one. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [WORDS_HEAD, WRAPPED_HEAD],
  ["export const memory = withKnowledge({", "export const memory = withKnowledgeByMeaning({"],
  [WALK_LINE, `${WALK_LINE}\n${POOL_LINE}\n${WEIGHTS_LINE}`],
]

/** What the learner edits. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_MEMORY = replaced(WORDS_MEMORY, REPLACED)

/** The whole file as the learner reads it. */
export const memoryDocumentOf = (memory: string): string => `${MEMORY_HEADER}${memory}\n`

/** The same file as a module a test can compile: nothing in it needs a type. */
export const memoryModuleOf = (memory: string): string => `${MEMORY_HEADER}${memory}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const memoryBodyOf = (memory: string): string => memory.replace(/^export /gm, "")
