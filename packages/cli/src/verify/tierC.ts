import { join } from "node:path"
import { Effect } from "effect"
import { check, expect, skip, fail } from "./check.js"
import type { CheckResult } from "./report.js"
import type { VerifyCtx } from "./context.js"

/**
 * Tier C — LLM-as-judge, semantic smoke. Bridges to the existing evals runner
 * (the single source of judge logic) rather than re-implementing it: spawn a
 * curated, cheap fast-tier subset on the verify model and parse the `--json`
 * RunAgg. SOFT by default (a flaky judge shouldn't fail a build); `--strict`
 * promotes a sub-1.0 pass-rate to a hard fail. Source/commit only.
 */

// Cheap, fast-tier suites — they call the fast use cases directly (no full loop).
const SMOKE_SUITES = ["tool-selection", "session-title", "judge-approval"]

// Minimal shape of the evals `--json` output (RunAgg[]); typed loosely on purpose.
interface SuiteAggLite {
  readonly suite: string
  readonly passRate: number
}
interface RunAggLite {
  readonly suites: ReadonlyArray<SuiteAggLite>
}

// The evals runner prints its progress logs (`[HH:MM:SS] INFO …`) on stdout
// too, so a naive first-`[`/last-`]` slice grabs a timestamp bracket. The
// pretty-printed JSON array (`JSON.stringify(runs, null, 2)`) is the LAST block
// whose opening `[` sits on its own line — scan candidate `[`-lines from the
// bottom and return the first that parses.
export const extractJsonArray = (stdout: string): unknown => {
  const lines = stdout.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.trim().startsWith("[")) continue
    const candidate = lines.slice(i).join("\n")
    const end = candidate.lastIndexOf("]")
    if (end < 0) continue
    try {
      return JSON.parse(candidate.slice(0, end + 1))
    } catch {
      // not the array — keep scanning upward (e.g. a `[timestamp]` log line)
    }
  }
  return undefined
}

export const runTierC = (ctx: VerifyCtx): Effect.Effect<ReadonlyArray<CheckResult>> =>
  Effect.gen(function* () {
    if (ctx.repoRoot === undefined) {
      return [yield* check("evals-smoke", "C", Effect.succeed(skip("n/a — evals run from a source checkout")))]
    }
    if (!ctx.hasKey) {
      return [yield* check("evals-smoke", "C", Effect.succeed(skip("no credential")))]
    }

    return [
      yield* check("evals-smoke", "C", Effect.gen(function* () {
        const r = yield* Effect.tryPromise(async () => {
          const proc = Bun.spawn(
            [
              process.execPath, join(ctx.repoRoot!, "packages/evals/src/run.ts"),
              ...SMOKE_SUITES,
              "--main", ctx.model, "--fast", ctx.model, "--judge", ctx.model,
              "--samples", "1", "--json",
            ],
            { cwd: ctx.repoRoot!, stdout: "pipe", stderr: "pipe", env: process.env },
          )
          const [stdout, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            proc.exited,
          ])
          return { stdout, exitCode }
        }).pipe(Effect.orElseSucceed(() => ({ stdout: "", exitCode: 1 })))

        const parsed = extractJsonArray(r.stdout) as ReadonlyArray<RunAggLite> | undefined
        if (!parsed || parsed.length === 0) {
          return ctx.strict ? fail("no JSON report from evals runner") : skip("evals produced no report (key/transient)")
        }
        const suites = parsed.flatMap((run) => run.suites)
        const failing = suites.filter((s) => s.passRate < 1)
        const summary = suites.map((s) => `${s.suite} ${Math.round(s.passRate * 100)}%`).join(" · ")
        return expect(failing.length === 0, summary || "ran", { soft: !ctx.strict })
      })),
    ]
  })
