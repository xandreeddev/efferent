import { Schema } from "effect"
import type { Prompt } from "effect/ai"
import { ENGINE_KEY, RequestStamp } from "../domain/engine-stamp.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"

const isObject = Schema.is(Schema.JsonObject)
const isRequestStamp = Schema.is(RequestStamp)

/** Whether these options mark the first message of a volatile suffix. */
export const isVolatileContext = (options: Prompt.ProviderOptions): boolean =>
  isRequestStamp(options[ENGINE_KEY])

/** Remove only the recognized request marker, retaining unrelated metadata. */
export const stripVolatileContext = (options: Prompt.ProviderOptions): Prompt.ProviderOptions => {
  if (!isVolatileContext(options)) return options
  const { [ENGINE_KEY]: stamp, ...providers } = options
  const { requestVolatile: _volatile, ...rest } = isObject(stamp) ? stamp : {}
  return Object.keys(rest).length === 0 ? providers : { ...providers, [ENGINE_KEY]: rest }
}

/** Mark the first volatile message on an outgoing copy; durable messages stay untouched. */
export const markVolatileContext = (messages: ReadonlyArray<AgentMessage>, stableMessages: number): ReadonlyArray<AgentMessage> =>
  messages.map((message, index) => {
    if (index !== stableMessages) return message
    const options = message.providerOptions ?? {}
    const stamp = options[ENGINE_KEY]
    return { ...message, providerOptions: { ...options, [ENGINE_KEY]: { ...(isObject(stamp) ? stamp : {}), requestVolatile: true } } }
  })
