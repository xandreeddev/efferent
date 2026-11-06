---
title: Native memory and RAG
description: Evidence-backed conversation memory, temporal graphs and cited document retrieval.
---

# Native memory, temporal graphs, and RAG

Start with [how memory learns and retrieves](/docs/guides/memory-engine/): one
statement becomes source records, memory sentences, graph edges and vectors,
then a question passes through search, rank fusion, traversal and reranking.
It shows the stored rows, actual ranking formula and current implementation limits.
This page is the composition and lifecycle reference.

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

Each engine records its jobs under an engine id that names the engine and its
embedding space: `knowledgeEngineId("rag:1", space)` is
`rag:1/<model>/<version>/<dimensions>` (a `/` or `%` in the model or version is
escaped). A worker discovers (`pending`) and claims (`claim`, also by job id)
only jobs recorded under its own id, so processes configured with different
embedding spaces can share one store without indexing each other's sources. A
job queued under another configuration waits for a worker of that
configuration. The engine sets the id on `ingest` and `capture`, whatever
`engine` the caller passes.

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
publish no partial facts or document revisions. Successful staged extraction is
reused after an embedding failure. Scope-version conflicts trigger reconciliation
against the updated graph.

A document's graph is optional; its chunks are not. When graph extraction or its
review fails, or the helper's answer is invalid, the failure is recorded on the
job and the job is retried within `maxAttempts`: an invalid model answer is not
an invalid source. The last attempt stages and publishes the source's chunks
without entities or assertions, and the completed job's stage carries a
`GraphOmitted` note with the failure's reason and message
(`stage.notes`, read through `status`). Ingest the next revision to extract its
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
a correction preserves what was previously believed without treating the old
claim as currently valid. Query `graph.perspective` with separate `validAt` and
`knownAt` coordinates. Temporal graph filtering applies at every hop. Historical
graph filtering does not make RAG's current chunk index a historical chunk index;
original source revisions are read explicitly by their reference.

Entity identities are resolved conservatively from supplied candidates. Every
entity and assertion retains exact source evidence. Ambiguous identities remain
distinct. The extractor cannot invent source identities, retire another scope's
records, or publish invalid intervals. Every extracted span includes a literal quote. A quote found in the source repairs offset
errors (its occurrence nearest the proposed start); invented quotes are rejected. A review pass checks extraction
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
when enabled, query planning and evidence reranking. Traversal defaults to two
hops and is capped at three. Results expose truncation and retain citations.
Query/model work has explicit budgets; invalid planner/reranker output falls
back to deterministic retrieval. Retrieved text is framed as data in a recorded turn-tier section.

## Narrow retrieval per turn

A host that keeps one owner's sources apart, such as each conversation's own
attachments or one workspace of a team, narrows retrieval without replacing
the tools or sections. `KnowledgeNarrowing` is a reference the document and
memory capabilities ask, once per tool call or section render, for the run's
`KnowledgeReach`: the owner whose knowledge it reads and, optionally, the only
source ids it may read. The default reaches the session owner's whole
collection. Provide your own among the agent's `services` or a turn's
services:

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
kept only when every span of its provenance cites a listed source. A graph
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

## Cited sources and evidence text

A `retrieve` or `recall` result names, beside its candidates and graph, the
source revisions its evidence cites. `sources` holds one `KnowledgeSourceInfo`
per cited revision, once each, in order of first citation (candidates, then
relations, then entities): its `ref`, `occurredAt`, `recordedAt` and the
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
same framing, citations and data rule as the built-in tools; the metadata is
for the host and is not added to that text.

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
[evaluation guide](/docs/concepts/knowledge-evaluation) provides LongMemEval/LoCoMo
normalization, matched-budget comparisons and graph ablations. Run those with
explicit models and credentials before claiming parity. The initial exact-vector implementation and scoped
extraction snapshots suit modest corpora; measure memory, indexing and retrieval
costs before claiming large-scale performance or adding approximate indexes.
