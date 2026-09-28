import { describe, expect, test } from "bun:test"
import { Effect, FiberRef, Option, Ref } from "effect"
import { CurrentPromptProvenance, PromptId } from "@xandreed/core"
import { defineDecisionPrompt, evaluateDecision, rawDecision, renderDecision, validateAnswers } from "./decision.entity.functions.js"
import type { EvaluationWire } from "./evaluation-model.adapter.js"
import { makeEvaluationModel, scriptedEvaluationModel } from "./evaluation-model.adapter.js"
import { EvaluationModel } from "./ports/evaluation-model.port.js"

/** Is a reply grounded, and which tone does it take? */
const review = defineDecisionPrompt({
  id: "test.review",
  version: "review-v1",
  family: "reply-review",
  state: (input: { readonly reply: string }) => ({ reply: input.reply }),
  questions: () => ({
    grounded: { type: "boolean", instructions: "Is every claim in the reply supported by the state?" },
    tone: { type: "choice", instructions: "Which tone does the reply take?", criteria: { neutral: "Plain and factual.", warm: "Friendly." } },
  }),
  variants: {
    baseline: { shared: {} },
    strict: {
      shared: { grounded: { instructions: "Is every claim, number and name in the reply stated in the state?" } },
      // The most specific fragment replaces the shared one; it does not merge with it.
      models: { "eval/judge": { grounded: { instructions: "Is every claim, number and name in the reply stated in the state?" }, tone: { criteria: { warm: "Friendly, never flattering." } } } },
    },
  },
})

const expectedHash = (state: string, questions: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify({ state, questions })).digest("hex")

