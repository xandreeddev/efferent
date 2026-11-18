// Lesson 18's memory.ts: the kernel's flat memory, wrapped with the kernel's
// `withGraph`, as lesson 11's is wrapped with `withFacts`. The file is
// statements: the wrapper is made as the file runs, so options `withGraph`
// refuses refuse the build. `flatMemory` is the name the page hands a
// watched memory under, so the Context tab shows what the wrapper added after
// it as the code's. The page's controls edit the options of the one call, a
// line each (config-edit.ts). The learner edits all of it; the page runs it
// as written, and program.test.ts compiles and runs it.
import { INTRO } from "../remember/memory.source.ts"

/**
 * Read-only: where each name the memory uses comes from. The file as it starts names `flatMemory` and `withGraph`
 * alone: the `by-distance` experiment writes a wrapper of its own over the others, and an experiment edits only
 * the code under the imports.
 */
export const MEMORY_IMPORTS = `import { Effect, Layer, Option } from "effect"
import { Sessions } from "@xandreed/core/kernel"
import { flatMemory, linksNote, Memory, namedIn, questionOf, recalledEvent, recalledOf, saidLinks, walked, withGraph } from "@xandreed/sdk/kernel"`

/** Everything before the editable part. */
export const MEMORY_HEADER = `${MEMORY_IMPORTS}\n\n`

export { INTRO }

/** The comment over the one statement. */
export const WRAPPED_HEAD = `// The memory a conversation reads with, wrapped: each request is sent the conversation, then
// the links near what the question names. withGraph reads the links that stand in the graph
// session and adds them last, best first, framed as data. It stores nothing. Options it does
// not take are refused here, as the file runs.`

/** The `hops` option with its comment: how far the walk goes. */
export const HOPS_LINE = `  // How many links away from a thing the question names the walk goes, from 1 to 3.
  hops: 2,`

/** The `limit` option with its comment: how many links a request is sent at most. */
export const LIMIT_LINE = `  // The most links a request is sent, from 1 to 50: the best ranked first.
  limit: 5,`

/** The `speaker` option with its comment: who "I" is. */
export const SPEAKER_LINE = `  // The person the agent talks with: "I", "me" or "my" in a question names the thing "user".
  speaker: { name: "user", words: ["i", "me", "my"] },`

/** The one statement, with its comment: the memory agent.ts provides. Options `withGraph` refuses are refused here, as the file runs. */
export const WRAPPED = `${WRAPPED_HEAD}
export const memory = withGraph({
${HOPS_LINE}
${LIMIT_LINE}
${SPEAKER_LINE}
})(flatMemory)`

/** What the learner edits. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_MEMORY = `${INTRO}\n${WRAPPED}`

/** The whole file as the learner reads it. */
export const memoryDocumentOf = (memory: string): string => `${MEMORY_HEADER}${memory}\n`

/**
 * The same file as a module a test can compile. As it starts nothing in it needs a type; the wrapper the
 * `by-distance` experiment writes takes its parameter's type and says its note's role is the literal.
 */
export const memoryModuleOf = (memory: string): string => `${MEMORY_HEADER}${memory
  .replace("const byDistance = (inner) =>", "const byDistance = <E, R>(inner: Layer.Layer<Memory, E, R>) =>")
  .replace('{ role: "user", content:', '{ role: "user" as const, content:')}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const memoryBodyOf = (memory: string): string => memory.replace(/^export /gm, "")
