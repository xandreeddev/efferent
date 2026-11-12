import { Effect, Match, Stream } from "effect"
import { Prompt } from "effect/ai"
import type { Agent, AssistantMessage, ModelRequest } from "@xandreed/core/kernel"

/** The request as the model's prompt: the system text, then the messages in order. */
const promptOf = (request: ModelRequest): Prompt.Prompt =>
  Prompt.make([
    { role: "system", content: request.system },
    ...request.messages.map(({ message }) => Match.valueTags(message, {
      User: ({ text }): Prompt.MessageEncoded => ({ role: "user", content: text }),
      Assistant: ({ text }): Prompt.MessageEncoded => ({ role: "assistant", content: text }),
    })),
  ])

/**
 * Send a request to the agent's model and gather its answer. The text
 * streams: each piece goes to `onDelta` as it arrives, and the whole of it
 * is the message returned. The model's own error is the failure.
 *
 * @public
 */
export const callModel = Effect.fn("kernel.call_model")(function* <E, R>(agent: Agent, request: ModelRequest, onDelta: (delta: string) => Effect.Effect<void, E, R>) {
  const text = yield* agent.model.streamText({ prompt: promptOf(request) }).pipe(
    Stream.runFoldEffect(() => "", (text, part) => part.type === "text-delta" ? Effect.as(onDelta(part.delta), text + part.delta) : Effect.succeed(text)),
  )
  const message: AssistantMessage = { _tag: "Assistant", text, toolCalls: [] }
  return message
})
