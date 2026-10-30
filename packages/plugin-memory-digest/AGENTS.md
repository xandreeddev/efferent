# @xandreed/plugin-memory-digest

The `ResultDigester` that runs tools' digest tasks (select the items to keep, or summarize a result) on the turn's `UtilityLlm`, so digests are budgeted with the turn. The memory strategy decides when to digest and the tool's view decides how; this plugin only asks. Node 24 and Bun; layer `plugin-memory-digest` in `foundry.config.ts` (imports core only).

## Rules

- Session scope: the digester is built per turn from that turn's `UtilityLlm`; never cache one across turns.
- A call that fails or outlasts `digestTimeoutMs` fails with `memory.digest` and logs `digest left out: …`; memory then records no digest and the result keeps its view.
- `digest` is a `memory.digest` span (`Effect.fn`), failed with the call.
- The user's request and the result (or its items) are data: frame them with core's `framed` and clip them with `clipTo`, the request to a quarter of `maxSourceChars`.
- `keysOf` accepts only keys the task offered, read inside brackets first, so a reply cannot keep an item that was not shown.
- Bump `UTILITY_DIGESTER.version` when the prompt or the reading of a reply changes: recorded digests name the digester (`utility-digest@1` in the sdk golden).
- A text change updates its exact pin in `src/plugin.adapter.test.ts`.

## Public surface

- `memoryDigestPlugin` (also the default export) and `MemoryDigestLive` (its `.live` layer); `MemoryDigestConfig`, `memoryDigestDefaults`, `UTILITY_DIGESTER`. The prompt and the reading of a reply (`digestPrompt`, `keysOf`, `outcomeOf`) stay inside the package.

The root names each export, and `quality/exports-have-consumers` checks each one: other packages' tests and the scripts import `memoryDigestPlugin` and `MemoryDigestLive`, and the rest, which no first-party code imports, are tagged `@public` at their declarations (`memoryDigestPlugin`'s tag covers the default export).

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `memoryDigestPlugin` | `@xandreed/plugin-memory-digest` | session | `efferent/ResultDigester` | none | `@xandreed/core/UtilityLlm` |

## Model-facing text

All of it goes to the digester (the utility model); the task's own `instructions` come from the tool's view.

| Text | Source | Pinned by |
|---|---|---|
| Select: data rule and reply format | `src/plugin.adapter.ts:36`, `:39` | exact, `src/plugin.adapter.test.ts:27` |
| Summarize: identifiers to keep, data rule, `Reply with the summary only.` | `src/plugin.adapter.ts:43`, `:44`, `:47` | exact, `src/plugin.adapter.test.ts:38` |
| `<user-request>`, `<result-items>`, `<tool-result>` frames and `[key]` item lines | `src/plugin.adapter.ts:32`, `:38`, `:46` | exact, `src/plugin.adapter.test.ts:27`, `:38`; clip sizes `:50` |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | config, `digestPrompt`, reply reading (`keysOf`, `outcomeOf`), the plugin |
| `src/index.ts` | the public exports |

## Tests

- `src/plugin.adapter.test.ts`: reply keys, the prompt for both modes and its clipping, a digester that answers, fails or stalls (under `TestClock`), and its `memory.digest` spans.
- The sdk golden (`packages/sdk/src/agent.golden.test.ts`) composes it with a `Select` digest; it pins the digest the turn records, not the digester's prompt.
- Run: `bun test packages/plugin-memory-digest packages/sdk/src/agent.golden.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
