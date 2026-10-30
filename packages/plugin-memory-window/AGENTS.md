# @xandreed/plugin-memory-window

Windowed conversation memory: a `ConversationMemory` over core's memory log that stores every message and tool result whole, and shows the model the current turn verbatim, earlier turns through their tools' compact views and, only under budget pressure, spill previews and a ledger in place of the oldest turns. It also contributes `recall_context`, which reads a spilled result back. Node 24 and Bun; layer `plugin-memory-window` in `foundry.config.ts` (imports core only).

## Rules

- The policy only decides: `windowPolicy` returns `CompactionAction`s as data, and core's `openLogSession` records and renders them.
- `open` is a `memory.open` span (`Effect.fn`), as in every memory plugin.
- Keep the pressure order: compact earlier turns at turn start, spill the current turn's largest results, drop the oldest turns, then fail with `context.budget`.
- Never spill a `recall_context` result or a pinned one: the recalled page is what makes a spill lossless.
- Bump `WINDOW_STRATEGY.version` when a decision changes: every recorded `Compaction` and every `context.built` carries it.
- `memory.recall` is an always-on skill, so its summary never reaches the model: guidance goes in the tool's and its parameters' descriptions.
- A text change updates its exact pin; text the sdk goldens show is re-recorded with `EFFERENT_UPDATE_MODEL_GOLDEN=1` and the diff reviewed.

## Public surface

- `memoryWindowPlugin` (also the default export) and `MemoryWindowLive` (its `.live` layer); `MemoryWindowConfig`, `memoryWindowDefaults`, `WINDOW_STRATEGY`, `windowPolicy`, `recallCapability`.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `memoryWindowPlugin` | `@xandreed/plugin-memory-window` | runtime | `efferent/ConversationMemory` | `efferent/Capabilities` (`recallCapability`) | none |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| `recall_context` description | `src/plugin.adapter.ts:107` | exact, `src/plugin.adapter.test.ts:63`; sdk golden; sdk compaction golden |
| `locator` and `offset` descriptions | `src/plugin.adapter.ts:109-110` | exact, `src/plugin.adapter.test.ts:64`; sdk golden; sdk compaction golden |
| Spill preview (`[… N more characters kept out of context; call recall_context …]`) | `src/plugin.adapter.ts:62` | exact, `src/plugin.adapter.test.ts:58`; sdk compaction golden |
| Page continuation (`[… N more characters; call recall_context …]`) | `src/plugin.adapter.ts:122` | exact, `src/plugin.adapter.test.ts:75` |
| `UnknownLocator`, `OffsetOutOfRange` failures | `src/plugin.adapter.ts:139`, `:141` | exact, `src/plugin.adapter.test.ts:78`, `:77` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | config, the window policy, the recall capability, the plugin |
| `src/index.ts` | the public exports |

## Tests

- `src/plugin.adapter.test.ts`: the policy's decisions over hand-built log entries, recall paging, and the `memory.open` span.
- `packages/sdk/src/memory.conformance.test.ts` runs core's `memoryConformance` against this strategy; the sdk golden (`packages/sdk/src/agent.golden.test.ts`) composes it with `digestOnWriteChars: 1`.
- The sdk compaction golden (`packages/sdk/src/agent.compaction-golden.test.ts`, `packages/sdk/golden/agent-compaction.model.json`) composes it under a small budget: a result spilled and read back with `recall_context`, then two turns dropped for core's host note and ledger.
- Run: `bun test packages/plugin-memory-window packages/sdk/src/memory.conformance.test.ts packages/sdk/src/agent.golden.test.ts packages/sdk/src/agent.compaction-golden.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
