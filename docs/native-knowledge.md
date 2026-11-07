# Native memory, temporal graphs, and RAG

Efferent provides its own knowledge engines. `plugin-memory` learns reusable
knowledge from interactions. `plugin-rag` retrieves original document passages.
Both use the native PostgreSQL/pgvector adapter, host-supplied models and shared
evidence contracts. No external memory product is a runtime dependency.

The existing window, summary and digest plugins manage the active conversation.
Keep one window/summary strategy when adding long-term memory or RAG.

## Compose the engines

The memory engine requires `MemoryStore`, `UtilityLlm` and Effect's
`EmbeddingModel.EmbeddingModel`. Plain RAG requires `KnowledgeStore` and the
embedding service. GraphRAG also requires `UtilityLlm`. Query planning and
reranking are opt-in on both engines (`queryPlanning: true`, `rerank: true`):
each adds one `UtilityLlm` call to every search, and RAG skips them when no
`UtilityLlm` is supplied. Supply a model suitable for extraction and
relationship reasoning. The models plugin's `fastModel` configures its helper
model independently of the main conversation model.

Each helper call a knowledge engine makes runs with `CurrentKnowledgeHelperCall`
set: its purpose (`extract`, `review`, `plan` or `rerank`), the scope, the
processing job and attempt for extraction and review (none for a search's
planning and reranking), and the engine's `maxHelperOutputTokens` when it is
configured. A host's `UtilityLlm` reads it with
`Effect.service(CurrentKnowledgeHelperCall)` to budget, attribute or refuse a
call; the reference is `Option.none()` for any other helper call. The models
plugin's own `UtilityLlm` does not read it, so `maxHelperOutputTokens` is
advisory: it caps nothing unless the host's `UtilityLlm` applies it.

`embeddingModel`, `embeddingVersion` and `embeddingDimensions` identify the
host's actual embedding space. Configure the same identity on both engines when
sharing a model. Incompatible stored and query vectors fail explicitly. Changing
models requires a new collection or a deliberate reindex.

