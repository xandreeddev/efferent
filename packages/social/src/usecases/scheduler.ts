import { Clock, Effect, Schedule } from "effect"
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

    // Run first scan immediately
    yield* findOpportunitiesAndDraft(TARGET_QUERIES).pipe(
      Effect.catchAll((err) => Effect.logError(`Scan failed: ${(err as Error).message}`))
    )

    // Schedule subsequent scans every 2 hours
    const cronSchedule = Schedule.fixed("2 hours")
    
    yield* findOpportunitiesAndDraft(TARGET_QUERIES).pipe(
      Effect.catchAll((err) => Effect.logError(`Scan failed: ${(err as Error).message}`)),
      Effect.repeat(cronSchedule)
    )
  })
