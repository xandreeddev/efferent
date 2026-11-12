import { Option, Schema } from "effect"
import { AssistantMessageData, CORE_EVENTS } from "./event.entity.js"
import type { StoredEvent } from "./journal.entity.js"
import { UserMessage } from "./message.entity.js"
import type { Message } from "./message.entity.js"

const decodeUser = Schema.decodeUnknownOption(UserMessage)
const decodeAssistant = Schema.decodeUnknownOption(AssistantMessageData)

/** The message a stored event holds; none for an event that is no message. */
export const messageOf = (event: StoredEvent): Option.Option<Message> =>
  event.name === CORE_EVENTS.userMessage ? decodeUser(event.data)
    : event.name === CORE_EVENTS.assistantMessage ? Option.map(decodeAssistant(event.data), (data) => data.message)
    : Option.none()