Each engine records its jobs under an engine id that names the engine, the
extraction version (`KNOWLEDGE_EXTRACTION_VERSION`, now `4`) and its
embedding space: `knowledgeEngineId("rag:4", space)` is
`rag:4/<model>/<version>/<dimensions>` (a `/` or `%` in the model or version is
escaped). A worker discovers (`pending`) and claims (`claim`, also by job id)
only jobs recorded under its own id, so processes configured with different
embedding spaces can share one store without indexing each other's sources. A
job queued under another configuration waits for a worker of that
configuration. The engine sets the id on `ingest` and `capture`, whatever
`engine` the caller passes. A new extraction version changes the id, like a
new embedding space: a job still queued under a previous one (`memory:3/…`,
`rag:3/…`) waits for a worker of that version, so let one drain the queue
before switching. A job that failed under it is started over under the
current id by `retry` (below). Extraction version 2 stages what version 1
failed with `Invalid` for one record's sake, but `isRetryableKnowledgeFailure`
calls `Invalid` final, so list those jobs with
`failed({ namespace, reasons: ["Invalid"] })` and pass them to `retry`
directly. Version 3 asks each extracted memory why it supersedes
(`supersession`) and links successors to what they replaced; version 4 lets
it name the candidate memory a source restates (`restates`), which adds
evidence to that memory instead of a new one
([one memory for a repeated statement](#one-memory-for-a-repeated-statement)).
A job of an earlier version that failed is retried the same way.

Build typed layers when the host needs direct ingestion, status and backfill
APIs beside the agent. `stackPlugins` retains every capability and background
worker contribution:

```ts
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { EmbeddingModel } from "effect/ai"
import {
  Knowledge, KnowledgeJobId, KnowledgeSourceId, LongTermMemory,
  UtilityLlm, stackPlugins,
} from "@xandreed/core"
import type { UtilityCompletion, UtilityError } from "@xandreed/core"
import { KnowledgePostgresLive } from "@xandreed/plugin-knowledge-postgres"
import { MemoryPluginLive } from "@xandreed/plugin-memory"
import { RagPluginLive } from "@xandreed/plugin-rag"

declare const databaseUrl: string
declare const embedding: EmbeddingModel.EmbeddingModel
declare const complete: (prompt: string) => Effect.Effect<UtilityCompletion, UtilityError>

const models = Layer.merge(
  Layer.succeed(EmbeddingModel.EmbeddingModel, embedding),
  Layer.succeed(UtilityLlm, UtilityLlm.of({ complete })),
)
const native = KnowledgePostgresLive(Redacted.make(databaseUrl)).pipe(
  stackPlugins(MemoryPluginLive({
    namespace: "assistant", embeddingModel: "host-embedding",
    embeddingVersion: "1", embeddingDimensions: 768,
  })),
  stackPlugins(RagPluginLive({
    namespace: "assistant", embeddingModel: "host-embedding",
    embeddingVersion: "1", embeddingDimensions: 768,
    graph: true, worker: false,
  })),
  Layer.provide(models),
)

const indexed = Effect.scoped(Effect.gen(function* () {
  const services = yield* Layer.build(native)
  const documents = Context.get(services, Knowledge)
  const memory = Context.get(services, LongTermMemory)
  const scope = { owner: "user-1", namespace: "assistant", collection: "knowledge" }
  const job = yield* documents.ingest({
    jobId: KnowledgeJobId.make("handbook:1"), engine: "rag", // replaced by the engine's own id
    expectedRevision: Option.none(),
    source: {
      scope, ref: { id: KnowledgeSourceId.make("handbook"), revision: 1 },
      text: "# Release handbook\nDeploy the blue lane after verification.",
      occurredAt: 1_793_577_600_000, recordedAt: 1_793_577_600_000,
      metadata: { title: "Release handbook", uri: "handbook.md" },
    },
  })
  yield* documents.process(scope, 1)
  const status = yield* documents.status(scope, job.id)
  const evidence = yield* documents.retrieve({
    scope, query: "Which lane should be deployed?", limit: 8, maxChars: 8_000,
  })
  return { status, evidence, profile: yield* memory.profile({ ...scope, collection: "memory" }) }
}))
```

The example processes RAG explicitly. Its production worker is enabled by
default. Within the same owning scope, pass the built `services` context to
`Agent.define`, compose the usual window/summary, discovery and loop plugins,
and add `memoryCapturePlugin`. Its options must use the memory engine's namespace
and collection. Declare `Sessions` among `turnServices` when providing it per
turn. The built context supplies the native tools, sections, services and workers.
Alternatively put `knowledgePostgresPlugin`, `memoryPlugin`, `memoryCapturePlugin`
and `ragPlugin` directly in the agent graph; the PostgreSQL plugin reads its
secret URL from `EFFERENT_KNOWLEDGE_DATABASE_URL` by default.

The PostgreSQL adapter needs the pgvector extension installed on its server.
Its versioned migrations create Efferent-owned tables and indexes under the
`efferent_knowledge` schema. Provision the extension with an administrative role
before using a restricted application role; that role still needs CREATE on the
database and on `efferent_knowledge`, and read and write access to its tables.
Never point the native adapter at another product's private tables.

Opening the store tells a setup problem from an outage. A server without
pgvector, a role that may not create the extension or the schema, a role
missing a privilege on the tables and a database whose `efferent_knowledge`
objects do not fit the layout fail with `KnowledgeError` reason `Invalid`, and
a message naming the cause and the fix: retrying will not help. Connection
failures and deadlines stay `Unavailable`, concurrent writes `Conflict`.
Messages never carry the connection string; the driver's error is the `cause`.

## Conversation and action capture

`memoryCapturePlugin` is built before the turn and observes acknowledged closing
commits. It saves the user's initial and steered input, the final host reply,
and original recorded tool-result views, with their correlated arguments.
Intermediate assistant messages, reasoning, context sections, summaries,
digests and memory/RAG tool results are skipped as standalone capture events.
Final replies remain evidence and may contain proposals or repeat retrieved
material; extraction is instructed to distinguish those claims from confirmed
effects. Capture uses the original result view, before later context compaction
or digest presentations, and cannot restore bytes the tool never returned.
Handler outcomes remain distinct from confirmed domain effects: a handler can
return successfully while reporting a failed command or incomplete action.

Capture enqueues immutable source jobs and then appends a plugin-owned checkpoint
to the source journal. Original timestamps, session/run identity and source-part
offsets survive retries. A crash between enqueue and checkpoint repeats the same
source identity rather than duplicating its knowledge. A crash before enqueue
leaves the journal available for synchronization.

`MemoryCapture.sync(address)` performs bounded catch-up. `backfill({ owner,
before?, limit? })` visits one owner-authorized page of sessions; retain the
returned cursor and continue explicitly. Capture never claims that a bounded
page contains the owner's complete history. An incomplete turn or page limit
does not advance its checkpoint. A host ending a supplied `TurnWriter` calls
`sync` after its own acknowledged end; `Agent.turn` does not own that end.

A host screens what capture stores of each committed turn with
`MemoryCaptureAdmission`, a reference every sync asks once per closed turn,
before enqueuing it: the observer's, the `memory.recalled` section's catch-up,
and a host's own `sync` and `backfill`. It receives the turn's session
address, run id, turn number, evidence text and committed entries, and
answers `Admit` (optionally with replacement text, stored in the evidence's
place under the same source identities) or `Refuse`. A refused turn enqueues
nothing, but the checkpoint still moves past it, so no later sync reads it
again; `sync` reports it in `refused`. A failure or an invalid decision fails
the sync before that turn's checkpoint, and the turn is asked again next time.
The default admits every turn as is. Provide your own among the agent's
`services` or a turn's services:

```ts
import { Context, Effect } from "effect"
import { MemoryCaptureAdmission } from "@xandreed/plugin-memory"

declare const withheldTurns: (session: string) => Effect.Effect<ReadonlySet<number>>

const admission = Context.make(MemoryCaptureAdmission, {
  admit: (turn) => withheldTurns(turn.session.id).pipe(
    Effect.map((withheld) => withheld.has(turn.turn) ? { _tag: "Refuse" as const } : { _tag: "Admit" as const }),
  ),
})
```

Screening a turn is not narrowing: `KnowledgeNarrowing` scopes what a turn
reads, the admission decides what capture learns from it.

Memory processing is asynchronous. `capture` or `ingest` returning a job means
the source is durably accepted. Inspect `status`, call `process` explicitly, or
let the worker publish it. `retry` requeues a failed job. Model/embedding errors
publish no partial facts or document revisions.

A host finds failed jobs without keeping their ids: `KnowledgeIndex.failed`
(on `MemoryStore` or `KnowledgeStore`) lists them across owners in one
namespace, oldest first, optionally narrowed to an `engine`, a `collection`
and the failure `reasons` to look for, a page of at most `limit` jobs at a
time; pass the page's `next` cursor as `after` to read on. `retry` on
`LongTermMemory` or `Knowledge` starts a failed job of the engine's collection
over: it requeues the job under the engine's current id with its attempts
reset, so the engine's automatic retries apply again, and a job that failed
under an older id of the engine (before its extraction version or embedding
space changed) is taken over instead of waiting for a worker of the old
configuration. The staged extraction is kept when the id is unchanged and
discarded otherwise. Forgotten or superseded sources are never requeued: a
job whose source was forgotten fails with `Tombstoned`, whatever its phase
(forgetting cancels the source's jobs), and one a newer revision superseded,
or that is not failed, with `Conflict`.

```ts
import { Effect, Option } from "effect"
import { isRetryableKnowledgeFailure, Knowledge, KnowledgeStore } from "@xandreed/core"
import type { KnowledgeJobCursor } from "@xandreed/core"

/** Requeues every failed document job a retry can help, page by page. */
const requeueRetryable = (after?: KnowledgeJobCursor): Effect.Effect<void, unknown, Knowledge | KnowledgeStore> => Effect.gen(function* () {
  const page = yield* (yield* KnowledgeStore).failed({ namespace: "default", collection: "knowledge", limit: 100, ...(after === undefined ? {} : { after }) })
  const knowledge = yield* Knowledge
  yield* Effect.forEach(page.jobs, (job) => job.phase._tag === "Failed" && isRetryableKnowledgeFailure(job.phase) ? knowledge.retry(job.scope, job.id) : Effect.void, { concurrency: 1, discard: true })
  if (Option.isSome(page.next)) yield* requeueRetryable(page.next.value)
})
```

An engine's own retries within `maxAttempts` use `KnowledgeIndex.retry`,
which keeps the job's engine and attempts; `KnowledgeIndex.requeue({ scope,
jobId, engine })` is the reset the services' `retry` calls.

A failed job's `Failed` phase (read through `status`) records why its last
attempt failed, as a `KnowledgeJobFailure`: the `KnowledgeError` reason, its
message, and the `step` that failed, `Graph` for the optional graph extraction
and `Required` for anything the job cannot publish without.
`isRetryableKnowledgeFailure(phase)` is the rule the engines retry by within
`maxAttempts`, and the one a host applies before calling `retry`: a failed
graph step is always retryable; otherwise `Invalid`, `Tombstoned` and
`EmbeddingMismatch` are final and every other reason is transient. A job that
failed before reasons were recorded reads as `Unavailable` at step `Required`,
so it counts as retryable and its next failure records its own reason. A store
records a failure with `KnowledgeIndex.fail(lease, { reason, message, step })`. Successful staged extraction is
reused after an embedding failure. Scope-version conflicts trigger reconciliation
against the updated graph.

Staging (`stageKnowledgeExtraction`) checks each extracted record on its own.
A record that fails a check of its own is left out and the rest of the
extraction is staged and published: a span that is not the exact source text
even after its quote repaired the offsets, an `existing` entity identity that is
not among the supplied candidates, a reference to an entity key the extraction
does not define, a `supersedes` entry that names an unknown or inactive record,
an inferred memory's unknown supporting memory, an inferred routine with fewer
than three supporting episodes, or a validity interval that ends before it
starts. Leaving out an entity also leaves out every memory and assertion that
refers to its key, and an entity that only left-out records referred to is
left out with them. Each record left out adds a `RecordDropped` note to the
stage (`record`: `entity`, `memory` or `assertion`; the extraction's local
`key`; reason `Invalid`; and the message), read through `status` like
`GraphOmitted`. The job still fails with `Invalid`, as before, when the
extraction repeats an entity key, does not encode, or proposed memories or
assertions and had every one of them left out (its entities alone are no
surviving knowledge); it then fails with the first record's message, so
`KnowledgeIndex.failed({ reasons: ["Invalid"] })` still lists extractions that
are broken throughout. Publication's own checks (provenance against the stored
source, support cycles, routine episodes by source metadata) are unchanged and
still refuse the whole stage. Over several windows, a part that repeats an
entity key refuses the source; a record that names a key no part defines is
left to staging, which drops it alone.

A document's graph is optional; its chunks are not. When graph extraction or its
review fails, or the helper's answer is invalid, the failure is recorded on the
job with step `Graph` and the job is retried within `maxAttempts`: an invalid model answer is not
an invalid source. The last attempt stages and publishes the source's chunks
without entities or assertions, and the completed job's stage carries a
`GraphOmitted` note with the failure's reason and message
(`stage.notes`, read through `status`). A graph some of whose records were
left out at staging is no failure: the chunks publish with the rest of the
graph and the stage carries their `RecordDropped` notes. Ingest the next revision to extract its
graph again. A source that is itself invalid or unavailable still fails without
retry.

## Graph, time and evidence

The graph stores typed entities and directed subject/predicate/object
assertions, including entity-to-value facts. It is a relational graph in
PostgreSQL with scoped, bounded breadth-first traversal. pgvector supplies
semantic ranking alongside PostgreSQL lexical ranking. This is more than
entity co-occurrence: an assertion can express who works on a project, which
tool a routine uses, or when a preference changed.

Each assertion has world validity (`validFrom`, `validTo`) and recorded knowledge
time (`knownFrom`, `knownTo`). Intervals are half-open. Unknown validity is
explicit. A world change emits a revised historical interval and a replacement;
the historical copy ends where the change takes effect (or earlier, where it
had already ended), never before it began. A change the source states as
present without a date ("I moved to Oslo") takes effect at the source's
occurrence time: the latest time the source shows the new state held. Its
`validFrom` is then that time and `validFromBasis` is `observed`; a date the
source states has basis `stated`, and an assertion stored without the key
reads as stated. An assertion that supersedes nothing keeps an unknown start
unknown. The extraction prompt shows the occurrence time as ISO 8601 in UTC
and in the epoch milliseconds its dates are given in, and asks for relative
dates to be resolved against it, never against the current time.
A correction preserves what was previously believed without treating the old
claim as currently valid.

A successor links the earlier state it replaced in `replaces`, a list of `{
id, supersession }` written on the successor at staging, never on the record
it retired (whose only change is its `knownTo`). A relation's change links the
history copy, which carries the ended `validTo`; a relation's correction links
the retired relation. A memory supersedes too: an extracted memory says why
(`supersession`, `change` when the situation changed, `correction` when the
earlier memory was wrong), and the new memory links each memory it retires
with that supersession. The extraction prompt (version 3 on) asks for this and
for the new memory to state the new situation and what it replaces. A record
stored before links existed decodes with none. Query `graph.perspective` with separate `validAt` and
`knownAt` coordinates. Temporal graph filtering applies at every hop. Historical
graph filtering does not make RAG's current chunk index a historical chunk index;
original source revisions are read explicitly by their reference.

Entity identities are resolved conservatively from supplied candidates. Every
entity and assertion retains exact source evidence. Ambiguous identities remain
distinct. The extractor cannot invent source identities, retire another scope's
records, or publish invalid intervals. Every extracted span includes a literal quote. A quote found in the source repairs offset
errors (its occurrence nearest the proposed start); a record with an invented quote is left out. A review pass checks extraction
against the source before embedding and publication. This validates evidence links;
semantic entailment still depends on model quality and evaluation.

Extraction calls are bounded by `maxExtractionChars` (48,000 by default on both
engines), separately from `maxSourceChars`, the largest source an engine
accepts. A longer source is split into windows at paragraph, line or word
boundaries (`knowledgeExtractionWindows`); each window is extracted, and
reviewed, in its own helper calls, one window after another, and its prompt
frames that part alone and says which part it is. The engine merges the
windows' results before staging: spans are checked and repaired within their
window, then moved to exact offsets into the whole source; an entity named in
several windows becomes one entity when its key and existing identity agree,
and any other repeated key is renamed (`key~2`). A source that fits one window
makes exactly the calls of a whole-source extraction. `extractKnowledge` runs
this for a host that builds its own engine.

Profiles and routines are evidence-backed memory kinds. Explicit preferences
need no recurrence threshold. Inferred routines need support from at least three
distinct source episodes and remain observations, not execution permission.
Corrections and forgetting invalidate dependent inferences so stale summaries
are hidden while surviving evidence is rebuilt.

`consolidate: false` on the memory engine supplies an additive extraction
control for evaluation: it suppresses inferred memories and supersession. Use a
separate collection/build for this control. Normal operation enables consolidation.

Memory recall and RAG combine lexical/vector candidates, graph expansion and,
when enabled, query planning and evidence reranking. Reciprocal rank fusion
ranks every list on its own: each query's lexical and semantic results (the
question's, and with planning each planned query's) give a candidate
`1 / (61 + rank)` at its 0-based rank there, and its score is the sum over the
lists that hold it, so a candidate a planned query finds first ranks with the
question's best and one several queries find gains from each
(`fuseKnowledgeCandidates` takes one pair or one per query). Memory recall
then weighs each memory by how often it was said
([memories said in several episodes](#memories-said-in-several-episodes)). Traversal defaults to two
hops and is capped at three. Results expose truncation and retain citations.
Query/model work has explicit budgets; invalid planner/reranker output falls
back to deterministic retrieval. Retrieved text is framed as data in a recorded turn-tier section;
memory's can be turned off and placed by the host instead ([place memory recall yourself](#place-memory-recall-yourself)).

## Narrow retrieval per turn

A host that keeps one owner's sources apart, such as each conversation's own
attachments or one workspace of a team, narrows retrieval without replacing
the tools or sections. `KnowledgeNarrowing` is a reference the document and
memory capabilities ask, once per tool call or section render, for the run's
`KnowledgeReach`: the owner whose knowledge it reads and, optionally, the only
source ids it may read, the metadata those sources must carry
([narrow by source metadata](#narrow-by-source-metadata)), or both. The
default reaches the session owner's whole collection. Provide your own among
the agent's `services` or a turn's services:

```ts
import { Context, Effect } from "effect"
import { KnowledgeNarrowing } from "@xandreed/core"
import type { KnowledgeSourceFilter } from "@xandreed/core"

declare const sourcesOfConversation: (conversation: string) => Effect.Effect<KnowledgeSourceFilter>

const narrowing = Context.make(KnowledgeNarrowing, {
  reach: (run) => sourcesOfConversation(run.session.id).pipe(
    Effect.map((sources) => ({ owner: run.session.owner, sources })),
  ),
})
```

With sources listed, `search_knowledge`, `recall_memory` and both recall
sections pass them on as `sources`; `read_knowledge` and `read_memory` answer a
source outside them as not found, and an empty list reads nothing. A record is
kept only when every span of its own provenance cites a listed source (a
memory's restatements by other sources are no part of it: see
[one memory for a repeated statement](#one-memory-for-a-repeated-statement)). A graph
entity is kept when a listed source mentions it, with only those spans, and a
relation needs every span listed and both of its entities kept. Owners and
sources come from the host, never from model arguments. Narrowing scopes what
a turn reads, never what it may change: saving and forgetting a memory stay
on the session owner's memory, as conversation capture does, and
`forget_memory` answers a source outside the listed ones as not found, as
`read_memory` does. A reach that fails makes the tools report the collection
unavailable and leaves the recall sections out of that turn.

Host calls take the same filter: `Knowledge.retrieve` and
`LongTermMemory.recall` accept `sources` (`KnowledgeRecall.sources`, at most
1000 ids), and `KnowledgeIndex.search` applies `KnowledgeSearch.sources` in the
store, in SQL for PostgreSQL. The engine's namespace and collection stay the
configured ones.

### Narrow by source metadata

A host that marks its sources with metadata at ingestion (a project, a kind,
a visibility) narrows by it instead of turning those marks into id lists of
its own. `KnowledgeReach.metadata`, `KnowledgeRecall.metadata` and
`KnowledgeSearch.metadata` take a `KnowledgeMetadataFilter`: top-level keys of
`KnowledgeSource.metadata`, each with a JSON scalar or a list of alternatives.
Every key must hold; a key holds when the metadata's value equals the scalar,
or one of the alternatives, exactly. A key the metadata lacks matches nothing,
`null` matches only a stored `null`, an array or object value matches no
scalar, and an empty list of alternatives matches nothing. A filter names at
most 16 keys and 100 alternatives a key; an empty filter matches every source.

```ts
import { Context, Effect } from "effect"
import { KnowledgeNarrowing } from "@xandreed/core"

const narrowing = Context.make(KnowledgeNarrowing, {
  reach: (run) => Effect.succeed({
    owner: run.session.owner,
    metadata: { project: "atlas", kind: ["notes", "spec"] },
  }),
})
```

A record is judged by the metadata of the source revisions it cites, the
same rule as for `sources`: a chunk when the revision it quotes matches, a
memory or a relation only when every revision its spans cite does, and a graph
entity with only its spans in matching revisions. A record from an older
revision is judged by that revision's metadata, so a memory read as of an
earlier time still matches what its revision said then. With both `sources`
and `metadata`, both must hold. `read_knowledge` and `read_memory` answer a
revision outside the filter as not found, and the memory section's profile
keeps only memories within it. Forgetting removes every revision of a
source, which a filter on revisions cannot vouch for, so while a metadata
filter is set `forget_memory` answers every source as not found: a host that
isolates by metadata gets the same isolation for deletes. A turn that should
forget narrows by a source list instead, which `forget_memory` checks.

The stores apply the filter before ranking and the limit, so a narrow filter
still returns its best matches when the unfiltered nearest neighbours all lie
outside it: the in-memory store filters before scoring, and the PostgreSQL
store joins each candidate to the source revision it cites, inside the lexical
and semantic statements, before `ORDER BY` and `LIMIT`. The engines narrow the
graph with the info of the revisions it cites (`KnowledgeIndex.sourceInfo`).
`matchesKnowledgeMetadata`, `admitsKnowledgeSource`, `knowledgeNarrowingAdmits`
and `narrowKnowledgeGraphBy` state the rule for a host's own store or tools.

## Cited sources and evidence text

A `retrieve` or `recall` result names, beside its candidates and graph, the
source revisions its evidence cites. `sources` holds one `KnowledgeSourceInfo`
per cited revision, once each, in order of first citation (candidates, then
relations, then entities, then earlier states): its `ref`, `occurredAt`, `recordedAt` and the
host's `metadata` as ingested, without the text. A host shows a title, link,
page or date beside a citation without a source read per hit; `source(scope,
ref)` still returns the text. `citedKnowledgeSources(result)` lists the cited
references themselves. The engines read the info in one call,
`KnowledgeIndex.sourceInfo(scope, refs)`, which leaves out absent and forgotten
revisions; a result encoded before `sources` existed decodes with none.

The text the tools give the model is exported for a host's own tools:
`knowledgeEvidenceText` (the evidence `search_knowledge` and the
`knowledge.evidence` section show) and `knowledgeSourcePage` (a
`read_knowledge` page) from `@xandreed/plugin-rag`, and `renderMemoryRecall`
and `memorySourcePage` from `@xandreed/plugin-memory`. A host tool that
retrieves evidence its own way and renders it with them gives the model the
same framing, citations and data rule as the built-in tools. The host's
metadata is not added to that text; memory recall adds each source's date
(below).

### Dated memory recall

Memory recall shows the model when each record was said. Given a result's
`sources`, `renderMemoryRecall(result, maxChars, options)` states one reading
rule above the evidence, "Each record is dated by when its source was said or
written; a validity range bounds when a relationship held.", and labels each
record:

```text
[2026-03-02 · preference · stated] The user prefers tea.
Source: conversation:…:1:0 revision 1, characters 6-19

[2026-05-14 · valid 2026-05-14–present (start taken from when it was said)] The user lives in Oslo.
Source: conversation:…:1:0 revision 1, characters 6-22
```

- A memory: the date, its kind and whether it was stated or inferred.
- A passage: the date.
- A relation: the date and, when known, its validity: `valid <from>–<to>`,
  `valid <from>–present`, or `valid until <to>` when only its end is known.
  A start taken from the source's occurrence time (`validFromBasis:
  "observed"`) says so.

The date is the UTC calendar date of the source revision the record's first
span cites (`knowledgeRecordDate(provenance, sources)` in
`@xandreed/core`). Staging puts a record's own spans first, before its
entities' evidence and its supports, and a relation's history copy keeps the
earlier relation's spans first, so that revision is where the record was
stated. A record whose revision is missing from `sources` (forgotten, or a
result encoded before `sources` existed) keeps its other labels, undated.

`options.now` adds "Today is YYYY-MM-DD." after the reading rule and marks a
relation whose validity ended by then `(no longer current since <date>)`.
Without `sources`, or with `dates: false`, the text is exactly as before
records were dated. The `maxChars` budget still bounds the records' text and
citations; the labels add about 30 characters per record on top of it, and
about 30 more for a count.

The memory engine renders its `memory.recalled` section, `memoryRecallNote`
and `recall_memory` this way. `recallDates` (default `true`) turns the labels
on: a record's date never changes, so a recorded section or a cached prefix
stays the same from turn to turn. `recallToday` (default `false`) adds
today's date from the clock; the text then changes daily, so turn it on only
where recall is not part of a cached prefix. The section dates its profile
records from the recall's `sources` and, for a record whose revision the
recall did not cite, reads that revision (`LongTermMemory.source`) once.

### Earlier states in memory recall

A memory recall also returns the earlier states its current records replaced,
so the model can answer what was true before ("what did I drink before?")
without mistaking it for what is true now. `KnowledgeRecallResult.history`
holds one entry per earlier state, in the rank order of its successor: the
retired memory, or the relation's history copy or retired relation, as
`record`, with `successor` (the current record's key: `memory:<id>`, or
`knowledgeAssertionKey(relation)`, `assertion:<id>`), the `supersession`, and
`until`: when it stopped being current (a change's ended validity for a
relation, otherwise the date its successor was said). A result encoded before
`history` existed decodes with none.

`KnowledgeRecall.history` chooses which: `"changes"` (the default) follows
changes only, `"all"` also corrections, and `"none"` none. Corrections are
left out by default because a correction says the earlier belief was wrong.
`historyShare` (0 to 0.5, default 0.2) is the most of `maxChars` they may
take. The selection is deterministic, in three passes:

1. Current candidates and relations within `(1 - historyShare) × maxChars`.
2. One hop of `replaces` from the records pass 1 kept, in their rank order
   (candidates, then relations), within the share and what pass 1 left, at
   most `ceil(limit / 2)` of them. A memory is read by id
   (`MemoryStore.memory`); a relation comes from the snapshot recall already
   read. A link whose record was forgotten, is still current, or cites a
   revision outside the recall's `sources` or `metadata` is skipped.
3. Whatever the share left unused goes to further current records.

When no earlier state is followed, current evidence takes the whole budget,
exactly as before. `budgetKnowledgeRecall(result, maxChars, limit,
historyShare)` in `@xandreed/core` is this budget. Document retrieval
(`Knowledge.retrieve`) returns no earlier states.

`renderMemoryRecall` shows them after the current records, inside the same
frame, under their own heading:

```text
Earlier states, no longer current:

previously: The user usually drinks coffee in the morning. (until 2026-06-03; replaced by conversation:…:switched:1:0 revision 1)
Source: conversation:…:usual:1:0 revision 1, characters 6-44
```

A correction reads `previously: <text> (corrected YYYY-MM-DD; this was
wrong)`. Each line names the revision that states its successor, shown among
the current records. The memory engine's `recallHistory` (default `"changes"`)
and `recallHistoryShare` (default `0.2`) set both for the section,
`memoryRecallNote` and `recall_memory`, whose `history` parameter lets the
model ask for `all` or `none` on one call.

### Memories said in several episodes

A preference the user states in four conversations is better evidence than
one stated once. Memory recall counts it, ranks by it and tells the model.

Each memory records the source revisions whose own text states it,
`KnowledgeMemory.mentions`. Staging writes the source it extracts a stated
memory from; an inferred memory mentions that source and every revision that
states one of its supports. A memory's provenance may cite more revisions,
because staging appends its entities' evidence and its supports' provenance;
those never count as stating it. `knowledgeMemoryMentions(memory)` reads them,
and a memory stored before mentions existed falls back to the revision its
first span cites when stated, and every revision its provenance cites when
inferred. Publication refuses a memory that mentions a revision its
provenance does not cite, so forgetting a mentioned source removes the memory
with the rest of that source's evidence and requeues its other sources: a
forgotten source never counts.

`knowledgeMemorySupport(memory, infos)` gives a `KnowledgeSupport` from the
info of the mentioned revisions (`KnowledgeIndex.sourceInfo`): `episodes`,
the distinct `metadata.episode` values among the revisions found (a revision
without one counts as its own source, as for inferred routines), `sources`,
and `firstSeen` and `lastSeen`, the earliest and latest occurrence times.
Captured turns carry one episode per turn, and a remembered note its turn's.

Recall fuses the searches' lists as above into a pool of at most 100
candidates, reads the info of the pool's mentioned revisions in one batch, and
fuses again with a weight (`fuseKnowledgeCandidates(lists, limit, maxChars,
weight)`), each memory carrying its `support`:

```text
final = rrf × (1 + supportWeight × ln(min(episodes, 4)))
```

The weight applies to `preference`, `routine`, `profile` and `fact` memories;
chunks and other kinds weigh 1. With the default `supportWeight` of `0.15`,
two episodes weigh ×1.10, three ×1.16 and four or more ×1.21, so repetition
reorders records of similar relevance. Near the top of the lists a record
passes only records within about twelve places of it in both arms: a fact
both arms rank first stays ahead of a preference said in four episodes that
they rank twentieth. `supportWeight: 0` turns support off: no read, no
weight and no count, exactly as before.

`renderMemoryRecall` adds the count to a dated memory's labels when it was
said in two episodes or more, with the date of the latest:

```text
[2026-05-14 · preference · inferred · said 3 times, last 2026-05-14] The user's favourite drink is green tea.
```

The section's profile records show the count recall found for them.

### One memory for a repeated statement

Counting mentions helps only when a repeated statement is one memory. The
extraction prompt (version 4) shows the active candidate memories and asks the
model, when the source states one of them again without changing it, to return
it with `restates` naming that candidate instead of writing a new record: a
restatement adds evidence, not a memory. Staging turns such a proposal into a
corroboration (`KnowledgeStage.corroborations`: the memory, the source revision
as `mention`, and the proposal's own spans as `provenance`) of each named
memory that is active, stated, of the proposal's kind and published by
another source. A named memory that is unknown or no longer active drops the
proposal with a `RecordDropped` note; one that is inferred, of another kind or
published by this source (its next revision retires it) leaves the proposal a
new memory, as does a proposal that supersedes something. A memory another
proposal of the same extraction supersedes is never corroborated, since
publication refuses a corroboration of a memory its own stage retires: a
proposal that restates only such memories repeats the state the extraction
replaces and is dropped with a `RecordDropped` note ("The extraction restates a
memory it also supersedes"), and the successor publishes.

An extraction that misses a restatement gets a second chance once the stage is
embedded. `mergeKnowledgeRestatements(stage, snapshot, source, minSimilarity)`
takes a new stated memory that replaces nothing as a corroboration of the
active stated memory with the same kind and exactly the same entities, from
another source, whose embedding's cosine with its own is at least
`minSimilarity` (the most similar one, ties by id). The memory engine runs it
with `MemoryConfig.restatementSimilarity` (default `0.92`; `false` turns it
off). A memory without entities never merges, so two facts about different
people, places or things stay apart however alike their sentences read.

Publication appends a corroboration's spans to the memory's provenance and its
revision to the memory's `mentions` (`corroborateKnowledgeMemory`), writes the
source rows that link the memory to that revision, and neither writes a record
nor retires one. The memory must still be active once the publication has
retired what it replaces, or publication fails with `Conflict` and changes
nothing. When a later revision of a corroborating source is published, the
memories that source published retire as before, while a memory another source
published loses the earlier revision's spans and mention instead of retiring
(`stripKnowledgeRevisions`); the new revision restates it again if it still
says so. Forgetting a corroborating source uses the source closure: the memory
is removed and its other sources are requeued, and their extraction builds it
again from the mentions that survive, so a memory three conversations stated
is said twice once one of them is forgotten.

A read narrowed by `sources` or `metadata` judges a memory by its own evidence:
the spans of the revision that published it and of its entities. The revisions
that restated it later (a stated memory's `mentions` after the first) are no
part of that evidence, so a restatement from outside the reach, such as another
episode, project or tenant, neither hides the memory from a read that admits its
source nor shows there: `narrowKnowledgeMemory` leaves the restatement's spans
and mention out of the record the stores' search, the memory section's profile
and the earlier states return, and support counts only the mentions left. A
read that admits only the restating source finds nothing, as before.

```text
[2026-02-03 · fact · stated · said 3 times, last 2026-07-09] The user lives in Lisbon.
[2026-08-01 · fact · stated] The user's sister lives in Porto.
```

## Place memory recall yourself

By default the memory engine contributes the `memory.recalled` turn section.
Before the turn's first step it catches up capture of the session's committed
turns, then recalls for the user's message and records the evidence as the
turn's context, among the stable messages a provider can cache. A host that
wants recall only at the end of each step's request, resent every step and
never recorded as turn context, or no automatic recall at all, sets
`recallSection: "off"`: the engine then contributes no section and runs no
catch-up. Capture still follows committed turns through `memoryCapturePlugin`,
or the host's own `MemoryCapture.sync`; the tools are unchanged.

`memoryRecallNote(config)` gives the section's text without the section or the
catch-up: the same profile records and evidence, reach (`KnowledgeNarrowing`,
its source list and metadata filter included), `recallChars` budget and `retrievalTimeoutMs` deadline, rendered by
`renderMemoryRecall`, or none when nothing is recalled or recall fails. It
requires `RunContext`, which the turn provides, and `LongTermMemory`: build the
engine as above and pass its services to `Agent.define`, so a turn's `use` has
it. Recall once per turn and close each step's request with the same text
through the turn policy's `step` and `stepContext: "tail"`:

```ts
import { Effect, Option } from "effect"
import { memoryDefaults, memoryRecallNote } from "@xandreed/plugin-memory"
import type { Turn } from "@xandreed/sdk"

// The options the engine was built with.
const options = { recallSection: "off" as const, embeddingDimensions: 768 }
const recallNote = memoryRecallNote({ ...memoryDefaults, ...options })

// The `use` of `agent.turn(input, use)`.
const use = (turn: Turn) => Effect.gen(function* () {
  const recalled = yield* Effect.cached(recallNote)
  const result = yield* turn.run({
    stepContext: "tail",
    step: () => recalled.pipe(Effect.map((context) => ({ context, toolChoice: Option.none() }))),
  })
  return { outcome: result.outcome, reply: Option.some(result.text) }
})
```

A `ModelRequestHook` may return the same text as its `context` instead; the
turn adds a hook's context as a host note.

## Documents, tools and lifecycle

RAG accepts host-supplied text or Markdown. The host handles file parsing, URLs
and connectors. Chunking preserves UTF-16 offsets into the exact source revision
and prefers structural boundaries. Replace a document with the next integer
revision and `expectedRevision: Option.some(previousRevision)`. Its prior index
remains searchable until the new chunks, and the graph unless its last attempt
omitted it, are ready to publish atomically. Obsolete chunk locators become unavailable; source revisions remain
explicitly addressable until forgotten.

Memory tools are `recall_memory`, `read_memory`, `remember_memory` and
`forget_memory`. Read tools are always available through the memory skill.
Loading the management skill requires the `memory.write` grant. RAG exposes
read-only `search_knowledge` and `read_knowledge`. Its automatic turn recall is
opt-in with `recall: true`. Owner identities come from the run, by default
its session owner ([narrow retrieval per turn](#narrow-retrieval-per-turn));
model arguments cannot select another owner or source. Collections and namespaces never
implicitly join personal and document knowledge.

`forget(scope, sourceId)` tombstones all revisions, removes source text from the
native store, cancels pending work and hides dependent indexed knowledge,
including historical graph reads. Retry and backfill cannot resurrect that
source. Affected indexed text, vectors and provenance are purged. Every durable
extraction stage in the same scope is discarded; version and provenance checks
reject stale work before it can be staged again. Minimal identity fences and
tombstones remain. The original conversation journal and database backups have
independent retention. Use an explicit new source identity for newly authorized
evidence.

Native workers rescan durable jobs on startup, renew leases during processing,
and expose admitted claims and claimed work through `BackgroundWorkers`.
Sleeping pollers and queued jobs do not count as active work. Shutdown lets
admitted turns commit and enqueue,
stops new claims, then drains or interrupts active workers within the shared
deadline before their database scope closes. Retained jobs are recoverable by
another worker. A claim still waiting on storage at the deadline remains reported
in flight; cancellation prevents extraction when it returns. A serverless host
can disable the worker and schedule bounded `process` calls.

## Research and quality

The design draws on the following primary sources. Their engines are used only
as optional controlled evaluation baselines.

| Reference | Pattern used in Efferent |
|---|---|
| [past.dev](https://past.dev/blog/giving-ai-a-past) | Event time, source evidence and supersession |
| [Mem0](https://docs.mem0.ai/core-concepts/how-it-works) | Extraction, deduplication and reusable facts |
| [Zep](https://arxiv.org/abs/2501.13956) and [Graphiti](https://github.com/getzep/graphiti) | Incremental temporal relationships and hybrid graph retrieval |
| [Letta](https://docs.letta.com/agent-sdk/memory) | Small profiles, deeper retrievable memory and background consolidation |
| [Supermemory](https://supermemory.ai/docs/concepts/how-it-works) | Separate source passages and derived memory readiness |
| [Hindsight](https://arxiv.org/abs/2512.12818) | Distinct evidence, experiences and inferred observations |
| [Contextual retrieval](https://www.anthropic.com/research/contextual-retrieval) | Complementary lexical/semantic retrieval and evidence reranking |

Conformance, scripted models and real PostgreSQL tests prove the contracts;
they do not establish competitive extraction or answer accuracy. The
[evaluation guide](knowledge-evaluation.md) provides LongMemEval/LoCoMo
normalization, matched-budget comparisons and graph ablations. Run those with
explicit models and credentials before claiming parity. The initial exact-vector implementation and scoped
extraction snapshots suit modest corpora; measure memory, indexing and retrieval
costs before claiming large-scale performance or adding approximate indexes.
