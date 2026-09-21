import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema, TestClock, TestContext } from "effect"
import { JourneyError, JourneyTrial, type Journey } from "./journey.entity.js"
import { scoreJourneyTurn, scoreSelection } from "./journey.entity.functions.js"
import { JourneyDriver, JourneyEvidence } from "./ports/journey.port.js"
import { runJourney } from "./journey.usecase.functions.js"

const journey: Journey = { id: "map", persona: { id: "guest", category: "runner", authenticated: false }, tier: "blocking", tierReason: "Grounding", expectedLocale: "en", description: "Show a sourced course", fixture: "race-v1", turns: [{ action: { type: "message", text: "Course?" }, expected: { requiredTools: ["read_race"], forbiddenTools: ["raw_sql"], recipes: [], components: ["map"], outcome: "answered", requiredText: [], forbiddenText: [] } }] }
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
  const result = scoreJourneyTurn({ ...journey.turns[0]!.expected, requiredLinks: ["/event"], canvas: true, layout: "paired", minAgentSteps: 2, maxNewRuns: 0, forbiddenComponents: ["untrusted"] }, { text: "", locale: "en", tools: ["read_race"], recipes: [], components: ["map", "untrusted"], outcome: "answered", evidence: ["snapshot"], costUsd: 0, latencyMs: 1 }, "en")
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
        Layer.succeed(JourneyDriver, { open: () => Effect.succeed({ perform: () => Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never), Effect.ensuring(Ref.set(released, true))) }) }),
        Layer.succeed(JourneyEvidence, { write: () => Ref.set(saved, true) }),
      )), Effect.fork,
    )
    yield* Deferred.await(started)
    yield* TestClock.adjust("91 seconds")
    const trial = yield* Fiber.join(fiber)
    return { trial, released: yield* Ref.get(released), saved: yield* Ref.get(saved) }
  }).pipe(Effect.provide(TestContext.TestContext)))
  expect(result.trial.passed).toBe(false)
  expect(result.released).toBe(true)
  expect(result.saved).toBe(true)
})
