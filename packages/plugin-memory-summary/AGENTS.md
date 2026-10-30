# @xandreed/plugin-memory-summary

Summarizing conversation memory: a `ConversationMemory` with the window strategy's full-fidelity log and render, which folds the oldest turns into one recorded summary (the previous summary included) once the rendered context passes `triggerRatio` of the budget. The summarizer is the `UtilityLlm` of the turn that opens the session. Node 24 and Bun; layer `plugin-memory-summary` in `foundry.config.ts` (imports core only).

## Rules

- The policy only decides: a `Summarize` action (`keepFromTurn`, `summary`) that core's `openLogSession` records; core's `handoffToMessage` is what shows the summary to the model.
- A summarizer that fails or outlasts `summaryTimeoutMs` decides nothing: log `summary left out: …` and let the turn go on; never fail the turn over it.
- After a failed or timed-out call, never ask the summarizer again in that turn (the `failed` ref in `memorySummaryPlugin`).
- Everything after the instructions in `summaryPrompt` is data: the transcript and an earlier summary go through core's `framed`, never pasted bare.
- Opening without a `UtilityLlm` in the turn's services fails with `memory.summary`.
- `open` is a `memory.open` span (`Effect.fn`); each ask of the summarizer is a `memory.summarize` span, failed when the call fails or outlasts `summaryTimeoutMs`. A step under the trigger asks nothing and opens no span.
- Bump `SUMMARY_STRATEGY.version` when a decision changes: every recorded `Compaction` and every `context.built` carries it.
- A text change updates its exact pin in `src/plugin.adapter.test.ts`.

## Public surface

- `memorySummaryPlugin` (also the default export) and `MemorySummaryLive` (its `.live` layer); `MemorySummaryConfig`, `memorySummaryDefaults`, `SUMMARY_STRATEGY`, `summaryPolicy`.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `memorySummaryPlugin` | `@xandreed/plugin-memory-summary` | runtime | `efferent/ConversationMemory` | none | none; optional: `@xandreed/core/UtilityLlm` (read from each turn's services) |

## Model-facing text

All of it goes to the summarizer (the utility model), not to the agent's model.

| Text | Source | Pinned by |
|---|---|---|
| Default `instructions` | `src/plugin.adapter.ts:53` | unpinned (the plugin reference shows it as a default) |
| The data rule, the earlier-summary line, `Reply with the summary only.` | `src/plugin.adapter.ts:81`, `:84`, `:87` | exact, `src/plugin.adapter.test.ts:37` |
| `<earlier-summary>` and `<conversation-transcript>` frames | `src/plugin.adapter.ts:84`, `:86` | exact, `src/plugin.adapter.test.ts:37` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | config, `summaryPrompt`, the summary policy, the plugin |
| `src/index.ts` | the public exports |

## Tests

- `src/plugin.adapter.test.ts`: the prompt, a summarizer that answers, fails or stalls (under `TestClock`), alone and in the plugin, and the spans.
- `packages/sdk/src/memory.conformance.test.ts` runs core's `memoryConformance` against this strategy and checks the `memory.summary` failure without a `UtilityLlm`.
- Run: `bun test packages/plugin-memory-summary packages/sdk/src/memory.conformance.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
