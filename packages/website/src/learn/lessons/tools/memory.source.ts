// Lesson 2's memory.ts: lesson 1's flat memory, with tool calls in the
// conversation. A call goes only with its result (`paired`): a turn stopped
// while a tool ran leaves a call no result answers, which a provider refuses.

/** Read-only: where each name the memory uses comes from. */
export const MEMORY_IMPORTS = `import { Effect, Layer, Option } from "effect"
import { CONVERSATION_READER, messageOf, readerFor, readJournal } from "@xandreed/core/kernel"
import { Memory, paired, promptMessage } from "@xandreed/sdk/kernel"`

/** Read-only: the comment and the declaration before the editable layer. */
export const MEMORY_INTRO = `${MEMORY_IMPORTS}

// A memory decides what of the journal goes into the context.
// This one is flat: every message of the conversation so far, oldest first, tool calls and results included.
export const flatMemory = `

/** What the learner edits: the layer that provides Memory. */
export const DEFAULT_MEMORY = `Layer.succeed(
  Memory,
  Memory.of({
    context: (session) =>
      Effect.gen(function* () {
        // It reads the conversation, and its own records ("plugin.flat."), where it writes none yet.
        const reader = readerFor("flat", [], CONVERSATION_READER)
        const journal = yield* session.journal
        const conversation = yield* Effect.fromResult(readJournal(reader)(journal))
        const messages = conversation.flatMap((record) => Option.toArray(messageOf(record)))
        // A tool call goes only with its result: a turn stopped while a tool ran leaves a call nothing answers.
        return paired(messages).map(promptMessage)
      }),
  }),
)`

/** The whole file as the learner reads it. */
export const memoryDocumentOf = (memory: string): string => `${MEMORY_INTRO}${memory}\n`

/** The same file as a module a test can compile. */
export const memoryModuleOf = (memory: string): string => `${MEMORY_INTRO}${memory}\n`
