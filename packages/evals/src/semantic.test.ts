import { expect, test } from "bun:test"
import { LanguageModel, Prompt } from "@effect/ai"
import { Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import { assessAll, unknownEvaluationUsage } from "./assessment.usecase.functions.js"
import { SemanticJudge } from "./ports/semantic-judge.port.js"
import { SemanticInput } from "./semantic.entity.js"
import { semanticResponseSchema } from "./semantic.entity.functions.js"
import { semanticEvaluator } from "./evaluators/semantic.js"
import { SemanticJevLive } from "./adapters/semantic-jev.adapter.js"
import { SemanticLlmLive } from "./adapters/semantic-llm.adapter.js"

const input: SemanticInput = { state: "Answer: open at 09:00. Evidence: hours 09:00–17:00.", questions: {
  groundedness: { type: "boolean", instructions: "All factual claims are supported by the evidence." },
  completeness: { type: "score", instructions: "Coverage of expected opening time.", criteria: ["Missing", "Partial", "Complete"] },
  preference: { type: "choice", instructions: "Choose the better supported answer.", criteria: { A: "First", B: "Second", tie: "Equal" } },
} }
const answers = { groundedness: { type: "boolean" as const, probability: 0.9 }, completeness: { type: "score" as const, score: 1.5 }, preference: { type: "choice" as const, choice: "A" } }
const evaluator = semanticEvaluator({ id: "quality", version: "rubric-v1", questions: input.questions, state: (value: { state: string }) => value.state })
const bindings = [{ evaluator, select: ["groundedness", "completeness", "preference"] }]
const finish = { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
const model = (prompts: Ref.Ref<ReadonlyArray<string>>) => Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
  generateText: (request) => Ref.update(prompts, (prior) => [...prior, JSON.stringify(request.prompt)]).pipe(Effect.as([{ type: "text" as const, text: JSON.stringify({ answers }) }, finish])),
  streamText: () => Stream.die("unused"),
}))

test("a single Jev request emits selected typed metrics and preserves unknown usage", async () => {
  const calls: SemanticInput[] = []
  const layer = SemanticJevLive({ evaluate: async (request) => { calls.push(request); return { answers } } })
  const [result] = await Effect.runPromise(assessAll(bindings, { state: input.state }).pipe(Effect.provide(layer)))
  expect(calls).toEqual([input])
  expect(result?.status).toBe("scored")
  expect(result?.metrics).toEqual([{ kind: "probability", name: "groundedness", value: 0.9 }, { kind: "score", name: "completeness", value: 1.5, min: 0, max: 2 }, { kind: "preference", name: "preference", value: "A" }])
  expect(result?.metadata.backend).toBe("jev")
  expect(Option.isNone(result!.usage.costUsd)).toBe(true)
  expect(Option.isNone(result!.usage.inputTokens)).toBe(true)
})

test("native LLM profiles pair distinct prompts and model Layers with the same rubric", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const seenA = yield* Ref.make<ReadonlyArray<string>>([])
    const seenB = yield* Ref.make<ReadonlyArray<string>>([])
    const profile = (variant: string, seen: Ref.Ref<ReadonlyArray<string>>) => SemanticLlmLive({
      id: `llm-${variant}`, metadata: { promptVersion: "1", variant },
      prompt: (request) => Prompt.make([{ role: "system", content: `Rubric profile ${variant}` }, { role: "user", content: JSON.stringify(request) }]),
    }).pipe(Layer.provide(model(seen)))
    const a = yield* assessAll(bindings, { state: input.state }).pipe(Effect.provide(profile("concise", seenA)))
    const b = yield* assessAll(bindings, { state: input.state }).pipe(Effect.provide(profile("detailed", seenB)))
    expect(a[0]?.metrics).toEqual(b[0]?.metrics)
    expect((yield* Ref.get(seenA))[0]).toContain("Rubric profile concise")
    expect((yield* Ref.get(seenB))[0]).toContain("Rubric profile detailed")
    expect((yield* Ref.get(seenA))[0]).toContain("09:00")
    expect(a[0]?.metadata.variant).toBe("concise")
    expect(a[0]?.metadata.backend).toBe("llm-concise")
    expect(Option.getOrThrow(a[0]!.usage.inputTokens)).toBe(10)
    expect(Option.getOrThrow(a[0]!.usage.outputTokens)).toBe(5)
    expect(Option.isNone(a[0]!.usage.costUsd)).toBe(true)
  }))
})

test("malformed, mismatched and non-finite answers fail without scores", async () => {
  const invalid = [null, {}, { ...answers, extra: answers.groundedness },
    { ...answers, groundedness: { type: "score", score: 1 } },
    { ...answers, groundedness: { type: "boolean", probability: 1.1 } },
    { ...answers, groundedness: { type: "boolean", probability: NaN } },
    { ...answers, completeness: { type: "score", score: Infinity } },
    { ...answers, completeness: { type: "score", score: -1 } },
    { ...answers, completeness: { type: "score", score: 3 } },
    { ...answers, preference: { type: "choice", choice: "C" } },
  ]
  await Promise.all(invalid.map(async (value) => {
    const [result] = await Effect.runPromise(assessAll(bindings, { state: input.state }).pipe(Effect.provide(SemanticJevLive({ evaluate: async () => ({ answers: value }) }))))
    expect(result?.status).toBe("error")
    expect(result?.metrics).toEqual([])
  }))
})

