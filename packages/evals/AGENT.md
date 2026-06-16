# @efferent/evals

A minimal, Effect-native eval library + the agent's eval suites. Driver-level:
depends on `@efferent/core` + `@efferent/adapters` (composes them at the edge, like
`cli`) and never on `@efferent/cli`.

## Layout

```
src/
├── index.ts            re-exports the framework (the reusable lib surface)
├── framework/
│   ├── Eval.ts         EvalSpec / Scorer / EvalCase / ScoreResult + defineEval + result types
│   ├── scorers.ts      predicate · includesAll · fromEffect · llmJudge (LLM-as-judge)
│   ├── runEval.ts      runEval(spec) — wraps suite/case/scorer in SPANS, annotates eval.score.*
│   └── report.ts       coloured per-suite ANSI table (the live pass/fail scorecard)
├── config/             RunConfig + configHash · settingsLayer (FixedSettingsStoreLive) ·
│   │                   promptVariants · baseline.matrix.json
├── telemetry/
│   ├── collect.ts      makeCollector — NodeSdk + InMemorySpanExporter (+ OTLP when endpoint set)
│   └── metrics.ts      eval_score / eval_cases_total (Effect Metric, exported via the collector)
├── trace/
│   ├── process.ts      processSpans(ReadableSpan[]) → RunAgg[] — BUILD eval data from the traces
│   └── report.ts       renderRuns — per-config table + baseline-vs-candidate comparison
├── env.ts              EvalEnv type + makeEvalEnv(config?) — in-memory stores; adds UtilityLlm
├── support/
│   ├── inMemoryConversationStore.ts / inMemoryContextTreeStore.ts   Ref-backed; mirror Postgres
│   ├── workspace.ts    withTempWorkspace (acquire/release temp dir) + readWorkspaceFile
│   └── coder.ts        runCoder — real coder agent over a temp repo + tool/file capture
├── suites/{handoff,toolSelection,coderEdit,wholeTask,judgeApproval,headroomDigest,sessionTitle}.eval.ts
└── run.ts              bun run eval [name …] [--config f] [--main m] [--fast m] [--json]
```

## Trace-first: eval data IS the trace

The agent's prod code (core + adapters) only **annotates** OpenTelemetry spans + records metrics.
`runEval` adds `eval.suite → eval.case → eval.task/eval.scorer` spans and annotates each case's
`eval.score.*` / `eval.mean` / `eval.ok`. `run.ts` provides an **in-memory collector**
(`telemetry/collect.ts`) around the whole run, then **builds the report from the collected spans**
(`trace/process.ts` → `trace/report.ts`): tokens/cost come from descendant `llm.generate` spans,
steps from `agent.turn` spans, config from the enclosing `eval.run` span. There is **no separate
metrics/persistence store** — the trace is the data. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and the same
run also streams to Grafana (`grafana/otel-lgtm`); see `../../observability/`.

## Rules

- **A spec is pure data.** `defineEval({ name, data, task, scorers, threshold?, concurrency? })`.
  Pin specs to `R = EvalEnv` so a subset-requiring task/scorer assigns by contravariance.
- **Config injection.** `makeEvalEnv(config?)` pins `{main, fast, judge, promptVariant, maxSteps}`
  via a `FixedSettingsStoreLive` whose `load()` ignores disk — so a `--config` matrix run is the
  independent variable. No config ⇒ today's `LocalSettingsStoreLive` (honours `EFFERENT_MODEL`).
- **`runEval` never errors** — every task/scorer goes through `Effect.exit`: a 429 (typed or defect)
  becomes a 0-scored case, not a crash. Failures annotate `eval.ok=false` on the span.
- **No Postgres, no Docker, no LLM in unit tests.** In-memory stores; `trace/process.ts` is a pure
  function over synthetic `ReadableSpan[]` (see `process.test.ts`). Live suites skip cleanly with no key.
- **Don't re-collect metrics in `runCoder`/suites** — tokens/steps/cost live on the agent's spans.
  A suite's `task` returns only what its `scorers` read (final text, files, a verdict).

## Adding a suite

Create `src/suites/<name>.eval.ts` exporting `defineEval<I, O, T, EvalEnv>({...})`, register it in
`run.ts`'s `SUITES`. Use `runCoder` (support/coder.ts, with `systemPromptOverride` for prompt A/Bs)
for anything that drives the real agent loop; call a fast-tier use case directly
(`judgeApproval` / `compressToolResults` / `generateSessionTitle`) for fast-model suites.
