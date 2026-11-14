// Lesson 5's memory.ts: the stock summary memory, with the options the
// learner turns. Its record of what it summarized is its state: stored once,
// so every later context starts the same way.

/** Read-only: where each name the memory uses comes from. */
export const MEMORY_IMPORTS = `import { summaryMemory } from "@xandreed/sdk/kernel"`

/** Read-only: the comment and the declaration before the editable layer. */
export const MEMORY_INTRO = `${MEMORY_IMPORTS}

// A memory with state of its own. While the conversation fits the budget, it sends every message.
// Over it, it asks the summarizer to fold the oldest turns into a summary, and stores the summary once
// ("plugin.summary.summarized", tagged memory). Every later context starts with that summary,
// then the turns after it: the prompt's start stays the same until the next summary.
export const memory = `

/** What the learner edits: the summary memory's options. */
export const DEFAULT_MEMORY = `summaryMemory({
  // How many tokens of history fit: the system text and the tools are not counted. Small, so it compacts soon.
  budgetTokens: 200,
  // How many of the latest finished turns stay whole when it compacts. The turn being answered always does.
  keepTurns: 1,
})`

/** The whole file as the learner reads it. */
export const memoryDocumentOf = (memory: string): string => `${MEMORY_INTRO}${memory}\n`

/** The same file as a module a test can compile. */
export const memoryModuleOf = (memory: string): string => `${MEMORY_INTRO}${memory}\n`
