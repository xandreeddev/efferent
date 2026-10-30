import { Context } from "effect"
import type { Effect } from "effect"
import type { Trial } from "../domain/trial.entity.js"
import type { TranscriptEvent } from "../domain/transcript.entity.js"
import type { EvaluationRun } from "../domain/evaluation-run.entity.js"
import type { EvalPath, EvaluationError } from "../domain/identity.entity.js"

/**
 * Where a run's results are kept. The runner writes a trial when it starts,
 * once it settles (with its whole transcript) and after each grade; in
 * between, each transcript event is appended, so a running trial costs one
 * event's bytes per event, and a store that ignores appends still receives
 * every event at settlement.
 */
export class EvaluationRunStore extends Context.Service<EvaluationRunStore, {
  readonly writeTrial: (trial: Trial) => Effect.Effect<void, EvaluationError>
  /** One event of a running trial, after those before it (sequence from 0). Appends, never rewrites. */
  readonly appendTranscript: (trial: EvalPath, event: TranscriptEvent) => Effect.Effect<void, EvaluationError>
  readonly writeRun: (run: EvaluationRun) => Effect.Effect<void, EvaluationError>
}>()("efferent/evals/EvaluationRunStore") {}
