# @xandreed/plugin-memory

Efferent's native cross-conversation memory engine. `memoryPlugin` is runtime scoped;
it requires `MemoryStore`, `UtilityLlm`, and Effect's `EmbeddingModel`, provides
`LongTermMemory`, and contributes recall capabilities and a background worker.
`memoryCapturePlugin` is session scoped and requires owner-checked `Sessions`.
It captures after acknowledged turn commits and exposes `MemoryCapture` for
explicit synchronization and bounded backfill.

Keep the existing `ConversationMemory` strategies independent. Never promote
assistant proposals or handler success into confirmed domain effects. Retrieved
sections and the memory/RAG tools' outputs are excluded from capture. All model
tools derive scope from `RunContext.session.owner`; only host APIs accept scopes.

Extraction and query protocols are core's shared native knowledge helpers. Stage
validated extraction before embedding. Publish through the store's lease and
scope revision checks; external model work never runs inside a transaction.
Workers stop claims before shutdown, retain durable queued work, and recover
unfinished processing through leases. Profile and routine memories retain their
evidence; inferred routines require three distinct source episodes.

Capture reads are bounded by pageSize and maxPages, including checkpoint
fallback scans. Check the recent journal tail for the usual checkpoint; never
silently skip a malformed or forward ACK. A sync with no complete turn reports
stalled open-turn or page-limit and leaves through unchanged. hasMore checks
the durable tail, including rows beyond the page that held the selected end.
Large turns split into exact UTF-16 source ranges with one metadata.episode
across every part; partial enqueue and lost ACKs replay the same source IDs.
Remembered notes use the tool invocation ID and the original TurnStarted
timestamp, and share the containing turn's episode identity.

Handler receipts describe execution only. Keep accepted tool results and their
run/step/name-correlated arguments as separate evidence; arbitrary host labels
and stages are display metadata and are not exported or interpreted as domain
confirmation. A host-specific result supplies any domain-effect evidence.
Read-only recall is always available; the separate management skill requires
memory.write and does not authorize any other action. The complete recall
section, catch-up and profile included, shares one retrieval timeout. A failed
semantic recall still permits profile injection.

Production imports core, `effect`, and `effect/ai` only. Tests additionally use
the SDK, agent loop, window memory, sessions, and tool discovery without adding
those dependencies to production. See the repository skills and definition of done.

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| Memory tool descriptions and skill summaries | `src/memory-capability.adapter.ts:13` | exact, `src/memory-capability.adapter.test.ts:15`; exact, `src/memory-capability.adapter.test.ts:22` |
| Parameters, failures, forgotten receipt and source data rule | `src/memory-capability.adapter.ts:21` | exact, `src/memory-capability.adapter.test.ts:38` |
| Saved receipt and source page framing/continuation | `src/memory-capability.adapter.ts:41`, `:47` | exact, `src/memory-capability.adapter.test.ts:56`; exact, `src/memory-capability.adapter.test.ts:59`; exact, `src/memory-capability.adapter.test.ts:60` |
| Saved note request/assistant evidence distinction | `src/memory-capability.adapter.ts:44` | exact, `src/memory-capability.adapter.test.ts:57` |
| Recall evidence, source locators, inference guidance and truncation | `src/memory-capability.adapter.ts:84` | exact, `src/memory-capability.adapter.test.ts:33`; exact, `src/memory-capability.adapter.test.ts:34` |
| Captured user and final-reply evidence | `src/memory-capture.adapter.ts:21` | exact, `src/memory.journey.test.ts:45` |
| Tool result, correlated arguments and handler receipt evidence | `src/memory-capture.adapter.ts:29`, `:33` | exact, `src/memory-capture.adapter.test.ts:16`; exact, `src/memory-capture.adapter.test.ts:161` |

## Layout

- `memory.entity.ts`: configuration and plugin checkpoint schemas.
- `memory-engine.adapter.ts`: native memory orchestration and processing worker.
- `memory-capture.adapter.ts`, `ports/memory-capture.port.ts`: committed journal capture.
- `memory-capability.adapter.ts`: recall, source read, explicit save/forget and turn evidence.
- `plugin.adapter.ts`, `index.ts`: registered plugins and named host API.
