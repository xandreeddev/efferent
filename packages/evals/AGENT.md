# @agent/evals

A minimal, Effect-native eval library + the agent's eval suites. Driver-level:
depends on `@agent/core` + `@agent/adapters` (composes them at the edge, like
`cli`) and never on `@agent/cli`.

## Layout

```
src/
├── index.ts            re-exports the framework (the reusable lib surface)
├── framework/
│   ├── Eval.ts         EvalSpec / Scorer / EvalCase / ScoreResult + defineEval + result types
│   ├── scorers.ts      predicate · includesAll · fromEffect · llmJudge (LLM-as-judge)
│   ├── runEval.ts      runEval(spec): Effect<EvalReport, never, R> — captures failures via Effect.exit
│   └── report.ts       coloured per-suite ANSI table (inline escapes; no cli dependency)
├── env.ts              EvalEnv type + EvalEnvLive (main.ts composition, Postgres → in-memory store)
├── support/
│   ├── inMemoryConversationStore.ts   ConversationStore over a Ref; mirrors Postgres fold semantics
│   ├── workspace.ts                   withTempWorkspace (acquire/release temp dir) + readWorkspaceFile
│   └── coder.ts                       runCoder — real coder agent over a temp repo + tool/file capture
├── suites/{handoff,toolSelection,coderEdit}.eval.ts
└── run.ts              bun run eval [name …] [--json] — key-gated, provides EvalEnvLive once
```

## Rules

- **A spec is pure data.** `defineEval({ name, data, task, scorers, threshold?, concurrency? })`.
  `task`/`scorers` return Effects; their environment `R` is supplied to the run, not baked in.
  Pin suite specs to `R = EvalEnv` so a subset-requiring task/scorer assigns by contravariance.
- **`runEval` leaves `R` open** and never errors — `run.ts` provides `EvalEnvLive` *once* around all
  suites so they share one set of provider clients + one `SettingsStore` (loaded once, honoring
  `AGENT_MODEL`). Every task/scorer goes through `Effect.exit`: a 429 (typed or defect) becomes a
  0-scored case, not a crash.
- **No Postgres, no Docker, no LLM in unit tests.** `EvalEnvLive` uses the in-memory store; the
  framework + store have `bun test` coverage that needs no key. Live suites are gated on
  `hasKey(GOOGLE_API_KEY|OPENAI_API_KEY)` and skip cleanly when absent.
- **Default `concurrency: 1`** — gentle on rate limits and safe over the shared in-memory store.
- Cases are inline today (dataset files are a deferred follow-up). Keep tool-selection cases
  read-only and bounded (allow-list + `stopAfterFirstToolTurn`) so a case is ~1 LLM call.

## Adding a suite

Create `src/suites/<name>.eval.ts` exporting `defineEval<I, O, T, EvalEnv>({...})`, then register
it in `run.ts`'s `SUITES`. Use `runCoder` (support/coder.ts) for anything that drives the real
agent loop over a workspace.
