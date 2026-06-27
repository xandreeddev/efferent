import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { AuthStore, SettingsStore } from "@xandreed/sdk-core"
import type { RunConfig } from "./config/RunConfig.js"
import { makeEvalEnv, type EvalEnv } from "./env.js"
import type { EvalSpec } from "./framework/Eval.js"
import { runEval } from "./framework/runEval.js"
import { buildReport, fileHash, gitSha, readReport, reportExists, writeReport, type RunManifest } from "./storage.js"
import { resolveImageDigest } from "./support/dockerSandbox.js"
import { JUDGE_LABELS, judgeLabeledCases } from "./support/judgeAgreement.js"
import { makeCollector } from "./telemetry/collect.js"
import { processSpans } from "./trace/process.js"
import { renderRuns, renderVsBaseline } from "./trace/report.js"
import { coderEditEval } from "./suites/coderEdit.eval.js"
import { distillEval } from "./suites/distill.eval.js"
import { handoffEval } from "./suites/handoff.eval.js"
import { compactionDigestEval } from "./suites/compactionDigest.eval.js"
import { feature } from "./suites/feature.eval.js"
import { judgeApprovalEval } from "./suites/judgeApproval.eval.js"
import { quality } from "./suites/quality.eval.js"
import { repoTasksEval } from "./suites/repoTasks.eval.js"
import { researchEfficiencyEval } from "./suites/researchEfficiency.eval.js"
import { sessionTitleEval } from "./suites/sessionTitle.eval.js"
import { swarmEval } from "./suites/swarm.eval.js"
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
  distillEval,
  swarmEval,
  researchEfficiencyEval,
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
  "--max-cost",
  "--shard",
  // NB: value-taking flags only. Boolean flags (`--json`, `--sequential`,
  // `--judge-agreement`) are read with `argv.includes` and must NOT be listed
  // here — otherwise the consumed-token loop swallows the NEXT arg (e.g. a suite
  // name), so `eval --sequential quality` would run every suite, not just quality.
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
const maxCost = (() => {
  const i = argv.indexOf("--max-cost")
  return i >= 0 && i + 1 < argv.length ? Number(argv[i + 1]) : undefined
})()
const shard = (() => {
  const i = argv.indexOf("--shard")
  if (i < 0 || i + 1 >= argv.length) return undefined
  const parts = argv[i + 1]!.split("/").map(Number)
  const current = parts[0]
  const total = parts[1]
  if (
    current !== undefined &&
    total !== undefined &&
    Number.isFinite(current) &&
    Number.isFinite(total) &&
    total > 0 &&
    current > 0 &&
    current <= total
  ) {
    return { current: current - 1, total }
  }
  return undefined
})()
const sequential = argv.includes("--sequential")

// `--shard N/M` keeps only this shard's cases of EACH suite, partitioning the
// actual work (and spend) across CI jobs — not just the printed report. Applied
// to `data` before the run so means/passRate/`--save` all reflect the shard.
const shardSpec = (s: AnySpec): AnySpec => {
  if (shard === undefined) return s
  const { current, total } = shard
  const keep = <X>(arr: ReadonlyArray<X>): ReadonlyArray<X> =>
    arr.filter((_, i) => i % total === current)
  return Effect.isEffect(s.data)
    ? { ...s, data: Effect.map(s.data, keep) }
    : { ...s, data: keep(s.data) }
}

const selected: ReadonlyArray<AnySpec> = picked
  .map((s) => (samplesOverride !== undefined ? { ...s, samples: samplesOverride } : s))
  .map(shardSpec)

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

// Suites run in parallel by default, but BOUNDED — an unbounded fan-out across
// all suites (each driving the full agent loop + per-case Docker) would invite
// the provider rate-limit storms `retryableLlm` exists to fight. `--sequential`
// (or a `--max-cost` budget) forces one-at-a-time.
const DEFAULT_SUITE_CONCURRENCY = 4

// Running cost across all configs/suites, re-derived from the collected spans
// (`SimpleSpanProcessor` exports synchronously on span end, so a read right after
// a suite finishes sees its spend). `--max-cost` uses it to gate further work.
let totalCostUsd = 0
let aborted = false
const recomputeCost = (): void => {
  totalCostUsd = processSpans(collector.getSpans()).reduce(
    (a, r) => a + r.suites.reduce((b, s) => b + s.cases.reduce((c, ca) => c + (ca.costUsd ?? 0), 0), 0),
    0,
  )
}
const overBudget = (): boolean => maxCost !== undefined && totalCostUsd >= maxCost

