---
title: Evaluating your agent
description: Run the eval suites, compare against baselines, interpret the statistical report, and write your own suites to measure what matters.
sidebar:
  label: Evaluating your agent
  order: 9
---

The eval framework lives in `packages/evals`. It is **colocated** — the eval harness, the scenarios, and the agent loop all share one codebase. Change the agent, run the evals, and you know immediately whether the change helped.

## What you'll do

1. Set up a provider key and run the built-in suites.
2. Read the scorecard and understand the statistics.
3. Compare a run against a committed baseline.
4. Run a model comparison matrix.
5. Write a custom eval suite.

## 1 · First run

Evals need a provider key. The runner checks for any of these env vars (CI path) or falls back to `~/.efferent/auth.json` (local dev path):

```sh
export OPENCODE_API_KEY=<your-key>
```

Run all suites:

```sh
bun run eval
```

Run just the quality scorecard:

```sh
bun run eval quality
```

Run with a specific model:

```sh
bun run eval quality --main opencode:kimi-k2.6 --code opencode:deepseek-v4-pro
```

If no key is present, the run skips cleanly with a warning — no crash, no partial run.

:::note
The first run can take several minutes. The `quality` suite runs the **real agent loop** end-to-end over a small golden set; each case is a genuine LLM call.
:::

## 2 · Reading the scorecard

A typical report looks like this:

```
━━ config: inline ━━

▌ quality  mean 0.99 · pass 100% · 5 cases
  ✓ bug-fix · off-by-one in one file    mean 1.00  quality=1.00  routing=1.00  efficiency=1.00  objective=1.00  5× · 47 steps · 325.4k→6.1k tok · $0.1234 · 177.2s
  ✓ feature · add a small pure function  mean 1.00  quality=1.00  routing=1.00  efficiency=1.00  objective=1.00  5× · 57 steps · 393.4k→12.7k tok · $0.2345 · 309.5s
  ...
  PASS  mean 0.99 (threshold 0.50)  · 5 cases · 486.7s
```

Each case line shows:

| Column | Meaning |
|--------|---------|
| `✓` / `~` / `✗` | Passed / below threshold / failed |
| `mean` | Average score across all scorers for this case |
| `quality=1.00` | Per-scorer score (0..1) |
| `5×` | 5 samples were run; the mean is averaged across them |
| `47 steps` | Root agent turns |
| `325.4k→6.1k tok` | Input → output tokens |
| `$0.1234` | Estimated cost (when a pricing table is available) |
| `177.2s` | Wall-clock duration |

The **suite verdict** (`PASS` / `FAIL`) compares the suite mean against the `threshold` (default 0.6). A suite can have every case at 1.0 and still fail if the threshold is higher — the threshold is your quality gate.

### What the scorers measure

The `quality` suite uses four scorers:

| Scorer | Type | What it checks |
|--------|------|----------------|
| `quality` | LLM judge (anchored rubric) | Correctness, completeness, scope discipline |
| `routing` | Objective (trajectory) | Did it delegate to the code tier when it should? |
| `efficiency` | Objective (steps) | Within the step budget? |
| `objective` | Objective (substrings) | Must/must-not substrings in the produced file |

## 3 · Baseline comparison

A **baseline** is a committed snapshot of a run. You generate one, commit it, and later runs compare against it to answer "did this change help?"

### Generate a baseline

```sh
bun run eval quality --samples 3 \
  --save packages/evals/baselines/$(date +%F)-quality.json \
  --label "before routing fix"
```

Then commit it:

```sh
git add packages/evals/baselines/
git commit -m "baseline: quality before routing fix"
```

### Compare against it

```sh
bun run eval quality --compare packages/evals/baselines/2026-06-26-quality.json
```

The comparison block shows, per suite:

