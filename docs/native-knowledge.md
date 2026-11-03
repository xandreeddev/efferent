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
embedding service. GraphRAG also requires `UtilityLlm`; query planning and
reranking use it when available. Supply a model suitable for extraction and
relationship reasoning. The models plugin's `fastModel` configures its helper
model independently of the main conversation model.

`embeddingModel`, `embeddingVersion` and `embeddingDimensions` identify the
host's actual embedding space. Configure the same identity on both engines when
sharing a model. Incompatible stored and query vectors fail explicitly. Changing
models requires a new collection or a deliberate reindex.

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
    jobId: KnowledgeJobId.make("handbook:1"), engine: "rag:1",
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
before using a restricted application role. Never point the native adapter at
another product's private tables.

## Conversation and action capture

`memoryCapturePlugin` is built before the turn and observes acknowledged closing
commits. It saves the user's initial and steered input, the final host reply,
and recorded tool outcomes. Assistant proposals, hidden reasoning, retrieved
context, summaries and memory/RAG results do not become fresh learning evidence.
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

Memory processing is asynchronous. `capture` or `ingest` returning a job means
the source is durably accepted. Inspect `status`, call `process` explicitly, or
let the worker publish it. `retry` requeues a failed job. Model/embedding errors
publish no partial facts or document revisions. Successful staged extraction is
reused after an embedding failure. Scope-version conflicts trigger reconciliation
against the updated graph.

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
records, or publish invalid intervals. Every extracted span includes a literal quote. Unique quotes can repair offset
errors; ambiguous or invented quotes are rejected. A review pass checks extraction
against the source before embedding and publication. This validates evidence links;
semantic entailment still depends on model quality and evaluation.

Profiles and routines are evidence-backed memory kinds. Explicit preferences
need no recurrence threshold. Inferred routines need support from at least three
distinct source episodes and remain observations, not execution permission.
Corrections and forgetting invalidate dependent inferences so stale summaries
are hidden while surviving evidence is rebuilt.

`consolidate: false` on the memory engine supplies an additive extraction
control for evaluation: it suppresses inferred memories and supersession. Use a
separate collection/build for this control. Normal operation enables consolidation.

Memory recall and RAG combine lexical/vector candidates, optional query planning,
graph expansion and evidence reranking. Traversal defaults to two hops and is
capped at three. Results expose truncation and retain citations. Query/model work
has explicit budgets; invalid planner/reranker output falls back to deterministic
retrieval. Retrieved text is framed as data in a recorded turn-tier section.

## Documents, tools and lifecycle

RAG accepts host-supplied text or Markdown. The host handles file parsing, URLs
and connectors. Chunking preserves UTF-16 offsets into the exact source revision
and prefers structural boundaries. Replace a document with the next integer
revision and `expectedRevision: Option.some(previousRevision)`. Its prior index
remains searchable until the new chunks and optional graph are ready to publish
atomically. Obsolete chunk locators become unavailable; source revisions remain
explicitly addressable until forgotten.

Memory tools are `recall_memory`, `read_memory`, `remember_memory` and
`forget_memory`. Read tools are always available through the memory skill.
Loading the management skill requires the `memory.write` grant. RAG exposes
read-only `search_knowledge` and `read_knowledge`. Its automatic turn recall is
opt-in with `recall: true`. Owner identities always come from `RunContext`;
model arguments cannot select another owner. Collections and namespaces never
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
