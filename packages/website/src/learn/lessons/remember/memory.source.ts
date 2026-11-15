// Lesson 11's memory.ts: the kernel's flat memory, wrapped with the kernel's
// `withFacts`. The file is statements, as lesson 8's memory.ts is: the
// wrapper is made as the file runs, so a limit `withFacts` refuses refuses
// the build. It is a text of its own, not derived from lesson 2's: lesson 2
// writes its flat memory out in this file, and here the file is one line
// over the kernel's, so the page can watch the memory under the wrapper
// (`flatMemory` is the name the page hands a watched memory under, as it
// hands agent.ts `kernel` and `sessions`). The learner edits all of it; the
// page runs it as written, and program.test.ts compiles and runs it.

/**
 * Read-only: where each name the memory uses comes from. The file as it starts names `flatMemory` and `withFacts`
 * alone: the `facts-first` experiment writes a wrapper of its own over the others, and an experiment edits only
 * the code under the imports.
 */
export const MEMORY_IMPORTS = `import { Effect, Layer } from "effect"
import { Sessions } from "@xandreed/core/kernel"
import { factsNote, flatMemory, Memory, questionOf, relevant, rememberedFacts, withFacts } from "@xandreed/sdk/kernel"`

/** Everything before the editable part. */
export const MEMORY_HEADER = `${MEMORY_IMPORTS}\n\n`

/** What the file says of the memory under the wrapper: true of the file as it starts and as each experiment leaves it. */
export const INTRO = `// flatMemory is the kernel's: lesson 2's memory, every message of the conversation so far.
`

/** The one statement, with its comment: the memory agent.ts provides. A limit `withFacts` refuses is refused here, as the file runs. */
export const WRAPPED = `// The memory a conversation reads with, wrapped: each request is sent the conversation, then up
// to five facts. withFacts reads the facts that stand in the memory session and adds them last,
// framed as data. It stores nothing. A limit that is no whole number of at least 1 is refused
// here, as the file runs.
export const memory = withFacts({ limit: 5 })(flatMemory)`

/** What the learner edits. Plain JavaScript, so the page runs it as written. */
export const DEFAULT_MEMORY = `${INTRO}\n${WRAPPED}`

/** The whole file as the learner reads it. */
export const memoryDocumentOf = (memory: string): string => `${MEMORY_HEADER}${memory}\n`

/**
 * The same file as a module a test can compile. As it starts nothing in it needs a type; the wrapper the
 * `facts-first` experiment writes takes its two parameters' types and says its note's role is the literal.
 */
export const memoryModuleOf = (memory: string): string => `${MEMORY_HEADER}${memory
  .replace("const factsFirst = (limit) => (inner) =>", "const factsFirst = (limit: number) => <E, R>(inner: Layer.Layer<Memory, E, R>) =>")
  .replace('{ role: "user", content:', '{ role: "user" as const, content:')}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const memoryBodyOf = (memory: string): string => memory.replace(/^export /gm, "")
