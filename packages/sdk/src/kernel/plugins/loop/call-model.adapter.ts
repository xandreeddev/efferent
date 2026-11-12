import { Effect, Match, Stream } from "effect"
import { Prompt } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import { resolveRequest } from "@xandreed/core/kernel"
import type { AssistantMessage, ModelRequest, OpenSession, ResolvedRequest } from "@xandreed/core/kernel"

/** A resolved request as the model's prompt: the system text, then the messages in order. */
const promptOf = (request: ResolvedRequest): Prompt.Prompt =>
  Prompt.make([
    { role: "system", content: request.system },
    ...request.messages.map(({ message }) => Match.valueTags(message, {
      User: ({ text }): Prompt.MessageEncoded => ({ role: "user", content: text }),
      Assistant: ({ text }): Prompt.MessageEncoded => ({ role: "assistant", content: text }),
    })),
  ])

/**
 * Send a request to the model and gather its answer. The request's
 * pointers are resolved against the session's journal, so the model is sent
 * exactly what the stored request says. The text streams: each piece goes
 * to `onDelta` as it arrives, and the whole of it is the message returned.
 * The model's own error is the failure. No tools are offered in this cut,
 * so the answer asks for none.
 *
 * @public
 */
export const callModel = Effect.fn("kernel.call_model")(function* <E, R>(
  model: LanguageModel.LanguageModel,
  session: OpenSession,
  system: string,
  request: ModelRequest,
  onDelta: (delta: string) => Effect.Effect<void, E, R>,
) {
  const resolved = yield* Effect.fromResult(resolveRequest(yield* session.journal, { system, ...request }))
  const text = yield* model.streamText({ prompt: promptOf(resolved) }).pipe(
    Stream.runFoldEffect(() => "", (text, part) => part.type === "text-delta" ? Effect.as(onDelta(part.delta), text + part.delta) : Effect.succeed(text)),
  )
  const message: AssistantMessage = { _tag: "Assistant", text, toolCalls: [] }
  return message
})
