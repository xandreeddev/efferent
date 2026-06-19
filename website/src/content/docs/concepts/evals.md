---
title: Colocated evals
description: An Effect-native eval harness that lives in the codebase — data → task → scorers, where the task can be the real agent loop.
sidebar:
  label: Evals
  order: 9
---

Evals live **in the codebase**, not bolted on — part of the wedge. `packages/evals` is a minimal,
Effect-native harness: Evalite's `data → task → scorers` shape re-expressed as Effects, so a `task` can be
the *real* agent loop and a `Scorer` can itself call an LLM.

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
and `llmJudge` (LLM-as-judge).

## No Docker, no sqlite

The eval environment mirrors the app's composition but swaps in an **in-memory** conversation store and a
fixed settings store — so a `--config matrix.json` run is a clean A/B against a baseline, with no Docker.
Reports are built from in-memory spans; set `OTEL_EXPORTER_OTLP_ENDPOINT` and they also stream to Grafana.

```sh
bun run eval [name …] [--config f] [--main m] [--fast m] [--json]
```

Gated on having a key — no key, the run skips cleanly. Suites cover the full loop (bug-fix, multi-file,
refactor, failing-test, read-only Q&A) plus the [fast-tier](/efferent/concepts/providers/) use cases
(approval judging, headroom digests, session titles).