describe("decision prompts", () => {
  test("a variant rewords questions; the provenance hashes the state and the questions as sent", async () => {
    const [baseline, strict, shared] = await Effect.runPromise(Effect.all([
      renderDecision(review, { reply: "It opens at nine." }),
      renderDecision(review, { reply: "It opens at nine." }, { model: "eval/judge", variant: "strict" }),
      renderDecision(review, { reply: "It opens at nine." }, { model: "eval/other", variant: "strict" }),
    ]))
    expect(baseline!.state).toBe('{"reply":"It opens at nine."}')
    expect(baseline!.provenance).toEqual({
      id: PromptId.make("test.review"), version: "review-v1", variant: "baseline", modelOverride: Option.none(),
      hash: expectedHash(baseline!.state, baseline!.questions),
    })
    expect(strict!.questions.grounded.instructions).toBe("Is every claim, number and name in the reply stated in the state?")
    expect(strict!.questions.tone).toEqual({ type: "choice", instructions: "Which tone does the reply take?", criteria: { neutral: "Plain and factual.", warm: "Friendly, never flattering." } })
    expect(strict!.provenance).toMatchObject({ variant: "strict", modelOverride: Option.some("eval/judge"), hash: expectedHash(strict!.state, strict!.questions) })
    expect(strict!.family).toBe("reply-review")
    expect(shared!.questions.grounded.instructions).toBe(strict!.questions.grounded.instructions)
    expect(shared!.questions.tone.criteria).toEqual({ neutral: "Plain and factual.", warm: "Friendly." })
    expect(shared!.provenance.modelOverride).toEqual(Option.none())
  })

  test("a variant may not add questions or choices", async () => {
    const adding = defineDecisionPrompt({
      id: "test.adding", version: "1", family: "test", state: () => "state",
      questions: () => ({ tone: { type: "choice", instructions: "Which tone?", criteria: { neutral: "Plain." } } }),
      variants: { baseline: { shared: { tone: { criteria: { rude: "Rude." } } } }, extra: { shared: { other: { instructions: "Another?" } } } },
    })
    const [choice, question] = await Effect.runPromise(Effect.all([
      Effect.either(renderDecision(adding, undefined)),
      Effect.either(renderDecision(adding, undefined, { model: "unknown", variant: "extra" })),
    ]))
    expect(choice).toMatchObject({ _tag: "Left", left: { code: "variant.invalid" } })
    expect(question).toMatchObject({ _tag: "Left", left: { code: "variant.invalid" } })
  })

  test("answers must answer every question asked, nothing else, with offered choices only", async () => {
    const asked = review.questions({ reply: "" })
    const check = (raw: unknown) => Effect.runPromise(Effect.either(validateAnswers(asked, raw)))
    expect(await check({ grounded: { type: "boolean", probability: 0.9 }, tone: { type: "choice", choice: "warm", confidence: 0.7 } })).toMatchObject({
      _tag: "Right", right: { grounded: { _tag: "boolean", probability: 0.9 }, tone: { _tag: "choice", choice: "warm", confidence: Option.some(0.7) } },
    })
    expect(await check({ grounded: { type: "boolean", probability: 0.9 }, tone: { type: "choice", choice: "angry" } })).toMatchObject({ _tag: "Left", left: { code: "invalid" } })
    expect(await check({ grounded: { type: "boolean", probability: 0.9 } })).toMatchObject({ _tag: "Left", left: { code: "invalid" } })
    expect(await check({ grounded: { type: "boolean", probability: 0.9 }, tone: { type: "choice", choice: "warm" }, extra: { type: "boolean", probability: 1 } })).toMatchObject({ _tag: "Left", left: { code: "invalid" } })
    expect(await check({ grounded: { type: "choice", choice: "neutral" }, tone: { type: "choice", choice: "warm" } })).toMatchObject({ _tag: "Left", left: { code: "invalid" } })
    expect(await check({ grounded: { type: "boolean", probability: 1.5 }, tone: { type: "choice", choice: "warm" } })).toMatchObject({ _tag: "Left", left: { code: "invalid" } })
  })

  test("the evaluation model sends the rendered decision, under its provenance, and checks what comes back", async () => {
    const { answers, sent, provenance } = await Effect.runPromise(Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<EvaluationWire>>([])
      const provenance = yield* Ref.make(Option.none<string>())
      const model = yield* makeEvaluationModel({
        model: "eval/judge",
        transport: (wire) => {
          Effect.runSync(Ref.update(sent, (all) => [...all, wire]))
          return Promise.resolve({ answers: { grounded: { type: "boolean", probability: 0.2 }, tone: { type: "choice", choice: "neutral" } } })
        },
      })
      const observed = EvaluationModel.of({
        model: model.model,
        evaluate: (rendered) => FiberRef.get(CurrentPromptProvenance).pipe(
          Effect.flatMap((current) => Ref.set(provenance, Option.map(current, (value) => value.hash))),
          Effect.zipRight(model.evaluate(rendered)),
        ),
      })
      const answers = yield* evaluateDecision(review, { reply: "It opens at nine." }).pipe(Effect.provideService(EvaluationModel, observed))
      return { answers, sent: yield* Ref.get(sent), provenance: yield* Ref.get(provenance) }
    }))
    expect(answers.grounded.probability).toBe(0.2)
    expect(answers.tone.choice).toBe("neutral")
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ model: "eval/judge", state: '{"reply":"It opens at nine."}' })
    expect(Option.isSome(provenance)).toBe(true)
  })

  test("a choice that was not offered, a slow transport and an oversized decision fail as values", async () => {
    const decision = rawDecision({ id: "test.raw", version: "1", family: "test" }, "state", {
      tone: { type: "choice", instructions: "Which tone?", criteria: { neutral: "Plain." } },
    })
    const evaluate = (options: Partial<Parameters<typeof makeEvaluationModel>[0]>) => Effect.runPromise(Effect.either(Effect.gen(function* () {
      const model = yield* makeEvaluationModel({ model: "eval/judge", transport: () => Promise.resolve({ answers: { tone: { type: "choice", choice: "rude" } } }), ...options })
      return yield* model.evaluate(yield* decision)
    })))
    expect(await evaluate({})).toMatchObject({ _tag: "Left", left: { _tag: "EvaluationError", code: "invalid" } })
    expect(await evaluate({ timeoutMs: 5, transport: () => new Promise(() => undefined) })).toMatchObject({ _tag: "Left", left: { code: "timeout" } })
    expect(await evaluate({ maxInputBytes: 10 })).toMatchObject({ _tag: "Left", left: { code: "budget" } })
    expect(await evaluate({ transport: () => Promise.reject(new Error("down")) })).toMatchObject({ _tag: "Left", left: { code: "unavailable" } })
    expect(await evaluate({ timeoutMs: 0 })).toMatchObject({ _tag: "Left", left: { code: "invalid" } })
  })

  test("a scripted model is checked like any other", async () => {
    const scripted = scriptedEvaluationModel(() => ({ grounded: { type: "boolean", probability: 1 }, tone: { type: "choice", choice: "warm" } }))
    const answers = await Effect.runPromise(evaluateDecision(review, { reply: "hi" }).pipe(Effect.provideService(EvaluationModel, scripted)))
    expect(answers.tone).toEqual({ _tag: "choice", choice: "warm", confidence: Option.none() })
    const offKey = scriptedEvaluationModel(() => ({ grounded: { type: "boolean", probability: 1 }, tone: { type: "choice", choice: "cold" } }))
    const exit = await Effect.runPromise(Effect.either(evaluateDecision(review, { reply: "hi" }).pipe(Effect.provideService(EvaluationModel, offKey))))
    expect(exit).toMatchObject({ _tag: "Left", left: { code: "invalid" } })
  })
})
