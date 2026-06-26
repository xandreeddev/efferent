---
title: Colocated evals
description: An Effect-native eval harness that lives in the codebase — data → task → scorers, where the task can be the real agent loop.
sidebar:
  label: Evals
  order: 9
---

Evals live **in the codebase**, not bolted on — part of the wedge. `packages/evals` is a minimal,
Effect-native harness: the `data → task → scorers` shape expressed as Effects, so a `task` can be
the *real* agent loop and a `Scorer` can itself call an LLM.

For a hands-on guide — running suites, reading the scorecard, comparing baselines, and writing your own — see [Evaluating your agent](/docs/guides/evals-guide/).

## The shape

```ts
const spec = defineEval({
  name: "tool-selection",
  data: [{ input: "read foo.ts", expected: "read_file" }, /* … */],
  task: (input) => /* Effect<Output, …, R> — can run the real coder loop */,
  scorers: [predicate("picked-read", (a) => a.output.tool === "read_file")],
  threshold: 0.6,
})

const report = yield* runEval(spec)   // Effect<EvalReport> — never crashes a run
```

Every per-case and per-scorer failure is captured via `Effect.exit`, so a provider 429 scores 0 instead
of crashing the suite. Built-in scorers: `predicate`, `includesAll` (substring coverage), `fromEffect`,
and `llmJudge` (LLM-as-judge with retry and tolerant JSON extraction).

## Trace-first: the trace is the data

The framework's central design principle is that **the trace is the data**. Production code annotates
OpenTelemetry spans; `runEval` wraps each case in an `eval.case` span, annotating `eval.score.*`,
`eval.mean`, `eval.ok`, and `eval.stdev`. After the run, `processSpans` walks the collected span tree
and builds the report — scores from `eval.case`, tokens/cost from descendant `llm.generate` spans,
steps from `agent.turn` spans, config from the enclosing `eval.run` span.

There is **no separate metrics store**. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and the same run streams
to Grafana; the runner prints a deep link scoped to the run ID.

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

## Statistical rigor

A single LLM run is noisy. The framework addresses this at multiple levels:

- **N-sample runs** — `samples: 3` runs each case 3× and reports mean ± sample stdev.
- **Bootstrap 95% CI** — paired per-case deltas are resampled 2000× with a deterministic seeded PRNG.
- **Bonferroni correction** — when comparing multiple configs in a matrix, alpha is divided by the number of comparisons.
- **Cohen's d** — standardized effect size reported alongside every CI (0.2=small, 0.5=medium, 0.8=large).

The verdict is `✔ better` / `✘ worse` when the CI excludes 0, or `~ noise` when it doesn't. Trust the
CI over raw per-case deltas.

## Baselines

A **baseline** is a dated, git-stamped JSON snapshot of a run's per-config/per-suite/per-case
aggregates. Commit baselines to `packages/evals/baselines/` and compare later runs against them:

```sh
bun run eval quality --compare packages/evals/baselines/2026-06-26-quality.json
```

The baseline README at `packages/evals/baselines/README.md` documents what each snapshot captures
and interprets historical findings.

## No Docker, no sqlite

The eval environment mirrors the app's composition but swaps in an **in-memory** conversation store and a
fixed settings store — so a `--config matrix.json` run is a clean A/B against a baseline, with no Docker.

```sh
bun run eval [name …] [--config f] [--main m] [--fast m] [--json]
```

The inline model/prompt flags (`--fast`, `--code`, `--judge`, `--prompt`, `--max-steps`) only take
effect alongside **`--main`** (or a `--config` file) — they form a single ad-hoc config, so on their
own (without `--main`) they're ignored and the run uses your default settings.

Gated on having a key — no key, the run skips cleanly. (On a logged-in box it falls back to
`~/.efferent/auth.json`, so an unscoped `bun run eval <suite>` spends real money.) Suites cover the full loop (bug-fix, multi-file,
refactor, failing-test, read-only Q&A) plus the [fast-tier](/docs/concepts/providers/) use cases
(approval judging, compaction digests, session titles).

## Eval telemetry stays disjoint from prod

The collector tags every span with `service.name=efferent-evals` (→ Prometheus `job`) +
`deployment.environment=eval` + a per-invocation `resource.eval.run_id`. Prod dashboards filter
`{job="efferent"}`; eval dashboards filter `{job="efferent-evals"}`. They never mix.
