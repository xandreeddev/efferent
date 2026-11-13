import { Effect, Layer, Option } from "effect"
import { CONVERSATION_READER, messageOf, readerFor, readJournal } from "@xandreed/core/kernel"
import type { OpenSession } from "@xandreed/core/kernel"
import { promptMessage } from "../../contracts/memory/memory.entity.functions.js"
import { Memory } from "../../contracts/memory/memory.port.js"

/** What the flat memory reads: the conversation, and its own prefix (`plugin.flat.`), where it writes nothing yet. */
const FLAT_READER = readerFor("flat", [], CONVERSATION_READER)

/**
 * The flat memory: every message of the conversation so far, oldest first.
 * Nothing dropped, nothing stored, so each context starts with the one
 * before it and a provider's prompt cache reuses all of it, until the
 * conversation outgrows the model. A record of the conversation, or of its
 * own, that it cannot read and may not skip is refused (`UnknownRecord`).
 *
 * @public
 */
export const flatMemory: Layer.Layer<Memory> = Layer.succeed(
  Memory,
  Memory.of({
    context: Effect.fn("kernel.flat.context")(function* (session: OpenSession) {
      // Only the conversation's records and its own; a record it cannot read and may not skip is refused.
      const conversation = yield* Effect.fromResult(readJournal(FLAT_READER)(yield* session.journal))
      return conversation.flatMap((record) => Option.toArray(messageOf(record))).map(promptMessage)
    }),
  }),
)
