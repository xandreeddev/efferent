---
title: Packages that are no longer published
description: The eighteen packages of the engine before 0.23.0, their last version, and what a host writes instead of each.
---

Up to 0.22.0, Efferent was an engine: `Agent.define` composed `@xandreed/plugin-*`
packages through a plugin graph (`@xandreed/runtime`) and ran a turn engine of
its own. From 0.23.0 the kernel replaces it: a host composes plain Effect layers
and writes its own loop over `modelAnswer` and `callTool`
([ADR 0036](https://github.com/xandreeddev/efferent/blob/main/docs/adr/0036-the-old-engine-goes-and-the-kernel-takes-the-package-roots.md)).
The six packages that are still published are `@xandreed/core`, `@xandreed/sdk`
and the four eval packages.

The eighteen packages below were last published at **0.22.0**. They stay on npm
as they are: they are not deprecated, not unpublished and not published again,
so nothing on npm says they ended. A host that depends on them keeps working at
0.22.0, with every package pinned to that one version; nothing of 0.23.0 can be
mixed with them, since `@xandreed/core` and `@xandreed/sdk` no longer export the
old engine.

| Package | Last version | What a host writes instead |
| --- | --- | --- |
| `@xandreed/runtime` | 0.22.0 | Nothing: each part is an Effect layer, composed with `Layer.provideMerge` or provided to the program; a stack missing a part does not compile |
| `@xandreed/process-host` | 0.22.0 | None yet |
| `@xandreed/plugin-agent-loop` | 0.22.0 | The host's own loop over `modelAnswer` and `callTool`; `planned` for retries and fallbacks |
| `@xandreed/plugin-memory-window` | 0.22.0 | `windowMemory` |
| `@xandreed/plugin-memory-summary` | 0.22.0 | `summaryMemory` over the host's `Summarizer` |
| `@xandreed/plugin-memory-digest` | 0.22.0 | None yet; a long tool result is sent as its start and a pointer (`pointed`, the `ReadResult` tool) |
| `@xandreed/plugin-memory` | 0.22.0 | `curate` and `withKnowledge` (memory kept by a curator); `withFacts` with `factTools` (facts the model keeps itself); for its embedding model, an `Embedder`: `openAiCompatibleEmbedder` on `@xandreed/sdk/node` |
| `@xandreed/plugin-rag` | 0.22.0 | `withKnowledgeByMeaning` over an `Embedder` and a `VectorStore` recalls memories by meaning; retrieval of a document's passages: none yet |
| `@xandreed/plugin-knowledge-postgres` | 0.22.0 | None yet: vectors are an index of the journal (`inMemoryVectors`), and journals are kept on a disk (`directoryJournal`, `sqliteJournal`) |
| `@xandreed/plugin-tool-discovery` | 0.22.0 | Skills: `defineSkill`, `skills(base, ...skills)` and the `loadSkill` tool |
| `@xandreed/plugin-models` | 0.22.0 | `openAiCompatibleModel` and `anthropicModel` on `@xandreed/sdk/node`, which charge the spend ledger; the router, the credential and settings stores and the subscription sign-ins: none yet |
| `@xandreed/plugin-session-files` | 0.22.0 | `directoryJournal`; `directoryMedia` for its media folder |
| `@xandreed/plugin-session-sqlite` | 0.22.0 | `sqliteJournal`, on Node and on Bun |
| `@xandreed/plugin-sessions` | 0.22.0 | `sessions()` over a journal, `recoverTurns`, and the inbox (`inbox`, `inboxOf`) |
| `@xandreed/plugin-tasks` | 0.22.0 | `tasks(run)` with the `startTask` and `cancelTask` tools |
| `@xandreed/plugin-render` | 0.22.0 | View records (`showView`, `viewsOf`) and live progress (`progressEvent`); the feed's SSE and WebSocket transports: none yet |
| `@xandreed/plugin-workspace` | 0.22.0 | `diskFiles`, `processShell` and `filesSearch`, with their tools; image resizing and a skills directory: none yet |
| `@xandreed/plugin-telemetry` | 0.22.0 | The kernel's own spans and metrics, exported with `otlpTelemetry` or `otlpTelemetryFromEnv` |

`@xandreed/core` and `@xandreed/sdk` are still published, but what they held
of the engine is gone: core's old root, `./conformance` and `./internal` (the
old entities, ports and kits), and the sdk's `Agent.define`, `Agent.turn`, the
turn engine and `./conformance`. Their roots are the kernel now, with the sdk's
Node entry at `@xandreed/sdk/node`. A local embedder that runs in a Node or Bun
process has no replacement yet: `openAiCompatibleEmbedder` also reaches a local
server that speaks the OpenAI-compatible wire.

To move a host over, start from [getting started](/docs/getting-started/), then
[the guide](/docs/guide/); the [learn track](/learn/) builds an agent on the
kernel one part at a time.
