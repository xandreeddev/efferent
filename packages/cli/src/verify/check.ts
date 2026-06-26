import { Effect } from "effect"
import type { CheckResult, CheckStatus, Tier } from "./report.js"

/**
 * The tiny check-runner: wrap a check body so it's timed and any failure/defect
 * degrades to a `fail` row instead of aborting the whole battery. Tiers return
 * `Effect<CheckOutcome>` bodies; `check(...)` stamps name/tier/ms around them.
 */

export interface CheckOutcome {
  readonly status: CheckStatus
  readonly detail?: string | undefined
}

export const pass = (detail?: string): CheckOutcome => ({ status: "pass", detail })
export const fail = (detail?: string): CheckOutcome => ({ status: "fail", detail })
export const skip = (detail?: string): CheckOutcome => ({ status: "skip", detail })
export const soft = (detail?: string): CheckOutcome => ({ status: "soft", detail })

/** `pass` when `cond`, else `fail` (or `soft` when `soft: true`) with `detail`. */
export const expect = (
  cond: boolean,
  detail: string,
  opts: { readonly soft?: boolean } = {},
): CheckOutcome => (cond ? pass(detail) : opts.soft ? soft(detail) : fail(detail))

export const check = (
  name: string,
  tier: Tier,
  body: Effect.Effect<CheckOutcome>,
): Effect.Effect<CheckResult> =>
  Effect.gen(function* () {
    const started = Date.now()
    const outcome = yield* body.pipe(
      Effect.catchAllCause((cause) =>
        Effect.succeed(fail(`crashed: ${String(cause).split("\n")[0]}`)),
      ),
    )
    return {
      name,
      tier,
      status: outcome.status,
      detail: outcome.detail,
      ms: Date.now() - started,
    }
  })
