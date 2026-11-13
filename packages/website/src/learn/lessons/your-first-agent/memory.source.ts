// Lesson 1's memory.ts: a memory the learner writes. The editable part is
// the `flatMemory` layer; the page evaluates this exact text, and the
// lesson's tests run it through the memory kit and compile it.

/** Read-only: where each name the memory uses comes from. */
export const MEMORY_IMPORTS = `import { Effect, Layer, Option } from "effect"
import { CONVERSATION_READER, messageOf, readerFor, readJournal } from "@xandreed/core/kernel"
import { Memory, promptMessage } from "@xandreed/sdk/kernel"`

/** Read-only: the comment and the declaration before the editable layer. */
export const MEMORY_INTRO = `${MEMORY_IMPORTS}

// A memory decides what of the journal goes into the context.
// This one is flat: every message of the conversation so far, oldest first. Nothing dropped, nothing stored.
export const flatMemory = `

/** What the learner edits: the layer that provides Memory. */
export const DEFAULT_MEMORY = `Layer.succeed(
  Memory,
  Memory.of({
    context: (session) =>
      Effect.gen(function* () {
        // It reads the conversation, and its own records ("plugin.flat."), where it writes none yet.
        // A record it cannot read and may not skip is refused, never passed over.
        const reader = readerFor("flat", [], CONVERSATION_READER)
        const journal = yield* session.journal
        const conversation = yield* Effect.fromResult(readJournal(reader)(journal))
        const messages = conversation.flatMap((record) => Option.toArray(messageOf(record)))
        return messages.map(promptMessage)
      }),
  }),
)`

/** The whole file as the learner reads it. */
export const memoryDocumentOf = (memory: string): string => `${MEMORY_INTRO}${memory}\n`

/** The same file as a module a test can compile. */
export const memoryModuleOf = (memory: string): string => `${MEMORY_INTRO}${memory}\n`
