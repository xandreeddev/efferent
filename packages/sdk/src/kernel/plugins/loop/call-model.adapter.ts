import { Effect, Match, Stream } from "effect"
import { Prompt } from "effect/ai"
import type { LanguageModel } from "effect/ai"
import type { AssistantMessage } from "@xandreed/core/kernel"
import type { PointedMessage } from "../../contracts/loop/request.entity.js"
import { ModelFailed } from "./loop.entity.js"

/** The system text and the resolved messages as the model's prompt, in order. */
const promptOf = (system: string, messages: ReadonlyArray<PointedMessage>): Prompt.Prompt =>
  Prompt.make([
    { role: "system", content: system },
    ...messages.map(({ message }) => Match.valueTags(message, {
      User: ({ text }): Prompt.MessageEncoded => ({ role: "user", content: text }),
      Assistant: ({ text }): Prompt.MessageEncoded => ({ role: "assistant", content: text }),
    })),
  ])

/**
 * Send the system text and the resolved messages to the model and gather
 * its answer. The text streams: each piece goes to `onDelta` as it arrives,
 * and the whole of it is the message returned. The model's own error is the
 * failure, and so is an error the stream reports part-way (`ModelFailed`):
 * an answer cut by one is no answer. Every kind of part the stream can
 * carry is named here; the ones this cut does nothing with are ignored by
 * name, so a new kind does not compile until it is decided. No tools are
 * offered in this cut, so the answer asks for none.
 *
 * @public
 */
export const callModel = Effect.fn("kernel.call_model")(function* <E, R>(
  model: LanguageModel.LanguageModel,
  system: string,
  messages: ReadonlyArray<PointedMessage>,
  onDelta: (delta: string) => Effect.Effect<void, E, R>,
) {
  const keep = (text: string): Effect.Effect<string, E | ModelFailed, R> => Effect.succeed(text)
  const text = yield* model.streamText({ prompt: promptOf(system, messages) }).pipe(
    Stream.runFoldEffect(() => "", (text, part) => Match.value(part).pipe(Match.discriminatorsExhaustive("type")({
      "text-delta": ({ delta }): Effect.Effect<string, E | ModelFailed, R> => Effect.as(onDelta(delta), text + delta),
      error: ({ error }): Effect.Effect<string, E | ModelFailed, R> => Effect.fail(new ModelFailed({ message: "the model's stream reported an error", cause: error })),
      // Framing of the text, and the end of the answer: nothing to gather.
      "text-start": () => keep(text),
      "text-end": () => keep(text),
      finish: () => keep(text),
      "response-metadata": () => keep(text),
      // Reasoning, files and sources are not part of this cut's message.
      "reasoning-start": () => keep(text),
      "reasoning-delta": () => keep(text),
      "reasoning-end": () => keep(text),
      file: () => keep(text),
      source: () => keep(text),
      // Tools are not offered in this cut: with no toolkit the stream's type holds no call and no result, only these.
      "tool-params-start": () => keep(text),
      "tool-params-delta": () => keep(text),
      "tool-params-end": () => keep(text),
      "tool-approval-request": () => keep(text),
    }))),
  )
  const message: AssistantMessage = { _tag: "Assistant", text, toolCalls: [] }
  return message
})
