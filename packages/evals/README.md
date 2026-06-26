<p align="center">
  <img src="../../assets/logo-evals.svg" alt="efferent [ evals ]" width="520">
</p>

# @xandreed/evals

> A minimal, **Effect-native** eval library + the agent's own eval suites. Trace-first: production code only annotates spans; evals **build their data from the collected traces**.

A driver-level package (depends on `@xandreed/sdk-core` + `@xandreed/sdk-adapters`, composes them at the edge like the CLI, never imports the CLI). The `data → task → scorers` shape expressed as Effects, so a `task` can be the real agent loop and a `Scorer` can itself call an LLM. No sqlite, no UI; runs under Bun directly.

## Quick Start

```bash
# Run all suites (requires a provider key)
bun run eval

# Run specific suites
bun run eval quality feature

# Run with a specific model
bun run eval quality --main opencode:kimi-k2.6 --code opencode:deepseek-v4-pro

# Compare against a committed baseline
bun run eval quality --compare packages/evals/baselines/2026-06-26-quality.json

# Run a model comparison matrix
bun run eval quality --config packages/evals/dataset/configs/code-model-matrix.json --samples 3

# Run with a cost budget (aborts if exceeded)
bun run eval --max-cost 2.00

# Shard across CI jobs
bun run eval --shard 1/4
```

## Layout

```
src/
├── framework/          # The reusable eval library
│   ├── Eval.ts         # EvalSpec, Scorer, EvalCase, defineEval
│   ├── scorers.ts      # predicate, includesAll, llmJudge, qualityRubric
│   ├── runEval.ts      # Executes specs with span-based observability
│   └── report.ts       # ANSI scorecard formatter
├── config/
│   ├── RunConfig.ts    # Model/prompt/step pinning for A/B tests
│   ├── settingsLayer.ts# FixedSettingsStoreLive (ignores disk)
│   └── promptVariants.ts # Named prompt transforms
├── telemetry/
│   ├── collect.ts      # In-memory + OTLP span collector
│   └── metrics.ts      # eval_score histogram + eval_cases_total counter
├── trace/
│   ├── process.ts      # Build RunAgg[] from ReadableSpan[]
│   ├── report.ts       # Comparison tables + baseline diff
│   └── significance.ts # Bootstrap 95% CI with Bonferroni + Cohen's d
├── env.ts              # EvalEnv + makeEvalEnv(config?)
├── support/
│   ├── coder.ts        # runCoder — real agent over temp repo
│   ├── scenarioRun.ts  # runScenario — trajectory + hidden-test capture
│   ├── repoTask.ts     # Docker-sandboxed real-commit tasks
│   └── workspace.ts    # withTempWorkspace
├── suites/             # The agent's eval suites
│   ├── quality.eval.ts      # Golden set: rubric + routing + efficiency
│   ├── feature.eval.ts      # Hard scenarios with hidden tests
│   ├── wholeTask.eval.ts    # End-to-end agent tasks
│   ├── handoff.eval.ts      # Handoff summary quality
│   ├── toolSelection.eval.ts# First-tool selection
│   ├── repoTasks.eval.ts    # Docker-sandboxed real commits
│   ├── judgeApproval.eval.ts# Fast-tier auto-approval judge
│   ├── compactionDigest.eval.ts # Compaction fidelity
│   └── sessionTitle.eval.ts # Session title generation
├── dataset/
│   ├── golden.ts       # Quality scenario definitions
│   ├── feature.ts      # Hard feature scenario definitions
│   └── configs/        # Model comparison matrices (JSON)
├── baselines/          # Committed baseline snapshots
└── run.ts              # CLI entry point
```

## The `data → task → scorers` Model

An eval is **pure data** — no runtime dependencies baked in:

```typescript
import { defineEval, predicate, llmJudge } from "@xandreed/evals"

const myEval = defineEval<string, string, null, never>({
  name: "echo",
  data: [
    { name: "hello", input: "hello", expected: null },
  ],
  task: (input) => Effect.succeed(input),
  scorers: [
    predicate("nonempty", ({ output }) => output.length > 0),
  ],
})
```

- **`data`** — an array of cases, or an `Effect` that loads them.
- **`task`** — an `Effect` that transforms `input → output`. Can be the real agent loop.
- **`scorers`** — array of judges. Each returns a `ScoreResult` (0..1 number or `{ score, detail }`).
- **`threshold`** — pass bar (default 0.6). Suite passes if mean ≥ threshold.
- **`samples`** — repeat each case N times and report mean ± stdev.

Run it:

```typescript
const report = await Effect.runPromise(runEval(myEval))
console.log(report.passed) // true | false
```

## Scorers

### Built-in scorers

| Scorer | Use case |
|--------|----------|
| `predicate(name, test)` | Pass/fail boolean check |
| `includesAll(name, pick)` | Fraction of substrings present |
| `llmJudge(name, buildPrompt)` | LLM-as-judge with retry + fault tolerance |
| `qualityRubric(name, build)` | Anchored 5-level rubric for trend-able scores |
| `fromEffect(name, score)` | Arbitrary Effect-based scorer |

### LLM Judge Robustness

`llmJudge` has several resilience features:

