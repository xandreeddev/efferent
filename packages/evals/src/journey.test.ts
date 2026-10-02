import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { JourneyError, JourneyTrial, type Journey } from "./journey.entity.js"
import { scoreJourneyTurn, scoreSelection } from "./journey.entity.functions.js"
import { JourneyDriver, JourneyEvidence } from "./ports/journey.port.js"
import { runJourney } from "./journey.usecase.functions.js"

const journey: Journey = { id: "map", persona: { id: "guest", category: "runner", authenticated: false }, tier: "blocking", tierReason: "Grounding", hostLocale: "en", description: "Show a sourced course", fixture: "race-v1", turns: [{ action: { type: "message", text: "Course?" }, expected: { locale: "en", requiredTools: ["read_race"], forbiddenTools: ["raw_sql"], recipes: [], components: ["map"], outcome: "answered", requiredText: [], forbiddenText: [] } }] }
test("failed infrastructure writes a failing trial and cannot become all-skipped success", async () => {
  const saved: unknown[] = []
  const result = await Effect.runPromise(runJourney(journey, { id: "trial", mode: "scripted", candidate: { model: "fixture" } }).pipe(Effect.provide(Layer.mergeAll(
    Layer.succeed(JourneyDriver, { open: () => Effect.fail(new JourneyError({ message: "Browser unavailable" })) }),
    Layer.succeed(JourneyEvidence, { write: (trial) => Effect.sync(() => { saved.push(trial) }) }),
  ))))
  expect(result.passed).toBe(false)
  expect(Option.isSome(result.infrastructureError)).toBe(true)
  expect(saved).toHaveLength(1)
})
test("high recall cannot erase a forbidden tool", () => {
  const result = scoreSelection(["read_race"], ["read_race", "raw_sql"], ["raw_sql"])
  expect(result.recall).toBe(1)
  expect(result.precision).toBe(0.5)
  expect(result.forbidden).toEqual(["raw_sql"])
})

test("unexpected driver defects still persist a failing trial", async () => {
  const saved: unknown[] = []
  const result = await Effect.runPromise(runJourney(journey, { id: "defect", mode: "scripted", candidate: {} }).pipe(Effect.provide(Layer.mergeAll(
    Layer.succeed(JourneyDriver, { open: () => Effect.die("Browser crashed unexpectedly") }),
    Layer.succeed(JourneyEvidence, { write: (trial) => Effect.sync(() => { saved.push(trial) }) }),
  ))))
  expect(result.passed).toBe(false)
  expect(Option.isSome(result.infrastructureError)).toBe(true)
  expect(saved).toHaveLength(1)
})

test("trial evidence survives JSON encoding and schema hydration", () => {
  const original = { id: "roundtrip", journeyId: "map", mode: "scripted" as const, candidate: {}, observations: [], scores: [], passed: false, infrastructureError: Option.some("offline") }
  const saved = JSON.stringify(Schema.encodeSync(JourneyTrial)(original))
  expect(Schema.decodeUnknownSync(JourneyTrial)(JSON.parse(saved))).toEqual(original)
})

test("visual evidence checks fail closed when observations are missing", () => {
  const result = scoreJourneyTurn({ ...journey.turns[0]!.expected, requiredLinks: ["/event"], canvas: true, layout: "paired", minAgentSteps: 2, maxNewRuns: 0, forbiddenComponents: ["untrusted"] }, { text: "", locale: "en", tools: ["read_race"], recipes: [], components: ["map", "untrusted"], outcome: "answered", evidence: ["snapshot"], costUsd: 0, latencyMs: 1 })
  expect(result.passed).toBe(false)
  expect(result.failures).toHaveLength(6)
})

test("stalled driver is interrupted and its failing trial is persisted", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const released = yield* Ref.make(false)
    const saved = yield* Ref.make(false)
    const fiber = yield* runJourney(journey, { id: "timeout", mode: "scripted", candidate: {} }).pipe(
      Effect.provide(Layer.mergeAll(
        Layer.succeed(JourneyDriver, { open: () => Effect.succeed({ perform: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Ref.set(released, true))) }) }),
        Layer.succeed(JourneyEvidence, { write: () => Ref.set(saved, true) }),
      )), Effect.forkChild,
    )
    yield* Deferred.await(started)
    yield* TestClock.adjust("91 seconds")
    const trial = yield* Fiber.join(fiber)
    return { trial, released: yield* Ref.get(released), saved: yield* Ref.get(saved) }
  }).pipe(Effect.provide(TestClock.layer())))
  expect(result.trial.passed).toBe(false)
  expect(result.released).toBe(true)
  expect(result.saved).toBe(true)
})

test("drivers receive only execution inputs; changing labels changes scores alone", async () => {
  const seen: unknown[] = []
  const layers = Layer.mergeAll(
    Layer.succeed(JourneyDriver, { open: (input) => Effect.sync(() => {
      seen.push(input)
      return { perform: (action) => Effect.sync(() => {
        seen.push(action)
        return { text: "resposta", locale: "pt", tools: ["read_race"], recipes: [], components: ["map"], outcome: "answered", evidence: ["journal"], costUsd: 0, latencyMs: 1 }
      }) }
    }) }),
    Layer.succeed(JourneyEvidence, { write: () => Effect.void }),
  )
  const scenario = { ...journey, turns: [{ ...journey.turns[0]!, expected: { ...journey.turns[0]!.expected, locale: "pt" } }] }
  const good = await Effect.runPromise(runJourney(scenario, { id: "a", mode: "scripted", candidate: {} }).pipe(Effect.provide(layers)))
  const wrong = await Effect.runPromise(runJourney(journey, { id: "b", mode: "scripted", candidate: {} }).pipe(Effect.provide(layers)))
  expect(good.passed).toBe(true)
  expect(wrong.passed).toBe(false)
  expect(seen.slice(0, 2)).toEqual(seen.slice(2))
  expect(seen[0]).toEqual({ id: "map", persona: journey.persona, hostLocale: "en", fixture: "race-v1" })
  expect(seen[1]).toEqual({ type: "message", text: "Course?" })
})

test("legacy same-language declarations require explicit migration", async () => {
  const { decodeLegacyJourney } = await import("./journey.entity.functions.js")
  const { Journey: JourneySchema } = await import("./journey.entity.js")
  const { hostLocale, ...metadata } = journey
  const old = { ...metadata, expectedLocale: hostLocale, turns: journey.turns.map(({ action, expected: { locale: _locale, ...expected } }) => ({ action, expected })) }
  expect(await Effect.runPromise(Effect.isFailure(Schema.decodeUnknownEffect(JourneySchema)(old)))).toBe(true)
  expect(await Effect.runPromise(decodeLegacyJourney(old))).toEqual(journey)
})
