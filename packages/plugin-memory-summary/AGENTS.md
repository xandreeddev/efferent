# @xandreed/plugin-memory-summary

Summarizing conversation memory: a `ConversationMemory` with the window strategy's full-fidelity log and render, which folds older whole turns into one recorded summary (the previous summary included). Normal summaries run at `summarizeAt` (`turn-end` by default, `step` for pre-request timing); overflow can force an eligible reduction. The summarizer is the `UtilityLlm` of the turn that opens the session. Node 24 and Bun; layer `plugin-memory-summary` in `foundry.config.ts` (imports core only).

## Rules

- The policy only decides: a `Summarize` action (`keepFromTurn`, `summary`) that core's `openLogSession` records; core's `handoffToMessage` is what shows the summary to the model.
- The policy opts in with `checkpoint: "render"`. Core publishes a checkpoint only after an actually reducing summary and requested digests acknowledge, outside memory allocation and provider callbacks. A compatible durable checkpoint accelerates later rendering; the full archive and maintenance inputs remain complete. No extra summary call, initial archive I/O savings, deletion or strategy version change is implied. `src/plugin.adapter.test.ts` checks one checkpoint for one paid reducing summary.
- An expected utility failure or `summaryTimeoutMs` timeout decides nothing: log `summary left out: …` and let the turn go on. Original recorder/storage `TurnError` defects stay hard and retain identity, including defects raised during timeout cancellation cleanup. A terminal Exit captured outside the helper's cleanup is checked before softening a timeout; the pinned timeout awaits that cleanup.
- Each built-in opened session owns private tagged `Ready`/`Running`/`Failed` state. It declines concurrent or reentrant asks, remembers attempted prompt/frontier fingerprints for that session (including earlier frontiers revisited after a budget change), and prevents every later ask after a failed or timed-out call. It holds no lock while calling the provider. A new eligible frontier can be asked after an empty or nonreducing answer; the identical frontier cannot buy that answer repeatedly. Public `summaryPolicy` stays stateless and reusable across opened sessions; it owns the pure timing/reduction decisions, not the adapter's paid-attempt lifetime.
- Use `scaledTokens` consistently for the trigger, kept tail and prospective summary. Append `Summarize` only when its rendered context is smaller. Keep the current admitted turn intact, even after one `Turn.run` returns.
- `overflow` bypasses normal timing, successful cooldown and pressure threshold; it never resets failed-helper state. Normal cooldown counts admitted turns, not loop run ordinals.
- Everything after the instructions in `summaryPrompt` is data: the transcript and an earlier summary go through core's `framed`, never pasted bare.
- Opening without a `UtilityLlm` in the turn's services fails with `memory.summary`.
- `open` is a `memory.open` span (`Effect.fn`); each ask of the summarizer is a `memory.summarize` span, failed when the call fails or outlasts `summaryTimeoutMs`. A step under the trigger asks nothing and opens no span.
- `SUMMARY_STRATEGY.version` is `2`; bump it when a decision changes. Existing version 1 compactions and saved render recipes still apply without running a new summarizer.
- A text change updates its exact pin in `src/plugin.adapter.test.ts`; the sdk compaction golden shows it too, re-recorded with `EFFERENT_UPDATE_MODEL_GOLDEN=1` and the diff reviewed.

## Public surface

- `memorySummaryPlugin` (also the default export) and `MemorySummaryLive` (its `.live` layer); `MemorySummaryConfig`, `memorySummaryDefaults`, `SUMMARY_STRATEGY`, `summaryPolicy`.

The root names each export, and `quality/exports-have-consumers` checks each one: other packages' tests and the scripts import `memorySummaryPlugin`, and the rest, which no first-party code imports, are tagged `@public` at their declarations (`memorySummaryPlugin`'s tag covers the default export).

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `memorySummaryPlugin` | `@xandreed/plugin-memory-summary` | runtime | `efferent/ConversationMemory` | none | none; optional: `@xandreed/core/UtilityLlm` (read from each turn's services) |

## Model-facing text

All of it goes to the summarizer (the utility model), not to the agent's model.

| Text | Source | Pinned by |
|---|---|---|
| Default `instructions` (the plugin reference shows it as a default) | `src/plugin.adapter.ts:63` | exact, `src/plugin.adapter.test.ts:76`; sdk compaction golden |
| The data rule, the earlier-summary line, `Reply with the summary only.` | `src/plugin.adapter.ts:92`, `:95`, `:98` | exact, `src/plugin.adapter.test.ts:59`; sdk compaction golden |
| `<earlier-summary>` and `<conversation-transcript>` frames | `src/plugin.adapter.ts:95`, `:97` | exact, `src/plugin.adapter.test.ts:59`; sdk compaction golden |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | config, `summaryPrompt`, the summary policy, the plugin |
| `src/summary-attempt.entity.ts`, `src/summary-attempt.entity.functions.ts` | the per-session paid-attempt phase and pure claims |
| `src/index.ts` | the public exports |

## Tests

- `src/plugin.adapter.test.ts`: the prompt, a summarizer that answers, fails or stalls (under `TestClock`), alone and in the plugin, and the spans.
- `src/maintenance-policy.adapter.test.ts`: normal timing, force/cooldown, calibrated candidates, per-open no-progress memoization across budget oscillations, provider callback reentry, failed-helper preservation (including timeout cleanup) and public-policy reuse across sessions; `src/summary-attempt.entity.functions.test.ts` pins the phase transitions.
- `packages/sdk/src/memory.conformance.test.ts` runs core's `memoryConformance` against this strategy and checks the `memory.summary` failure without a `UtilityLlm`.
- The sdk compaction golden (`packages/sdk/src/agent.compaction-golden.test.ts`, `packages/sdk/golden/agent-compaction.model.json`) composes it with `cooldownTurns: 0` and a scripted summarizer: two summaries in consecutive turns, the second folding the first, each summarizer prompt recorded and the next request carrying core's handoff.
- Run: `bun test packages/plugin-memory-summary packages/sdk/src/memory.conformance.test.ts packages/sdk/src/agent.compaction-golden.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
