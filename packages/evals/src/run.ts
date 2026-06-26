import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { AuthStore, SettingsStore } from "@xandreed/sdk-core"
import type { RunConfig } from "./config/RunConfig.js"
import { makeEvalEnv, type EvalEnv } from "./env.js"
import type { EvalSpec } from "./framework/Eval.js"
import { runEval } from "./framework/runEval.js"
import { buildReport, gitSha, readReport, reportExists, writeReport } from "./storage.js"
import { makeCollector } from "./telemetry/collect.js"
import { processSpans } from "./trace/process.js"
import { renderRuns, renderVsBaseline } from "./trace/report.js"
import { coderEditEval } from "./suites/coderEdit.eval.js"
import { handoffEval } from "./suites/handoff.eval.js"
import { compactionDigestEval } from "./suites/compactionDigest.eval.js"
import { feature } from "./suites/feature.eval.js"
import { judgeApprovalEval } from "./suites/judgeApproval.eval.js"
import { quality } from "./suites/quality.eval.js"
import { repoTasksEval } from "./suites/repoTasks.eval.js"
import { sessionTitleEval } from "./suites/sessionTitle.eval.js"
import { toolSelectionEval } from "./suites/toolSelection.eval.js"
import { wholeTaskEval } from "./suites/wholeTask.eval.js"

/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous specs */
type AnySpec = EvalSpec<any, any, any, EvalEnv>

const SUITES: ReadonlyArray<AnySpec> = [
  quality,
  feature,
  handoffEval,
  toolSelectionEval,
  coderEditEval,
  wholeTaskEval,
  judgeApprovalEval,
  compactionDigestEval,
  sessionTitleEval,
  repoTasksEval,
]

// --- argv ---------------------------------------------------------------
// Usage: bun run eval [names…] [--config f.json] [--main m] [--fast m]
//                     [--max-steps N] [--prompt v] [--json]
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}
const json = argv.includes("--json")
const FLAG_NAMES = [
  "--config",
  "--main",
  "--fast",
  "--code",
  "--judge",
  "--max-steps",
  "--prompt",
  "--save",
  "--compare",
  "--label",
  "--samples",
]
const consumed = new Set<string>()
for (const f of FLAG_NAMES) {
  const i = argv.indexOf(f)
  if (i >= 0) {
    consumed.add(argv[i] as string)
    if (i + 1 < argv.length) consumed.add(argv[i + 1] as string)
  }
}
const names = argv.filter((a) => !a.startsWith("-") && !consumed.has(a))
const picked = names.length === 0 ? SUITES : SUITES.filter((s) => names.includes(s.name))
// `--samples N` overrides each suite's sample count (statistical rigor on demand
// — golden runs N=3, the noise on a delta shrinks with √N).
const samplesOverride = (() => {
  const i = argv.indexOf("--samples")
  return i >= 0 && i + 1 < argv.length ? Math.max(1, Number(argv[i + 1])) : undefined
})()
const selected: ReadonlyArray<AnySpec> =
  samplesOverride !== undefined ? picked.map((s) => ({ ...s, samples: samplesOverride })) : picked

// Build the list of configs to run. undefined ⇒ the default env (today's
// behavior). A `--config` file is an array of RunConfig; otherwise the inline
// model/prompt flags form a single ad-hoc config.
const buildConfigs = (): ReadonlyArray<RunConfig | undefined> => {
  const file = flag("--config")
  if (file !== undefined) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ReadonlyArray<RunConfig>
    return parsed
  }
  const main = flag("--main")
  if (main === undefined) return [undefined]
  const maxSteps = flag("--max-steps")
  const fast = flag("--fast")
  const code = flag("--code")
  const judge = flag("--judge")
  const prompt = flag("--prompt")
  return [
    {
      name: "inline",
      main,
      ...(fast !== undefined ? { fast } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(judge !== undefined ? { judge } : {}),
      ...(prompt !== undefined ? { promptVariant: prompt } : {}),
      ...(maxSteps !== undefined ? { maxSteps: Number(maxSteps) } : {}),
    },
  ]
}

const otlpEndpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]

// One id for this whole invocation — a RESOURCE attribute on every eval span
// (so the dashboard can scope the case-trace list to a single run) and printed
// as a Grafana deep link when the data reached the stack. A driver script, so
// Date.now() is fine.
const runId = `run-${Date.now().toString(36)}-${Math.round(performance.now()).toString(36)}`
const collector = makeCollector(otlpEndpoint, runId)

const runConfigGroup = (config: RunConfig | undefined) =>
  Effect.gen(function* () {
    // Settings: a pinned config ignores disk; the default path loads it.
    if (config === undefined) {
      yield* (yield* SettingsStore).load(process.cwd(), homedir())
    }
    yield* Effect.forEach(selected, (s) => runEval(s), { discard: true })
  }).pipe(
    Effect.withSpan("eval.run", {
      attributes: {
        "config.name": config?.name ?? "default",
        ...(config?.main !== undefined ? { "config.main": config.main } : {}),
        ...(config?.fast !== undefined ? { "config.fast": config.fast } : {}),
        ...(config?.code !== undefined ? { "config.code": config.code } : {}),
        ...(config?.promptVariant !== undefined ? { "config.prompt": config.promptVariant } : {}),
      },
    }),
    Effect.provide(makeEvalEnv(config)),
  )

const program = Effect.gen(function* () {
  if (selected.length === 0) {
    console.error(`No matching suite. Available: ${SUITES.map((s) => s.name).join(", ")}`)
    process.exitCode = 1
    return
  }

  // Live suites need a provider; without one, skip cleanly. Keys come from the
  // env (EnvAuthStoreLive), not auth.json.
  const haveKey = yield* Effect.gen(function* () {
    const creds = yield* (yield* AuthStore).all
    return Object.keys(creds).length > 0
  }).pipe(Effect.provide(makeEvalEnv()))

  if (!haveKey) {
    console.log(
      "⚠ skipped — no provider key (set GOOGLE_GENERATIVE_AI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY)",
    )
    return
  }

  for (const config of buildConfigs()) {
    yield* runConfigGroup(config)
  }

  // Build the eval data from the collected spans — the single data path.
  const spans = collector.getSpans()
  const runs = processSpans(spans)

  // Compare against a committed baseline (`--compare <path>`): per-suite delta +
  // bootstrap 95% CI → "is this change effective, or noise?".
  const comparePath = flag("--compare")
  // Persist this run as a (committable) baseline (`--save <path>`).
  const savePath = flag("--save")

  if (json) {
    console.log(JSON.stringify(runs, null, 2))
  } else {
    console.log(renderRuns(runs))
    if (comparePath !== undefined && reportExists(comparePath)) {
      console.log("")
      console.log(renderVsBaseline(runs, readReport(comparePath)))
    }
    console.log("")
    // The data only reached Grafana if an OTLP endpoint was set; otherwise the
    // report above is the whole story (in-memory only).
    if (otlpEndpoint !== undefined && otlpEndpoint.length > 0) {
      const grafana = process.env["EFFERENT_GRAFANA_URL"] ?? "http://localhost:3000"
      console.log(
        `   traces → ${grafana}/d/efferent-evals/efferent-evals?var-run=${encodeURIComponent(runId)}`,
      )
      console.log("")
    }
  }

  if (savePath !== undefined) {
    const label = flag("--label")
    writeReport(savePath, buildReport(runs, new Date().toISOString(), gitSha(), label))
    console.log(`saved baseline → ${savePath}`)
  }

  const anyFail = runs.some((r) => r.suites.some((s) => s.mean < 0.6))
  if (anyFail) process.exitCode = 1
}).pipe(Effect.provide(collector.layer))

BunRuntime.runMain(program)