const runConfigGroup = (config: RunConfig | undefined) =>
  Effect.gen(function* () {
    // Settings: a pinned config ignores disk; the default path loads it.
    if (config === undefined) {
      yield* (yield* SettingsStore).load(process.cwd(), homedir())
    }
    if (maxCost !== undefined) {
      // Cost-budgeted: run suites one at a time and re-check the running total
      // BEFORE starting each next suite, so the budget actually caps spend
      // instead of only reporting it after the whole config ran.
      for (const s of selected) {
        recomputeCost()
        if (overBudget()) {
          aborted = true
          break
        }
        yield* runEval(s)
      }
    } else {
      // Bounded parallel by default; --sequential forces one-at-a-time.
      yield* Effect.forEach(selected, (s) => runEval(s), {
        discard: true,
        concurrency: sequential ? 1 : DEFAULT_SUITE_CONCURRENCY,
      })
    }
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
      "⚠ skipped — no provider key (set GOOGLE_GENERATIVE_AI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENCODE_API_KEY, or log in via ~/.efferent/auth.json)",
    )
    return
  }

  // `--judge-agreement`: grade the human-labelled set with the (independent)
  // judge and report κ + TPR/TNR — the gate for trusting the LLM-judge axis.
  if (argv.includes("--judge-agreement")) {
    const cfg = buildConfigs()[0]
    const s = yield* judgeLabeledCases(JUDGE_LABELS).pipe(Effect.provide(makeEvalEnv(cfg)))
    const verdict =
      s.cohensKappa >= 0.61 ? "substantial" : s.cohensKappa >= 0.41 ? "moderate" : "weak — do not trust"
    console.log(
      `\n▌ judge agreement (${cfg?.judge ?? "main model"})\n` +
        `  n=${s.n} · κ=${s.cohensKappa.toFixed(2)} (${verdict}) · raw=${(s.rawAgreement * 100).toFixed(0)}%` +
        ` · TPR=${s.tpr.toFixed(2)} · TNR=${s.tnr.toFixed(2)}\n` +
        `  confusion: tp=${s.confusion.tp} fp=${s.confusion.fp} tn=${s.confusion.tn} fn=${s.confusion.fn}`,
    )
    return
  }

  for (const config of buildConfigs()) {
    if (aborted) break
    yield* runConfigGroup(config)
    recomputeCost()
  }
  if (aborted && maxCost !== undefined) {
    console.error(
      `\n⚠ ABORTED — cost budget $${maxCost.toFixed(4)} exceeded ($${totalCostUsd.toFixed(4)} spent)`,
    )
    process.exitCode = 1
  }

  // Build the eval data from the collected spans — the single data path. Sharding
  // already happened on the inputs, so these runs reflect only this shard.
  const runs = processSpans(collector.getSpans())

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
    if (maxCost !== undefined) {
      const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
      console.log(dim(`   total cost: $${totalCostUsd.toFixed(4)} / $${maxCost.toFixed(4)} budget`))
      console.log("")
    }
  }

  // Don't persist a baseline from a run aborted mid-budget — it would understate
  // means/cost from a partial set of suites.
  if (savePath !== undefined && !aborted) {
    const label = flag("--label")
    // Reproducibility manifest: pin the sandbox image digest, the dep-lock hash,
    // and the per-config model selections into the committed baseline.
    const models: Record<string, Record<string, string>> = {}
    for (const c of buildConfigs()) {
      if (c === undefined) continue
      models[c.name] = {
        main: c.main,
        ...(c.code !== undefined ? { code: c.code } : {}),
        ...(c.fast !== undefined ? { fast: c.fast } : {}),
        ...(c.judge !== undefined ? { judge: c.judge } : {}),
      }
    }
    const digest = resolveImageDigest()
    const lock = fileHash("bun.lock")
    const manifest: RunManifest = {
      ...(digest !== undefined ? { imageDigest: digest } : {}),
      ...(lock !== undefined ? { bunLockHash: lock } : {}),
      ...(Object.keys(models).length > 0 ? { models } : {}),
    }
    writeReport(savePath, buildReport(runs, new Date().toISOString(), gitSha(), label, manifest))
    console.log(`saved baseline → ${savePath}`)
  }

  const anyFail = runs.some((r) => r.suites.some((s) => s.mean < 0.6))
  if (anyFail) process.exitCode = 1
}).pipe(Effect.provide(collector.layer))

BunRuntime.runMain(program)