test("invalid rubrics fail before invoking transport", async () => {
  const calls: unknown[] = []
  const layer = SemanticJevLive({ evaluate: async () => { calls.push(true); return { answers } } })
  await Promise.all([{}, { q: { type: "boolean" as const, instructions: "" } }, { q: { type: "score" as const, instructions: "Score", criteria: ["Only one"] } }, { q: { type: "choice" as const, instructions: "Choose", criteria: {} } }].map(async (questions) => {
    const failed = await Effect.runPromise(Effect.flatMap(SemanticJudge, (judge) => judge.evaluate({ state: "", questions })).pipe(Effect.provide(layer), Effect.isFailure))
    expect(failed).toBe(true)
  }))
  expect(calls).toEqual([])
})

test("response schema constrains offered choices and fractional score bounds", () => {
  const schema = semanticResponseSchema(input.questions)
  expect(Schema.is(schema)({ answers })).toBe(true)
  expect(Schema.decodeUnknownEither(schema)({ answers: { ...answers, unexpected: answers.groundedness } })._tag).toBe("Left")
  expect(Schema.is(schema)({ answers: { ...answers, preference: { type: "choice", choice: "C" } } })).toBe(false)
  expect(Schema.is(schema)({ answers: { ...answers, completeness: { type: "score", score: 3 } } })).toBe(false)
})

test("categorical decisions remain usable directly but cannot become preference metrics", async () => {
  const questions = { route: { type: "choice" as const, instructions: "Choose a route", criteria: { search: "Search", answer: "Answer" } } }
  const calls: unknown[] = []
  const layer = SemanticJevLive({ evaluate: async () => { calls.push(true); return { answers: { route: { type: "choice", choice: "search" } } } } })
  const direct = await Effect.runPromise(Effect.flatMap(SemanticJudge, (judge) => judge.evaluate({ state: "", questions })).pipe(Effect.provide(layer)))
  expect(direct.answers.route).toEqual({ type: "choice", choice: "search" })
  const categorical = semanticEvaluator({ id: "route", version: "1", questions, state: () => "" })
  const [result] = await Effect.runPromise(assessAll([{ evaluator: categorical, select: ["route"] }], {}).pipe(Effect.provide(layer)))
  expect(result?.status).toBe("error")
  expect(calls).toHaveLength(1)
})

test("provider rejection stays a failed assessment with no implicit fallback", async () => {
  const [result] = await Effect.runPromise(assessAll(bindings, { state: input.state }).pipe(Effect.provide(SemanticJevLive({ evaluate: () => Promise.reject(new Error("offline")) }))))
  expect(result?.status).toBe("error")
  expect(result?.metrics).toEqual([])
  expect(Option.getOrThrow(result!.reason)).toContain("offline")
})

test("Jev enforces UTF-8 byte limits before transport", async () => {
  const calls: unknown[] = []
  const small = { state: "😀😀😀", questions: { q: { type: "boolean" as const, instructions: "Supported?" } } }
  const layer = SemanticJevLive({ maxInputBytes: JSON.stringify(small).length, evaluate: async () => { calls.push(true); return { answers } } })
  const failed = await Effect.runPromise(Effect.flatMap(SemanticJudge, (judge) => judge.evaluate(small)).pipe(Effect.provide(layer), Effect.isFailure))
  expect(failed).toBe(true)
  expect(calls).toHaveLength(0)
})

test("Jev deadlines abort the SDK request", async () => {
  const aborted: boolean[] = []
  const layer = SemanticJevLive({ timeoutMs: 10, evaluate: (_input, signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => { aborted.push(true); reject(new Error("aborted")) }) }) })
  const [result] = await Effect.runPromise(assessAll(bindings, { state: input.state }).pipe(Effect.provide(layer)))
  expect(result?.status).toBe("error")
  expect(Option.getOrThrow(result!.reason)).toContain("deadline")
  expect(aborted).toEqual([true])
})

test("invalid transport configuration fails acquisition", async () => {
  await Promise.all([{ timeoutMs: 0 }, { timeoutMs: NaN }, { maxInputBytes: 0 }, { maxInputBytes: 1.5 }].map(async (options) => {
    expect(await Effect.runPromise(Effect.flatMap(SemanticJudge, (judge) => judge.evaluate(input)).pipe(Effect.provide(SemanticJevLive({ ...options, evaluate: async () => ({ answers }) })), Effect.isFailure))).toBe(true)
  }))
})

test("custom backends are revalidated before metric conversion", async () => {
  const layer = Layer.succeed(SemanticJudge, {
    id: "custom", evaluate: () => Effect.succeed({ answers: { ...answers, preference: { type: "choice", choice: "missing" } }, usage: unknownEvaluationUsage, metadata: {} }),
  })
  const [result] = await Effect.runPromise(assessAll(bindings, { state: input.state }).pipe(Effect.provide(layer)))
  expect(result?.status).toBe("error")
  expect(result?.metrics).toEqual([])
})


test("interrupting a judge aborts the pending SDK request", async () => {
  const started = Promise.withResolvers<void>()
  const aborted: boolean[] = []
  const layer = SemanticJevLive({ evaluate: (_input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted.push(true); reject(new Error("cancelled")) })
    started.resolve()
  }) })
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.flatMap(SemanticJudge, (judge) => judge.evaluate(input)).pipe(Effect.provide(layer), Effect.fork)
    yield* Effect.promise(() => started.promise)
    yield* Fiber.interrupt(fiber)
  }))
  expect(aborted).toEqual([true])
})
