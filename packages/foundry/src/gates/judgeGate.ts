import { Effect, Option, Schedule } from "effect"
import { GateName, RuleId } from "../domain/Brands.js"
import type { GateCrash } from "../domain/Errors.js"
import { Finding } from "../domain/Finding.js"
import type { Gate, Workspace } from "../ports/Gate.js"

/** What a judge says about the workspace as a whole. */
export interface JudgeVerdict {
  readonly sound: boolean
  readonly reasons: ReadonlyArray<string>
}

const JUDGE_REJECTED = RuleId.make("judge/needs-work")

/**
 * A rank-4 gate from any judging function — the seam the runtime's
 * independent Opus `Verifier` plugs into (the adapter lives with the
 * runtime; foundry never imports it). Judges run LAST (`kindRank` 4): only
 * code that already survived every deterministic rank spends judge tokens.
 * `deterministic: false` is carried on the gate — a judge verdict is an
 * opinion, and the report says so.
 *
 * Fail-closed by construction: an unavailable judge is a `GateCrash`, which
 * the pipeline folds into a `fail` verdict — never a silent pass (mirroring
 * `gateLoop.ts`'s "unavailable is surfaced loudly").
 *
 * The judge call RETRIES before crashing (idempotent read; two spaced
 * re-runs): a transient upstream failure must not spend a whole forge
 * attempt — the 2026-07-12 dogfood run burned attempt 2 on a coder
 * spelunking the harness because one judge call hit a provider timeout
 * (task #110).
 */
export const makeJudgeGate = <R>(
  name: string,
  judge: (workspace: Workspace) => Effect.Effect<JudgeVerdict, GateCrash, R>,
): Gate<R> => ({
  name: GateName.make(name),
  kind: "judge",
  deterministic: false,
  run: (workspace: Workspace) =>
    judge(workspace).pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced("8 seconds") }),
      Effect.map((verdict) => {
        if (verdict.sound) return []
        // A rejection with no reasons must still FAIL (toVerdict passes on
        // zero error findings) — synthesize the reason.
        const reasons =
          verdict.reasons.length > 0
            ? verdict.reasons
            : ["the judge rejected the deliverable without naming reasons"]
        return reasons.map(
          (reason) =>
            new Finding({
              rule: JUDGE_REJECTED,
              severity: "error",
              message: reason,
              location: Option.none(),
              fixHint: Option.some("address the judge's reason, then the work is re-checked"),
            }),
        )
      }),
    ),
})
