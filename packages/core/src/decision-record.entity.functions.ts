import { Effect } from "effect"
import { RunContext } from "./ports/run-context.port.js"
import type { DecisionRecord } from "./decision-record.entity.js"
import type { TurnError } from "./session/sessions.entity.js"

/** Journal a decision on the current turn's bus (`decision.recorded`). */
export const recordDecision = (record: DecisionRecord): Effect.Effect<void, TurnError, RunContext> =>
  RunContext.pipe(Effect.flatMap((run) => run.events.publish({ _tag: "decision.recorded", record })))
