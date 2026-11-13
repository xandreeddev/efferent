import { Schema } from "effect"
import type { StoredDefinition } from "./event.entity.js"
import { tagsOf } from "./event.entity.functions.js"
import { EventName } from "./ids.entity.js"
import type { Reader } from "./journal.entity.js"
import { turnEndedEvent, turnStartedEvent } from "./vocabulary.entity.js"

/*
 * The conversation's records: what was said, by the user and by the model.
 * They are core's vocabulary, named `conversation.`, because whoever runs a
 * turn writes them (a loop plugin, or a host's own program) and every memory
 * reads them. They are tagged `conversation`: what a memory builds the
 * context from. Nothing else about a request is stored: the system text is
 * the program's, and what a model was shown is rebuilt from these records.
 */

/**
 * The data of `conversation.user.message`: none. The message is the record's.
 *
 * @public
 */
export const UserMessageData = Schema.Struct({})
export type UserMessageData = typeof UserMessageData.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * What the provider reported a model call cost: the tokens it read, those of them it read from its prompt cache,
 * and the tokens it wrote.
 *
 * @public
 */
export const Usage = Schema.Struct({ inputTokens: Count, outputTokens: Count, cachedInputTokens: Schema.optionalKey(Count) })
export type Usage = typeof Usage.Type

/**
 * The data of `conversation.assistant.message`: metadata about the answer, when its writer has it. The model that
 * answered and what the provider reported it cost. The message is the record's.
 *
 * @public
 */
export const AssistantMessageData = Schema.Struct({ model: Schema.optionalKey(Schema.String), usage: Schema.optionalKey(Usage) })
export type AssistantMessageData = typeof AssistantMessageData.Type

/**
 * The data of `conversation.tool.result`: none. The result is the record's message.
 *
 * @public
 */
export const ToolResultData = Schema.Struct({})
export type ToolResultData = typeof ToolResultData.Type

/** `conversation.user.message`: what the user sent, in the turn that answers it. Stored, tagged `conversation`. */
export const userMessageEvent: StoredDefinition<UserMessageData> = {
  kind: "stored",
  name: EventName.make("conversation.user.message"),
  data: UserMessageData,
  skippable: false,
  tags: tagsOf(["conversation"]),
}

/** `conversation.assistant.message`: what the model answered. Stored, tagged `conversation`. */
export const assistantMessageEvent: StoredDefinition<AssistantMessageData> = {
  kind: "stored",
  name: EventName.make("conversation.assistant.message"),
  data: AssistantMessageData,
  skippable: false,
  tags: tagsOf(["conversation"]),
}

/**
 * `conversation.tool.result`: what a tool call the model asked for came to, stored after the assistant message that
 * asked for it. Stored, tagged `conversation`. The tools themselves are the program's code, like the system text,
 * and never stored.
 *
 * @public
 */
export const toolResultEvent: StoredDefinition<ToolResultData> = {
  kind: "stored",
  name: EventName.make("conversation.tool.result"),
  data: ToolResultData,
  skippable: false,
  tags: tagsOf(["conversation"]),
}

/**
 * The reader of a conversation: core's records and the conversation's. A
 * memory reads through it, or through its own reader over it
 * (`readerFor(name, own, CONVERSATION_READER)`), so a conversation record it
 * does not know and may not skip is refused, never passed over in silence.
 *
 * @public
 */
export const CONVERSATION_READER: Reader = {
  reads: ["core.", "conversation."],
  knows: [turnStartedEvent.name, turnEndedEvent.name, userMessageEvent.name, assistantMessageEvent.name, toolResultEvent.name],
}
