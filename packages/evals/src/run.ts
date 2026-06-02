import { homedir } from "node:os"
import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { SettingsStore } from "@efferent/core"
import { GOOGLE_API_KEY, hasKey, OPENAI_API_KEY } from "@efferent/adapters"
import { EvalEnvLive, type EvalEnv } from "./env.js"
import type { EvalReport, EvalSpec } from "./framework/Eval.js"
import { formatReport } from "./framework/report.js"
import { runEval } from "./framework/runEval.js"
import { coderEditEval } from "./suites/coderEdit.eval.js"
import { handoffEval } from "./suites/handoff.eval.js"
import { toolSelectionEval } from "./suites/toolSelection.eval.js"

/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous specs */
type AnySpec = EvalSpec<any, any, any, EvalEnv>

const SUITES: ReadonlyArray<AnySpec> = [handoffEval, toolSelectionEval, coderEditEval]

// Usage: bun run eval [name ...] [--json]
const argv = process.argv.slice(2)
const json = argv.includes("--json")
const names = argv.filter((a) => !a.startsWith("-"))
const selected = names.length === 0 ? SUITES : SUITES.filter((s) => names.includes(s.name))

const skippedReport = (s: AnySpec, reason: string): EvalReport => ({
  name: s.name,
  ...(s.description !== undefined ? { description: s.description } : {}),
  cases: [],
  mean: 0,
  threshold: s.threshold ?? 0.6,
  passed: false,
  durationMs: 0,
  skipped: true,
  skipReason: reason,
})

const program = Effect.gen(function* () {
  if (selected.length === 0) {
    console.error(`No matching suite. Available: ${SUITES.map((s) => s.name).join(", ")}`)
    process.exitCode = 1
    return
  }

  // Live suites need a provider; without one, skip cleanly so the harness is
  // still demonstrably wired (no hard failure when credits aren't loaded yet).
  const haveKey = (yield* hasKey(GOOGLE_API_KEY)) || (yield* hasKey(OPENAI_API_KEY))

  const reports: Array<EvalReport> = []
  if (!haveKey) {
    for (const s of selected) {
      reports.push(
        skippedReport(s, "no provider key (set GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY)"),
      )
    }
  } else {
    // One load for the whole run — honors EFFERENT_MODEL / .efferent/config.json.
    const settings = yield* SettingsStore
    yield* settings.load(process.cwd(), homedir())
    for (const s of selected) {
      reports.push(yield* runEval(s))
    }
  }

  if (json) {
    console.log(JSON.stringify(reports, null, 2))
  } else {
    for (const r of reports) console.log(formatReport(r))
    console.log("")
  }

  if (reports.some((r) => r.skipped !== true && !r.passed)) process.exitCode = 1
}).pipe(Effect.provide(EvalEnvLive))

BunRuntime.runMain(program)
