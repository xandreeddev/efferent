import { Schema } from "effect"

export const JourneyAction = Schema.Union(
  Schema.Struct({ type: Schema.Literal("message"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("click"), target: Schema.String }),
  Schema.Struct({ type: Schema.Literal("cancel", "reconnect", "reopen") }),
)
export const JourneyExpectation = Schema.Struct({
  requiredTools: Schema.Array(Schema.String),
  forbiddenTools: Schema.Array(Schema.String),
  recipes: Schema.Array(Schema.String),
  components: Schema.Array(Schema.String),
  outcome: Schema.Literal("answered", "clarification", "out-of-scope", "cancelled"),
  requiredText: Schema.Array(Schema.String),
  forbiddenText: Schema.Array(Schema.String),
  forbiddenComponents: Schema.optional(Schema.Array(Schema.String)),
  requiredLinks: Schema.optional(Schema.Array(Schema.String)),
  canvas: Schema.optional(Schema.Boolean),
  layout: Schema.optional(Schema.String),
  minAgentSteps: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  maxNewRuns: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
})
export const JourneyTurn = Schema.Struct({ action: JourneyAction, expected: JourneyExpectation })
export const Journey = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  persona: Schema.Struct({ id: Schema.String, category: Schema.String, authenticated: Schema.Boolean }),
  tier: Schema.Literal("blocking", "quality", "exploratory"),
  tierReason: Schema.String,
  expectedLocale: Schema.String,
  description: Schema.String,
  fixture: Schema.String,
  turns: Schema.Array(JourneyTurn).pipe(Schema.minItems(1)),
})
export type Journey = typeof Journey.Type
export type JourneyTurn = typeof JourneyTurn.Type
export type JourneyExpectation = typeof JourneyExpectation.Type
export const JourneyObservation = Schema.Struct({
  text: Schema.String, locale: Schema.String,
  tools: Schema.Array(Schema.String), recipes: Schema.Array(Schema.String), components: Schema.Array(Schema.String),
  outcome: Schema.String, evidence: Schema.Array(Schema.String),
  costUsd: Schema.Number.pipe(Schema.nonNegative()), latencyMs: Schema.Number.pipe(Schema.nonNegative()),
  links: Schema.optional(Schema.Array(Schema.String)),
  canvas: Schema.optional(Schema.Boolean),
  layout: Schema.optional(Schema.String),
  agentSteps: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  newRuns: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
})
export type JourneyObservation = typeof JourneyObservation.Type
export const JourneyScore = Schema.Struct({ passed: Schema.Boolean, failures: Schema.Array(Schema.String) })
export type JourneyScore = typeof JourneyScore.Type
export const JourneyTrial = Schema.Struct({
  id: Schema.String, journeyId: Schema.String, mode: Schema.Literal("scripted", "live"),
  candidate: Schema.Record({ key: Schema.String, value: Schema.String }),
  observations: Schema.Array(JourneyObservation),
  scores: Schema.Array(JourneyScore),
  passed: Schema.Boolean,
  infrastructureError: Schema.OptionFromNullOr(Schema.String),
})
export type JourneyTrial = typeof JourneyTrial.Type
export class JourneyError extends Schema.TaggedError<JourneyError>()("JourneyError", { message: Schema.String }) {}
