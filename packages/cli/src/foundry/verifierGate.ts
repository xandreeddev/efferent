import { Effect } from "effect"
import { GateName, makeJudgeGate } from "@xandreed/foundry"
import type { Gate } from "@xandreed/foundry"
import { GateCrash } from "@xandreed/foundry"
import { Verifier } from "@xandreed/sdk-core"

/**
 * The runtime consumes foundry: the independent Opus deliverable gate
 * (`Verifier.gate`, `claude -p` in the repo — the mandatory end-of-objective
 * check in `driveLoop`) wrapped as a foundry rank-4 JUDGE gate, so a forge
 * pipeline can end with the exact same fail-closed sign-off the swarm loop
 * uses. Foundry never imports sdk-core — this adapter lives with the
 * runtime, and `R = Verifier` flows up into the pipeline type.
 *
 * `sound` → pass; `needs_work`/`blocked` → the reasons become findings that
 * `renderFeedback` routes back to the implementor; an unavailable verifier
 * (no `claude`) is a `GateCrash` the pipeline folds into a FAIL verdict —
 * never a silent pass, exactly like `gateOnce`'s `unavailable` event.
 */
export const makeVerifierJudgeGate = (input: {
  /** What the implementor was asked to do (the spec's goal + acceptance). */
  readonly task: string
  /** What it claims it did (rendered from the receipt / final text). */
  readonly summary: string
  readonly filesChanged: ReadonlyArray<string>
}): Gate<Verifier> =>
  makeJudgeGate("deliverable-verifier", (workspace) =>
    Effect.gen(function* () {
      const verifier = yield* Verifier
      const verdict = yield* verifier
        .gate({
          task: input.task,
          summary: input.summary,
          filesChanged: input.filesChanged,
          repoDir: workspace.rootDir,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new GateCrash({
                gate: GateName.make("deliverable-verifier"),
                message: `verifier unavailable: ${e.message}`,
              }),
          ),
        )
      return {
        sound: verdict.verdict === "sound",
        reasons: verdict.reasons,
      }
    }),
  )
