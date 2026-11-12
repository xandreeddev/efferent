import { Option, Result } from "effect"
import type { StoredEvent } from "./event.entity.js"
import { PluginName } from "./ids.entity.js"
import type { EventName } from "./ids.entity.js"
import { UnknownRecord } from "./journal.entity.js"
import type { Reader } from "./journal.entity.js"
import type { Message } from "./message.entity.js"
import { KERNEL_READER } from "./vocabulary.entity.js"

/** The message a record bears, whatever record it is; none for a record that bears none. */
export const messageOf = (event: { readonly message?: Message }): Option.Option<Message> => Option.fromNullishOr(event.message)

/**
 * The reader of plugin `plugin`: it answers for the session and loop
 * plugins' records and for those under its own prefix, and knows, of its
 * own, the definitions in `own`.
 */
export const readerFor = (plugin: string, own: ReadonlyArray<{ readonly name: EventName }>): Reader => ({
  reads: [...KERNEL_READER.reads, `plugin.${PluginName.make(plugin)}.`],
  knows: [...KERNEL_READER.knows, ...own.map((definition) => definition.name)],
})

/**
 * A journal as `reader` reads it: the records it knows, in order. A record
 * under one of its prefixes that it does not know is passed over when the
 * record says it may be, and refused otherwise. A record under no prefix
 * of its own is another plugin's, and not this reader's to judge.
 */
export const readJournal = (reader: Reader) => (events: ReadonlyArray<StoredEvent>): Result.Result<ReadonlyArray<StoredEvent>, UnknownRecord> => {
  const known: Array<StoredEvent> = []
  for (const event of events) {
    if (!reader.reads.some((prefix) => event.name.startsWith(prefix))) continue
    if (reader.knows.includes(event.name)) known.push(event)
    else if (!event.skippable) {
      return Result.fail(new UnknownRecord({ name: event.name, seq: event.seq, message: `the record ${event.name} at ${event.seq} is not known to this reader and may not be skipped` }))
    }
  }
  return Result.succeed(known)
}