- **Tolerant JSON extraction** — handles markdown fences (` ```json `), preambles, and multiple JSON blocks (takes the last one).
- **Retry on transient failures** — 429, 5xx, timeouts retry up to 2× with 1s delay via `isTransientAiError`.
- **Graceful degradation** — permanent failures score 0 with a `detail` explaining the error, never crashing the suite.

### Adding a custom scorer

```typescript
const myScorer = fromEffect<string, string, null>("semantic-sim", ({ output, expected }) =>
  Effect.gen(function* () {
    const embedding = yield* computeEmbedding(output)
    const sim = cosineSimilarity(embedding, expectedEmbedding)
    return { score: sim, detail: `cosine=${sim.toFixed(3)}` }
  })
)
```

## Statistical Rigor

### N-Sample Runs

Set `samples: 3` on a spec or pass `--samples 3` on the CLI. Each case runs 3×. The framework reports:

- **Mean** — average score across samples
- **Stdev** — sample standard deviation (noise estimate)
- **Per-scorer aggregation** — each scorer's score is averaged across samples

### Baseline Comparison (`--compare`)

Compare a run against a committed baseline:

```bash
bun run eval quality --compare packages/evals/baselines/2026-06-26-quality.json
```

For each suite, the report shows:

- **Mean delta** — candidate mean − baseline mean
- **Bootstrap 95% CI** — paired per-case delta, resampled 2000× with a deterministic seeded PRNG
- **Bonferroni correction** — when comparing multiple configs, alpha is divided by the number of comparisons
- **Cohen's d** — standardized effect size (0.2=small, 0.5=medium, 0.8=large)
- **Verdict** — `✔ better` / `✘ worse` (CI excludes 0) or `~ noise`

### Committing Baselines

```bash
bun run eval quality --samples 3 \
  --save packages/evals/baselines/$(date +%F)-quality.json \
  --label "before routing fix"
git add packages/evals/baselines/
```

Baselines are dated, git-stamped JSON. They store per-config/per-suite/per-case aggregates (the same `RunAgg[]` the report is built from).

## Model Comparison Matrices

Define a matrix in JSON:

```json
[
  { "name": "baseline", "main": "google:gemini-3.5-flash" },
  { "name": "sonnet",   "main": "anthropic:claude-sonnet-4-6" }
]
```

Run it:

```bash
bun run eval quality --config packages/evals/dataset/configs/baseline.matrix.json
```

The first config is the comparison baseline. Every subsequent config is compared against it with Bonferroni-corrected CIs.

## Trace-First Architecture

The framework's central design principle: **the trace is the data**.

1. **Production code** annotates spans (`llm.generate`, `agent.turn`, etc.) with tokens, cost, model info.
2. **`runEval`** wraps each case in an `eval.case` span, annotating `eval.score.*`, `eval.mean`, `eval.ok`.
3. **`processSpans`** reads the collected `ReadableSpan[]` and builds `RunAgg[]` — scores, steps, tokens, cost — by walking the span tree.
4. **`renderRuns`** formats the aggregates into the ANSI scorecard.

There is **no separate metrics store**. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and the same run streams to Grafana.

### Span hierarchy

```
eval.run          (config attributes)
└── eval.suite    (suite name)
    └── eval.case (scores, ok, samples, stdev)
        ├── eval.task    (the agent loop)
        │   ├── llm.generate  (tokens, model, cost)
        │   └── agent.turn    (step count)
        └── eval.scorer:quality
            └── llm.generate  (judge call)
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `[names…]` | Run only matching suites |
| `--config <file.json>` | Model comparison matrix |
| `--main <model>` | Main model (`provider:id`) |
| `--fast <model>` | Fast/helper model |
| `--code <model>` | Code-tier model |
| `--judge <model>` | Pin judge model |
| `--max-steps <N>` | Step cap |
| `--prompt <variant>` | Prompt variant key |
| `--samples <N>` | Override sample count |
| `--compare <file>` | Compare against baseline |
| `--save <file>` | Save as baseline |
| `--label <text>` | Baseline label |
| `--max-cost <usd>` | Abort if cost exceeds budget |
| `--shard <N/M>` | Run only cases N of M |
| `--sequential` | Run suites sequentially (default: parallel) |
| `--json` | Output JSON instead of ANSI |

## Adding a Suite

1. Create `src/suites/<name>.eval.ts`:

```typescript
import { defineEval } from "../framework/Eval.js"
import { predicate } from "../framework/scorers.js"
import type { EvalEnv } from "../env.js"

export const mySuite = defineEval<string, string, null, EvalEnv>({
  name: "my-suite",
  threshold: 0.6,
  data: [
    { name: "case-1", input: "hello", expected: null },
  ],
  task: (input) => Effect.succeed(input),
  scorers: [predicate("nonempty", ({ output }) => output.length > 0)],
})
```

2. Register in `run.ts`'s `SUITES` array.

3. Use `runCoder` (from `support/coder.ts`) for real agent loops, or `runScenario` for trajectory + hidden-test capture.

## Environment

Evals need a provider key. The runner checks `AuthStore` and skips cleanly if none:

```bash
# Option 1: env var (CI path)
export OPENCODE_API_KEY=<key>
bun run eval quality

# Option 2: local auth.json (dev path)
bun run eval quality  # reads ~/.efferent/auth.json
```

## Unit Tests

```bash
bun test packages/evals
```

Covers:
- `runEval` aggregation and fault tolerance
- N-sample statistics (mean, stdev)
- Bootstrap CI determinism and significance
- Span processing with synthetic spans (no LLM, no Docker)

## Design Rules

- **A spec is pure data.** No runtime env baked in.
- **`runEval` never errors.** Every task/scorer goes through `Effect.exit` — failures become 0-scored cases.
- **No Postgres, no Docker in unit tests.** In-memory stores; trace processor is pure over synthetic spans.
- **Don't re-collect metrics in suites.** Tokens/steps/cost live on the agent's spans.
- **Eval telemetry stays disjoint from prod.** `service.name=efferent-evals`, `deployment.environment=eval`.

Part of [**efferent**](../../README.md) — an agent runtime on Effect.ts + Bun.
