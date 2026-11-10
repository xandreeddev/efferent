# @xandreed/plugin-memory-summary

Summarizing conversation memory: a `ConversationMemory` with the window strategy's full-fidelity log and render, which folds older whole turns into one recorded summary (the previous summary included). Normal summaries run at `summarizeAt`: `turn-end` by default (after the reply is final and sealed, on the run's reported input, with the next run's start as the safety net for a summary that could not finish), `step` for pre-request timing; overflow can force an eligible reduction. The summarizer is the `UtilityLlm` of the turn that opens the session. A result longer than `boundOnWriteChars` is shown as its first characters and a locator from the first request that includes it, and the plugin contributes core's `recall_context` to read the rest, whatever that option is. Node 24 and Bun; layer `plugin-memory-summary` in `foundry.config.ts` (imports core only).

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
- Bounding a result as it is written is core's (`recordTail`, `packages/core/AGENTS.md`): the policy sets `MemoryPolicy.boundOnWriteChars` from the option (16,000 by default), and core records each bound as this strategy's own `Spill`. `boundOf(config)` is the one place the option is read: `0`, or a config written without the key and given to `summaryPolicy` as it is, bounds nothing. The strategy never spills under pressure and never reduces the current turn, so results that are each bounded can still pass the budget together and the request is then sent as it is: say so wherever the bound is described, never that a bounded turn fits.
- The plugin contributes core's `recallCapabilityOf("@xandreed/plugin-memory-summary/recall")` always, whatever `boundOf` gives, as the window plugin does. A bound is a fact of the session's log: a session bounded under the default and opened again at `0` still shows those results with their notice, which names `recall_context`, so the tool must be there (`src/plugin.adapter.test.ts`, `packages/sdk/src/bound-on-write.journey.test.ts`). `0` means only that nothing more is bounded. Never make the contribution follow the option again, and never bound without the tool: the notice names it. The capability id never changes. A graph that also holds the window plugin registers `recall_context` twice (`tools.duplicate`): a host lists the one it binds.
- `SUMMARY_STRATEGY.version` is `2`; bump it when a summary decision changes. Existing version 1 compactions and saved render recipes still apply without running a new summarizer. Bounding results did not bump it, on purpose: a bump makes `validateMemorySnapshot` set every stored render checkpoint aside (`packages/core/src/memory/memory-snapshot.entity.functions.ts`), and keeping it is safe because a bound is a recorded `Spill` of the current turn that every release of this version already renders and retains (`appliedCompactions`, `retainedMemoryPrefix`), `decide` is unchanged, and a checkpoint saved before any bound still projects (`packages/core/src/memory/memory-checkpoint.adapter.test.ts`). What the version no longer tells apart is a session with bounded results from one without: read the compactions for that.
- A text change updates its exact pin in `src/plugin.adapter.test.ts`; the sdk compaction golden shows it too, re-recorded with `EFFERENT_UPDATE_MODEL_GOLDEN=1` and the diff reviewed.

## Public surface

- `memorySummaryPlugin` (also the default export) and `MemorySummaryLive` (its `.live` layer); `MemorySummaryConfig`, `memorySummaryDefaults`, `SUMMARY_STRATEGY`, `summaryPolicy`.

The root names each export, and `quality/exports-have-consumers` checks each one: other packages' tests and the scripts import `memorySummaryPlugin`, and the rest, which no first-party code imports, are tagged `@public` at their declarations (`memorySummaryPlugin`'s tag covers the default export).

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `memorySummaryPlugin` | `@xandreed/plugin-memory-summary` | runtime | `efferent/ConversationMemory` | `efferent/Capabilities` (core's recall capability as `@xandreed/plugin-memory-summary/recall`, whatever `boundOnWriteChars` is) | none; optional: `@xandreed/core/UtilityLlm` (read from each turn's services) |

## Model-facing text

The plugin's own text all goes to the summarizer (the utility model), not to the agent's model. What its capability and its bounds show the agent's model is core's, inventoried in `packages/core/AGENTS.md`.

| Text | Source | Pinned by |
|---|---|---|
| `recall_context`'s description and parameter descriptions, the spill preview a bounded result ends with, the page continuation and the `UnknownLocator` and `OffsetOutOfRange` failures, contributed here whatever `boundOnWriteChars` is | `packages/core/src/memory/recall.entity.functions.ts` | exact tests `packages/core/src/memory/recall.entity.functions.test.ts#recall_context says what it returns and how to page`; `packages/core/src/memory/recall.entity.functions.test.ts#the preview says how many characters it left out and the offset to read them from`; `packages/core/src/memory/recall.entity.functions.test.ts#a result comes back a page at a time, each page ending with the offset of the next`; `src/plugin.adapter.test.ts#recall_context is contributed whatever the bound is` |
| Default `instructions` (the plugin reference shows it as a default) | `src/plugin.adapter.ts:85` | exact tests `src/plugin.adapter.test.ts#the default instructions open it` |
| The data rule, the earlier-summary line, `Reply with the summary only.` | `src/plugin.adapter.ts:132`, `:135`, `:138` | exact tests `src/plugin.adapter.test.ts#instructions, the data rule, any earlier summary and the transcript, each framed, then what to reply` |
| `<earlier-summary>` and `<conversation-transcript>` frames | `src/plugin.adapter.ts:135`, `:137` | exact tests `src/plugin.adapter.test.ts#instructions, the data rule, any earlier summary and the transcript, each framed, then what to reply` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | config, `summaryPrompt`, the summary policy, the recall capability under this plugin's id, the plugin |
| `src/summary-attempt.entity.ts`, `src/summary-attempt.entity.functions.ts` | the per-session paid-attempt phase and pure claims |
| `src/index.ts` | the public exports |

## Tests

- `src/plugin.adapter.test.ts`: the prompt, a summarizer that answers, fails or stalls (under `TestClock`), alone and in the plugin, the spans, and the bound: the recall capability contributed whatever the bound is, the `Spill` recorded under `summary` version 2, nothing bounded at `0`, and a session bounded at the default and opened again at `0`, whose notice names a tool that is contributed and serves the page.
- `src/maintenance-policy.adapter.test.ts`: normal timing, force/cooldown, calibrated candidates, per-open no-progress memoization across budget oscillations, provider callback reentry, failed-helper preservation (including timeout cleanup) and public-policy reuse across sessions; `src/summary-attempt.entity.functions.test.ts` pins the phase transitions.
- `packages/sdk/src/memory.conformance.test.ts` runs core's `memoryConformance` against this strategy and checks the `memory.summary` failure without a `UtilityLlm`.
- The sdk compaction golden (`packages/sdk/src/agent.compaction-golden.test.ts`, `packages/sdk/golden/agent-compaction.model.json`) composes it with `cooldownTurns: 0` and a scripted summarizer: two summaries in consecutive turns, the second folding the first, each summarizer prompt recorded and the next request carrying core's handoff; every request offers `recall_context`.
- `packages/sdk/src/bound-on-write.journey.test.ts`: four results far above the bound in one turn through `Agent.define`, each bounded from its first request, the next page read with `recall_context`, `boundOnWriteChars: 0` (whole results, the recall tool still offered), calls made together in one step and the next turn's first request, a tool's own annotation, a session bounded at the default and continued at `0`, and fourteen bounded results that pass the budget and are sent as they are.
- Run: `bun test packages/plugin-memory-summary packages/sdk/src/memory.conformance.test.ts packages/sdk/src/agent.compaction-golden.test.ts packages/sdk/src/bound-on-write.journey.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
