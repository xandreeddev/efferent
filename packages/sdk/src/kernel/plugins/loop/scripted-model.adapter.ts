import { Effect, Layer, Match, Ref, Stream } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import type { LoopScript } from "../../contracts/loop/loop.entity.js"

const usage = { inputTokens: { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } }

/** One call's answer as the parts a model streams: a text delta for each piece. */
const answered = (pieces: ReadonlyArray<string>): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => Stream.fromIterable<Response.StreamPartEncoded>([
  { type: "text-start", id: "scripted" },
  ...pieces.map((delta) => ({ type: "text-delta" as const, id: "scripted", delta })),
  { type: "text-end", id: "scripted" },
  { type: "finish", reason: "stop", usage },
])

const down = AiError.make({ module: "ScriptedModel", method: "streamText", reason: new AiError.UnknownError({ description: "the scripted model was told to fail" }) })

/**
 * What a scripted model was sent, call by call: each message's role and text.
 *
 * @public
 */
export type ScriptedCalls = ReadonlyArray<ReadonlyArray<{ readonly role: string; readonly text: string }>>

const sent = (prompt: Prompt.Prompt): ScriptedCalls[number] =>
  prompt.content.map((message) => ({
    role: message.role,
    text: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join(""),
  }))

/**
 * A model that follows a script and calls no provider: call `n` streams
 * the script's `n`th answer or fails as it says, and calls past the
 * script's end repeat its last entry. It is what a host hands the loop
 * kit's subject (`loopConformance` gives each check its script), and what a
 * test or an example runs an agent on. `calls` is what it was sent so far.
 *
 * @public
 */
export const scriptedModel = Effect.fn("kernel.scripted_model")(function* (script: LoopScript) {
  const calls = yield* Ref.make<ScriptedCalls>([])
  const model = yield* LanguageModel.make({
    generateText: () => Effect.die("the scripted model only streams"),
    streamText: (options) => Stream.unwrap(Ref.modify(calls, (all) => {
      const step = script[Math.min(all.length, script.length - 1)]
      const stream = step === undefined ? Stream.fail(down) : Match.valueTags(step, {
        Answers: ({ pieces }) => answered(pieces),
        Fails: (): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => Stream.fail(down),
      })
      return [stream, [...all, sent(options.prompt)]] as const
    })),
  })
  return { model: Layer.succeed(LanguageModel.LanguageModel, model), calls: Ref.get(calls) }
})
