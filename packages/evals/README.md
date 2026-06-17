<p align="center">
  <img src="../../assets/logo-evals.svg" alt="efferent [ evals ]" width="520">
</p>

# @xandreed/evals

> A minimal, **Effect-native** eval library + the agent's own eval suites. Trace-first: production code only annotates spans; evals **build their data from the collected traces**.

A driver-level package (depends on `@xandreed/sdk-core` + `@xandreed/sdk-adapters`, composes them at the edge like the CLI, never imports the CLI). Built when Evalite hit three hard incompatibilities at once — `data → task → scorers` re-expressed as Effects, so a `task` can be the real agent loop and a `Scorer` can itself call an LLM. No sqlite, no UI; runs under Bun directly.

## Layout

- **`framework/`** — `Eval.ts` (`EvalSpec` / `Scorer` / `defineEval`), `scorers.ts` (`predicate` · `includesAll` · `fromEffect` · `llmJudge`), `runEval.ts` (wraps suite/case/scorer in **spans**), `report.ts` (coloured per-suite ANSI scorecard).
- **`config/`** — `RunConfig` pins `{ main, fast, judge, promptVariant, maxSteps }`; `FixedSettingsStoreLive` ignores disk so a `--config matrix.json` run is A/B'd against a baseline.
- **`telemetry/`** + **`trace/`** — collect spans in-memory (and to OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set), then `processSpans()` **builds the eval report from the traces**.
- **`suites/`** — `handoff`, `tool-selection`, `coder-edit`, `whole-task` (the full loop), plus fast-model suites: `judge-approval`, `headroom-digest`, `session-title`.

## Run

```bash
bun run eval [name …] [--config f] [--main m] [--fast m] [--json]
```

Gated on a provider key being present — no key, it skips cleanly. Unit tests (`bun test`) cover the framework, the store-fold contract, and the pure trace processor with synthetic spans (no LLM, no Docker).

Part of [**efferent**](../../README.md) — a coding agent on Effect.ts + Bun.
