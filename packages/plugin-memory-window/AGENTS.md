# @xandreed/plugin-memory-window

Windowed conversation memory: a `ConversationMemory` over core's memory log that stores every message and tool result whole, and shows the model the current turn verbatim, earlier turns through their tools' compact views and, only under budget pressure, spill previews and a ledger in place of the oldest turns. It also contributes core's `recall_context`, which reads a spilled result back. Node 24 and Bun; layer `plugin-memory-window` in `foundry.config.ts` (imports core only).

## Rules

- The policy only decides: `windowPolicy` returns `CompactionAction`s as data, and core's `openLogSession` records and renders them.
- `open` is a `memory.open` span (`Effect.fn`), as in every memory plugin.
- Keep the pressure order: compact earlier turns at turn start, spill the current turn's largest results, drop the oldest turns. With `currentTurnFirst`, compact earlier turns, then drop the oldest turns, and spill the current turn's largest results only when dropping every earlier turn still does not fit: the fewest spills first, then the fewest dropped turns. Use `scaledTokens` with the same accepted observation at every candidate comparison; reserves are already outside the message budget.
- Normal `step`/`turn-start` maintenance fails with `context.budget` if the current turn still cannot fit. `turn-end` and `overflow` are advisory: return safe reductions even when irreducible current pressure remains. The next actual dispatch remains strict.
- Never spill a `recall_context` result or a pinned one: the recalled page is what makes a spill lossless.
- `WINDOW_STRATEGY.version` is `2`; bump it when a decision changes. Recorded version 1 actions and saved recipes keep replaying without rerunning the policy.
- `currentTurnFirst` keeps the strategy id `window` (so compactions recorded under either order keep applying) and suffixes the version: `2+current-turn-first`. The version is in every request header (`strategyVersion`) and `context.built`, so a request's fingerprint, a trace and a replay tell the two orders apart. A config is read through `windowPolicy(config).strategy`, never `WINDOW_STRATEGY` alone.
- The recall tool, its paging and the spill preview are core's (`packages/core/src/memory/recall.entity.functions.ts`): `recallCapability` is `recallCapabilityOf` under this plugin's capability id, `@xandreed/plugin-memory-window/recall`, which never changes; the policy writes a spill's preview with `spillPreview` and tells a recalled page by `RECALL_TOOL`. Change their text in core, with its pins.
- A decision that changes what the sdk goldens show is re-recorded with `EFFERENT_UPDATE_MODEL_GOLDEN=1` and the diff reviewed.

## Public surface

- `memoryWindowPlugin` (also the default export) and `MemoryWindowLive` (its `.live` layer); `MemoryWindowConfig`, `memoryWindowDefaults`, `WINDOW_STRATEGY`, `windowPolicy`, `recallCapability` (core's `recallCapabilityOf("@xandreed/plugin-memory-window/recall")`).

The root names each export, and `quality/exports-have-consumers` checks each one: other packages' tests and the scripts import `memoryWindowPlugin` and `MemoryWindowLive`, and the rest, which no first-party code imports, are tagged `@public` at their declarations (`memoryWindowPlugin`'s tag covers the default export).

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `memoryWindowPlugin` | `@xandreed/plugin-memory-window` | runtime | `efferent/ConversationMemory` | `efferent/Capabilities` (`recallCapability`) | none |

## Model-facing text

This plugin defines no text of its own. What its capability and its policy show the model is core's, inventoried in `packages/core/AGENTS.md`:

| Text | Source | Pinned by |
|---|---|---|
| `recall_context`'s description and parameter descriptions, the spill preview, the page continuation and the `UnknownLocator` and `OffsetOutOfRange` failures, contributed here as `recallCapability` and written by the policy's spills | `packages/core/src/memory/recall.entity.functions.ts` | exact tests `packages/core/src/memory/recall.entity.functions.test.ts#recall_context says what it returns and how to page`; `packages/core/src/memory/recall.entity.functions.test.ts#the preview says how many characters it left out and the offset to read them from`; `packages/core/src/memory/recall.entity.functions.test.ts#a result comes back a page at a time, each page ending with the offset of the next` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | config, the window policy, `recallCapability` (core's recall capability under this plugin's id), the plugin |
| `src/index.ts` | the public exports |

## Tests

- `src/plugin.adapter.test.ts`: the policy's decisions over hand-built log entries (a recalled page is never spilled again), the id and tool of `recallCapability`, the `memory.open` span, and the strategy the plugin reports for each order.
- `packages/core/src/memory/recall.entity.functions.test.ts`: the recall tool's descriptions, paging and failures, the spill preview, and the capability `recallCapabilityOf` builds.
- `src/maintenance-policy.adapter.test.ts`: calibrated fit/spill comparisons, advisory end-of-run pressure versus the next strict step, and the `currentTurnFirst` order (earlier turns dropped first, the current turn spilled only when it alone does not fit, `context.budget` only when nothing fits, recorded default-order compactions still applied).
- `packages/sdk/src/memory-window-current-turn.journey.test.ts`: a large current-turn result used over several steps under each order, through `Agent.define`.
- `packages/sdk/src/memory.conformance.test.ts` runs core's `memoryConformance` against this strategy; the sdk golden (`packages/sdk/src/agent.golden.test.ts`) composes it with `digestOnWriteChars: 1`.
- The sdk compaction golden (`packages/sdk/src/agent.compaction-golden.test.ts`, `packages/sdk/golden/agent-compaction.model.json`) composes it under a small budget: a result spilled and read back with `recall_context`, then two turns dropped for core's host note and ledger.
- Run: `bun test packages/plugin-memory-window packages/core/src/memory/recall.entity.functions.test.ts packages/sdk/src/memory.conformance.test.ts packages/sdk/src/agent.golden.test.ts packages/sdk/src/agent.compaction-golden.test.ts packages/sdk/src/memory-window-current-turn.journey.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
