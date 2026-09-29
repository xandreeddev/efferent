import { Context } from "effect"
import type { Effect, Scope } from "effect"
import type { Journey, JourneyError, JourneyObservation, JourneyTrial, JourneyTurn } from "../journey.entity.js"

/** Drivers use the same browser/socket boundary as a real user. Opening a
 * trial acquires a scoped isolated identity and fixture, never shared state. */
export class JourneyDriver extends Context.Service<JourneyDriver, {
  readonly open: (journey: Journey) => Effect.Effect<{
    readonly perform: (turn: JourneyTurn) => Effect.Effect<JourneyObservation, JourneyError>
  }, JourneyError, Scope.Scope>
}>()("efferent/evals/JourneyDriver") {}
export class JourneyEvidence extends Context.Service<JourneyEvidence, {
  readonly write: (trial: JourneyTrial) => Effect.Effect<void, JourneyError>
}>()("efferent/evals/JourneyEvidence") {}
