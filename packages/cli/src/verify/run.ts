import { Effect } from "effect"
import { DEFAULT_VERIFY_MODEL, hasCredential, type VerifyCtx } from "./context.js"
import { runContainerBattery } from "./container.js"
import { exitCodeFor, formatReport, type CheckResult, type VerifyReport } from "./report.js"
import { resolveTarget } from "./target.js"
import { runTierA } from "./tierA.js"
import { runTierB } from "./tierB.js"
import { runTierC } from "./tierC.js"

/**
 * `efferent verify` orchestrator: resolve the target, run the selected tiers
 * (Tier A always runs — it's the deterministic backbone), print the graded
 * report, clean up, and set a non-zero exit iff a HARD check failed.
 */

export type TierSelect = "A" | "B" | "C" | "all"

export interface VerifyOptions {
  readonly target?: string | undefined
  readonly model?: string | undefined
  readonly tier?: TierSelect | undefined
  readonly strict?: boolean | undefined
  readonly json?: boolean | undefined
  /** Keep temp workspaces / containers for debugging. */
  readonly keep?: boolean | undefined
}

const wantB = (t: TierSelect): boolean => t === "B" || t === "C" || t === "all"
const wantC = (t: TierSelect): boolean => t === "C" || t === "all"

export const runVerify = (opts: VerifyOptions): Effect.Effect<void> =>
  Effect.gen(function* () {
    const model = opts.model ?? DEFAULT_VERIFY_MODEL
    const tier: TierSelect = opts.tier ?? "all"
    const resolved = yield* resolveTarget(opts.target)

    const ctxBase: Omit<VerifyCtx, "repoRoot"> = {
      model,
      hasKey: hasCredential(),
      strict: opts.strict ?? false,
    }

    let checks: ReadonlyArray<CheckResult>

    if (resolved.kind === "container") {
      const ctx: VerifyCtx = { ...ctxBase, repoRoot: undefined }
      checks = yield* runContainerBattery(resolved.spec, resolved.expectVersion, ctx)
    } else {
      const ctx: VerifyCtx = { ...ctxBase, repoRoot: resolved.repoRoot }
      const runner = resolved.runner
      const acc: CheckResult[] = []
      acc.push(...(yield* runTierA(runner, ctx)))
      if (wantB(tier)) acc.push(...(yield* runTierB(runner, ctx)))
      if (wantC(tier)) acc.push(...(yield* runTierC(ctx)))
      if (!opts.keep) yield* runner.cleanup.pipe(Effect.ignore)
      checks = acc
    }

    const report: VerifyReport = { target: resolved.label, model, checks }

    yield* Effect.sync(() => {
      if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n")
      else process.stdout.write(formatReport(report))
      process.exitCode = exitCodeFor(report)
    })
  })
