import { Option, Result } from "effect"
import { taggedWith } from "./event.entity.functions.js"
import type { StoredEvent, Tag } from "./event.entity.js"
import { PluginName } from "./ids.entity.js"
import type { EventName } from "./ids.entity.js"
import { UnknownRecord } from "./journal.entity.js"
import type { Vocabulary } from "./journal.entity.js"
import type { Message } from "./message.entity.js"
import { KERNEL_VOCABULARY } from "./vocabulary.entity.js"

/**
 * The message a record bears when the record is the conversation's (tagged `conversation`), whichever definition
 * it is of; none for any other record, so text a record of another use bears never reads as part of the conversation.
 */
export const messageOf = (event: { readonly message?: Message; readonly tags: ReadonlyArray<Tag> }): Option.Option<Message> =>
  taggedWith("conversation")(event) ? Option.fromNullishOr(event.message) : Option.none()

/**
 * The vocabulary of plugin `plugin`: it answers for what `over` answers for
 * (core's own records when left out) and for the records under its own
 * prefix, and knows, of its own, the definitions in `own`. A plugin that
 * reads another plugin's records extends that plugin's vocabulary.
 */
export const vocabularyOf = (plugin: string, own: ReadonlyArray<{ readonly name: EventName }>, over: Vocabulary = KERNEL_VOCABULARY): Vocabulary => ({
  reads: [...over.reads, `plugin.${PluginName.make(plugin)}.`],
  knows: [...over.knows, ...own.map((definition) => definition.name)],
})

/**
 * A journal as read with `vocabulary`: the records it knows, in order. A record
 * under one of its prefixes that it does not know is passed over when the
 * record says it may be, and refused otherwise. A record under no prefix
 * of its own is another plugin's, and not this vocabulary's to judge.
 */
export const readJournal = (vocabulary: Vocabulary) => (events: ReadonlyArray<StoredEvent>): Result.Result<ReadonlyArray<StoredEvent>, UnknownRecord> => {
  const known: Array<StoredEvent> = []
  for (const event of events) {
    if (!vocabulary.reads.some((prefix) => event.name.startsWith(prefix))) continue
    if (vocabulary.knows.includes(event.name)) known.push(event)
    else if (!event.skippable) {
      return Result.fail(new UnknownRecord({ name: event.name, seq: event.seq, message: `the record ${event.name} at ${event.seq} is not known to this vocabulary and may not be skipped` }))
    }
  }
  return Result.succeed(known)
}
