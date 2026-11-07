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
validated extraction before embedding: `stageKnowledgeExtraction` leaves out a
record that fails its own checks and writes its `RecordDropped` note on the
stage; never fail a turn's whole capture for one record. A restatement is evidence, not a
memory: staging turns a named one (`restates`) into a corroboration, and after
embedding `mergeKnowledgeRestatements` (`restatementSimilarity`) turns a new
memory with the kind and entities of an active one from another source into
one; never merge memories without entities. Publish through the store's lease and
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
Keep the note and the section one function: their texts never diverge. Recall
text (section, note and `recall_memory`) is dated by default (`recallDates`):
`renderMemoryRecall` labels each record with the UTC date of the revision its
first span cites (`knowledgeRecordDate`), a memory with its kind and evidence,
a relation with its validity, from the recall's `sources`; the section reads
a profile record's dating revision when neither the recall nor the narrowing
did, and shows the record undated when that read fails. Today's date is said
only with `recallToday`, so the default text stays stable for cached prefixes.
Recall also returns, by default, the earlier states its current records
replaced (`recallHistory`: `changes`; `all` adds corrections, `none` turns it
off), one hop back along each successor's `replaces`, within
`recallHistoryShare` of the budget; `renderMemoryRecall` shows them after the
current records under "Earlier states, no longer current:". A link whose record
was forgotten, is still current or lies outside the narrowing is skipped.
Recall weighs a preference, routine, profile or fact by the distinct episodes
whose own text states it (`KnowledgeMemory.mentions`, `knowledgeMemorySupport`):
it fuses once, reads the pool's mentioned revisions' info in one `sourceInfo`
batch, and fuses again with the factor `1 + supportWeight × ln(min(episodes,
4))` (`memorySupportFactor`), each memory carrying its `support`; the render
adds `said <n> times, last <date>` from two episodes on, and the section's
profile records take the support recall found for them. Never count a
memory's provenance as its mentions: staging appends entity and support
evidence to it. `supportWeight: 0` reads nothing and ranks plainly.

Production imports core, `effect`, and `effect/ai` only. Tests additionally use
the SDK, agent loop, window memory, sessions, and tool discovery without adding
those dependencies to production. See the repository skills and definition of done.

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| Memory tool descriptions and skill summaries | `src/memory-capability.adapter.ts:17` | exact, `src/memory-capability.adapter.test.ts:16`; exact, `src/memory-capability.adapter.test.ts:23` |
| Parameters (the recall tool's `history` included), failures, forgotten receipt and source data rule | `src/memory-capability.adapter.ts:25` | exact, `src/memory-capability.adapter.test.ts:141` |
| Saved receipt and source page framing/continuation | `src/memory-capability.adapter.ts:46`, `:52` | exact, `src/memory-capability.adapter.test.ts:160`; exact, `src/memory-capability.adapter.test.ts:163`; exact, `src/memory-capability.adapter.test.ts:164` |
| Saved note request/assistant evidence distinction | `src/memory-capability.adapter.ts:49` | exact, `src/memory-capability.adapter.test.ts:161` |
| Recall evidence, source locators, inference guidance and truncation | `src/memory-capability.adapter.ts:134`, `:197` | exact, `src/memory-capability.adapter.test.ts:34`; exact, `src/memory-capability.adapter.test.ts:35` |
| Dated recall: reading rule, today's date, record dates, memory kind and evidence words, relation validity | `src/memory-capability.adapter.ts:129`, `:134`, `:197` | exact, `src/memory-capability.adapter.test.ts:61`; exact, `src/memory-capability.adapter.test.ts:69` |
| Support count: a memory said in two episodes or more labelled `said <n> times, last YYYY-MM-DD` | `src/memory-capability.adapter.ts:134`, `:197` | exact, `src/memory-capability.adapter.test.ts:99` |
| Earlier states: the "Earlier states, no longer current:" heading, a change's `previously: … (until …; replaced by …)` and a correction's `previously: … (corrected …; this was wrong)` | `src/memory-capability.adapter.ts:134`, `:197` | exact, `src/memory-capability.adapter.test.ts:129`; exact, `src/memory.journey.test.ts:458` |
| Recall note (`memoryRecallNote`): the `memory.recalled` section's text, profile records first, dated | `src/memory-capability.adapter.ts:299` | exact, `src/memory-capability.adapter.test.ts:238`; exact, `src/memory-capability.adapter.test.ts:244` |
| Captured user and final-reply evidence | `src/memory-capture.adapter.ts:21` | exact, `src/memory.journey.test.ts:55` |
| Tool result, correlated arguments and handler receipt evidence | `src/memory-capture.adapter.ts:29`, `:33` | exact, `src/memory-capture.adapter.test.ts:16`; exact, `src/memory-capture.adapter.test.ts:161` |

## Layout

- `memory.entity.ts`: configuration, plugin checkpoint and capture admission schemas;
  `memory.entity.functions.ts`: recall's support factor.
- `memory-engine.adapter.ts`: native memory orchestration and processing worker.
- `memory-capture.adapter.ts`, `ports/memory-capture.port.ts`: committed journal capture and
  its per-turn admission reference.
- `memory-capability.adapter.ts`: recall, source read, explicit save/forget and turn evidence;
  `renderMemoryRecall` and `memorySourcePage` are exported for a host's own tools, and
  `memoryRecallNote` for a host that places the recall section's text itself.
- `plugin.adapter.ts`, `index.ts`: registered plugins and named host API.
