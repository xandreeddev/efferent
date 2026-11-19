import { Effect, Layer, Option } from "effect"
import { CONVERSATION_VOCABULARY, messageOf, vocabularyOf, readJournal } from "@xandreed/core"
import type { OpenSession } from "@xandreed/core"
import { paired, promptMessage } from "../../contracts/memory/memory.entity.functions.js"
import { Memory } from "../../contracts/memory/memory.port.js"
import { pointed } from "../../contracts/memory/pointer.entity.functions.js"
import type { FlatOptions } from "./flat.entity.js"

/** What the flat memory reads: the conversation, and its own prefix (`plugin.flat.`), where it writes nothing yet. */
const FLAT_VOCABULARY = vocabularyOf("flat", [], CONVERSATION_VOCABULARY)

/**
 * The flat memory: every message of the conversation so far, oldest first.
 * Nothing dropped but a tool call no result answers, nothing stored, so each context starts with the one
 * before it and a provider's prompt cache reuses all of it, until the
 * conversation outgrows the model. A record of the conversation, or of its
 * own, that it cannot read and may not skip is refused (`UnknownRecord`).
 *
 * @public
 */
export const flatMemory: Layer.Layer<Memory> = Layer.succeed(
  Memory,
  Memory.of({
    context: Effect.fn("flat_memory.context")(function* (session: OpenSession) {
      // Only the conversation's records and its own; a record it cannot read and may not skip is refused.
      const conversation = yield* Effect.fromResult(readJournal(FLAT_VOCABULARY)(yield* session.journal))
      // A tool call goes only with its result: a turn stopped while a tool ran leaves a call nothing answers.
      return paired(conversation.flatMap((record) => Option.toArray(messageOf(record)))).map(promptMessage)
    }),
  }),
)

/**
 * The flat memory that points: every message of the conversation, as
 * `flatMemory` sends it, but a long tool result read as its pointer
 * (`pointed`, ADR 0011), in the turn that fetched it and in every later one,
 * so each context still starts with the one before it. Nothing stored, no
 * budget. Pointer options that are none are refused here, where the layer is
 * made.
 *
 * @public
 */
export const flatMemoryWith = (options: FlatOptions): Layer.Layer<Memory> => {
  // How a record's message is read: a long result as its pointer. Options that are none throw here.
  const sent = pointed(options.pointers)
  return Layer.succeed(Memory, Memory.of({
    context: Effect.fn("flat_memory.context")(function* (session: OpenSession) {
      const conversation = yield* Effect.fromResult(readJournal(FLAT_VOCABULARY)(yield* session.journal))
      return paired(conversation.flatMap((record) => Option.toArray(sent(record)))).map(promptMessage)
    }),
  }))
}
