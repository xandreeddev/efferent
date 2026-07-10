import { Effect, Schedule } from "effect"
import { findOpportunitiesAndDraft } from "./opportunityFinder.js"

const TARGET_QUERIES = [
  "Effect.ts",
  "EffectTS",
  "typescript agent",
  "typescript concurrency",
  "typescript schema validation",
]

export const startDaemon = () =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Social daemon initialized.")
    yield* Effect.logInfo("Press Ctrl+C to terminate.")

    // Effect.repeat runs the effect ONCE immediately, then on the schedule —
    // an explicit first run before it double-scanned at startup (audit).
    yield* findOpportunitiesAndDraft(TARGET_QUERIES).pipe(
      Effect.catchAllCause((cause) => Effect.logError(`Scan failed: ${cause}`)),
      Effect.repeat(Schedule.fixed("2 hours")),
    )
  })