```
▌ vs baseline (2026-06-26T06:03:02.683Z · 51a6572d399 · delegation hard-rule + multi-file judge fix)
  inline:
    quality          0.99 vs 0.82 · Δ +0.17 95%CI [0.05,0.29] (n=5) · d=2.15 large ✔ better
```

Reading this line:

- `0.99 vs 0.82` — candidate mean vs baseline mean
- `Δ +0.17` — raw improvement
- `95%CI [0.05,0.29]` — bootstrap confidence interval of the paired delta (2000 resamples, seeded PRNG)
- `(n=5)` — 5 paired cases
- `d=2.15 large` — Cohen's d (standardized effect size): 0.2=small, 0.5=medium, 0.8=large
- `✔ better` — the CI excludes 0, so the improvement is unlikely to be noise

:::tip
Trust the CI verdict over a raw per-case delta. A single case dipping from 1.0 to 0.8 is within noise; the CI tells you whether the *systematic* shift is real.
:::

### When the CI says "~ noise"

A `~ noise` verdict means the 95% CI **includes 0**. The observed delta could be sampling variation. Your options:

1. **Increase `--samples`** — noise shrinks with √N. Going from 3 to 5 samples tightens the CI significantly.
2. **Add discriminating cases** — if every model scores ~1.0 on every case, there's nothing to compare. Add harder scenarios (see the `feature` suite).
3. **Check the effect size** — even a "noise" result can have a medium Cohen's d if variance is high. A medium effect with a wide CI is a signal that needs more data.

## 4 · Model comparison matrices

A **matrix** is a JSON file with multiple `RunConfig` entries. The first is the baseline; every subsequent config is compared against it.

Example `matrix.json`:

```json
[
  {
    "name": "baseline",
    "main": "google:gemini-3.5-flash",
    "fast": "google:gemini-3.5-flash"
  },
  {
    "name": "sonnet",
    "main": "anthropic:claude-sonnet-4-6",
    "fast": "google:gemini-3.5-flash"
  }
]
```

Run it:

```sh
bun run eval quality --config matrix.json --samples 3
```

The report prints a per-config scorecard **plus** a comparison table. When there are multiple candidates, the framework applies **Bonferroni correction** — alpha is divided by the number of comparisons, so the family-wise error rate stays at 5%.

:::note
The bundled matrices live in `packages/evals/dataset/configs/`:
- `code-tier.json` — does having a code tier help?
- `code-model-matrix.json` — which model should back the code tier?
:::

## 5 · Writing a custom suite

A suite is pure data: `defineEval({ name, data, task, scorers, threshold? })`.

### A simple example

```ts
import { Effect } from "effect"
import { defineEval, predicate, llmJudge } from "@xandreed/evals"
import type { EvalEnv } from "../env.js"

interface Input {
  readonly code: string
}
interface Expected {
  readonly shouldExport: string
}

export const exportCheck = defineEval<Input, string, Expected, EvalEnv>({
  name: "export-check",
  threshold: 0.8,
  data: [
    {
      name: "has-default-export",
      input: { code: "export default function main() {}" },
      expected: { shouldExport: "default" },
    },
  ],
  task: (input) => Effect.succeed(input.code),
  scorers: [
    predicate("has-export", ({ output, expected }) =>
      output.includes(`export ${expected.shouldExport}`),
    ),
    llmJudge("quality", ({ output }) =>
      `Does this code have a clean export statement?\n\n${output}`,
    ),
  ],
})
```

Register it in `packages/evals/src/run.ts`:

```ts
import { exportCheck } from "./suites/exportCheck.eval.js"

const SUITES: ReadonlyArray<AnySpec> = [
  // ... existing suites
  exportCheck,
]
```

### Running the real agent loop

For end-to-end tests, use `runCoder` or `runScenario`:

