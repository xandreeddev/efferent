import { Cause, Effect, Option, Ref, Schema } from "effect"
import { Journey, JourneyError, type JourneyObservation, type JourneyTrial } from "./journey.entity.js"
import { scoreJourneyTurn } from "./journey.entity.functions.js"
import { JourneyDriver, JourneyEvidence } from "./ports/journey.port.js"

/** Persist every trial before aggregation. Driver timeouts interrupt their
 * scoped browser/provider work; no disconnected background trial survives. */
export const runJourney = (input: Journey, metadata: Pick<JourneyTrial, "id" | "mode" | "candidate">) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
  const journey = yield* Schema.decodeUnknown(Journey)(input).pipe(Effect.mapError((error) => new JourneyError({ message: String(error) })))
  const driver = yield* JourneyDriver
  const evidence = yield* JourneyEvidence
  const observed = yield* Ref.make<ReadonlyArray<JourneyObservation>>([])
  const execution = yield* restore(Effect.scoped(Effect.gen(function* () {
    const session = yield* driver.open(journey).pipe(Effect.timeoutFail({ duration: "30 seconds", onTimeout: () => new JourneyError({ message: "Journey initialization exceeded its deadline" }) }))
    yield* Effect.forEach(journey.turns, (turn) => session.perform(turn).pipe(
      Effect.timeoutFail({ duration: "90 seconds", onTimeout: () => new JourneyError({ message: "Journey turn exceeded its deadline" }) }),
      Effect.tap((result) => Ref.update(observed, (prior) => [...prior, result])),
    ))
  }))).pipe(Effect.exit)
  const observations = yield* Ref.get(observed)
  const scores = observations.map((observation, index) => scoreJourneyTurn(journey.turns[index]!.expected, observation, journey.expectedLocale))
  const trial: JourneyTrial = {
    ...metadata, journeyId: journey.id, observations, scores,
    passed: execution._tag === "Success" && scores.length === journey.turns.length && scores.every((score) => score.passed),
    infrastructureError: execution._tag === "Failure" ? Option.some(Cause.pretty(execution.cause)) : Option.none(),
  }
  yield* evidence.write(trial)
  return trial
}))
