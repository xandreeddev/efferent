import { Effect } from "effect"
import type { HarnessError } from "./harness/plugin.entity.js"
import { RunContext } from "./ports/run-context.port.js"
import type { DecisionRecord } from "./decision-record.entity.js"

/** Journal a decision on the current turn's bus (`decision.recorded`). */
export const recordDecision = (record: DecisionRecord): Effect.Effect<void, HarnessError, RunContext> =>
  RunContext.pipe(Effect.flatMap((run) => run.events.publish({ _tag: "decision.recorded", record })))
