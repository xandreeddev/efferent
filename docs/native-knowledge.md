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
extraction version (`KNOWLEDGE_EXTRACTION_VERSION`, now `8`) and its
embedding space: `knowledgeEngineId("rag:8", space)` is
`rag:8/<model>/<version>/<dimensions>` (a `/` or `%` in the model or version is
escaped). A worker discovers (`pending`) and claims (`claim`, also by job id)
only jobs recorded under its own id, so processes configured with different
embedding spaces can share one store without indexing each other's sources. A
job queued under another configuration waits for a worker of that
configuration. The engine sets the id on `ingest` and `capture`, whatever
`engine` the caller passes. A new extraction version changes the id, like a
new embedding space: a job still queued under a previous one (`memory:7/…`,
`rag:7/…`) waits for a worker of that version, so let one drain the queue
before switching. A job that failed under it is started over under the
current id by `retry` (below). Extraction version 2 stages what version 1
failed with `Invalid` for one record's sake, but `isRetryableKnowledgeFailure`
calls `Invalid` final, so list those jobs with
`failed({ namespace, reasons: ["Invalid"] })` and pass them to `retry`
directly. Version 3 asks each extracted memory why it supersedes
(`supersession`) and links successors to what they replaced; version 4 lets
it name the candidate memory a source restates (`restates`), which adds
evidence to that memory instead of a new one
([one memory for a repeated statement](#one-memory-for-a-repeated-statement));
version 5 gives a memory the time of the dated event it concerns (`eventAt`)
([plans tied to a dated event](#plans-tied-to-a-dated-event)); version 6
writes the review's proposal in the output schema's wire form
([evidence review](#graph-time-and-evidence)); version 7 asks for a
`supersession` only from a record that supersedes others
([graph, time and evidence](#graph-time-and-evidence)); version 8 tells
memory extraction how to refer to the conversation's user
([conversation and action capture](#conversation-and-action-capture)). A job of an earlier version
that failed is retried the same way: `retry` requeues it under the current
id through `KnowledgeIndex.requeue`. A memory job whose review copied
version 5's proposal back failed with `Invalid` ("The extraction model
returned an invalid knowledge object"), which `isRetryableKnowledgeFailure`
calls final, so list it with `failed({ namespace, reasons: ["Invalid"] })`
and `retry` it directly; a document whose graph was omitted that way is
extracted again by ingesting its next revision. A job that failed under
version 6 with the same message because a record that supersedes nothing gave
a `null` or no `supersession` is retried the same way, and so is a memory
job that failed under version 7 with `Invalid` and "The extraction refers to
an undefined entity key" because every record it proposed named the user
without defining it.

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
records a failure with `KnowledgeIndex.fail(lease, { reason, message, step, diagnostic })`. Successful staged extraction is
reused after an embedding failure.

A failed extraction also records where and how it failed, without its content,
in the failure's `diagnostic` (`KnowledgeFailureDiagnostic`), so a host or a
trace can tell a reply cut off at the output cap from one that drifted from the
schema or one staging refused. `stage` is `extract` or `review` when that
call's reply did not decode, and `stage` when staging refused the decoded
extraction as a whole (a repeated entity key, no record surviving its checks).
For a reply that did not decode, `path` is where its first decode issue sits,
as keys and array indexes (`["assertions", 0, "supersession"]`; empty for the
reply as a whole, such as JSON cut off mid-string), `finishReason` and
`outputTokens` are what the helper completion reported
(`UtilityCompletion.finishReason`, which the models plugin's `UtilityLlmLive`
fills from the response's finish part, and its usage; a helper that reports
neither leaves them out, and a zero output count reads as unreported), and
`window` is the part of the source the call read (`{ part, parts }`). A reply
cut off at the cap reads `finishReason: "length"` with an empty `path`; a
schema drift names the field that broke it; a staging refusal holds the stage
alone. It never holds the model's text, a quote or the source, and a failure
that is not an extraction's (a model call that timed out, embedding, storage)
has none. `status` and `KnowledgeIndex.failed` return it with the phase, and a
failure recorded before diagnostics decodes without one; the
`knowledge.failure-reason` check of `knowledgeStoreConformance` round-trips
one through a store, its failed listing included. The native engines also set
it on the span that processed the job, through `knowledgeFailureAttributes`:
`efferent.knowledge.failure.stage`, `efferent.knowledge.failure.path` (JSONPath
in bracket notation, `$` for the reply as a whole),
`efferent.knowledge.failure.finish_reason`,
`efferent.knowledge.failure.output_tokens` and
`efferent.knowledge.failure.window` (`part/parts`). A host's own engine builds
the job's failure from a `KnowledgeError` with `knowledgeJobFailure(error,
step)`, which keeps the error's diagnostic. Scope-version conflicts trigger reconciliation
against the updated graph.

Staging (`stageKnowledgeExtraction`) checks each extracted record on its own.
A record that fails a check of its own is left out and the rest of the
extraction is staged and published: a span that is not the exact source text
even after its quote repaired the offsets (a quote that differs from the source
only in its quotes, apostrophes, dashes or no-break spaces is repaired to the
source's text), an `existing` entity identity that is
not among the supplied candidates, a reference to an entity key the extraction
does not define, a `supersedes` entry that names an unknown or inactive record,
records superseded without a `supersession`, an inferred memory's unknown supporting memory, an inferred routine with fewer
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

Memory extraction (version 8 on) also says how to refer to the
conversation's user, whom every memory is already about: a memory never lists
the user in its `entities`, and a relationship whose subject or object is the
user defines the user in `entities` like any other entity, with a span where
the user speaks or refers to themselves. Every key a memory or relationship
names is defined in `entities`, as the output schema now also says of a
memory's `entities` and a relationship's `subject` and object `key`. A
memory's entities seed recall's graph traversal, so a memory that names no
user no longer brings each of the user's relationships into every recall that
finds it; recall reaches them through the other entities the memory or the
question names. Before version 8, extraction models often named an
undefined `user` key in a memory or a relationship, or another name for it
such as `user:self`, and staging
dropped that record with a `RecordDropped` note ("The extraction refers to an
undefined entity key"), losing the memory. Staging still drops such a record:
the rule changes what the model is asked, not what staging accepts. The
document prompt is unchanged but for the schema's descriptions. A completed
job keeps what it published; `retry` does not extract it again, so a memory it
dropped is learned again only when a later source states it.

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
for the new memory to state the new situation and what it replaces. An
extracted record gives a `supersession` only when its `supersedes` is
non-empty (version 7 on): one that supersedes nothing leaves it `null` or
out, and a value it gives anyway is ignored, so it neither dates nor links
anything. Staging drops a record that supersedes others without one, with a
`RecordDropped` note ("The extraction supersedes records without saying
whether it is a change or a correction"), and stages the rest; the records it
named stay active. Before version 7 the output schema required the key on
every record, so a reply with `"supersession": null` beside an empty
`supersedes`, the form extraction models commonly return, failed to decode
and failed the whole job. An extraction written in the earlier form, with a
value on every record, still decodes and stages as before. A record
stored before links existed decodes with none. Query `graph.perspective` with separate `validAt` and
`knownAt` coordinates. Temporal graph filtering applies at every hop. Historical
graph filtering does not make RAG's current chunk index a historical chunk index;
original source revisions are read explicitly by their reference.

Entity identities are resolved conservatively from supplied candidates. Every
entity and assertion retains exact source evidence. Ambiguous identities remain
distinct. The extractor cannot invent source identities, retire another scope's
records, or publish invalid intervals. Every extracted span includes a literal quote. A quote found in the source repairs offset
errors (its occurrence nearest the proposed start). A quote found nowhere exactly is compared again with
typography folded on both sides: single quotes, apostrophes and the prime (`‘ ’ ‚ ‛ ′`) read as `'`,
double quotes and the double prime (`“ ” „ ‟ ″`) as `"`, hyphens, dashes and the minus sign
(`‐ ‑ ‒ – — −`) as `-`, and the no-break, narrow no-break and figure spaces as a space. Each of these is
one UTF-16 unit read as one, so offsets stay the source's: a quote that differs from the source only in
this typography moves to the nearest such occurrence and takes the source's exact text there as its
quote, which staging's checks and the stored provenance then carry. An exact occurrence wins over a
typographic one. A record with an invented quote is left out. A review pass checks extraction
against the source before embedding and publication. Its prompt
(`knowledgeReviewPrompt`) shows the proposed extraction in the output
schema's wire form, the form the extraction call answered in: an absent
`existing` identity or `validFrom`/`validTo` date is `null`, a present one its
plain value. A reviewer that keeps the proposal as it is therefore returns a
valid extraction; before version 6 the proposal carried the decoded value's
`Option` objects (`{"_id":"Option","_tag":"None"}`), and a reviewer that
copied them back failed the output schema. This validates evidence links;
semantic entailment still depends on model quality and evaluation.

Extraction calls are bounded by `maxExtractionChars` (48,000 by default on both
engines), separately from `maxSourceChars`, the largest source an engine
accepts. A longer source is split into windows at paragraph, line or word
boundaries (`knowledgeExtractionWindows`); each window is extracted, and
reviewed, in its own helper calls, one window after another, and its prompt
frames that part alone and says which part it is. The engine merges the
windows' results before staging: spans are checked and repaired within their
window, typography included, then moved to exact offsets into the whole source; an entity named in
several windows becomes one entity when its key and existing identity agree,
and any other repeated key is renamed (`key~2`). A source that fits one window
makes exactly the calls of a whole-source extraction. `extractKnowledge` runs
this for a host that builds its own engine: its `complete` returns the helper's
`UtilityCompletion`, which `extractKnowledge` decodes, so a reply that does not
decode fails `Invalid` with its diagnostic (stage, window, path, finish reason
and output tokens), and a part that repeats an entity key names its window.

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
([memories said in several episodes](#memories-said-in-several-episodes))
and shows near-duplicates as one
([near-duplicates and a similarity floor](#near-duplicates-and-a-similarity-floor)). Traversal defaults to two
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

### The profile's order

The profile carries the same counts and is ordered by them, never by the
store. `LongTermMemory.profile` returns the current `preference` and `profile`
memories whose dated event, if any, has not passed, each with its `support`
(`KnowledgeProfileMemory`, a `KnowledgeMemory` with an optional `support`),
counted from the info of their mentioned revisions read in one batch. It
orders them by `knowledgeProfileOrder`: more episodes first, then the one said
more recently (`lastSeen`), then by id; a memory without support follows those
with it. Before, the profile kept the store's order: insertion order in memory
and id order in PostgreSQL, where a memory's id begins with its source's and
so with the host's session ids. The section's four profile records could then
leave out the preference said most often, and differ between stores.

The `memory.recalled` section (version 6) and `memoryRecallNote` show the
first four profile records the run's reach admits, in the profile's order and
with the profile's count: a narrowing applies before the cut, so a refused
record never takes an admitted one's place. A preference said in three
conversations precedes a newer one said once:

```text
[2026-02-03 · preference · stated · said 3 times, last 2026-06-11] The user takes oat milk in coffee.
[2026-07-13 · preference · stated] The user enjoys hiking at weekends.
```

`supportWeight: 0` reads nothing here either: the profile then has no counts
and is ordered by id. `longTermMemoryConformance`'s `profile-order` check holds
a host's own `LongTermMemory` to the same order and counts.

### One memory for a repeated statement

Counting mentions helps only when a repeated statement is one memory. The
extraction prompt (since version 4) shows the active candidate memories and asks the
model, when the source states one of them again without changing it, to return
it with `restates` naming that candidate instead of writing a new record: a
restatement adds evidence, not a memory. Staging turns such a proposal into a
corroboration (`KnowledgeStage.corroborations`: the memory, the source revision
as `mention`, and the proposal's own spans as `provenance`) of each named
memory that is active, stated, of the proposal's kind and published by
another source. A named memory that is unknown or no longer active drops the
proposal with a `RecordDropped` note; one that is inferred, of another kind or
published by this source (its next revision retires it) leaves the proposal a
new memory, as does a proposal that supersedes something or has another event time. A
memory another proposal of the same extraction supersedes is never corroborated,
since publication refuses a corroboration of a memory its own stage retires: a
proposal that restates only such memories repeats the state the extraction
replaces and is dropped with a `RecordDropped` note ("The extraction restates a
memory it also supersedes"), and the successor publishes.

An extraction that misses a restatement gets a second chance once the stage is
embedded. `mergeKnowledgeRestatements(stage, snapshot, source, minSimilarity)`
takes a new stated memory that replaces nothing as a corroboration of the
active stated memory with the same kind, event time and exactly the same entities, from
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

### Plans tied to a dated event

A plan, goal or interest tied to a dated event holds only until the event:
"I'd love to see the glass exhibition on 20 March" says nothing about what the
user wants in May. The extraction prompt (version 5) asks the model, when a
memory concerns a dated event (an appointment, a trip, a deadline, a booking),
to set `eventAt` to the event's time, resolving relative expressions against
the source occurrence time, with `end` only for an event that lasts beyond its
start. Staging keeps it on the memory (`KnowledgeMemory.eventAt`, a
`KnowledgeEventTime` of `start` and optional `end`, epoch milliseconds) and
drops a memory whose event ends before it starts with a `RecordDropped` note.
A memory stored before event times existed has none and is never past. A
restatement must have the same event time: a named one of another event, and
a similar new memory of another event, is written as its own memory.

A memory is past at a time when it is a `goal`, `decision`, `action` or
`preference` whose event ended before that time, at its `end`, else its
`start` (`knowledgeMemoryIsPast(memory, now)` in `@xandreed/core`). Facts,
routines and profiles are never past: "the exhibition opened in March" stays
true. Nothing is deleted or filtered from search for being past:

- Recall marks each past memory candidate `past: true`, judged at the recall's
  valid time (now, unless the graph perspective or the query plan names one).
- `KnowledgeRecall.temporal` chooses the ranking: `"current"` (the default)
  multiplies a past record's fused score by the memory engine's
  `pastEventWeight` (default `0.5`), after the support factor, so a current
  record of similar relevance ranks above it; `"all"` ranks it as any other.
  `pastEventWeight: 1` turns the demotion off. Document retrieval returns no
  memories and ignores it.
- `LongTermMemory.profile` leaves past records out, so the section's profile
  never shows a passed plan as current; recall still returns it.
- `renderMemoryRecall` says when after a memory's text, unless `dates` is
  false: `(event on YYYY-MM-DD)`, `(event on YYYY-MM-DD–YYYY-MM-DD)` for one
  that ends on a later day, and `(event on YYYY-MM-DD, past)` when recall
  marked it past. The section's version is 5 (6 since
  [the profile's order](#the-profiles-order), 7 since
  [near-duplicates](#near-duplicates-and-a-similarity-floor) fold).

```text
[2026-03-05 · preference · stated] The user is interested in weekly pottery classes at the community studio.
Source: conversation:…:1:0 revision 1, characters 6-68

[2026-03-02 · preference · stated] The user is interested in the glass exhibition on 20 March. (event on 2026-03-20, past)
Source: conversation:…:1:0 revision 1, characters 6-56
```

`recall_memory` takes a `temporal` parameter, so the model can ask for `all`
on one call ("which exhibitions did I want to see this year?"). A wrong
`eventAt` only demotes a live goal; it never hides one.

### Near-duplicates and a similarity floor

Restatements that publication did not merge (extracted without entities, with
another entity set, from the same source, or stored before restatements were
merged) are separate memories with near-identical embeddings. Each ranks close
to the others, so four wordings of one fact could fill four of recall's eight
places and push other evidence out. Memory recall folds them:

- After the support and event weights, in rank order, a memory of the same
  kind and event time as a memory ranked above it and kept, whose embedding's
  cosine with that memory's is at least `MemoryConfig.recallCollapseSimilarity`
  (default `0.95`), is folded into the first such one. Passages and
  memories without an embedding never fold.
- The folded memory leaves the result before reranking and the final
  selection, so its place and its share of the character budget go to the
  next evidence. The graph is still seeded with its entities.
- The kept candidate names the folded memories in `alike`
  (`KnowledgeCandidate`'s optional `KnowledgeMemoryId` list, in rank order) and
  carries their evidence as a corroborated memory does: their spans after its
  own in its provenance and the revisions that state them in its mentions. Its
  `support` therefore counts every episode that said any of them, and the
  result cites their sources. Its id, text, kind, score and first span (its
  date) stay its own. Nothing is merged in the store: each record keeps its own
  provenance, and forgetting a source removes only what it stated.

```text
[2026-03-02 · fact · stated · said 4 times, last 2026-03-23] The user's team releases on Fridays.
Source: conversation:…:1:0 revision 1, characters 6-34
Source: conversation:…:1:0 revision 1, characters 6-38
Source: conversation:…:1:0 revision 1, characters 6-45
Source: conversation:…:1:0 revision 1, characters 6-40
```

The section (version 7) shows a profile record that recall folded into a
memory it kept once, as the profile's record with the profile's count (a
record without one, from a host's own profile, takes the kept memory's
support). `recallCollapseSimilarity: false` turns
folding off, and the order and records are then exactly as before. The
threshold is high because folding needs no entity match: two facts of the
same kind about different things whose sentences embed at 0.95 or more are
shown as one. Lower it only with an embedding model whose near-duplicates you
have measured.

`KnowledgeSearch.minSimilarity` (from -1 to 1) is a floor on the semantic
arm: a store leaves out every semantic candidate whose score, the cosine
similarity of its embedding with the query vector, is below it, before the
limit, so weak matches take no place. The lexical arm is unaffected, so an
exact word still finds its record. Without a floor the in-memory store drops
scores of 0 or less, as it always has; with one, both stores keep every score at
or above it, so a floor of 0 or below keeps them too. The PostgreSQL store
applies the floor in its SQL.
`MemoryConfig.recallMinSimilarity` and `RagConfig.minSimilarity` pass one,
and both are absent by default: a useful floor depends on the embedding model
(values around 0.1 to 0.3 are used elsewhere), so measure recall with and
without one before setting it. `knowledgeStoreConformance`'s
`knowledge.similarity-floor` check holds a host's own store to both rules.

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