```ts
import { runCoder } from "../support/coder.js"

const suite = defineEval<{ files: Record<string, string>; prompt: string }, CoderRun, Expected, EvalEnv>({
  name: "my-e2e",
  data: [
    {
      name: "fix-bug",
      input: {
        files: { "src/sum.ts": "export const sum = (a, b) => a - b\n" },
        prompt: "Fix the sum function — it subtracts instead of adding.",
      },
      expected: { mustContain: ["a + b"] },
    },
  ],
  task: (input) => runCoder(input.files, input.prompt, { readback: ["src/sum.ts"] }),
  scorers: [
    predicate("correct", ({ output, expected }) =>
      expected.mustContain.every((s) => output.files["src/sum.ts"]?.includes(s)),
    ),
  ],
})
```

### Using hidden tests (the discriminating pattern)

The strongest evals use **hidden tests** — the agent never sees them, so it can't game the scorer:

```ts
import { runScenario } from "../support/scenarioRun.js"

const suite = defineEval<Input, ScenarioRun, Expected, EvalEnv>({
  name: "hidden-test",
  data: [
    {
      name: "lru-cache",
      input: {
        files: { "lruCache.ts": "/* stub */" },
        prompt: "Implement an LRU cache with TTL...",
        readback: ["lruCache.ts"],
      },
      expected: {},
    },
  ],
  task: (input) => runScenario(input.files, input.prompt, {
    readback: input.readback,
    hiddenTests: { "lruCache.spec.ts": "/* test suite */" },
  }),
  scorers: [
    fromEffect("tests", ({ output }) =>
      Effect.succeed(output.testResult?.ratio ?? 0),
    ),
  ],
})
```

The `hiddenTests` are written into the workspace **after** the agent finishes, then `bun test` runs them. The agent must infer the full spec from the prompt — exactly what separates a strong coder from a weak one.

## 6 · Advanced CLI flags

| Flag | What it does |
|------|--------------|
| `--samples N` | Run each case N times; report mean ± stdev |
| `--compare <file>` | Compare against a committed baseline |
| `--save <file>` | Save this run as a baseline |
| `--label <text>` | Human note for the baseline |
| `--max-cost <usd>` | Abort if cumulative cost exceeds budget |
| `--shard N/M` | Run only cases N of M (for CI matrix builds) |
| `--sequential` | Run suites sequentially (default: parallel) |
| `--json` | Output JSON instead of ANSI |

## 7 · Trace-first debugging

The eval framework is **trace-first**: the report is built from collected OpenTelemetry spans, not a separate metrics store. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and the same run streams to Grafana:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  bun run eval quality
```

The run prints a Grafana deep link:

```
traces → http://localhost:3000/d/efferent-evals/efferent-evals?var-run=run-...
```

Click it to see:

- A waterfall of every `eval.case` span
- Descendant `llm.generate` spans with tokens, model, cost
- `agent.turn` spans counting steps
- `eval.scorer:*` spans showing judge latency

This is invaluable for debugging why a case scored low — was it the task (agent loop), the judge (LLM scoring), or a transient failure (429/timeout)?

## 8 · Design rules for custom suites

1. **A spec is pure data.** No runtime env baked into the spec; inject config via `makeEvalEnv(config)`.
2. **`runEval` never errors.** Every task/scorer goes through `Effect.exit` — a 429 scores 0, not a crash.
3. **Don't re-collect metrics.** Tokens/steps/cost live on the agent's spans; the task returns only what scorers read.
4. **Use hidden tests for objective truth.** LLM judges are calibrated but not infallible; hidden tests are ground truth.
5. **Pin the judge model.** Pass `--judge <model>` so baselines are comparable. A judge that changes between runs invalidates the comparison.
6. **Commit baselines with `--samples 3+`.** A baseline without variance understates noise; `--samples 3` carries enough signal for most comparisons.

## Further reading

- [Evals concept](/docs/concepts/evals/) — architecture and philosophy
- [Observability](/docs/concepts/observability/) — tracing, metrics, and Grafana dashboards
- [Providers](/docs/concepts/providers/) — model selection and the tier system
