# @xandreed/plugin-memory

Efferent's native cross-conversation memory engine. `memoryPlugin` is runtime scoped;
it requires `MemoryStore`, `UtilityLlm`, and Effect's `EmbeddingModel`, provides
`LongTermMemory`, and contributes recall capabilities and a background worker.
`memoryCapturePlugin` is session scoped and requires owner-checked `Sessions`.
It captures after acknowledged turn commits and exposes `MemoryCapture` for
explicit synchronization and bounded backfill.

Keep the existing `ConversationMemory` strategies independent. Never promote
assistant proposals or handler success into confirmed domain effects. Retrieved
sections and the memory/RAG tools' outputs are excluded from capture. The read
tools and the recall section take the owner and any source or metadata filter
from the run's `KnowledgeNarrowing` (by default `RunContext.session.owner`, no
filter); only host APIs accept scopes. Recall passes both filters to
`MemoryStore.search`, which applies them before its limit; the section's
profile keeps a memory only when every revision it cites is within them.
Narrowing never widens a write: `remember_memory`, `forget_memory` and capture
keep the session's owner, and `forget_memory` refuses a source outside the
source list as not found, and every source while a metadata filter is set:
forgetting removes every revision, and the filter judges revisions one at a
time, so it cannot vouch for a whole source.

Extraction and query protocols are core's shared native knowledge helpers. Extract
through `extractKnowledge` (one call and review per `maxExtractionChars` window,
merged before staging), and run every UtilityLlm call inside
`CurrentKnowledgeHelperCall` (purpose, scope, job and attempt, output cap). Stage
validated extraction before embedding. Publish through the store's lease and
scope revision checks; external model work never runs inside a transaction.
Workers stop claims before shutdown, retain durable queued work, and recover
unfinished processing through leases. Jobs are enqueued, discovered and claimed
under the engine id of the configured embedding space (`knowledgeEngineId`). The
engine's own retries within `maxAttempts` use the store's `retry` (engine and
attempts kept); the service's `retry` is the host's: it checks the scope is the
engine's collection and calls the store's `requeue` with the engine id, so
attempts reset and a job failed under an older id is taken over. Profile and routine memories retain their
evidence; inferred routines require three distinct source episodes.
Count admitted claims before masked storage I/O and keep that I/O outside the
local admission permit. Shutdown remains bounded and reports a stalled claim
as busy; its eventual result observes cancellation before extraction starts.

Capture reads are bounded by pageSize and maxPages, including checkpoint
fallback scans. Check the recent journal tail for the usual checkpoint; never
silently skip a malformed or forward ACK. A sync with no complete turn reports
stalled open-turn or page-limit and leaves through unchanged. hasMore checks
the durable tail, including rows beyond the page that held the selected end.
Large turns split into exact UTF-16 source ranges with one metadata.episode
across every part; partial enqueue and lost ACKs replay the same source IDs.
Remembered notes use the tool invocation ID and the original TurnStarted
timestamp, and share the containing turn's episode identity.
Every sync (the observer's, the recall section's catch-up, a host's sync and
backfill) asks the `MemoryCaptureAdmission` reference, read where it runs, once
per closed turn before enqueuing it: admitted text replaces the evidence only
when given, a refused turn enqueues nothing yet is acknowledged, and a failed or
invalid decision fails the sync before that turn's checkpoint.

Handler receipts describe execution only. Keep accepted tool results and their
run/step/name-correlated arguments as separate evidence; arbitrary host labels
and stages are display metadata and are not exported or interpreted as domain
confirmation. A host-specific result supplies any domain-effect evidence.
Read-only recall is always available; the separate management skill requires
memory.write and does not authorize any other action. The complete recall
section, catch-up and profile included, shares one retrieval timeout. A failed
semantic recall still permits profile injection. `recallSection: "off"` contributes
no section and runs no catch-up; `memoryRecallNote` renders the section's text,
without the catch-up, for a host that places recall in its step context or omits it.
Keep the note and the section one function: their texts never diverge.

Production imports core, `effect`, and `effect/ai` only. Tests additionally use
the SDK, agent loop, window memory, sessions, and tool discovery without adding
those dependencies to production. See the repository skills and definition of done.

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| Memory tool descriptions and skill summaries | `src/memory-capability.adapter.ts:13` | exact, `src/memory-capability.adapter.test.ts:16`; exact, `src/memory-capability.adapter.test.ts:23` |
| Parameters, failures, forgotten receipt and source data rule | `src/memory-capability.adapter.ts:21` | exact, `src/memory-capability.adapter.test.ts:39` |
| Saved receipt and source page framing/continuation | `src/memory-capability.adapter.ts:41`, `:47` | exact, `src/memory-capability.adapter.test.ts:57`; exact, `src/memory-capability.adapter.test.ts:60`; exact, `src/memory-capability.adapter.test.ts:61` |
| Saved note request/assistant evidence distinction | `src/memory-capability.adapter.ts:44` | exact, `src/memory-capability.adapter.test.ts:58` |
| Recall evidence, source locators, inference guidance and truncation | `src/memory-capability.adapter.ts:114` | exact, `src/memory-capability.adapter.test.ts:34`; exact, `src/memory-capability.adapter.test.ts:35` |
| Recall note (`memoryRecallNote`): the `memory.recalled` section's text, profile records first | `src/memory-capability.adapter.ts:171` | exact, `src/memory-capability.adapter.test.ts:129` |
| Captured user and final-reply evidence | `src/memory-capture.adapter.ts:21` | exact, `src/memory.journey.test.ts:55` |
| Tool result, correlated arguments and handler receipt evidence | `src/memory-capture.adapter.ts:29`, `:33` | exact, `src/memory-capture.adapter.test.ts:16`; exact, `src/memory-capture.adapter.test.ts:161` |

## Layout

- `memory.entity.ts`: configuration, plugin checkpoint and capture admission schemas.
- `memory-engine.adapter.ts`: native memory orchestration and processing worker.
- `memory-capture.adapter.ts`, `ports/memory-capture.port.ts`: committed journal capture and
  its per-turn admission reference.
- `memory-capability.adapter.ts`: recall, source read, explicit save/forget and turn evidence;
  `renderMemoryRecall` and `memorySourcePage` are exported for a host's own tools, and
  `memoryRecallNote` for a host that places the recall section's text itself.
- `plugin.adapter.ts`, `index.ts`: registered plugins and named host API.
