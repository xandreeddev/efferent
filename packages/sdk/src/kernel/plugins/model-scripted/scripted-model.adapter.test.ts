import { describe, expect, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { AiError, LanguageModel, Prompt } from "effect/ai"
import { scriptedModel } from "./scripted-model.adapter.js"
import type { ScriptedAnswer } from "./scripted-model.entity.js"

/** What one call of a model that follows `step` hands on, part by part, and how it ends: worth another try or not. */
const firstCall = (step: ScriptedAnswer) =>
  Effect.runPromise(Effect.gen(function* () {
    const { model } = yield* scriptedModel([step])
    const parts: Array<string> = []
    const exit = yield* Effect.exit(LanguageModel.streamText({ prompt: Prompt.make("Hi.") }).pipe(
      Stream.runForEach((part) => Effect.sync(() => { parts.push(part.type === "text-delta" ? `text-delta ${part.delta}` : part.type) })),
      Effect.provide(model),
    ))
    const ended = Exit.match(exit, {
      onSuccess: () => "answered",
      onFailure: (cause) => {
        const error = cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))[0]
        return AiError.isAiError(error) ? (error.isRetryable ? "failed, worth another try" : "failed for good") : "failed otherwise"
      },
    })
    return { parts, ended }
  }))

describe("the scripted model's failures", () => {
  test("Fails: before anything or after some pieces, worth another try or not, as the script says", async () => {
    const cases: ReadonlyArray<readonly [ScriptedAnswer, { parts: Array<string>; ended: string }]> = [
      [{ _tag: "Fails" }, { parts: [], ended: "failed for good" }],
      [{ _tag: "Fails", retryable: true }, { parts: [], ended: "failed, worth another try" }],
      // A start and no piece: the shape of a model that began its answer and failed before a word.
      [{ _tag: "Fails", pieces: [] }, { parts: ["text-start"], ended: "failed for good" }],
      [{ _tag: "Fails", retryable: true, pieces: [] }, { parts: ["text-start"], ended: "failed, worth another try" }],
      [{ _tag: "Fails", pieces: ["It is "] }, { parts: ["text-start", "text-delta It is "], ended: "failed for good" }],
      [{ _tag: "Fails", retryable: true, pieces: ["It ", "is "] }, { parts: ["text-start", "text-delta It ", "text-delta is "], ended: "failed, worth another try" }],
    ]
    for (const [step, expected] of cases) expect({ step, ...(await firstCall(step)) }).toEqual({ step, ...expected })
  })
})
