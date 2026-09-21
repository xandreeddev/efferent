import { Context } from "effect"
import type { Effect, Scope } from "effect"
import type { Journey, JourneyError, JourneyObservation, JourneyTrial, JourneyTurn } from "../journey.entity.js"

/** Drivers use the same browser/socket boundary as a real user. Opening a
 * trial acquires a scoped isolated identity and fixture, never shared state. */
export class JourneyDriver extends Context.Tag("efferent/evals/JourneyDriver")<JourneyDriver, {
  readonly open: (journey: Journey) => Effect.Effect<{
    readonly perform: (turn: JourneyTurn) => Effect.Effect<JourneyObservation, JourneyError>
  }, JourneyError, Scope.Scope>
}>() {}
export class JourneyEvidence extends Context.Tag("efferent/evals/JourneyEvidence")<JourneyEvidence, {
  readonly write: (trial: JourneyTrial) => Effect.Effect<void, JourneyError>
}>() {}
